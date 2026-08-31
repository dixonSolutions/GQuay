# Operations

## The CLI

```bash
gquay status                  # from the running Router: parked calls, targets, work items
gquay doctor                  # validate config, secrets, reachability
gquay items --state=idle      # list work items
gquay show issue:acme/x#42    # everything known about one (never the MCP token)
gquay terminate issue:acme/x#42
gquay refresh                 # drop cached repo config
```

`status` asks the running Router rather than inferring from the database, so it reflects parked calls and live capacity — which only exist in memory.

## Failure modes

| Failure | Symptom | What handles it |
|---|---|---|
| Agent comments → webhook → itself | infinite loop, burned quota | bot-actor guard; events authored by the App are never delivered |
| Two events, one work item, racing | duplicate PRs | `KeyedQueue` serialises per work-item key |
| Hook Bus down | merge gate silently open | settings-level `ask` floor + branch protection; `/healthz` on the bus |
| Transient GitHub API failure | event silently dropped (202 already sent) | in-process retry with backoff, then a Teams alert |
| Session dies mid-task | work item stuck `working` | exit is observed; the item is marked `parked` or `dead` and resumed from `session_id` |
| Router restarts | rows claiming to be live are stale | boot-time reconcile: with a session id → `parked`, without → `dead` |
| Rate limit | agent stops mid-PR | `StopFailure` matcher `rate_limit` → Teams alert |
| Context compaction loses the issue | agent forgets the task | `PreCompact` re-injects the work item brief |
| Worktree left behind | disk fills | `SessionEnd` + the Router's GC on terminate |
| Stale agent-locks claim | a path stays blocked forever | `SessionEnd` calls `lock_finish`; the idle supervisor reaps past `stale_lock_after` |
| Teams workflow orphaned | notifications silently stop | add co-owners; a daily heartbeat card |
| Dispatch worker disconnects | its sessions vanish | items are marked dead and stay pinned to that worker for resume |

## Idle handling

```
starting ──▶ working ──Stop──▶ idle ──park_after──▶ parked
                 ▲                │
                 │                └── new event ──▶ working
                 │
                 └── answer ──── awaiting_input ◀── Notification/agent_needs_input
                                    │
                        nudge_after ─┤
                     escalate_after ─┘
```

Two distinct clocks, and only one of them escalates.

`idle` means the agent has nothing to do. That is normal. Most of it collapses into `await_events`: the idle clock *is* that call's `timeout_s`, and `idle_ms` tells the agent how long it has been parked, so "nudge at T1" is something the agent decides on a timed-out return rather than a state the Router pushes at it.

`awaiting_input` means the agent is blocked on a person. That one escalates, because it has to fire whether or not the agent is parked — an agent blocked on a human is not going to nudge anyone on its own behalf.

The Router's idle supervisor therefore keeps only two responsibilities: the escalation clock, and the park/terminate decision (a session idle for a day should stop costing a process). Nudges and escalations each fire once, recorded on the work item, so a long wait produces two messages rather than one per sweep.

## What to watch

**`gquay status` → `parked_calls`.** Should roughly track the number of live work items. Zero with live items means the Stop hook is not firing — check the generated `settings.json` under `data/sessions/`.

**Journal for `giving up on event`.** Every one of these is a comment a human wrote that no agent saw.

**`comms_log`.** Denials are recorded with their reason. A cluster of them usually means a channel description is not saying what you think it says.

**The Teams heartbeat.** If the daily card stops, the Workflow was orphaned or deleted and every notification since has been silently dropped.

## Build order

If you are extending this, the design's own build order still holds:

1. **Webhook → spawn → comment.** Proves the loop.
2. **Registry + linking.** This is the piece that makes it feel like one agent.
3. **Merge gate.** Add it *before* giving the agent write-heavy permissions, not after.
4. **Teams mirrors.** Start with `gquay.started`, `gquay.needs_input`, `pr.opened`. Add rows as people ask.
5. **Idle timers.** Only meaningful once step 2 works.
6. **`asyncRewake` inbox.** Last — mid-task delivery is a refinement over spawn-and-resume, not a prerequisite.

Steps 1–3 are a working system. If the project stalls after 3, it still has value.
