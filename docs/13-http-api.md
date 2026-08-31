# HTTP API

Two listeners, deliberately separate.

**The public server** (`server.port`, default 8080) takes the GitHub webhook, the MCP connection, the dispatch worker socket and the git push proxy. Put a TLS terminator in front of it.

**The Hook Bus** (`server.hook_bus_port`, default 8787) binds loopback only. It is separate because hook responses are latency-sensitive — they block tool calls, and a merge gate must never queue behind a webhook retry storm.

---

## Public server

### `GET /healthz`

Unauthenticated. `{"ok": true}`.

### `GET /gquay/status`

`Authorization: Bearer $HOOK_BUS_TOKEN`.

```jsonc
{
  "parked_calls": 3,
  "parked_keys": ["issue:acme/widgets#42", "pr:acme/widgets#87"],
  "workers": 1,
  "targets": [
    { "name": "local", "kind": "process", "parking": true, "used": 2, "max": 3 }
  ],
  "work_items": [
    { "key": "issue:acme/widgets#42", "state": "idle", "model": "claude-opus-5",
      "target": "local", "branch": "gquay/issue-42", "linked": "pr:acme/widgets#87",
      "last_activity": "2026-09-01 04:11:22" }
  ]
}
```

`parked_calls` and `workers` exist only in memory, which is why `gquay status` asks the Router rather than reading the database.

### `POST /gquay/webhook`

The GitHub ingress. Headers: `X-GitHub-Event`, `X-GitHub-Delivery`, `X-Hub-Signature-256`.

| Response | Meaning |
|---|---|
| `202` | accepted; routing continues after the response |
| `200 {"deduped": true}` | this delivery id has already been processed |
| `401` | signature missing, malformed, or wrong |
| `400` | missing delivery headers |

**The signature is verified over the raw bytes.** Parsing JSON and re-serialising changes whitespace and key order and the HMAC will never match, so the ingress keeps the raw buffer via a custom content-type parser. The comparison is constant-time, including the length-mismatch path — bailing early on a length difference is itself a timing signal.

**Why 202 before routing.** GitHub's delivery timeout is short and spawning a session is not. The consequence is that GitHub will never retry this delivery, so a transient failure would silently drop a real comment — which is why the Router retries in-process with backoff (2s, 10s, 30s) and alerts to Teams when it gives up.

### `POST /gquay/refresh`

`Authorization: Bearer $HOOK_BUS_TOKEN`. Drops every cached repo config.

Exists because a change to an Actions Variable emits no webhook. A change to `.github/gquay.yml` does, and is handled automatically.

### `ALL /mcp`

MCP Streamable HTTP. `Authorization: Bearer <session mcp_token>`.

`POST` without `mcp-session-id` initialises a session: the Router looks up the work item by bearer, builds a per-session `McpServer`, and returns `mcp-session-id`. Later requests carry that header.

| Response | Meaning |
|---|---|
| `401` | missing or unknown bearer |
| `400` | `mcp-session-id` names a session that does not exist |
| `403` | the session id and the bearer disagree — refused rather than served |

The transport owns the response stream from here, including the long-lived stream a parked `await_events` depends on. Fastify's `reply.hijack()` hands it over.

### `GET /gquay/worker` (WebSocket)

The dispatch worker socket. See the protocol below.

### `ALL /git/:token/*`

The branch-scoped push proxy. Path shape:

```
/git/<session-mcp-token>/<owner>/<repo>.git/<service>
```

Fetches (`git-upload-pack`) pass through. Pushes (`git-receive-pack`, POST) are parsed first.

| Response | Meaning |
|---|---|
| `401` | unknown or expired session token |
| `403` | the session is scoped to a different repo, or the push targets a forbidden ref |
| `400` | the ref updates could not be read, so they could not be checked |
| *(upstream)* | forwarded verbatim once authorised |

Errors come back as a **pkt-line the git client prints**, so the agent sees why it was refused. A silent refusal teaches it nothing.

See [08-security](08-security.md) for why this is a proxy and not a credential helper.

---

## Hook Bus

Loopback only. Every endpoint requires `Authorization: Bearer $HOOK_BUS_TOKEN` (constant-time compared) and reads identity from `X-GQuay-Work-Item` — **not** from the payload.

