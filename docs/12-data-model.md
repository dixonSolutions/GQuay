# Data model

One SQLite file at `paths.data/gquay.db`, opened with `better-sqlite3` — single-writer and synchronous.

That is a deliberate fit rather than a shortcut. Webhook handling is short and bursty, and the registry is what decides whether an event spawns, delivers, resumes or is dropped. An async driver would buy nothing and would open a window where two deliveries for the same work item both read "no session" and both spawn.

WAL is on so the MCP server's bookkeeping and the ingress path don't block each other on reads. `busy_timeout` is 5s, `foreign_keys` on.

## Migrations

Append-only, each applied once inside a transaction, with the applied index recorded in `schema_migrations`. **Never edit an entry that has shipped — add a new one.**

The bookkeeping table is bootstrapped by `migrate()` rather than by a migration, because a migration that created it would have to run before the table recording whether it ran exists. (Getting this wrong is not hypothetical: an earlier version had migration 001 recreate it, and every fresh install failed at boot. A test caught it.)

---

## `work_items`

The registry. One row per issue or PR that GQuay has ever touched.

| Column | Notes |
|---|---|
| `key` | PK — `issue:owner/repo#42` or `pr:owner/repo#87` |
| `kind` | `issue` \| `pr` |
| `repo`, `number` | denormalised from the key for indexed lookups |
| `session_id` | Claude Code session id, lifted off the `stream-json` output |
| `pid` | for `process` and `container` targets on this host |
| `state` | see the state machine below |
| `model` | resolved at spawn from labels; pinned for the session |
| `target` | execution target name — **sticky for the life of the item** |
| `worker_id` | which dispatch worker holds the session |
| `branch`, `worktree` | `gquay/issue-42`, and its absolute path |
| `owner_login` | the human who triggered it |
| `linked_key` | the issue ↔ PR pairing, written in both directions |
| `title` | for cards and logs |
| `granted_scopes` | JSON array, resolved once at spawn |
| `mcp_token` | per-session bearer for `/mcp` and the push proxy. Never logged, never printed by `gquay show` |
| `created_at`, `last_activity` | |
| `idle_since`, `awaiting_since` | the two distinct clocks — see below |
| `nudged_at`, `escalated_at` | so a long wait produces two messages, not one per sweep |
| `merge_approved_until`, `merge_approved_by` | the merge gate flag |
| `notify_thread` | Teams message id for threading |
| `error` | last failure reason |

### Why `target` is sticky

A worktree on a dispatch worker does not exist anywhere else. A resumed session has to go home, so `ExecutionPlane.select()` short-circuits on a pinned target before it considers any routing rule.

### The state machine

```
starting ──▶ working ──Stop──▶ idle ──park_after──▶ parked
                 ▲                │                    │
                 │                └── new event ──▶ working
                 │                                     ▲
                 │                          resume ────┘
                 └── answer ─── awaiting_input ◀── Notification/agent_needs_input
                                     │
                                     ├── nudge_after   → one Teams nudge
                                     └── escalate_after → one escalation
   any ──▶ dead   (crash, terminate, worker lost)
```

`LIVE_STATES` = `starting`, `working`, `idle`, `awaiting_input`. Only those count toward target capacity.

**Two clocks, and only one escalates.**

`idle_since` means the agent has nothing to do. Normal. Most of it collapses into `await_events` — the idle clock *is* that call's `timeout_s`, and `idle_ms` tells the agent how long it waited, so "nudge at T1" is something the agent decides rather than a state pushed at it.

`awaiting_since` means the agent is blocked on a person. That one escalates, because it has to fire whether or not the agent is parked — an agent blocked on a human is not going to nudge anyone on its own behalf.

`setState()` enforces the exclusivity: entering `idle` clears `awaiting_since`, `nudged_at` and `escalated_at`; leaving `awaiting_input` clears them too, so the next block starts a fresh escalation rather than firing immediately.

### The linking rule in SQL

```sql
-- pr:repo#87 inherits everything that makes it the same session
INSERT INTO work_items (key, ..., session_id, target, branch, worktree,
                        granted_scopes, mcp_token, linked_key)
VALUES ('pr:repo#87', ..., <issue's session_id>, ..., 'issue:repo#42');

UPDATE work_items SET linked_key = 'pr:repo#87' WHERE key = 'issue:repo#42';
```

Written **in both directions**, so `siblingKeys()` resolves from either end and a parked call on either drains both queues.

### Failing closed

