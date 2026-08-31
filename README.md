# GQuay

**GQuay** (pronounced "Gee Q-ay") — a GitHub-driven Claude Code agent system.

GitHub issues and pull requests are the work queue. Each work item is owned by exactly one agent session. Microsoft Teams is the human-facing channel. Everything is one long-running process you host yourself.

```
   GitHub ──webhook──▶ GQuay Router ──spawn──▶ Claude Code session (one per work item)
       ▲                    │  ▲                        │
       │                    │  └────── MCP ─────────────┘   await_events parks here
       └──── agent posts ───┘         (parked call)
                            │
                            └──▶ Teams (a doorbell, not a conversation)
```

---

## The fact that shapes the whole design

"Hooks" means two different things here, and conflating them is the failure mode:

| | Direction | Mechanism |
|---|---|---|
| **GitHub → agent** | inbound | GitHub App **webhooks**, landing on a process you run |
| **Agent → world** | outbound | Claude Code **hooks** (lifecycle events) |

Claude Code hooks fire on *its* lifecycle — session start, tool call, turn end, idle. Nothing external can raise one directly, so a webhook does not "fire a hook."

But an MCP tool call is itself a lifecycle point, and an MCP server is a long-lived process that can simply *not return* from a tool call until something happens. The agent calls `gquay__await_events`, the server parks the call, and when the GitHub webhook arrives the call returns with the comment as its result. Same session, same context window, no restart — and `PostToolUse` fires on the way out. A **virtual hook**, triggered from outside.

The limit that survives is narrower and more useful than "you can't reach a live session":

> **An agent is reachable at the points where it yields to a tool, not at arbitrary instants.**

An agent parked in `await_events` is reachable immediately. An agent three files into a refactor is not — it isn't in the call. GQuay covers both: the blocking call for the parked case, an `asyncRewake` inbox hook for the working case.

This is why GitHub Actions cannot host it. A workflow run is a fresh container per event with no live process to park a tool call in — no idle state, no session continuity. GQuay assumes a **long-running host** with inbound 443 for the webhook and outbound to the Claude API, GitHub and Teams.

---

## What it does

- **One session per work item.** `issue:owner/repo#42` gets a session, a git worktree and a branch. Nothing else touches them.
- **The linking rule.** When the agent working an issue opens a PR, that PR is registered against the *same session*. Comments on either thread route to the same process, so it behaves like one agent that owns both.
- **Parking instead of polling.** A finished turn parks in `await_events` and costs no tokens until something happens. Structural, not discretionary: a `Stop` hook makes the call, so an agent cannot forget to.
- **A merge gate that holds under `bypassPermissions`.** The agent *can* merge, but only after a maintainer with write access posts the approval phrase on that specific PR, within a TTL, once.
- **Branch-scoped pushes.** The agent's `origin` points at a proxy that reads the ref updates out of the `git-receive-pack` request and refuses anything that isn't its own branch. It never holds a credential that can write to `main`.
- **Four execution targets.** On the Router host, on a worker machine that dials out from inside a private network, in a container, or on the Claude Code cloud sandbox.
- **Teams as a doorbell.** The agent picks the cheapest channel adequate to its message, from a registry that describes each channel by *the reader's obligation*. Saying nothing is an explicit, encouraged option.

---

## Quick start

```bash
git clone https://github.com/dixonSolutions/GQuay.git
cd GQuay && npm install && npm run build
```

```bash
cp router.example.yml router.yml && cp .env.example .env && ./scripts/gen-secrets.sh
```

Edit `router.yml` (`public_url`, `github.app_id`) and `.env`, then:

```bash
node dist/cli.js doctor
```

`doctor` checks the things that otherwise fail silently for hours: a private key that never loaded, a `public_url` GitHub can't reach, a missing hook overlay, a dispatch target no worker can attach to.

```bash
npm start
```

Full setup — the GitHub App, the Teams Workflow, TLS — is in [docs/02-deployment.md](docs/02-deployment.md).

---

## How a work item flows

1. Someone labels an issue `gquay`.
2. The Router checks the actor has **write access**, resolves the model and comms scopes from four config tiers, cuts a worktree from a local bare mirror, and spawns a session.
3. The session posts a comment on the issue so progress is visible where the work is.
4. It works. Its `origin` push URL only accepts `gquay/issue-42`.
5. It opens a PR. A `PostToolUse` hook tells the Router, which links the PR to the same session.
6. It finishes its turn. The `Stop` hook parks it in `await_events`. Zero tokens.
7. A reviewer comments. The webhook lands, the parked call returns with the comment, the agent continues — same context window.
8. A maintainer posts `@gquay merge`. The Router verifies their permission level against the GitHub API and sets a 15-minute single-use flag.
9. The agent calls the merge tool. The `PreToolUse` gate consults the registry, allows it once, and burns the approval.

---

## Documentation

| | |
|---|---|
| [01 — Architecture](docs/01-architecture.md) | Components, the parking mechanism, the routing table, what is deliberately not used |
| [02 — Deployment](docs/02-deployment.md) | GitHub App, TLS, systemd, first webhook |
| [03 — Execution targets](docs/03-execution-targets.md) | process, dispatch, container, cloud — and what each can and cannot do |
| [04 — The merge gate](docs/04-merge-gate.md) | Why it is a hook, why not a deny rule, and how it fails |
| [05 — Comms](docs/05-comms.md) | The channel registry, the scope vocabulary, writing a channel description |
| [06 — Configuration](docs/06-configuration.md) | The four tiers, and why secrets cannot live in GitHub |
| [07 — Teams](docs/07-teams.md) | Workflows vs the Teams MCP server, and the delegated-auth problem |
| [08 — Security](docs/08-security.md) | Prompt injection, the push proxy, the guards and their order |
| [09 — Operations](docs/09-operations.md) | Failure modes, the CLI, what to watch |

---

## Project layout

```
src/
  index.ts            boot
  server.ts           ingress + MCP + worker socket + push proxy
  cli.ts              gquay status | doctor | items | show | terminate
  worker.ts           dispatch worker — dials out to the Router
  config.ts           router.yml + Tier 1 secrets
  git.ts              bare mirrors, worktrees
  state/              registry, event queue, delivery dedupe, asyncRewake inbox
  github/             App auth, REST client, webhook HMAC, event normalisation
  router/             routing table, spawn, prompts, merge gate, push proxy, idle
  mcp/                the parking lot, tools, comms registry, agent-locks, framing
  hooks/              the Hook Bus
  runners/            the four execution targets
  teams/              Workflows relay, Adaptive Cards
runner/
  settings.json       the hook overlay — the park loop and the merge gate live here
  hooks/              check-inbox.sh (asyncRewake), block-downgrade.sh
```

---

## Status

Early. The pieces that carry the design — the parking lot, the routing table, the merge gate, the push proxy, the scope ceiling — are implemented and tested, including a live check that a signed GitHub webhook wakes a parked MCP call in the same session.

Build order, if you are working on it: webhook → spawn → comment, then the registry and the linking rule, then the merge gate. Those three are a working system.

## Licence

MIT
