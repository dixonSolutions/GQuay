# MCP tools

The `gquay` MCP server is the Router's agent-facing side. It runs inside the Router process, because the parked `await_events` calls have to share the work-item registry and the webhook queue with the part that receives GitHub events.

**Identity comes from the bearer token** on the HTTP connection, which the Router minted at spawn and wrote into that session's `mcp.json`. A tool call therefore cannot claim to be a different work item than the connection it arrived on. If the MCP session id and the bearer ever disagree, the request is refused rather than served.

Each session gets its own `McpServer` instance, built by `buildMcpServer(workItemKey, deps)`.

---

## `await_events`

Block until something happens on your work item.

```jsonc
// input
{ "timeout_s": 540 }   // optional, 5–900, defaults to the Router's park window
```

```jsonc
// returns two content blocks: framed prose, then structured JSON
{
  "events": [
    {
      "kind": "comment",
      "work_item": "issue:acme/widgets#42",
      "author": "alice",
      "author_association": "MEMBER",
      "author_permission": "write",
      "body": "Please also cover the refresh-token path.",
      "url": "https://github.com/acme/widgets/issues/42#issuecomment-9",
      "received_at": "2026-09-01T04:11:22.831Z"
    }
  ],
  "idle_ms": 1966,
  "timed_out": false
}
```

`kind` is one of `comment`, `review`, `review_comment`, `ci`, `control`. Review events carry `review_state`; review comments carry `path`, `line` and `diff_hunk`; CI events carry `conclusion` and `workflow`.

### What actually happens

1. The call **drains the queue first**. If events are already waiting it returns immediately with `idle_ms: 0`. This ordering is what makes the lost-wakeup race impossible — an event that landed a millisecond before the call registered is already in SQLite.
2. Otherwise the call is registered as a waiter and does not return.
3. The work item goes to state `idle`.
4. MCP progress notifications go out on a ~25s heartbeat, because both ends of an HTTP stream have idle timeouts.
5. When a webhook for this item (**or its linked twin**) arrives, the Router enqueues the event and rings the doorbell. The waiter drains and returns.
6. The item goes back to `working`.

### Draining both threads

An issue and its linked PR share one session, so the call watches both keys. Without that, a review landing on the PR would sit unseen while the agent waited on the issue.

### Timeouts are normal

`timed_out: true` with zero events means nobody has replied yet. It is not an error. The `Stop` hook simply parks again, and a returned "no events" is cheap.

Read `idle_ms` and decide for yourself: nudge, summarise, or wind down. The Router does not push that decision in.

### It is called for you

A `Stop` hook of type `mcp_tool` invokes this whenever a turn ends. You can still call it deliberately mid-task — after pushing a branch and wanting CI, for instance.

One observability consequence: when the *hook* makes the call it is not a model tool call, so `PostToolUse` does not fire for it. The explicit path still does, with matcher `mcp__gquay__await_events`.

---

## `list_channels`

```jsonc
// returns
{
  "channels": [
    {
      "key": "decisions",
      "name": "#gquay-needs-you",
      "description": "Work is blocked on a human decision about a specific issue or PR…",
      "do_not_use_for": "Progress updates, or anything you can decide yourself.",
      "attention_cost": "high",
      "urgency_floor": "high",
      "granted_scopes": ["post", "reply", "ask", "mention.assignee", "escalate"],
      "rate_limit": "6/hour",
      "rate_limit_remaining": 4,
      "quiet_hours": null
    }
  ],
  "note": "Saying nothing is always an option."
}
```

Only channels this session holds a non-`mirror` scope on are returned. The agent chooses from a menu of things it can actually do, rather than discovering its limits by being denied.

`rate_limit_remaining` lets it spend the budget deliberately instead of hitting the wall mid-task.

---

## `post`

```jsonc
{
  "channel": "notes",              // key from list_channels
  "summary": "Skipped the retry backoff rewrite — out of scope for #42.",
  "detail": "…",                   // optional, needs the `attach` scope, truncated at 12 KB
  "urgency": "low",                // low | normal | high | critical
  "mention": "assignee"            // optional, needs mention.assignee
}
```

```jsonc
{ "posted": true, "channel": "#gquay-notes", "rate_limit_remaining": 3 }
```

Or, when refused:

```jsonc
{ "posted": false, "reason": "#gquay-needs-you is for high-and-above messages; this one is normal. Post it to #gquay-notes instead." }
```

