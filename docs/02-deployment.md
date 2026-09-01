# Deployment

> **Before anything here:** if you only want an agent that reads an issue and opens a pull request, you do not need any of this. Run `./setup.sh action` and stop. See [00-start-smaller](00-start-smaller.md).

GQuay needs a long-running host with a public HTTPS endpoint. That is the whole infrastructure requirement, and it is not negotiable — see [01-architecture](01-architecture.md) for why Actions cannot host it.

## The setup scripts

One front door, focused modules behind it. The hard part of setup is knowing *which* of four things you are setting up, on three different machines — so `./setup.sh` asks, then hands off.

```bash
./setup.sh              # interactive: asks what you are setting up
./setup.sh --list       # show the profiles without running anything
```

| Profile | Runs on | Needs root | What it does |
|---|---|---|---|
| `./setup.sh action` | any repo | no | Installs the GitHub Action workflow and its secret. No server at all |
| `./setup.sh secrets` | the Router host | no | Generates `.env`: webhook secret, hook bus token, agent credential, Teams URL |
| `./setup.sh router` | the Router host | yes | Build, install to `/opt/gquay`, systemd unit, then runs `doctor` |
| `./setup.sh worker` | a *different* machine | yes | Installs a dispatch worker that dials out to the Router |
| `./setup.sh doctor` | anywhere installed | no | Checks an existing install, changes nothing |

Every module also runs standalone and non-interactively, because two of them need root and root often means a provisioning pipeline rather than a person:

```bash
scripts/setup/action.sh  --repo owner/name --mode label --yes
scripts/setup/secrets.sh --yes
scripts/setup/router.sh  --prefix /opt/gquay --no-service --yes
scripts/setup/worker.sh  --router wss://host --labels internal-net --yes
```

`--yes` takes every default and never blocks on a prompt. It cannot invent a credential, so it warns and carries on rather than half-configuring something.

**What the scripts deliberately do not do:** create the GitHub App, create the Teams Workflow, or configure TLS. Each needs a decision only you can make, and each happens in a browser. The scripts print exactly what to do and wait — a setup script that pretends it can automate those is worse than one that stops and says so.

The manual walkthrough below is what `./setup.sh router` automates. Read it if you want to know what the script is doing, or if you are installing by hand.

## What the host needs

- **Inbound 443** for the GitHub webhook, terminated by nginx/Caddy/Cloudflare in front of the Router.
- **Outbound** to the Claude API, `api.github.com`, `github.com`, and your Teams Workflows URL.
- Node 20+, git, and Docker if you use the GitHub MCP server image or container targets.
- Disk for one worktree per concurrent work item, plus one bare mirror per repository.

---

## 1. The GitHub App

An App installation token, not a personal PAT. It is scoped per repository, expires in an hour, attributes actions to the App rather than a person, and — unlike the default Actions `GITHUB_TOKEN` — pushes made with it *do* trigger downstream workflows, so CI runs on the agent's commits.

Create the App at **Settings → Developer settings → GitHub Apps → New**.

**Repository permissions:**

| Permission | Level | Why |
|---|---|---|
| Contents | Read & write | clone, push to the agent's branch |
| Issues | Read & write | read the thread, comment, label |
| Pull requests | Read & write | open, review, merge |
| Actions | Read | read CI results |
| Metadata | Read | mandatory |

These are the **hard ceiling** on what any agent can do — beneath the MCP toolset, beneath the hooks. Grant nothing you do not use.

**Webhook:** URL `https://your-host/gquay/webhook`, secret = your `GITHUB_WEBHOOK_SECRET`, content type `application/json`.

**Subscribe to:** Issues, Issue comment, Pull request, Pull request review, Pull request review comment, Workflow run, Push.

Then **Install** the App on the repositories you want. The installation *is* the repo list — adding a repo to it is how the pipeline expands, and there is no list to maintain in config. `github.allowed_repos` in `router.yml` is a second, narrower perimeter on top.

Download the private key and put it where `github.private_key_path` points.

## 2. Branch protection

Protect the default branch and require an approving review.

This is the fail-safe backstop for the merge gate. The hook gate is the primary control, but if the Hook Bus is down or misconfigured, GitHub itself still refuses the merge. Belt and braces — and the braces are enforced by a system your organisation already administers.

## 3. Secrets

```bash
./scripts/gen-secrets.sh >> .env
chmod 600 .env
```

Fill in the agent credential and `TEAMS_WORKFLOW_URL`. See [06-configuration](06-configuration.md) for why these cannot live in GitHub Actions Secrets.

For the agent credential, set **exactly one** of:

