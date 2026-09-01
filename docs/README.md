# GQuay documentation

**Start with [00 — Start smaller](00-start-smaller.md).** It answers whether you need the Router at all — for a lot of use cases you do not, and the official GitHub Action is a better fit.

After that: [01 — Architecture](01-architecture.md) to understand the system, or [02 — Deployment](02-deployment.md) to run it.

## Deciding

| | |
|---|---|
| **[00 — Start smaller](00-start-smaller.md)** | The GitHub Action versus the Router, what each can and cannot do, and the single question that decides between them |

## Understanding it

| | |
|---|---|
| **[01 — Architecture](01-architecture.md)** | Components, the parking mechanism, the routing table, coordination between agents, and what the design deliberately does not use |
| **[12 — Data model](12-data-model.md)** | The registry schema, the state machine, the event queue, and what deliberately isn't in the database |
| **[15 — Glossary](15-glossary.md)** | Terms that mean something specific here |

## Running it

| | |
|---|---|
| **[02 — Deployment](02-deployment.md)** | GitHub App setup and permissions, branch protection, secrets, systemd, the first webhook |
| **[03 — Execution targets](03-execution-targets.md)** | `process`, `dispatch`, `container`, `claude_cloud` — what each can and cannot do |
| **[06 — Configuration](06-configuration.md)** | The four tiers, the Variables contract, and a full key reference |
| **[07 — Teams](07-teams.md)** | Workflows vs the Teams MCP server, and the delegated-auth problem that decides it |
| **[09 — Operations](09-operations.md)** | Failure modes, the CLI, idle handling, what to watch |

## The controls

| | |
|---|---|
| **[04 — The merge gate](04-merge-gate.md)** | Why a hook and not a deny rule, how approval is granted, how it fails |
| **[05 — Comms](05-comms.md)** | The channel registry, the scope vocabulary, writing a channel description that works |
| **[08 — Security](08-security.md)** | Prompt injection, the push proxy, every guard and the order they run in |

## Reference

| | |
|---|---|
| **[10 — MCP tools](10-mcp-tools.md)** | The seven tools an agent can call, with response shapes |
| **[11 — Hooks](11-hooks.md)** | Every hook in the overlay: what it matches, what it returns, why it exists |
| **[13 — HTTP API](13-http-api.md)** | Every endpoint on both listeners, plus the dispatch worker protocol |
| **[14 — Development](14-development.md)** | Conventions, where things live, how to add an event / tool / target / config key |

---

## If you only read three things

**[The parking mechanism](01-architecture.md#the-parking-mechanism)** — why a webhook can reach a live agent at all, and the two implementation details (drain-then-park, and the two timeouts) that make it hold.

**[The merge gate](04-merge-gate.md)** — the clearest example of the pattern the whole security posture uses: `PreToolUse` denies hold under `bypassPermissions`, so policy can be tightened past what permissions allow but never loosened.

**[Writing a channel description](05-comms.md#writing-a-channel-description)** — the difference between a Teams integration people read and one they mute in a week is entirely in these four sentences per channel.

---

## Common questions

**Why can't this run on GitHub Actions?**
A workflow run is a fresh container per event. There is no live process to park a tool call in, so no session continuity and no idle state. [01](01-architecture.md)

**How does a webhook reach an agent that's already running?**
Three ways, in descending fidelity: it resolves a parked `await_events` call (same context window), it lands in an inbox file that an `asyncRewake` hook reads between tool batches, or it triggers `--resume`. [01](01-architecture.md), [11](11-hooks.md)

**What stops an agent merging whatever it likes?**
A `PreToolUse` hook, which fires before any permission-mode check. Approval is per-PR, permission-checked against the GitHub API, TTL-bounded and single-use — with branch protection as the backstop. [04](04-merge-gate.md)

**What stops an agent pushing to `main`?**
Its `origin` push URL points at a proxy that reads the ref updates out of the push and refuses anything that isn't its own branch. It never holds a credential that can write to the default branch. [08](08-security.md)

**What stops a malicious issue body taking over the agent?**
Layered: only actors with write access are acted on at all; untrusted text can never set the merge flag; and delivered text is framed with the author's real permission level in a container it cannot close. [08](08-security.md)

**Why can't secrets live in GitHub?**
The REST API lists Actions secrets without revealing their values, by design — only a workflow runtime can decrypt one, and the Router is not a workflow. Variables are readable, which is why the config model splits the way it does. [06](06-configuration.md)

**Why does Teams only go one way?**
Posting to Teams needs delegated, user-context Graph permissions that an unattended agent does not have. And you already have a perfectly good inbound channel: GitHub comments, which arrive as webhooks you are handling anyway. [07](07-teams.md)

**Do I need the Router just to get an agent to open a pull request?**
No. Use the official GitHub Action — no host, no public URL, no database. The Router earns its keep only when issues turn into multi-round conversations. [00](00-start-smaller.md)

**Can two agents work the same file?**
They have separate worktrees, so they cannot overwrite each other. Contradictory work is handled by agent-locks claims, checked before spawn and enforced by a `PreToolUse` hook. [01](01-architecture.md#coordination-between-agents)
