# Configuration

Config lives in GitHub wherever GitHub can actually serve it. One hard constraint decides the split:

> **Actions *secrets* cannot be read back.** The REST API lists secrets in an org or repo without revealing their values — by design. Only a workflow runtime can decrypt one. **Variables are different**: stored in the clear, visible in the UI, readable through the API.

The Router is a standalone process, not an Actions job. So it can read Variables and can never read Secrets. That asymmetry produces four tiers.

```
label on item  >  repo Variable  >  repo gquay.yml  >  org Variable  >  built-in default
```

---

## Tier 1 — Runner-local secrets

| Value | Why here |
|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` | the agent credential; unreadable from GitHub, needed at spawn |
| GitHub App private key | bootstraps GitHub access itself |
| `TEAMS_WORKFLOW_URL` | the `sig` query parameter is a credential |
| `HOOK_BUS_TOKEN` | local only |
| `GITHUB_WEBHOOK_SECRET` | must be known before any GitHub call is trusted |
| `GQUAY_WORKER_TOKEN_*` | one per dispatch target |

An env file with `0600`, or a real secret manager. If you also run Actions workflows that need these, keep GitHub Secrets holding copies — but treat GitHub as a sync target, never the source of truth. A value you cannot read back is a value you cannot recover.

## Tier 2 — GitHub Variables: operational knobs

Readable via `GET /repos/{owner}/{repo}/actions/variables` and the org equivalent, with org values inherited and repo values overriding. The right home for anything an admin should flip without opening a PR.

| Variable | Scope | Example |
|---|---|---|
| `GQUAY_ENABLED` | repo | `false` — instant kill switch |
| `GQUAY_DEFAULT_MODEL` | org | `claude-opus-5` |
| `GQUAY_TRIGGER_LABEL` | repo | `gquay` |
| `GQUAY_IDLE_NUDGE_MINUTES` | org | `20` |
| `GQUAY_IDLE_PARK_HOURS` | org | `24` |

Two operational notes. GitHub emits **no webhook when a variable changes**, so the Router reads them with ETag-conditional requests and caches the result; `POST /gquay/refresh` (or `gquay refresh`) drops the cache. And `GQUAY_ENABLED=false` is checked at *event receipt*, not only at spawn, so flipping it stops new work immediately while letting running sessions finish.

### JSON inside a variable

Technically fine — a variable holds up to 48 KB and the Router reads it as a plain string through the API. The shell-quoting hazards people warn about only bite when a workflow interpolates `${{ vars.X }}` into a `run:` block, which this does not.

The problems are editorial, not technical: no schema validation on write, no diff, no blame, no review; the audit log records *that* a variable changed, not *what* changed inside it; no webhook on change; and editing nested JSON in a settings textarea is miserable for exactly the admin the tier was meant to serve.

So: **JSON in variables for flat overlays, the file for structure.**

```jsonc
// GQUAY_MODEL_MAP
{"v":1,"default":"claude-opus-5","label:model-sonnet":"claude-sonnet-5"}

// GQUAY_SCOPE_OVERRIDES — temporarily mute a channel without a PR
{"v":1,"notes":[],"decisions":["post","ask"]}

