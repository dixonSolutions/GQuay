# Architecture

## Components

```
                    ┌────────────────────────────────┐
   GitHub ─webhook─▶│  Ingress (HMAC verify, dedupe) │
                    └──────────────┬─────────────────┘
                                   ▼
                    ┌────────────────────────────────┐
                    │  GQuay Router / Supervisor     │
                    │  · work-item registry (SQLite) │
                    │  · spawn / deliver / ignore    │
                    │  · approval flags (merge)      │
                    │                                │
                    │  ┌──────────────────────────┐  │
                    │  │ GQuay MCP server         │  │
                    │  │ await_events (blocking)  │  │
                    │  │ comms: post/reply/ask    │  │
                    │  └──────────────────────────┘  │
                    └───┬────────────────────┬───────┘
                        │ spawn/resume       │ MCP (parked call resolves)
                        ▼                    ▼
        ┌──────────────────────────────────────────────┐
        │  Agent runner  (one per work item)           │
        │  claude · MCP: github + gquay + agent-locks  │
        └───────────────┬──────────────────────────────┘
                        │ hooks (http / mcp_tool / command)
                        ▼
        ┌──────────────────────────────────────────────┐
        │  Hook Bus  (localhost HTTP)                  │
        │  · merge gate · comms ceiling · edit guard   │
        │  · state updates back to the Router          │
        └───────────────┬──────────────────────────────┘
                        ▼
              Teams (Power Automate Workflows webhook)
```

The MCP server is drawn *inside* the Router because that is what it is: the Router's agent-facing side. It holds the parked `await_events` calls, so it must share the registry and the webhook queue with the part that receives GitHub events. Running it as a separate process would mean inventing an IPC layer for no gain.

The Hook Bus is a separate Fastify listener on loopback. It could be the same service, but the *endpoints* stay distinct because hook responses are latency-sensitive — they block tool calls, and a merge gate must never queue behind a webhook retry storm.

---

## The parking mechanism

`src/mcp/parking.ts`.

An agent calls `gquay__await_events`. The server does not return. When a webhook arrives for that work item, the call returns with the comment as its result.

Three implementation details carry real weight.

**Resolve exactly once.** Events are committed to a SQLite queue on arrival and *drained* by the returning call. They are never handed straight to a waiting promise. That ordering is what makes the lost-wakeup race impossible: an event that lands a millisecond before the call registers is already in the table, so the call drains it instead of parking on an empty queue. `ParkingLot.notify()` is only a doorbell; the queue is the source of truth.

**Keep the transport alive.** Both ends of an HTTP stream have idle timeouts. The parked call emits MCP progress notifications on a heartbeat, and `timeout_s` is bounded (default 540s, hard max 900s) so the `Stop` hook re-fires rather than relying on one socket surviving for hours. A returned "no events" is cheap.

**Return the idle duration.** `idle_ms` lets the agent decide whether to nudge, summarise, or wind down, rather than the Router pushing that decision in.

### Why the Stop hook, and not an instruction

An agent that *forgets* to call `await_events` ends its turn and the session dies with work outstanding. "Remember to call the tool" is exactly the kind of instruction that survives twenty turns and then does not.

So it is structural. A `Stop` hook of type `mcp_tool` calls the wait directly (`runner/settings.json`). MCP tool hooks are available on every hook event once servers are connected, and Claude Code reads the tool's text output the same way it reads command-hook stdout. The return value decides what happens next:

| Server returns | Effect |
|---|---|
| `additionalContext` with the event | turn continues, event lands in context as feedback |
| `decision: "block"` with a reason | turn continues, framed as "you're not done" |
| empty / no decision | turn ends cleanly, session goes idle → parked |

`additionalContext` is the normal path. `decision: "block"` is reserved for an agent trying to stop with something genuinely unfinished.

The idle threshold falls out of the timeouts: the tool's `timeout_s` sits below the hook's `timeout`, so the server returns "nothing arrived" first and the turn ends deliberately. If the hook itself times out, Claude Code cancels it and discards the output, so no decision is rendered and the turn ends anyway. The failure mode is "session parks", not "session hangs".

**One observability note.** When the *hook* makes the MCP call it is not a model tool call, so `PostToolUse` does not fire for it. "Picked the thread back up" is mirrored from the Router side, not from `PostToolUse`. The explicit path — the agent calling the tool itself — still fires `PostToolUse` with matcher `mcp__gquay__await_events`.

### Reaching an agent that is working, not parked

An agent mid-refactor is not in the call. For that case the Router writes the event to a per-work-item inbox file, and a `PostToolBatch` hook (`async: true`, `asyncRewake: true`) reads it between tool batches. The hook prints the message to stderr and exits 2, which wakes Claude and surfaces it as a system reminder mid-task.

It reads a file rather than calling the Router because it runs after every tool batch: it has to be cheap, and it must not fail the batch when the Router is briefly unavailable.

---

## Identity: which agent owns what

Work items are keyed `issue:owner/repo#42` and `pr:owner/repo#87`. The registry schema is in `src/state/db.ts`.

### The linking rule

When the agent working `issue:repo#42` calls `mcp__github__create_pull_request`, a `PostToolUse` hook reports the new PR number to the Router, which writes `pr:repo#87` with `linked_key = issue:repo#42` and the *same* `session_id`, worktree, branch, scopes and MCP bearer.