Every refusal names a better channel, so the model re-routes rather than giving up or retrying identically.

---

## `reply`

```jsonc
{ "channel": "decisions", "body": "CI is green now.", "urgency": "normal" }
```

Adds to a thread this work item already started. Prefer it over `post` — one root card per work item keeps the channel readable.

---

## `ask`

```jsonc
{
  "channel": "decisions",
  "question": "Two valid migrations here. I recommend the additive one — take it?",
  "options": ["additive (recommended)", "destructive + backfill"]
}
```

```jsonc
{
  "ticket_id": "q-8f2c1a04",
  "channel": "#gquay-needs-you",
  "posted": true,
  "answer": null,
  "note": "This returned a ticket, not an answer. Carry on with anything that does not depend on the answer; it will reach you through await_events."
}
```

**`ask` is asynchronous.** It posts the question, flips the work item to `awaiting_input`, starts the escalation clock, mirrors the question onto the GitHub thread, and returns a ticket.

It does not return an answer, and it never will. Answers come back through `await_events`, because people reply on GitHub. If a model believes `ask` blocks, it will block on it and burn a turn finding out otherwise — which is why the description, the return payload and the server instructions all say so in three different places.

Include a recommended default. A question the reader can answer in one word gets answered; one that requires composing a paragraph waits until tomorrow.

---

## `check_conflict`

```jsonc
{ "path": "backend/src/oauth/callback.ts" }
```

```jsonc
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "backend/src/oauth/** is claimed by issue:kingspan/portal#42 (active 40m). Coordinate in the issue thread before editing."
  },
  "conflicts": [
    { "pattern": "backend/src/oauth/**", "claimed_by": "issue:kingspan/portal#42",
      "title": "Fix flaky OAuth callback test", "age_minutes": 40 }
  ]
}
```

The response is shaped as a `PreToolUse` decision because it is also wired as one. An `mcp_tool` hook's output is read the same way command-hook stdout is, so it has to be a `permissionDecision` object — and agent-locks itself returns a lock array. This tool is the shim between the two.

The overlap test is a **static-prefix heuristic, biased toward false positives on purpose**: a false positive costs one extra check, a false negative hides a real conflict.

Claims from your own `agent_id` are excluded, finished claims are ignored, and claims older than `stale_lock_after` are treated as abandoned.

---

## `work_item_status`

```jsonc
{
  "work_item": "issue:acme/widgets#42",
  "title": "Broken login",
  "state": "working",
  "model": "claude-opus-5",
  "branch": "gquay/issue-42",
  "linked": "pr:acme/widgets#87",
  "target": "local",
  "granted_scopes": ["notes:post", "decisions:post", "decisions:ask"],
  "open_questions": [{ "ticket_id": "q-8f2c1a04", "question": "Two valid migrations…" }],
  "merge_approved": false,
  "peer_claims": ["Refactor billing (issue:acme/widgets#51) claims billing/** — active 12m"]
}
```

Useful after a resume, when the transcript may predate the current state.

---

## Server instructions

The MCP server ships `instructions` (see `src/mcp/instructions.ts`) rather than relying on a repository's `CLAUDE.md`. The contract has to travel with the tools; a rule in a project file is a rule that may not be loaded.

The instructions cover four things: how waiting works, the GitHub-versus-Teams split, the channel selection contract, and what the agent cannot do and why.

The selection contract's last clause does the most work:

> *None of the above?* → **say nothing.** Silence is the correct default and costs you nothing.

Without an explicit "no channel" option a model treats channel selection as mandatory and finds something to say every time.

---

## The other two servers

**`github`** — the official GitHub MCP server, run in Docker with an installation token and `GITHUB_TOOLSETS=repos,issues,pull_requests,actions`. The toolset is a real security control: `GITHUB_TOOLSETS` and `--exclude-tools` limit what exists at all, which is stronger than any prompt. Don't enable `code_security` or `projects` unless you use them.

**`agent-locks`** — launched with `AGENT_LOCKS_AGENT_ID` set to the work item key, so every claim traces back to an issue, a PR and a Teams thread. The agent uses `lock_create` / `lock_update` / `lock_finish` directly; GQuay wraps only the conflict check, because that is the one whose output has to become a permission decision.

Each session's `mcp.json` is generated into `data/sessions/<work-item>/` at `0600` and never written inside the worktree — the worktree is a git checkout the agent could `git add -A` at any moment.
