#!/usr/bin/env bash
#
# The smallest path: the official GitHub Action, no Router at all.
#
# Installs a workflow into a repository and sets the credential secret. No
# server, no public URL, no database. See docs/00-start-smaller.md for whether
# this is enough for you — for a lot of use cases it is.
#
#   scripts/setup/action.sh [--repo owner/name] [--mode mention|label] [--yes]

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

ROOT="$(repo_root)"
REPO=""
MODE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --mode) MODE="$2"; shift 2 ;;
    --yes|-y) GQUAY_YES=1; shift ;;
    *) die "unknown argument: $1" ;;
  esac
done

need gh "Install from https://cli.github.com"
gh auth status >/dev/null 2>&1 || die "gh is not authenticated. Run: gh auth login"

step "GitHub Action setup"

# Default to the repo in the current directory, if there is one.
if [ -z "$REPO" ]; then
  detected="$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || true)"
  REPO="$(ask "Repository (owner/name)" "$detected")"
fi
[ -n "$REPO" ] || die "no repository given"
gh repo view "$REPO" >/dev/null 2>&1 || die "cannot see $REPO — check the name and your gh auth"
ok "repository: $REPO"

# ── 1. The Claude GitHub App ──────────────────────────────────────────────────

manual "Install the Claude GitHub App on $REPO:" \
  "https://github.com/apps/claude" \
  "" \
  "It needs Contents, Issues and Pull requests (read & write)." \
  "If you already installed it for another repo, just add this one."

# ── 2. The credential secret ──────────────────────────────────────────────────

existing="$(gh secret list --repo "$REPO" 2>/dev/null | awk '{print $1}' || true)"

if grep -qx "CLAUDE_CODE_OAUTH_TOKEN" <<<"$existing"; then
  ok "CLAUDE_CODE_OAUTH_TOKEN already set on $REPO"
  SECRET_INPUT="claude_code_oauth_token"
elif grep -qx "ANTHROPIC_API_KEY" <<<"$existing"; then
  ok "ANTHROPIC_API_KEY already set on $REPO"
  SECRET_INPUT="anthropic_api_key"
else
  say ""
  say "  Which credential should the Action use?"
  say "    1) Claude subscription (CLAUDE_CODE_OAUTH_TOKEN)"
  say "    2) Console API key     (ANTHROPIC_API_KEY)"
  choice="$(ask "1 or 2" "1")"

  if [ "$choice" = "2" ]; then
    SECRET_NAME="ANTHROPIC_API_KEY"; SECRET_INPUT="anthropic_api_key"
  else
    SECRET_NAME="CLAUDE_CODE_OAUTH_TOKEN"; SECRET_INPUT="claude_code_oauth_token"
    # Reuse the Router's token if this checkout already has one.
    reuse="$(get_env "$ROOT/.env" CLAUDE_CODE_OAUTH_TOKEN)"
    if [ -n "$reuse" ] && confirm "Reuse the token from .env?" y; then
      printf '%s' "$reuse" | gh secret set "$SECRET_NAME" --repo "$REPO"
      ok "$SECRET_NAME set on $REPO"
      SECRET_NAME=""
    elif have claude && [ "$GQUAY_YES" != "1" ] && confirm "Run \`claude setup-token\` now?" y; then
      claude setup-token || warn "setup-token did not complete"
    fi
  fi

  if [ -n "${SECRET_NAME:-}" ]; then
    if [ "$GQUAY_YES" = "1" ]; then
      warn "--yes: cannot prompt for a secret. Set it with: gh secret set $SECRET_NAME --repo $REPO"
    else
      # `gh secret set` reads stdin, so the value is never in argv or history.
      say ""
      note "Paste the value and press ctrl-D:"
      gh secret set "$SECRET_NAME" --repo "$REPO" && ok "$SECRET_NAME set on $REPO"
    fi
  fi
fi

# ── 3. The workflow ───────────────────────────────────────────────────────────

if [ -z "$MODE" ]; then
  say ""
  say "  How should it trigger?"
  say "    1) @claude mentions on issues and PRs        (interactive)"
  say "    2) label an issue 'claude' → get a PR        (automation)"
  say "    3) both"
  MODE="$(ask "1, 2 or 3" "1")"
fi

install_workflow() {
  local src="$1" dest=".github/workflows/$2"
  mkdir -p .github/workflows
  if [ -f "$dest" ] && ! confirm "$dest exists. Overwrite?" n; then
    note "kept existing $dest"
    return
  fi
  sed "s/claude_code_oauth_token: \${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}/${SECRET_INPUT}: \${{ secrets.$( [ "$SECRET_INPUT" = "anthropic_api_key" ] && echo ANTHROPIC_API_KEY || echo CLAUDE_CODE_OAUTH_TOKEN ) }}/" \
    "$ROOT/examples/minimal-action/$src" > "$dest"
  ok "wrote $dest"
}

case "$MODE" in
  1|mention) install_workflow claude.yml claude.yml ;;
  2|label)   install_workflow label-to-pr.yml claude-label.yml ;;
  3|both)    install_workflow claude.yml claude.yml
             install_workflow label-to-pr.yml claude-label.yml ;;
  *) die "unknown mode: $MODE" ;;
esac

if [[ "$MODE" =~ ^(2|3|label|both)$ ]]; then
  if gh label create claude --repo "$REPO" --color 6b46c1 \
       --description "GQuay: hand this issue to Claude" 2>/dev/null; then
    ok "created the 'claude' label"
  else
    note "'claude' label already exists"
  fi
fi

step "Next"
say "  1. Commit and push the workflow file(s)."
say "  2. Comment '@claude implement this' on an issue, or add the 'claude' label."
say ""
note "No server, no public URL, no database. If you later need an agent that"
note "stays alive across comments, see docs/00-start-smaller.md."