| Endpoint | Hook event | Returns |
|---|---|---|
| `GET /healthz` | — | `{ ok, parked }` |
| `POST /hooks/session-start` | `SessionStart` | `additionalContext` |
| `POST /hooks/turn-end` | `Stop` (async) | `{}` |
| `POST /hooks/merge-gate` | `PreToolUse` | `permissionDecision` |
| `POST /hooks/comms-gate` | `PreToolUse` | `permissionDecision` |
| `POST /hooks/edit-guard` | `PreToolUse` | `permissionDecision` |
| `POST /hooks/github-write` | `PostToolUse` (async) | `{}` |
| `POST /hooks/needs-input` | `Notification` | `{}` |
| `POST /hooks/agent-error` | `StopFailure` | `{}` |
| `POST /hooks/pre-compact` | `PreCompact` | `additionalContext` |
| `POST /hooks/session-end` | `SessionEnd` | `{}` |

Full behaviour of each: [11-hooks](11-hooks.md).

### Example: the merge gate

```bash
curl -s -X POST http://127.0.0.1:8787/hooks/merge-gate \
  -H "Authorization: Bearer $HOOK_BUS_TOKEN" \
  -H "X-GQuay-Work-Item: pr:acme/widgets#87" \
  -H "content-type: application/json" \
  -d '{"hook_event_name":"PreToolUse","tool_name":"mcp__github__merge_pull_request"}'
```

```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",
 "permissionDecisionReason":"Merge requires an explicit request. Ask on the pull request thread, and a maintainer with write access must reply \"@gquay merge\"."}}
```

---

## The dispatch worker protocol

The worker **dials out** and holds the connection open. The Router never initiates a connection to a worker — that is the entire reason this target exists.

```
worker  ──TLS──▶  Router /gquay/worker
```

### Worker → Router

```jsonc
{ "type": "hello", "token": "…", "worker_id": "buildbox-1",
  "labels": ["windows", "internal-net"], "capacity": 2, "os": "win32", "shell": "powershell" }

{ "type": "state",  "work_item": "issue:acme/x#42", "state": "working", "session_id": "…" }
{ "type": "output", "work_item": "issue:acme/x#42", "stream": "stdout", "line": "…" }
{ "type": "exit",   "work_item": "issue:acme/x#42", "code": 0, "signal": null }
{ "type": "mcp",    "id": "…", "work_item": "…", "payload": {} }   // MCP tunnelled home
{ "type": "pong" }
```

### Router → worker

```jsonc
{ "type": "welcome", "heartbeat_ms": 30000, "worker_id": "buildbox-1" }
{ "type": "reject",  "reason": "unknown worker token" }

{ "type": "spawn", "work_item": "issue:acme/x#42", "repo": "acme/x", "number": 42,
  "model": "claude-opus-5", "branch": "gquay/issue-42", "prompt": "…",
  "mcp_token": "…", "mcp_url": "https://…/mcp", "github_token": "…",
  "scopes": ["notes:post"], "resume_session_id": null,
  "provision": { "isolation": "worktree", "setup": ".gquay/setup.ps1",
                 "teardown": "on_session_end" } }

{ "type": "kill", "work_item": "issue:acme/x#42", "reason": "issue closed" }
{ "type": "mcp_result", "id": "…", "payload": {} }
{ "type": "ping" }
```

### Rules

**`hello` must come first.** Anything else on an unauthenticated socket closes it with 1008.

**The token identifies a target.** It is compared in constant time against the values of every dispatch target's `worker_token_env`, read from the host environment at boot. A worker proving possession of one is proving it was provisioned by whoever runs the host.

**Work items are sticky to a worker.** The worktree exists only there, so `WorkerRegistry` pins the assignment and a resumed session goes back to the same machine.

**A reconnect replaces the stale entry.** The old socket is dead by definition; leaving two entries would double-count capacity.

**A lost worker orphans its sessions.** They are marked `dead` and released from the parking lot, but stay pinned so they resume where their worktree is.

**MCP is proxied over this connection**, not dialled separately — one outbound connection per worker, no extra firewall rule, and the parked call rides a socket that is already heartbeated (30s).

### Running one

```bash
node dist/worker.js \
  --router wss://gquay.example.com/gquay/worker \
  --token "$GQUAY_WORKER_TOKEN_KINGSPAN" \
  --labels windows,internal-net \
  --capacity 2 \
  --workdir /var/lib/gquay-worker
```

Reconnects with exponential backoff capped at 60s. A `reject` stops it rather than retrying — a bad token will still be bad in a minute.