**One session now owns both.** Every subsequent comment on either thread routes to that agent, and a parked call on either key drains both queues — so a review landing on the PR reaches an agent waiting on the issue.

A PR opened by a human with no linked issue gets its own fresh session, owned by that PR key.

### The routing table

`Router.route()` in `src/router/router.ts`.

| GitHub event | Registry state | Action |
|---|---|---|
| `issues.opened` / `labeled` (trigger label) | no row | **spawn** |
| `issue_comment.created` | session parked | **deliver** — the parked call returns |
| `issue_comment.created` | session working | **deliver** — via the asyncRewake inbox |
| `issue_comment.created` | parked / dead | **resume** `--resume <session_id>` with the comment as the prompt |
| `pull_request_review_comment.created` | resolve PR → linked session | deliver as review feedback |
| `pull_request_review.submitted` | resolve PR → linked session | deliver |
| `issues.closed` / `deleted` | any | **terminate**, notify, release the worktree |
| `pull_request.closed` (unmerged) | any | terminate |
| `pull_request.closed` (merged) | any | notify, terminate |
| any event, actor is a bot | — | **ignore** (loop guard) |
| any event, actor lacks write access | — | **ignore** + audit log |

The bot-actor guard is not optional. Without it the agent's own comment triggers a webhook that delivers to itself, forever.

### Serialisation

Two events for one work item arriving at once is not hypothetical — a maintainer labels an issue and comments in the same breath, and GitHub delivers both within milliseconds. Without serialisation both handlers read "no session" and both spawn, and you get two agents and two pull requests for one issue.

`KeyedQueue` chains work per key. Different items still run concurrently; one item is strictly ordered, which also means events reach an agent in the order the humans wrote them.

### Retry, and why it exists

The ingress acknowledges a delivery with 202 *before* routing, because GitHub's delivery timeout is short and spawning a session is not. That trade has a consequence: GitHub will never retry this delivery, so a transient failure would silently drop a real comment.

So transient failures are retried in-process with backoff (2s, 10s, 30s), and only permanent ones give up. The classifier (`isTransient`) is a denylist of permanent conditions rather than an allowlist of transient ones: an unrecognised error is more likely to be a network hiccup than a policy decision, and retrying a policy decision three times is cheap while dropping a real comment is not. A final give-up posts to Teams at error severity, because a dropped event is otherwise invisible to the person who wrote the comment.

---

## Coordination between agents

Worktrees stop agents overwriting each other's files. They do nothing about two agents doing *contradictory* work: one renaming a function while another adds callers to it, two agents independently fixing the same bug, two PRs that both restructure a module and cannot both land.

That is a visibility problem, and [agent-locks](https://github.com/luohoa97/agent-locks) solves the hard part of it — claims stored as markdown under `git rev-parse --git-common-dir`/`agents-locks/`, a path every worktree of a repository shares and which is structurally impossible to commit, since git's index has no concept of a path under `.git/`.

GQuay adds the three things it deliberately leaves to the caller:

**Identity.** Claude Code exposes no session id to a stdio MCP server, so `agent_id` is whatever the caller supplies. The Router knows the work item before it spawns anything, so it passes it in — and every lock traces back to an issue, a PR, and a Teams thread.

**Claim at spawn, not mid-flight.** Conflicts are checked *before* a session starts, so an overlap is caught before an agent writes half a refactor. Policy per repo: `notify` (spawn, inject the conflict into context, post to the decisions channel), `queue` (hold until the claim finishes), `read_only` (spawn with write scopes stripped), `proceed`.

**Enforcement and cleanup.** agent-locks is advisory by design — right for a general tool, too loose for an unattended pipeline. A `PreToolUse` hook on `Edit|Write` turns an overlap report into a `permissionDecision`. And locks have no TTL, so `SessionEnd` calls `lock_finish` and the idle supervisor reaps claims whose work item is no longer running.

Two caveats worth knowing. The overlap check is a **static-prefix heuristic**, biased toward false positives on purpose: a false positive means an agent double-checks, a false negative hides a real conflict. That bias means `on_conflict: queue` will sometimes queue work unnecessarily — start with `notify`. And agent-locks does not model **case-sensitivity**, a deliberate limitation targeting Linux; on a Windows dispatch worker `Src/**` and `src/foo.ts` are the same real file but compare as non-overlapping. `coordination.normalise_case` handles that.

**Do not add agent-to-agent messaging.** Shared claims plus the GitHub thread is enough coordination for work already partitioned by issue. Direct messaging adds a large failure surface — deadlock, cascading context, one confused agent convincing another — for a problem the lock file already answers.

---

## What this design deliberately does not use

**GitHub Actions as the agent host.** No persistent session, no idle state, no mid-run delivery. Actions is still the right place for CI; the agent reads results through the GitHub MCP server's action tools.

**Agent Teams.** Right shape, experimental status. Teammates roughly double token use versus subagents, and there are known issues distinguishing idle-but-alive from dead teammates, which causes leads to spawn duplicates and destroy context. One OS process per work item, supervised by the Router, gives the same isolation with a lifecycle you control and unambiguous liveness.

**A single long-lived agent for all work items.** One context window holding every issue means compaction eventually destroys the oldest work. One session per work item, parked when idle.