`grantedScopes()` returns `[]` on unparseable JSON rather than throwing or guessing. An unreadable grant set is *no* grants, never *all* grants. There is a test for it.

---

## `events` — the per-item queue

```sql
id, work_item_key, kind, payload (JSON), created_at, delivered_at
```

Events are enqueued the moment a webhook is accepted, and drained by whichever `await_events` call is parked. They are **never handed straight to a waiting promise**.

That ordering is the whole design. An event that lands a millisecond before the call registers is already in the table, so the call drains it instead of parking on an empty queue. `ParkingLot.notify()` is only a doorbell; the queue is the source of truth.

`drain()` selects and marks delivered inside one transaction, which is what makes exactly-once delivery hold when two calls are parked on the same key.

Undelivered events also survive a Router restart, which matters because the parked call does not.

Delivered rows are pruned after 14 days.

### The delivered shape

```jsonc
{
  "kind": "comment | review | review_comment | ci | control",
  "work_item": "issue:acme/widgets#42",
  "author": "alice",
  "author_association": "MEMBER",   // from the payload — a weaker signal
  "author_permission": "write",     // from the API — what the framing quotes
  "body": "…",
  "url": "…",
  "received_at": "2026-09-01T04:11:22.831Z"
}
```

Plus `review_state`; or `path`, `line`, `diff_hunk`; or `conclusion`, `workflow` — depending on kind.

Carrying the author, their permission level and the source URL together is not incidental. The agent needs all three to judge a request, and the framing needs them to present it safely.

---

## `deliveries` — webhook dedupe

```sql
delivery_id (PK), event, action, repo, received_at, outcome
```

GitHub retries deliveries, and a retry carries the same `X-GitHub-Delivery`. A `UNIQUE` insert on that id is the entire guard: if the insert conflicts, this delivery has been seen.

Checked **before** anything with side effects, because the expensive failure is a duplicate spawn, not a duplicate log line.

`outcome` records what the Router decided — `spawn`, `deliver`, `resume`, `terminate`, `ignore`, `error` — which makes "what happened to that comment" answerable after the fact. Pruned after 7 days; GitHub gives up retrying long before that.

---

## `comms_log` — rate limiting and audit

```sql
id, work_item_key, channel, action, allowed, reason, thread_ref, created_at
```

Every `post`/`reply`/`ask` lands here **whether it was allowed or denied**, so "why did the agent go quiet" is answerable.

Rate limits count only `allowed = 1` rows inside the window, so a burst of denials doesn't consume the budget.

---

## `questions` — open asks

```sql
ticket_id (PK), work_item_key, channel, question, options, asked_at,
answered_at, answer, answered_by
```

Created by `ask`, surfaced in `work_item_status` and injected on `SessionStart` — so a resumed session knows what it is still waiting on even if that predates its transcript.

---

## `config_cache`

```sql
scope, source, etag, payload, fetched_at   -- PK (scope, source)
```

`scope` is `org:<org>` or `repo:<owner/repo>`; `source` is `variables` or `file`.

GitHub emits **no webhook when an Actions Variable changes**, so Variables are polled with ETag-conditional requests — a 304 costs nothing. The file config *does* get a `push` webhook, so the Router watches for `.github/gquay.yml` in a push's changed paths and invalidates.

The cache is also the last-known-good store. On a parse failure the Router logs, alerts, and keeps serving the previous value. It never fails open to "no restrictions" — a broken `GQUAY_SCOPE_OVERRIDES` must not become unlimited scopes.

---

## Not in the database

**Parked calls.** They live in `ParkingLot`, in memory. A restart releases them; the events they were waiting on survive in `events`.

**Agent-locks claims.** Markdown under `git rev-parse --git-common-dir`/`agents-locks/` — a path every worktree of a repository shares, and which is structurally impossible to commit since git's index has no concept of a path under `.git/`. That is agent-locks' design and it is the right one; GQuay reads the directory directly rather than through an MCP client, because both processes address the same files and a `PreToolUse` hook has milliseconds.

**Dispatch worker connections.** In `WorkerRegistry`, in memory. A worker that reconnects replaces its stale entry rather than double-counting capacity.

---

## Boot-time reconcile

Nothing survives a Router restart: child processes died with it, and dispatch workers lost their control connection. Rows still claiming to be live are stale, and leaving them that way would make the dispatcher believe a session exists to deliver into.

- A row **with** a `session_id` becomes `parked` — the transcript is intact and the next comment resumes it.
- A row **without** one becomes `dead`; there is nothing to resume.