- `CLAUDE_CODE_OAUTH_TOKEN` — run `claude setup-token`, approve in the browser, and copy the one-year token it prints. Backed by your Claude subscription; right for personal automation on your own repositories.
- `ANTHROPIC_API_KEY` — a Console key with its own billing and spend controls; right when GQuay serves a team.

Setting both is worse than setting neither: the API key silently wins and the subscription token is ignored. `gquay doctor` will tell you which one is actually in play. See [08-security](08-security.md#the-precedence-trap).

On auth choice: a Max-plan OAuth token works for personal automation, but this pipeline routes *other people's* requests through one person's seat and runs on shared infrastructure. Use a Console API key with its own billing and spend controls. Settle that before building.

## 4. router.yml

```bash
cp router.example.yml router.yml
```

At minimum set `public_url` and `github.app_id`. Everything else has a working default.

## 5. Check before you connect anything

```bash
node dist/cli.js doctor
```

It checks the things that otherwise fail silently for hours: a private key that never loaded, a `public_url` GitHub cannot reach, a missing hook overlay (without which there is no park loop and no merge gate), a dispatch target no worker can attach to, Teams enabled with no URL so notifications vanish, and — on Linux — whether the daemon is actually installed, enabled at boot and running.

## 6. Run it as a daemon

```bash
sudo ./setup.sh router
```

That installs the unit, enables it at boot, starts it, and reports whether it came up. There is no separate `systemctl enable --now` step — a Router that is installed but not running misses webhooks, and GitHub retries a delivery for a while and then gives up for good, so an install that stops one step short of a live daemon looks finished and is not.

```bash
systemctl status gquay        # running now, and at boot
journalctl -u gquay -f        # follow it
```

(`scripts/install.sh` still works and delegates here.)

Three settings in the unit are load-bearing rather than boilerplate:

- **`TimeoutStopSec=45`.** A session killed before `SessionEnd` runs leaves its agent-locks claim held and its worktree on disk, and nothing else cleans either up.
- **`ProtectHome=false`, with the home directory in `ReadWritePaths`.** Claude Code keeps its credential *and* its session transcripts under `$HOME/.claude`, and `--resume` reads those transcripts. With `ProtectHome=true` sessions fail to authenticate and every resume finds nothing. The directory is granted explicitly instead — the narrow version of what would otherwise be denied wholesale.
- **`ExecReload`.** `systemctl reload gquay` drops the cached repo config. GitHub emits **no webhook when an Actions Variable changes**, and a restart would kill every parked session, so this is how an edited `GQUAY_ENABLED` or `GQUAY_MODEL_MAP` is picked up. See [06-configuration](06-configuration.md).

`MemoryDenyWriteExecute` is deliberately absent: Node's JIT needs W+X pages and the unit will not start with it set.

A dispatch worker installs the same way, on its own machine — `sudo ./setup.sh worker --router wss://your-host` — and its unit carries the same `$HOME` and shutdown-grace reasoning.

## 7. First webhook

Label an issue `gquay` on an installed repository. Within a few seconds you should see, in order:

1. `webhook handled … outcome=spawn` in the journal,
2. a comment on the issue saying GQuay picked it up,
3. a Teams card if Teams is configured,
4. `session parked` once the agent finishes its first turn.

If nothing happens, check **Advanced → Recent Deliveries** on the App. A 401 is a secret mismatch; a 202 with no journal activity means the event was dropped by a guard — the trigger label, the bot guard, `allowed_repos`, or the actor lacking write access. All four log a line saying so.

---

## Dispatch workers

A worker runs where the code must stay. It **dials out**; nothing needs to reach it.

```bash
sudo ./setup.sh worker --router wss://gquay.example.com --labels windows,internal-net
```

That builds, installs to `/opt/gquay-worker`, copies the agent credential from this checkout, and writes the systemd unit. To run one by hand instead:

```bash
node dist/worker.js \
  --router wss://gquay.example.com/gquay/worker \
  --token "$GQUAY_WORKER_TOKEN_KINGSPAN" \
  --labels windows,internal-net \
  --capacity 2 \
  --workdir /var/lib/gquay-worker
``` The token must match the value of the target's `worker_token_env` on the Router. See [03-execution-targets](03-execution-targets.md).

---

## Upgrading

```bash
git pull && npm ci && npm run build && sudo systemctl restart gquay
```

Migrations run at boot and are append-only. On restart nothing survives — child processes died with the Router, and dispatch workers lost their control connection — so the Router reconciles: a row with a session id becomes `parked` (its transcript is intact and the next comment resumes it), and a row without one becomes `dead`.
