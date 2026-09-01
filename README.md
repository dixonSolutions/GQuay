# GQuay

**GQuay** (pronounced "Gee Q-ay") — a GitHub-driven Claude Code agent system.

GitHub issues and pull requests are the work queue. Each work item is owned by exactly one long-lived agent session. Microsoft Teams is the human-facing channel. It all runs as one process you host yourself.

```
   GitHub ──webhook──▶ GQuay Router ──spawn──▶ Claude Code session (one per work item)
       ▲                    │  ▲                        │
       │                    │  └────── MCP ─────────────┘   await_events parks here
       └──── agent posts ───┘         (parked call)
                            │
                            └──▶ Teams (a doorbell, not a conversation)
```

---

## Contents

- [The fact that shapes the whole design](#the-fact-that-shapes-the-whole-design)
- [What it does](#what-it-does)
- [How a work item flows](#how-a-work-item-flows)
- [Quick start](#quick-start)
- [The agent's tool surface](#the-agents-tool-surface)
- [Configuration at a glance](#configuration-at-a-glance)
- [Execution targets](#execution-targets)
- [The security posture](#the-security-posture)
- [Operating it](#operating-it)
- [Project layout](#project-layout)
- [Design decisions, and why](#design-decisions-and-why)
- [Documentation](#documentation)
- [Status](#status)

---

## The fact that shapes the whole design

"Hooks" means two different things here, and conflating them is the failure mode:

| | Direction | Mechanism |
|---|---|---|
| **GitHub → agent** | inbound | GitHub App **webhooks**, landing on a process you run |
| **Agent → world** | outbound | Claude Code **hooks** (lifecycle events) |

Claude Code hooks fire on *its* lifecycle — session start, tool call, turn end, idle, notification. Nothing external can raise one directly, so a webhook does not "fire a hook."

But that is not the same as saying an external event cannot reach a live session, because **an MCP tool call is itself a lifecycle point**. An MCP server is a long-lived process, and it can simply *not return* from a tool call until something happens. The agent calls `gquay__await_events`, the server parks the call, and when the GitHub webhook arrives the call returns with the comment as its result. Same session, same context window, no restart — and `PostToolUse` fires on the way out, so the external event really does produce hook events inside the session.

A **virtual hook**, triggered from outside.

The limit that survives is narrower and more useful than "you can't reach a live session":

> **An agent is reachable at the points where it yields to a tool, not at arbitrary instants.**

An agent parked in `await_events` is reachable immediately. An agent three files into a refactor is not — it isn't in the call. GQuay covers both cases: the blocking call for the parked one, an `asyncRewake` inbox hook for the working one.

This is also why **GitHub Actions cannot host it.** A workflow run is a fresh container per event with no live process to park a tool call in — no idle state, no session continuity. GQuay assumes a **long-running host** with inbound 443 for the webhook and outbound to the Claude API, GitHub and Teams.

---

## What it does

### One session per work item

`issue:owner/repo#42` gets a session, a git worktree cut from a local bare mirror, and a branch `gquay/issue-42`. Nothing else touches them. Two agents can never fight over a checkout.

### The linking rule

When the agent working an issue calls `create_pull_request`, a `PostToolUse` hook reports the new PR number to the Router, which registers `pr:repo#87` with the **same** session id, worktree, branch, comms scopes and MCP bearer.

One session now owns both threads. Every later comment on either routes to that agent, and a call parked on either key drains both queues — so a review landing on the PR reaches an agent that was waiting on the issue. This is the piece that makes it feel like one agent rather than two processes that happen to share a branch.

A PR opened by a human with no linked issue gets its own fresh session.

### Parking instead of polling

A finished turn parks in `await_events` and costs no tokens until something happens.

It is **structural, not discretionary**. A `Stop` hook of type `mcp_tool` makes the call, so an agent cannot forget to — and "remember to call the tool" is exactly the kind of instruction that survives twenty turns and then doesn't. The tool's `timeout_s` sits below the hook's own timeout, so the server returns "nothing arrived" first and the turn ends deliberately rather than being cancelled.

`idle_ms` comes back with the result, so the agent decides whether to nudge, summarise or wind down, instead of the Router pushing that decision in.

### A merge gate that holds under `bypassPermissions`

The agent *can* merge. It just can't merge unasked.

A `PreToolUse` hook consults the registry and denies unless a maintainer with **write access** posted the approval phrase on that specific PR, within a TTL, and the approval hasn't already been spent. `PreToolUse` fires *before* any permission-mode check, so the deny holds even under `--dangerously-skip-permissions`. Hooks can tighten policy past what permissions allow; they can never weaken it.

### Branch-scoped pushes

The agent's `origin` push URL points at a proxy inside the Router. The proxy reads the ref updates out of the `git-receive-pack` request and refuses anything that isn't the work item's own branch — before a byte reaches GitHub.

The agent never holds a credential that can write to the default branch. Combined with the merge gate and branch protection, an agent that goes wrong still cannot touch `main`, and you don't have to trust three layers to each work independently.

### Coordination without agent-to-agent messaging

Worktrees stop agents overwriting each other's files. They do nothing about *contradictory* work — one agent renaming a function while another adds callers to it.

GQuay integrates [agent-locks](https://github.com/luohoa97/agent-locks), which stores work claims under `git rev-parse --git-common-dir`/`agents-locks/` — a path every worktree shares and which is structurally impossible to commit. GQuay adds the three things it leaves to the caller: real identity (the work item key), admission control *before* a session starts, and enforcement plus reaping (claims have no TTL of their own).

Deliberately **no direct messaging between agents**. Shared claims plus the GitHub thread is enough coordination for work already partitioned by issue; messaging adds deadlock, cascading context and one confused agent convincing another, for a problem the lock file already answers.

### Teams as a doorbell

The agent picks the cheapest channel adequate to its message, from a registry that describes each channel by *the reader's obligation* — not by the system that fills it. Every card links back to GitHub, because that's where people answer.

**Saying nothing is an explicit, encouraged option.** Without that stated outright, a model treats channel selection as mandatory and finds something to say every time.

### Four execution targets

On the Router host, on a worker machine that dials out from inside a private network, in a container, or on the Claude Code cloud sandbox. See [Execution targets](#execution-targets).

---

## How a work item flows

1. Someone labels an issue `gquay`.
2. The webhook arrives. The Router verifies the HMAC over the **raw bytes**, dedupes by delivery id, checks the repo perimeter, drops it if the actor is a bot, and checks the actor has **write access** against the GitHub API.
3. It resolves the model, comms scopes and thresholds across four config tiers, checks whether any sibling agent already claims the area, cuts a worktree, and points its push remote at the branch-scoped proxy.
4. It spawns a session with the issue body, every comment, the labels, live peer claims and a config audit line.
5. `SessionStart` posts a comment on the issue, so progress is visible where the work is — not only in Teams.
6. The agent works. It can only push to `gquay/issue-42`.
7. It opens a PR. `PostToolUse` tells the Router, which links the PR to the same session.
8. It finishes its turn. The `Stop` hook parks it in `await_events`. Zero tokens.
9. A reviewer comments. The webhook lands, the parked call returns with the comment framed and the reviewer's permission level attached, and the agent continues — **same context window**.
10. A maintainer posts `@gquay merge`. The Router checks their permission level against GitHub and sets a 15-minute single-use flag.
11. The agent calls the merge tool. The gate allows it once and burns the approval.

If nothing is running when a comment arrives, step 9 becomes `claude --resume <session_id>` with the comment as the opening prompt — the full transcript is preserved at the cost of a cold start.

---

## Do you need this?

Probably not, at first. **If you want an agent that reads an issue and opens a pull request, use the [official GitHub Action](https://github.com/anthropics/claude-code-action)** — fifteen lines of YAML, no server, no public URL, no database. Two ready-to-use workflows are in [`examples/minimal-action/`](examples/minimal-action).

GQuay's machinery buys one thing the Action cannot give you: **an agent that stays alive between comments with its context window intact**, owning an issue and the PR it produced as one conversation. If your issues get resolved in one pass, that is worth nothing and the Action is the correct architecture.

[docs/00-start-smaller.md](docs/00-start-smaller.md) has the honest comparison, row by row, and the point at which moving up is justified.

## Quick start

```bash
git clone https://github.com/dixonSolutions/GQuay.git
cd GQuay && npm install && npm run build
```

```bash
./setup.sh
```

One front door, focused modules behind it — it asks which of the four things you are setting up, then hands off. `./setup.sh --list` shows them without running anything, and every module also runs standalone and non-interactively for provisioning:

| | |
|---|---|
| `./setup.sh action` | the GitHub Action — no server at all |
| `./setup.sh secrets` | generate `.env` for this checkout |
| `./setup.sh router` | build, install, systemd (needs root) |
| `./setup.sh worker` | a dispatch worker, on another machine |
| `./setup.sh doctor` | check an install without changing it |

To do it by hand instead:

```bash
cp router.example.yml router.yml
cp .env.example .env
./scripts/gen-secrets.sh >> .env && chmod 600 .env
node dist/cli.js doctor
```

`doctor` checks the things that otherwise fail silently for hours: a private key that never loaded, a `public_url` GitHub can't reach, a missing hook overlay (without which there is no park loop and no merge gate), a dispatch target no worker can attach to, Teams enabled with no URL so notifications vanish, and whether the daemon is installed, enabled at boot and actually running.

```bash
npm start
```

Creating the GitHub App, its permissions, branch protection, TLS and systemd are in **[docs/02-deployment.md](docs/02-deployment.md)**.

---

## The agent's tool surface

Three MCP servers are registered per session: `github` (the official server, narrow toolset), `agent-locks`, and `gquay` — the Router's own agent-facing side.

| Tool | Arguments | Returns |
|---|---|---|
| `await_events` | `timeout_s?` (5–900) | `{ events[], idle_ms, timed_out }` — blocks until something happens |
| `list_channels` | — | only channels this session can reach, with granted scopes and remaining budget |
| `post` | `channel`, `summary`, `detail?`, `urgency`, `mention?` | `{ posted, rate_limit_remaining }` |
| `reply` | `channel`, `body`, `urgency?` | `{ posted }` |
| `ask` | `channel`, `question`, `options?` | `{ ticket_id, answer: null }` — **asynchronous** |
| `check_conflict` | `path` | overlapping sibling claims, shaped as a `permissionDecision` |
| `work_item_status` | — | your item, its linked twin, branch, scopes, open questions, peer claims |

`ask` deserves the emphasis. It posts the question, flips the item to `awaiting_input`, starts the escalation clock and returns a **ticket, not a reply**. The answer arrives later through `await_events`, because people answer on GitHub. If the model believes `ask` returns an answer it will block on it and burn a turn finding out otherwise, so the tool description and the return payload both say so.

Full reference with response shapes and the selection contract: **[docs/10-mcp-tools.md](docs/10-mcp-tools.md)**.

---

## Configuration at a glance

Four tiers, because of one hard constraint: **Actions *secrets* cannot be read back** — the REST API lists them without revealing values, by design, and only a workflow runtime can decrypt one. The Router is a standalone process, not an Actions job. Variables are different: stored in the clear and readable through the API.

```
label on item  >  repo Variable  >  repo gquay.yml  >  org Variable  >  built-in default
```

| Tier | Lives in | Holds |
|---|---|---|
| 1 | host env (`.env`, `0600`) | API key, App private key, webhook secret, Teams URL, worker tokens |
| 2 | Actions Variables | kill switch, default model, idle thresholds, small JSON overlays |
| 3 | `.github/gquay.yml` | channel registry, notification matrix, guardrails, preamble |
| 4 | labels on the issue/PR | model override, read-only mode, target routing, priority |

The dividing line between 2 and 3: **Variables for values a non-developer flips under pressure; the file for anything that deserves review.** A file change arrives as a `push` webhook; a variable change emits nothing, so those are polled with ETags.

Labels are the cheapest interface there is — someone changes agent behaviour by clicking one:

```
model:sonnet      gquay:read-only     gquay:quiet      gquay:no-teams
gquay:sandbox     gquay:cloud         priority:high    area:<name>
```

Full reference: **[docs/06-configuration.md](docs/06-configuration.md)**.

---

## Execution targets

The Router is the control plane. *Where* a session runs is a separate, pluggable decision.

| Kind | Runs where | Parks | Use when |
|---|---|---|---|
| `process` | the Router host | yes | default |
| `dispatch` | a worker that dials out | yes | code that must not leave a network |
| `container` | Docker/Podman | yes | untrusted repos, isolation, parallelism |
| `claude_cloud` | Claude Code web sandbox | **no** | throwaway tasks, no local environment needed |

`parking` is what actually separates them. A target that can hold an `await_events` call for hours keeps one session alive across many GitHub events. A cloud sandbox is created at session start and destroyed at the end, so it runs fire-and-forget — the Router forces `parking: false` rather than trusting the config.

**Dispatch is the interesting one.** The worker dials out to the Router and holds the connection open; the Router never connects to a worker. A corporate build server has no inbound path from your host and nobody is opening one — so the only thing needing a public address is the Router, which already has one for the webhook.

The agent's **hooks ride that same connection**, and they have to: the Hook Bus is loopback-only on the Router, and on a worker machine loopback is not the Router. The worker runs its own loopback listener and tunnels each hook home, with the work item identified by a per-session bearer rather than by a header the agent controls. Without that, a worker session has no hooks at all — no park, no merge gate, no linking rule — which is a failure that looks like success until it matters.

Targets live in `router.yml`, never in a repository's config: a target names a machine and a token, and a repo that could choose its own target could choose to run on a box it was never granted.

Details, including what a dispatch worker rebuilds versus what a cloud session gives you: **[docs/03-execution-targets.md](docs/03-execution-targets.md)**.

---

## The security posture

**Prompt injection is the headline risk.** Issue bodies and comments are attacker-controlled text on a public surface, flowing into an agent that holds a GitHub App token.

Every event passes through these before anything is spawned:

```
1. HMAC over the raw bytes, constant-time      invalid → 401
2. Delivery-id dedupe                          replay  → 200, no side effects
3. allowed_repos perimeter                     outside → dropped
4. Bot-actor loop guard                        the agent's own comment → dropped
5. GQUAY_ENABLED                               kill switch, at receipt not at spawn
6. Trigger label                               absent  → dropped
7. Actor write access, from the GitHub API     absent  → dropped + audit log
```

And every tool call passes through:

```
PreToolUse  merge gate     before any permission-mode check
PreToolUse  comms ceiling  scope, mentions, urgency floor, rate limit, quiet hours
PreToolUse  edit guard     repo protected_paths, then sibling agents' claims
```

Delivered text is framed with its author, their **real** permission level from the API (not `author_association`, which the sender partly controls), and the source URL. The framing states facts rather than issuing system commands — text framed as an out-of-band override can trip Claude's own injection defences. It guarantees one narrow thing absolutely: a comment cannot close its own container and appear to be speaking as the Router.

Details: **[docs/08-security.md](docs/08-security.md)**.

---

## Operating it

```bash
gquay status                  # parked calls, target capacity, every work item
gquay doctor                  # validate config, secrets, reachability
gquay items --state=idle      # list work items
gquay show issue:acme/x#42    # everything known about one (never the MCP token)
gquay terminate issue:acme/x#42
gquay refresh                 # drop cached repo config
```

Three things worth watching:

- **`parked_calls` in `gquay status`.** Should roughly track live work items. Zero with live items means the `Stop` hook isn't firing.
- **`giving up on event` in the journal.** Every one is a comment a human wrote that no agent saw.
- **The Teams heartbeat.** A Workflow is owned by a *user*, not a channel, and orphans silently when that person leaves. A daily card is the only cheap way to notice.

Failure modes and what handles each: **[docs/09-operations.md](docs/09-operations.md)**.

---

## Project layout

```
src/
  index.ts              boot: config → logger → registry → reconcile → listeners
  server.ts             ingress + MCP + worker socket + git push proxy
  cli.ts                gquay status | doctor | items | show | terminate | refresh
  worker.ts             dispatch worker — dials out, provisions, runs sessions
  config.ts             router.yml schema + Tier 1 secrets + cross-field validation
  log.ts                pino, with central redaction of the four secret classes
  git.ts                bare mirrors, worktrees, branch naming, git-common-dir

  state/
    db.ts               SQLite schema and append-only migrations
    registry.ts         work-item keys, state machine, the linking rule
    events.ts           per-item event queue (enqueue → drain)
    deliveries.ts       webhook dedupe by delivery id
    inbox.ts            the asyncRewake inbox file

  github/
    app.ts              App JWT → installation token, cached
    api.ts              thin REST client: permissions, context, Variables
    webhook.ts          HMAC over raw bytes, constant-time
    events.ts           raw payload → the shape the routing table matches on

  router/
    router.ts           the routing table, spawn, deliver, resume, terminate
    prompt.ts           spawn and resume prompt assembly
    repoConfig.ts       the four-tier resolver and Variable overlay rules
    mergeGate.ts        approval matching, permission check, TTL, single-use
    pushProxy.ts        pkt-line parsing and branch-scoped authorisation
    queue.ts            per-work-item serialisation
    idle.ts             escalation clock, parking, lock reaping, pruning

  mcp/
    parking.ts          the parking lot — the mechanism the design turns on
    server.ts           the seven tools
    instructions.ts     the server instructions, including the channel contract
    comms.ts            channel registry, scope vocabulary, the ceiling
    locks.ts            agent-locks parsing, overlap heuristic, reaping
    framing.ts          how untrusted GitHub text is presented to the agent

  hooks/bus.ts          the loopback Hook Bus — gates and state updates
  runners/              process | dispatch | container | claude_cloud
  teams/                Workflows relay, Adaptive Cards

runner/
  settings.json         the hook overlay — the park loop and merge gate live here
  hooks/check-inbox.sh      asyncRewake: exit 2 wakes a working agent
  hooks/block-downgrade.sh  PreModelSwitch: fails closed by design

test/                   99 assertions across 9 files
docs/                   see below
```

---

## Design decisions, and why

| Decision | Rejected alternative | Why |
|---|---|---|
| MCP server inside the Router | separate process | parked calls must share the registry and webhook queue; splitting means inventing IPC for no gain |
| `Stop` hook calls `await_events` | instruct the agent to call it | an instruction survives twenty turns and then doesn't; a hook is structural |
| Enqueue to SQLite, then drain | resolve a waiting promise directly | an event landing between enqueue and registration would be lost; the queue is the source of truth, `notify()` is only a doorbell |
| Merge gate as `PreToolUse` | exclude the tool, or a settings `deny` | both kill the "when asked" path; a hook `allow` cannot loosen a settings deny |
| `git-receive-pack` proxy | a git credential helper | a helper never sees the refs — the credential is minted before git says what it intends to write |
| Comms ceiling in the hook | enforce inside the comms server | `PreToolUse` fires before permission checks, and a hook deny is visible to the model as feedback so it re-routes |
| One OS process per work item | Agent Teams | teammates roughly double token use and idle-vs-dead is ambiguous, which makes leads spawn duplicates |
| One session per work item | one long-lived agent for everything | compaction eventually destroys the oldest work |
| Teams one-way, answer on GitHub | two-way Graph subscriptions | posting needs delegated user-context auth an unattended agent doesn't have; and you already handle GitHub webhooks |
| In-process retry on transient failure | rely on GitHub retries | the ingress must 202 before routing, so GitHub never retries — a blip would swallow a real comment |

---

## Documentation

Start at **[docs/](docs/)** for the full index.

| | |
|---|---|
| [00 — Start smaller](docs/00-start-smaller.md) | Whether you need the Router at all, and what the Action gives you instead |
| [01 — Architecture](docs/01-architecture.md) | Components, the parking mechanism, the routing table, what is deliberately not used |
| [02 — Deployment](docs/02-deployment.md) | GitHub App, permissions, TLS, systemd, first webhook |
| [03 — Execution targets](docs/03-execution-targets.md) | process, dispatch, container, cloud — capabilities and limits |
| [04 — The merge gate](docs/04-merge-gate.md) | Why a hook, why not a deny rule, and how it fails |
| [05 — Comms](docs/05-comms.md) | Channel registry, scope vocabulary, writing a channel description |
| [06 — Configuration](docs/06-configuration.md) | The four tiers, plus a full key reference |
| [07 — Teams](docs/07-teams.md) | Workflows vs Teams MCP, and the delegated-auth problem |
| [08 — Security](docs/08-security.md) | Prompt injection, the push proxy, the guards and their order |
| [09 — Operations](docs/09-operations.md) | Failure modes, the CLI, what to watch |
| [10 — MCP tools](docs/10-mcp-tools.md) | The agent-facing tool reference |
| [11 — Hooks](docs/11-hooks.md) | Every hook in the overlay, what it returns, and why |
| [12 — Data model](docs/12-data-model.md) | Schema, state machine, queues, lifecycle |
| [13 — HTTP API](docs/13-http-api.md) | Every endpoint and the worker protocol |
| [14 — Development](docs/14-development.md) | Working on GQuay: conventions, tests, adding things |
| [15 — Glossary](docs/15-glossary.md) | Terms that mean something specific here |

---

## Status

Early, and honest about it.

The pieces that carry the design are implemented and tested: the parking lot, the routing table and linking rule, the merge gate, the push proxy, the comms ceiling, the four-tier config resolver, the four execution targets. 99 tests, plus a live check that a signed GitHub webhook wakes a parked MCP call in the same session in under two seconds.

Not yet exercised against a real GitHub App — the end-to-end run used a mock. `claude_cloud` needs a `launch_command` you supply, because there is no documented API for starting a web session from a third-party process and inventing an endpoint would be worse than admitting the gap.

**Build order, if you are extending it:**

1. Webhook → spawn → comment. Proves the loop.
2. Registry + linking. This is what makes it feel like one agent.
3. Merge gate. Add it *before* giving the agent write-heavy permissions, not after.
4. Teams mirrors. Start with three rows; add more as people ask.
5. Idle timers. Only meaningful once 2 works.
6. `asyncRewake` inbox. Last — mid-task delivery is a refinement over spawn-and-resume.

Steps 1–3 are a working system. If it stalls after 3, it still has value.

## Licence

MIT
