# Glossary

Terms that mean something specific here, in rough order of how central they are.

**Work item** — one issue or one pull request, keyed `issue:owner/repo#42` or `pr:owner/repo#87`. The unit of ownership: exactly one session, one worktree, one branch, one set of comms scopes.

**Parking** — an `await_events` MCP call that the Router holds open instead of returning. The agent is suspended inside a tool call, costs no tokens, and keeps its context window. This is the mechanism the whole design turns on.

**Virtual hook** — the effect of a webhook resolving a parked call. Nothing external can raise a Claude Code hook, but an MCP tool call is a lifecycle point, so an external event landing on a parked call produces hook events inside a live session.

**The linking rule** — when the agent working an issue opens a PR, that PR is registered with the *same* session id, worktree, branch, scopes and bearer. One session then owns both threads, and a call parked on either drains both queues.

**The routing table** — the decision for every inbound event: spawn, deliver, resume, terminate, or ignore. Implemented in `Router.route()`.

**Delivery** — getting an event into the session that owns a work item. Three paths in descending fidelity: the parked call (same context window), the asyncRewake inbox (agent is working, not parked), and `--resume` (nothing is running).

**asyncRewake** — a Claude Code hook flag. A hook marked `async: true, asyncRewake: true` that exits 2 wakes the agent mid-task and surfaces its stderr as a system reminder. GQuay uses it on `PostToolBatch` to reach an agent that is working rather than parked.

**Inbox** — a per-work-item JSONL file the Router appends to for the asyncRewake path. Read-and-cleared in one step so a message is delivered exactly once.

**Execution target** — where a session actually runs: `process`, `dispatch`, `container` or `claude_cloud`. Defined in `router.yml`, never in a repository's config, because a target names a machine and a token.

**Parking (target property)** — whether a target can hold an `await_events` call for hours. True for everything except `claude_cloud`, whose sandbox is destroyed at session end.

**Dispatch worker** — a machine that dials *out* to the Router and holds the connection open. The Router never connects to a worker, which is what makes a private network usable without an inbound path.

**Fire-and-forget** — how `claude_cloud` runs, because it cannot park: spawn per event, work, push, exit. Every later comment is a fresh spawn or a resume.

**The merge gate** — a `PreToolUse` hook on `merge_pull_request` that denies unless the Router has recorded an approval for that specific PR. Holds under `bypassPermissions`, because `PreToolUse` fires before any permission-mode check.

**Approval phrase** — the text (default `@gquay merge`) that authorises one merge when posted on a PR by someone with write access. Matched by the Router, anchored to line starts, permission-checked against the API, TTL-bounded, single-use.

**Push proxy** — the Router endpoint a worktree's `origin` push URL points at. It parses the pkt-line preamble of `git-receive-pack` and refuses any ref that is not the work item's own branch. A *proxy* rather than a credential helper because a helper never sees the refs.

**pkt-line** — git's wire framing: four hex digits of length (including the four), then payload, terminated by the flush packet `0000`. The ref updates in a push live in the preamble before the flush.

**Comms scope** — `<channel>:<capability>`, e.g. `decisions:ask`. Deliberately shaped like an Entra/Graph scope. Resolved once at spawn into a flat grant set and logged into the transcript.

**Attention cost** — `none` / `low` / `high` / `critical` on a channel. The comparator the agent uses when two channels both fit: prefer the cheapest adequate one.

**Urgency floor** — the minimum urgency a channel accepts. Stops a routine note landing in an alert channel.

**Mirror** — a channel capability meaning the Hook Bus may post there but the agent may not. `#gquay-activity` is filled entirely by the agent's lifecycle and the agent cannot write to it.

**The selection contract** — the instruction telling the agent how to choose a channel, ending in "*None of the above?* → say nothing." Without the explicit no-channel option, a model treats selection as mandatory.

**Framing** — how untrusted GitHub text is presented: author, real permission level, source URL, then the body fenced with a marker the body cannot close. States facts rather than issuing system commands, because out-of-band-command framing can trip Claude's own injection defences.

**The bot-actor guard** — dropping any event whose sender is a Bot or ends in `[bot]`. Without it the agent's own comment triggers a webhook that delivers to itself, forever.

**Static-prefix heuristic** — how agent-locks decides whether two path globs overlap. Compares the literal prefix before the first wildcard, biased toward false positives on purpose: a false positive costs one check, a false negative hides a real conflict.

**Stale lock** — an agent-locks claim whose owning work item is no longer running. Locks have no TTL, so `SessionEnd` releases them and the idle supervisor reaps whatever that misses.

**The two clocks** — `idle_since` (the agent has nothing to do; normal, never escalates) and `awaiting_since` (the agent is blocked on a person; escalates, because it must fire whether or not the agent is parked).

**The four tiers** — label > repo Variable > repo `gquay.yml` > org Variable > default. Forced by one constraint: the Router can read Actions Variables and can never read Actions Secrets.

**Overlay** — how Variable JSON merges *on top of* file config rather than replacing it, so a malformed variable degrades to file config rather than to no config.

**The Hook Bus** — the loopback listener that hooks talk to. Separate from the ingress because hook responses block tool calls and must not queue behind webhook retries.

**Work item key** — the string form, `issue:owner/repo#42`. Used as the registry primary key, the agent-locks `agent_id`, the `X-GQuay-Work-Item` header, and the branch and worktree names.