// GQUAY_QUIET_HOURS
{"v":1,"tz":"Australia/Sydney","window":"18:00-08:00","exempt":["incidents"]}
```

Five rules, all enforced in `src/router/repoConfig.ts`:

1. **Version the payload** (`"v":1`) so the Router rejects a shape it does not understand rather than misreading it.
2. **One variable per concern**, never one config blob. Smaller blast radius, and the textarea stays editable.
3. **Overlay, do not replace.** Variable JSON merges *on top of* file config, so a malformed variable degrades to file config rather than to no config.
4. **Validate on read, keep last-known-good.** On a parse failure: log, alert to Teams, keep serving the previous value. Never fail open to "no restrictions" — a broken `GQUAY_SCOPE_OVERRIDES` must not become unlimited scopes.
5. **No secrets, ever.** Variables are visible in the UI and in logs, and log masking is best-effort anyway.

## Tier 3 — `.github/gquay.yml`

Everything structural: the notification matrix, the channel registry, per-label model overrides, the prompt preamble, guardrails, protected paths. Read through the Contents API at the default branch.

Why a file beats Variables here: it is versioned, reviewable in a PR, has blame history, supports nesting a flat key-value store does not — and a change arrives as a `push` webhook, so no polling. The Router watches for `.github/gquay.yml` in a push's changed paths and invalidates its cache. This is the pattern Dependabot, CodeQL and Renovate all use, so it is already familiar.

**The dividing line:** Variables for values a non-developer flips under pressure; the file for anything that deserves review.

## Tier 4 — Labels on the item

Labels and assignees are configuration too, and they are the cheapest possible interface — someone changes agent behaviour by clicking a label.

```
model:sonnet        override the model for this issue only
gquay:no-teams      suppress channel mirrors for a noisy item
gquay:read-only     investigate and comment, never push
gquay:quiet         strip post/ask everywhere but notes
gquay:sandbox       route to the container target
gquay:cloud         route to the cloud target
priority:high       shorter idle thresholds
area:<name>         declares the scope used for the pre-spawn conflict check
```

## Settings and keys as controls

Three pieces of GitHub configuration do real work here and are not config files at all:

- **The App installation** defines which repos are in scope. Adding a repo to it is how the pipeline expands.
- **App permissions** are the hard ceiling on what any agent can do, beneath the MCP toolset and beneath the hooks.
- **Branch protection** on the default branch is the fail-safe backstop for the merge gate.

## The audit line

The resolved config is written into every session's opening prompt and repeated as `SessionStart` context:

```
Config resolved from: default → org-variables → gquay.yml → repo-variables → labels.
Model: claude-opus-5. Comms scopes: notes:post decisions:post decisions:ask.
```

Every transcript therefore records what the agent was actually running under, which is the only way to answer "why did it do that" a week later.

---

# Reference

## `router.yml` — host configuration

Validated by `RouterConfigSchema` in `src/config.ts`. Cross-field checks run at load, so a bad target or a routing rule pointing nowhere fails at boot rather than at the first spawn.

### Top level

| Key | Default | Notes |
|---|---|---|
| `public_url` | *required* | The origin GitHub delivers webhooks to, and that a cloud sandbox must be able to reach. Must be public HTTPS |

### `server`

| Key | Default | Notes |
|---|---|---|
| `port` | `8080` | Ingress + MCP + worker socket + push proxy. Put TLS in front |
| `host` | `0.0.0.0` | |
| `hook_bus_port` | `8787` | Loopback only — hook responses block tool calls |
| `hook_bus_host` | `127.0.0.1` | Do not expose this |

### `paths`

All resolved to absolute at load, so nothing downstream depends on the working directory.

| Key | Default |
|---|---|
| `data` | `./data` — SQLite, generated session configs |
| `worktrees` | `./worktrees` |
| `mirrors` | `./mirrors` — bare mirrors, one per repo |
| `inbox` | `./data/inbox` — asyncRewake files |
| `runner` | `./runner` — where the hook overlay template lives |

### `github`

| Key | Default | Notes |
|---|---|---|
| `app_id` | — | |
| `private_key_path` | — | Falls back to `GITHUB_APP_PRIVATE_KEY` in the environment |
| `allowed_repos` | `["*"]` | The hard perimeter, checked before anything else. `owner/*` globs span one path segment |
| `api_base` | `https://api.github.com` | |

### `runner`

| Key | Default | Notes |
|---|---|---|
| `default` | `local` | Must name a defined target |
| `claude_bin` | `claude` | |
| `max_concurrent_total` | `8` | Ceiling across every target |
| `targets` | *required* | See below |

### `runner.targets.<name>`

| Key | Applies to | Notes |
|---|---|---|
| `kind` | all | `process` \| `dispatch` \| `container` \| `claude_cloud` |
| `max_concurrent` | all | Default `3` |
| `labels` | dispatch | A worker must advertise all of them |
| `parking` | all | Default `true`; **forced to `false`** for `claude_cloud` |
| `workdir` | process | |
| `shell` | dispatch | |
| `image` | container | Required — validated at load |
| `network` | container | A network you created, with its own egress allowlist |
| `engine` | container | `docker` (default) or `podman` |
| `worker_token_env` | dispatch | Env var holding the shared token. Missing value fails at load |
| `launch_command` | claude_cloud | argv with `{{repo}}`, `{{branch}}`, `{{model}}`, `{{work_item}}`, `{{mcp_config}}`, `{{settings}}` |
| `provision` | dispatch | `isolation`, `mirror`, `setup`, `cache.{paths,key,ttl}`, `teardown` |

### `routing`

An ordered list; first match wins, unmatched falls back to `runner.default`.

```yaml
routing:
  - match: { repo: "kingspan/*" }     # repo | owner | label
    target: kingspan-win
  - match: {}
    target: local
```

### `idle`

| Key | Default | Notes |
|---|---|---|
| `idle_grace_minutes` | `10` | |
| `nudge_after_minutes` | `20` | `awaiting_input` only |
| `escalate_after_minutes` | `120` | `awaiting_input` only |
| `park_after_hours` | `24` | Terminate an idle session to free the slot |
| `park_timeout_seconds` | `540` | `await_events` window. Keep below the `Stop` hook's own timeout |

### `merge`, `coordination`, `teams`

| Key | Default |
|---|---|
| `merge.approval_ttl_minutes` | `15` |
| `merge.approval_phrase` | `@gquay merge` |
| `coordination.on_conflict` | `notify` — `notify` \| `queue` \| `read_only` \| `proceed` |
| `coordination.stale_lock_after_hours` | `6` |
| `coordination.normalise_case` | `true` — leave on if any Windows worker shares a repo with a Linux one |
| `teams.enabled` | `true` |
| `teams.workflow_url_env` | `TEAMS_WORKFLOW_URL` |
| `teams.thread_per_work_item` | `true` |
| `teams.severity_floor` | `info` — drops anything lower before it leaves the process |

---

## `.github/gquay.yml` — repository configuration

Validated by `RepoConfigSchema` in `src/router/repoConfig.ts`. Parsed as a deep partial, so a file may set only what it overrides.

| Key | Default | Notes |
|---|---|---|
| `enabled` | `true` | |
| `trigger_label` | `gquay` | |
| `model.default` | `claude-opus-5` | |
| `model.overrides` | `{}` | Keyed `label:<name>` → model id |
| `scopes` | `[]` | Extra grants beyond those implied by the channel registry |
| `channels` | `{}` | See below. **No channel is granted by default** |
| `teams.thread_per_work_item` | `true` | |
| `teams.events` | `{}` | `{ notify, severity, mention?, budget? }` per event name |
| `coordination.on_conflict` | `notify` | |
| `coordination.scope_source` | `labels` | `labels` \| `paths_in_issue` \| `agent_declares` |
| `coordination.stale_lock_after` | `6h` | |
| `idle.idle_grace` | `10m` | |
| `idle.nudge_after` | `20m` | |
| `idle.escalate_after` | `2h` | |
| `idle.park_after` | `24h` | |
| `preamble` | `""` | Prepended to every spawn prompt — repo-specific house rules |
| `guardrails.protected_paths` | `[]` | Wins over any lock state |
| `guardrails.merge_requires_approval` | `true` | |
| `guardrails.max_files_changed` | — | |
| `routing.preferred_target` | — | A *request*, honoured only if the target exists |

### `channels.<key>`

| Key | Default | Notes |
|---|---|---|
| `name` | *required* | The display name, e.g. `#gquay-needs-you` |
| `description` | `""` | **This is a prompt.** See [05-comms](05-comms.md#writing-a-channel-description) |
| `do_not_use_for` | `""` | Name the better channel |
| `attention_cost` | `low` | `none` \| `low` \| `high` \| `critical` |
| `urgency_floor` | `low` | `low` \| `normal` \| `high` \| `critical` |
| `scopes` | `[]` | Capabilities from the vocabulary below. Unknown entries are dropped with a warning, never granted |
| `rate_limit` | — | `6/hour`, `2/min`, `30/day` |
| `threading` | `flat` | `per_work_item` \| `flat` |
| `quiet_hours` | — | `18:00-08:00 Australia/Sydney`. Windows may wrap midnight |

Capabilities: `mirror`, `post`, `reply`, `ask`, `read`, `mention.assignee`, `mention.owner`, `mention.channel`, `attach`, `escalate`, `override_quiet_hours`.

### Durations and rates

Durations are `\d+(s|m|h|d)` — `90s`, `20m`, `2h`, `7d`. Unparseable values fall back to the built-in default rather than to zero.

Rates are `<n>/(min|hour|day)`. Unparseable means no limit.

---

## Environment — Tier 1

| Variable | Required | Notes |
|---|---|---|
| `GITHUB_WEBHOOK_SECRET` | **yes** | Must match the App's webhook secret |
| `HOOK_BUS_TOKEN` | **yes** | Bearer for the loopback hook listener |
| `CLAUDE_CODE_OAUTH_TOKEN` | one of these two | Subscription-backed, from `claude setup-token`. One-year lifetime |
| `ANTHROPIC_API_KEY` | one of these two | A Console key with its own spend controls. **Outranks the token above** — set only one |
| `GITHUB_APP_PRIVATE_KEY` | if not using `private_key_path` | |
| `TEAMS_WORKFLOW_URL` | if Teams is enabled | The whole URL is a credential |
| `GQUAY_WORKER_TOKEN_*` | per dispatch target | Named by that target's `worker_token_env` |
| `GQUAY_LOG_LEVEL` | no | `trace` … `silent` |
| `GQUAY_CONFIG` | no | Path to `router.yml` |
| `GQUAY_ROOT` | no | Base for relative paths |

---

## Actions Variables — Tier 2

Scalars: `GQUAY_ENABLED`, `GQUAY_TRIGGER_LABEL`, `GQUAY_DEFAULT_MODEL`, `GQUAY_IDLE_NUDGE_MINUTES`, `GQUAY_IDLE_PARK_HOURS`.

JSON overlays, all requiring `"v":1`:

| Variable | Shape |
|---|---|
| `GQUAY_MODEL_MAP` | `{"v":1,"default":"…","label:model-sonnet":"…"}` |
| `GQUAY_SCOPE_OVERRIDES` | `{"v":1,"notes":[],"decisions":["post","ask"]}` |
| `GQUAY_QUIET_HOURS` | `{"v":1,"tz":"…","window":"18:00-08:00","exempt":["incidents"]}` |

A malformed overlay is logged, alerted, and ignored — the previous value keeps serving. It never fails open.

---

## Labels — Tier 4

| Label | Effect |
|---|---|
| `gquay` | The trigger label (configurable) |
| `model:opus` \| `model:sonnet` \| `model:haiku` | Model for this item only |
| `gquay:read-only` | Investigate and comment; every scope but `notes:post` is stripped |
| `gquay:quiet` | Strips `post` and `ask` everywhere but `notes` |
| `gquay:no-teams` | Turns off every notification row |
| `gquay:sandbox` \| `gquay:cloud` | Route to that target |
| `priority:high` | `nudge_after` → 5m, `escalate_after` → 30m |
| `area:<name>` | Declares `<name>/**` as the scope for the pre-spawn conflict check |
