# Hooks

`runner/settings.json` is a **template**. The Router renders it per session into `data/sessions/<work-item>/settings.json` at `0600`, substituting `${...}` placeholders, and passes it with `--settings`.

It is generated per session rather than shared because two values differ per session — the work item key and the inbox path — and because a shared config would mean one leaked worktree exposes every session's credentials.

**Do not hand-edit the generated copy. Edit the template.**

## Placeholders

| Placeholder | Value |
|---|---|
| `${HOOK_BUS_URL}` | `http://127.0.0.1:8787` — the loopback Hook Bus |
| `${WORK_ITEM_KEY}` | `issue:acme/widgets#42` — sent as the `X-GQuay-Work-Item` header |
| `${INBOX_FILE}` | absolute path to this item's asyncRewake inbox |
| `${PARK_TIMEOUT_S}` | `idle.park_timeout_seconds` from `router.yml` |
| `${MODEL}` | the model resolved at spawn |
| `${RUNNER_DIR}` | where the hook scripts live |

Values are JSON-escaped on substitution, so a path containing a quote is safe.

## Identity

Every HTTP hook sends `X-GQuay-Work-Item`. The Hook Bus reads identity from **that header, not from the hook payload** — a session cannot claim to be a different work item than the one it was spawned for.

Authentication is `Authorization: Bearer $HOOK_BUS_TOKEN`, compared in constant time. `allowedEnvVars` restricts which environment variables a hook may interpolate; `allowedHttpHookUrls` restricts where hooks may talk at all, so a compromised repository cannot add a hook that exfiltrates to an external URL.

---

## The full overlay

| Event | Matcher | Type | Endpoint / tool |
|---|---|---|---|
| `SessionStart` | `startup\|resume` | http | `/hooks/session-start` |
| `Stop` | *(any)* | **mcp_tool** | `gquay__await_events` |
| `Stop` | *(any)* | http (async) | `/hooks/turn-end` |
| `PreToolUse` | `mcp__github__merge_pull_request` | http | `/hooks/merge-gate` |
| `PreToolUse` | `mcp__gquay__(post\|reply\|ask)` | http | `/hooks/comms-gate` |
| `PreToolUse` | `Edit\|Write\|MultiEdit\|NotebookEdit` | http | `/hooks/edit-guard` |
| `PostToolUse` | `mcp__github__(add_issue_comment\|issue_write\|pull_request_review_write\|create_pull_request\|merge_pull_request)` | http (async) | `/hooks/github-write` |
| `PostToolBatch` | *(any)* | command (async, **asyncRewake**) | `check-inbox.sh` |
| `Notification` | `agent_needs_input\|idle_prompt\|permission_prompt` | http | `/hooks/needs-input` |
| `StopFailure` | `rate_limit\|billing_error\|authentication_failed` | http | `/hooks/agent-error` |
| `PreCompact` | *(any)* | http | `/hooks/pre-compact` |
| `PreModelSwitch` | `^(?!${MODEL}$).*` | command | `block-downgrade.sh` |
| `SessionEnd` | *(any)* | **mcp_tool** | `agent-locks__lock_finish` |
| `SessionEnd` | *(any)* | http | `/hooks/session-end` |

---

## `Stop` — the park loop

The most important hook in the system.

```jsonc
{
  "type": "mcp_tool",
  "server": "gquay",
  "tool": "await_events",
  "input": { "timeout_s": 540 },
  "timeout": 600,
  "statusMessage": "Parked — waiting for GitHub"
}
```

Two properties make this work. MCP tool hooks are available on **every** hook event once the servers are connected, and Claude Code reads the tool's text output the same way it reads command-hook stdout. So the hook fires whenever a turn ends, the server parks it, and the return value decides what happens next:

| Server returns | Effect |
|---|---|
| `additionalContext` with the event | turn continues, the event lands in context as feedback |
| `decision: "block"` with a reason | turn continues, framed as "you're not done" |
| empty / no decision | turn ends cleanly, session goes idle → parked |

`additionalContext` is the normal path — the docs describe it on `Stop` as non-error feedback that continues the conversation, which is precisely a delivered comment. Reserve `decision: "block"` for an agent trying to stop with something genuinely unfinished.

### The two timeouts

`timeout_s` (540) sits **below** the hook's `timeout` (600) so the server returns "nothing arrived" first and the turn ends deliberately.

If the hook itself times out, Claude Code cancels it and discards the output, so no decision is rendered and the turn ends anyway. The failure mode is "session parks", not "session hangs" — which is why the ordering is worth getting right rather than leaving to chance.

### Why a hook rather than an instruction

An agent that *forgets* to call `await_events` ends its turn and the session dies with work outstanding. "Remember to call the tool" is exactly the kind of instruction that survives twenty turns and then doesn't.

The agent keeps `await_events` as a callable tool for deliberate mid-task waits. The loop just no longer depends on it choosing to.

---

## `PreToolUse` — the three gates

All three return the same shape:

```jsonc
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",           // allow | deny | ask
    "permissionDecisionReason": "…"
  }
}
```

**`PreToolUse` fires before any permission-mode check.** A deny blocks the call even under `bypassPermissions` or `--dangerously-skip-permissions`. Hooks can tighten policy past what permissions allow; they can never weaken it. That property is what makes GQuay safe to run unattended.

The corollary matters just as much: **a hook that times out does not block the tool call.** Execution continues through the normal permission flow. So gates fail closed and fail fast, and `merge_pull_request` also sits behind a settings-level `ask` rule as a floor.

### `/hooks/merge-gate`

