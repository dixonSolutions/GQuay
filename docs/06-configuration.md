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
| `ANTHROPIC_API_KEY` | unreadable from GitHub; needed at spawn |
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
