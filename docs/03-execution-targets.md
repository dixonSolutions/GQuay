# Execution targets

The Router is the control plane. Where a session actually *runs* is a separate, pluggable decision.

| Kind | Runs where | Parks | Use when |
|---|---|---|---|
| `process` | on the Router host | yes | default |
| `dispatch` | a worker machine that dials out | yes | code that must not leave a network |
| `container` | Docker/Podman | yes | untrusted repos, dependency isolation, parallelism |
| `claude_cloud` | Claude Code web sandbox | **no** | throwaway tasks, no local environment needed |

`parking` is the property that actually separates them. A target that can hold an `await_events` call for hours keeps one session alive across many GitHub events.

Targets are defined in `router.yml`, not in a repository's `gquay.yml`. A target names a machine and a token; a repository that could choose its own target could choose to run on a box it was never granted. Only the *routing rules* are repo-influenced, and a repo's `preferred_target` is honoured only if the target already exists.

A work item is **pinned** to its target for life. A worktree on a Kingspan worker does not exist anywhere else, so a resumed session has to go home.

---

## `process`

One OS process per work item on the Router host. The default, and the one to reach for unless something specific rules it out.

The session id is lifted off the `stream-json` output rather than guessed. Everything downstream — resume, the registry, `--resume` on a parked item — depends on capturing it.

Termination is SIGTERM with a 10-second grace, then SIGKILL. The grace exists so `SessionEnd` can run: that hook releases the agent-locks claim and triggers worktree GC, and losing it leaks state.

## `dispatch`

A worker **dials out** to the Router and holds the connection open. The Router never initiates a connection to a worker.

This matters more than it looks. A corporate build server has no inbound path from your host, and nobody is opening one. Because the worker dials out, the only thing needing a public address is the Router — which already has one for the webhook.

```
worker  ──TLS──▶  Router /gquay/worker
   ├─ hello    { token, worker_id, labels, capacity, os, shell }
   ├─ receive  { spawn work_item, model, branch, scopes, session_token }
   ├─ stream   { state, session_id, output, exit }
   ├─ hook     { method, path, body } → { status, body }
   └─ inbox    { line }              ← asyncRewake delivery, pushed down
```

### Hooks ride the control connection

They have to. The Hook Bus binds to loopback on the Router host — hook responses block tool calls, and the merge gate must never queue behind a webhook retry storm — and on a worker machine, loopback is not the Router.

So the worker runs its own loopback listener and forwards each `/hooks/*` request over the socket it already holds open. No second firewall rule, and the privileged hook surface is never exposed publicly.

Three things the tunnel does not trust:

- **The path.** The agent picks the hook URL, so only `/hooks/<name>` is forwarded. Anything else would hand a session the Router's whole loopback API.
- **The bearer.** The Router's real Hook Bus token never leaves the Router; sending it to every worker would put a Router-wide credential on a machine inside someone else's network. Each session gets a random token for the worker's own listener, and **identity comes from that token** — the `X-GQuay-Work-Item` header is ignored, so one session cannot answer a hook as another.
- **The work item.** The Router checks it against the worker assignment table, so one worker cannot answer for a session running on another.

When the control connection is down, a hook is refused immediately rather than waiting out the round-trip ceiling: `PreToolUse` holds a tool call open, and thirty seconds of silence for an answer that was never coming is thirty seconds of stalled agent. That failure is safe — a `PreToolUse` hook that renders no decision falls through to the `ask` permission the overlay keeps under `merge_pull_request`, so a dead bus degrades to *no merge*, never to *free merge*.

**This is what makes `Parks: yes` true for dispatch.** Parking is a `Stop` hook. Without the tunnel a worker session has no hooks at all — no park, no merge gate, no issue/PR linking, no lock release — and looks like it is working right up until it matters.

The mid-task inbox travels the same way, in the other direction. The asyncRewake hook reads a file, and on this target that file is on the worker, so the Router pushes the line down instead of writing one nothing will ever read.

MCP is dialled directly at the Router's public MCP endpoint with the session's bearer, since the worker already has outbound access to it.

### What you rebuild, and what you gain

Almost everything a cloud session gives you can be rebuilt on a dispatch worker, and the pieces that cannot are the ones you do not want.

| Cloud session provides | Dispatch equivalent |
|---|---|
| Fresh managed VM per session | Container per work item, or a worktree under a dedicated user |
| Clone via a connected account | `git worktree add` from a local bare mirror — faster, no clone-rate concerns, works offline |
| Setup script (~5 min cap), snapshot cached ~1 week | Prebuilt image + persistent cache volume. You set the TTL, and there is no cap |
| Network proxy with a domain allowlist | Egress allowlist on the container network — same threat model, your policy |
| Credentials never enter the VM; pushes go through a branch-scoped proxy | **Copy this exactly.** The Router sends the proxy URL with the spawn and the worker sets it worktree-locally. See [08-security](08-security.md) |
| VM destroyed at session end | `teardown: on_session_end` plus the Router's GC. Needs an explicit reaper — nothing cleans up for you |

And you gain what the cloud cannot give: the local environment — internal APIs, licensed toolchains, a database with realistic data, a warm build cache — plus parking.

## `container`

Same lifecycle as `process`, different blast radius.

The egress allowlist is the point. A container network reaching only the Claude API, the Router, and whatever the build needs is the same threat model as the cloud sandbox's domain proxy, except the policy is yours. `network:` names a network **you** created; the Router does not create it, because a network it could create is a network it could misconfigure under load.

The worktree is mounted read-write and the session config read-only. The config carries that session's bearer tokens, and nothing in the container has any reason to rewrite it.

Termination uses `docker stop --time 15`, which sends SIGTERM and waits so `SessionEnd` can run. Killing the local `docker run` client would orphan the container.

## `claude_cloud`

The weakest target, and still useful for a self-contained issue on a public repo when every local slot is busy.

**It cannot park.** A cloud session runs in an ephemeral managed VM, created at session start and destroyed at the end, with an environment snapshot that expires after roughly a week. A tool call held open for hours is not a safe bet against that lifecycle, and the sandbox cannot reach a private network in any case.

So it runs **fire-and-forget**: spawn per event, work, push to its branch, exit. Every subsequent comment is a fresh spawn or a `--resume`. The Router enforces this rather than hoping for it — `parking` is forced to `false` at config load even if you set it true.

The sandbox also cannot resolve private, internal or link-local addresses, so `public_url` must be genuinely public HTTPS and in the session's network allowlist. `available()` refuses to pretend otherwise, and `doctor` flags it.

There is no documented API for launching a web session from a third-party process, so the launch is delegated to a `launch_command` you configure. That keeps this target honest: it orchestrates, it does not invent an endpoint.
