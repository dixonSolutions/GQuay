# Deployment

GQuay needs a long-running host with a public HTTPS endpoint. That is the whole infrastructure requirement, and it is not negotiable — see [01-architecture](01-architecture.md) for why Actions cannot host it.

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

Fill in `ANTHROPIC_API_KEY` and `TEAMS_WORKFLOW_URL`. See [06-configuration](06-configuration.md) for why these cannot live in GitHub Actions Secrets.

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

It checks the things that otherwise fail silently for hours: a private key that never loaded, a `public_url` GitHub cannot reach, a missing hook overlay (without which there is no park loop and no merge gate), a dispatch target no worker can attach to, Teams enabled with no URL so notifications vanish.

## 6. Run it

```bash
sudo ./scripts/install.sh
sudo systemctl enable --now gquay
journalctl -u gquay -f
```

The unit sets `TimeoutStopSec=45` deliberately: a session killed before `SessionEnd` runs leaves its agent-locks claim held and its worktree on disk, and nothing else cleans either up.

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
node dist/worker.js \
  --router wss://gquay.example.com/gquay/worker \
  --token "$GQUAY_WORKER_TOKEN_KINGSPAN" \
  --labels windows,internal-net \
  --capacity 2 \
  --workdir /var/lib/gquay-worker
```

`gquay-worker.service` is the systemd equivalent. The token must match the value of the target's `worker_token_env` on the Router. See [03-execution-targets](03-execution-targets.md).

---

## Upgrading

```bash
git pull && npm ci && npm run build && sudo systemctl restart gquay
```

Migrations run at boot and are append-only. On restart nothing survives — child processes died with the Router, and dispatch workers lost their control connection — so the Router reconciles: a row with a session id becomes `parked` (its transcript is intact and the next comment resumes it), and a row without one becomes `dead`.
