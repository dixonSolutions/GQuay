#!/usr/bin/env bash
#
# Credentials and .env.
#
# Runs standalone or from ./setup.sh. Idempotent: existing values are kept
# unless you say otherwise, so re-running after adding a repo is safe.
#
#   scripts/setup/secrets.sh [--env-file PATH] [--yes]

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

ROOT="$(repo_root)"
ENV_FILE="$ROOT/.env"

while [ $# -gt 0 ]; do
  case "$1" in
    --env-file) ENV_FILE="$2"; shift 2 ;;
    --yes|-y)   GQUAY_YES=1; shift ;;
    *) die "unknown argument: $1" ;;
  esac
done

step "Credentials → $ENV_FILE"

[ -f "$ENV_FILE" ] || { cp "$ROOT/.env.example" "$ENV_FILE"; ok "created from .env.example"; }
chmod 600 "$ENV_FILE"

# ── Shared secrets ────────────────────────────────────────────────────────────
# Generated, never chosen. The webhook secret must also be pasted into the
# GitHub App; the hook bus token never leaves loopback.

for key in GITHUB_WEBHOOK_SECRET HOOK_BUS_TOKEN; do
  existing="$(get_env "$ENV_FILE" "$key")"
  if [ -n "$existing" ]; then
    ok "$key already set"
  else
    set_env "$ENV_FILE" "$key" "$(random_secret)"
    ok "$key generated"
  fi
done

# ── Agent credential ──────────────────────────────────────────────────────────
# Exactly one. Claude Code ranks ANTHROPIC_API_KEY above CLAUDE_CODE_OAUTH_TOKEN
# and uses the key unconditionally under -p, so having both set means the
# subscription token is silently ignored and every session bills to the Console
# org. See docs/08-security.md.

existing_oauth="$(get_env "$ENV_FILE" CLAUDE_CODE_OAUTH_TOKEN)"
existing_key="$(get_env "$ENV_FILE" ANTHROPIC_API_KEY)"

if [ -n "$existing_oauth" ] && [ -n "$existing_key" ]; then
  warn "Both CLAUDE_CODE_OAUTH_TOKEN and ANTHROPIC_API_KEY are set."
  note "The API key wins and the subscription token is ignored. Keep one."
  if confirm "Remove ANTHROPIC_API_KEY and use the subscription?" y; then
    tmp="$(mktemp)"; grep -vE '^ANTHROPIC_API_KEY=' "$ENV_FILE" > "$tmp"
    cat "$tmp" > "$ENV_FILE"; rm -f "$tmp"; chmod 600 "$ENV_FILE"
    ok "ANTHROPIC_API_KEY removed"
  fi
elif [ -n "$existing_oauth" ]; then
  ok "agent credential: Claude subscription (CLAUDE_CODE_OAUTH_TOKEN)"
elif [ -n "$existing_key" ]; then
  ok "agent credential: Console API key (ANTHROPIC_API_KEY)"
else
  say ""
  say "  Which credential should agent sessions use?"
  say "    1) Claude subscription — Pro/Max/Team/Enterprise. Right for your own repos."
  say "    2) Console API key     — own billing and spend controls. Right when it serves a team."
  choice="$(ask "1 or 2" "1")"

  if [ "$choice" = "2" ]; then
    key="$(ask "Paste your Console API key (sk-ant-…)" "")"
    if [ -n "$key" ]; then
      set_env "$ENV_FILE" ANTHROPIC_API_KEY "$key"
      ok "ANTHROPIC_API_KEY set"
    else
      warn "left blank — set ANTHROPIC_API_KEY in $ENV_FILE before starting"
    fi
  else
    if have claude && [ "$GQUAY_YES" != "1" ] && confirm "Run \`claude setup-token\` now?" y; then
      say ""
      note "A browser will open. Approve, then copy the token it prints."
      claude setup-token || warn "setup-token did not complete"
      say ""
    else
      note "Run \`claude setup-token\` in another terminal — it prints a one-year token."
    fi
    tok="$(ask "Paste the token" "")"
    if [ -n "$tok" ]; then
      set_env "$ENV_FILE" CLAUDE_CODE_OAUTH_TOKEN "$tok"
      ok "CLAUDE_CODE_OAUTH_TOKEN set"
    else
      warn "left blank — set CLAUDE_CODE_OAUTH_TOKEN in $ENV_FILE before starting"
    fi
  fi
fi

# ── Teams (optional) ──────────────────────────────────────────────────────────

if [ -z "$(get_env "$ENV_FILE" TEAMS_WORKFLOW_URL)" ]; then
  if confirm "Set up Teams notifications now?" n; then
    manual "Create the Workflow in Teams:" \
      "1. In the target channel: ⋯ → Workflows → 'When a Teams webhook request is received'" \
      "2. Add the action 'Post card in a chat or channel'" \
      "3. Save, then copy the trigger URL" \
      "" \
      "Add a co-owner while you are there. A Workflow is owned by a person," \
      "not a channel, and orphans silently when they leave."
    url="$(ask "Paste the Workflow URL" "")"
    [ -n "$url" ] && { set_env "$ENV_FILE" TEAMS_WORKFLOW_URL "$url"; ok "TEAMS_WORKFLOW_URL set"; }
  else
    note "Skipped. Set teams.enabled: false in router.yml, or fill this in later."
  fi
else
  ok "TEAMS_WORKFLOW_URL already set"
fi

chmod 600 "$ENV_FILE"
step "Done."
note "$ENV_FILE is mode 600 and gitignored. It is the only copy of these values."