Denies unless `merge_approved_until > now()` for that PR. Consumes the approval on allow, so a retry loop cannot turn one approval into several merges. See [04-merge-gate](04-merge-gate.md).

### `/hooks/comms-gate`

Checks, in order: scope, mentions, attachments, escalation, urgency floor, rate limit, quiet hours. Every denial names a better channel. See [05-comms](05-comms.md).

Lives here rather than inside the comms server for two reasons: the `bypassPermissions` property above, and because a hook deny is *visible to the model as feedback* so it re-routes, whereas a silent server-side drop teaches it nothing.

### `/hooks/edit-guard`

Repo-declared `protected_paths` first — those win over any lock state — then sibling agents' claims. This is the enforcement layer over agent-locks, which is advisory by design: right for a general tool, too loose for an unattended pipeline.

---

## `PostToolUse` — mirroring, and the linking rule

`async: true`, because a Teams post should never sit in front of the agent's next turn.

This is also where the **linking rule** lands. A `create_pull_request` response gives the Router the new PR number, which it registers against the same session id, worktree, branch, scopes and MCP bearer. One session now owns both threads.

The number is extracted defensively — a direct `number` field, then a JSON scan, then a `/pull/<n>` URL match — because the GitHub MCP server returns its payload as text content and the exact shape is not something to depend on.

> **Matcher note.** MCP tools match as `mcp__<server>__<tool>`. A whole-server match needs the `.*` suffix (`mcp__github__.*`) — a bare prefix is compared as an exact string and matches nothing.

---

## `PostToolBatch` — asyncRewake

```jsonc
{
  "type": "command",
  "command": "${RUNNER_DIR}/hooks/check-inbox.sh",
  "async": true,
  "asyncRewake": true
}
```

An agent parked in `await_events` is reachable through the MCP call. An agent three files into a refactor is not — it isn't in the call.

For that case the Router appends the event to a per-work-item inbox file, and this hook reads it between tool batches. The contract: **an `asyncRewake` hook that exits 2 wakes Claude and surfaces its stderr as a system reminder.** So a waiting message goes to stderr and the script exits 2; an empty inbox exits 0 and nothing happens.

The script reads a file rather than calling the Router deliberately. It runs after every tool batch, so it has to be cheap, and it must not fail the batch when the Router is briefly unavailable. Reading a usually-empty file costs nothing.

It also reads-and-clears in one step, so a message is delivered exactly once even if the next batch starts immediately.

---

## `SessionStart` — context injection

One of the few events where hook output is injected straight into the model's context, via `additionalContext`. It carries:

- unanswered questions this item has outstanding,
- what sibling agents currently claim,
- the resolved comms scopes and merge-approval state.

On `source: "startup"` it also posts a visible comment on the GitHub thread. Progress has to be visible in both places — Teams tells you something happened, GitHub is where it happened.

> **Type note.** This is an `http` hook, not `mcp_tool`. `SessionStart` typically fires *before* MCP servers finish connecting, so an `mcp_tool` hook there would fail with "not connected" on first run.

---

## `Notification` — the agent is blocked

Matchers `agent_needs_input`, `idle_prompt`, `permission_prompt`.

Sets `state = awaiting_input`, starts the escalation clock, posts to the decisions channel, and mirrors the question onto the GitHub thread.

That last part is not decoration. A `Stop` hook cannot collect an answer — the turn is already over — so the answer has to come back in through the delivery path, which means the question has to be somewhere answerable.

`Notification` output and exit code are ignored by Claude Code. It is a pure observation point, which is exactly what is wanted here.

---

## `PreCompact` — don't lose the brief

Compaction eventually destroys the oldest context, and the oldest context in one of these sessions is the issue itself.

This returns the work item brief as `additionalContext` — key, title, branch, repo, and the fact that the agent owns it until it is closed or merged.

---

## `PreModelSwitch` — pinning the model

The Router resolves the model at spawn from labels and passes `--model`. A mid-session switch would make the audit line written into the transcript untrue, and would quietly change the cost and capability of work a human already approved.

`block-downgrade.sh` exits 2 to block, with a message telling the agent to ask for a relabel instead.

Two things make this reliable. `PreModelSwitch` is the one event where **a hook cancelled at its timeout blocks the switch** rather than allowing it — so it fails closed by default. And there is no `$CLAUDE_MODEL` environment variable to read, which is why the expected model is passed as an argument.

Use `PostModelSwitch` if you want to log what a session is actually running.

---

## `StopFailure` — infrastructure errors

Matchers `rate_limit`, `billing_error`, `authentication_failed`. Records the error on the work item and alerts Teams at error severity. These are the failures where the agent stops mid-PR through no fault of its own, and where a human needs to know quickly.

---

## `SessionEnd` — cleanup

Two hooks, in order.

`agent-locks__lock_finish` releases the claim. **Locks have no TTL**, so without this a crashed agent holds its claim forever. The Router's idle supervisor reaps anything this misses, past `stale_lock_after`.

`/hooks/session-end` parks the item, keeping its `session_id` so the next comment resumes the transcript, and releases any parked call.

This is why `gquay.service` sets `TimeoutStopSec=45`. A session killed before `SessionEnd` runs leaves its claim held and its worktree on disk, and nothing else cleans either up.

---

## Adding a hook

1. Add it to `runner/settings.json` with a `_comment` explaining *why* — future you will not remember.
2. Add the endpoint to `src/hooks/bus.ts`. Read identity from `X-GQuay-Work-Item`.
3. If it is a `PreToolUse`, return a `permissionDecision` and make sure the failure path is closed, not open.
4. CI renders the template and asserts the required events are present, so a broken overlay fails the build rather than the first spawn.
