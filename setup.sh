#!/usr/bin/env bash
#
# GQuay setup — the front door.
#
# There are four different things you might be setting up, on three different
# machines, and the hard part is knowing which one you want. So this asks, then
# hands off to a focused module under scripts/setup/.
#
# Every module also runs standalone and non-interactively, because two of them
# need root and root often means a provisioning pipeline rather than a person:
#
#   scripts/setup/action.sh   --repo owner/name --mode label --yes
#   scripts/setup/secrets.sh  --yes
#   scripts/setup/router.sh   --prefix /opt/gquay --yes
#   scripts/setup/worker.sh   --router wss://host --labels internal-net --yes
#
#   ./setup.sh                 interactive
#   ./setup.sh action          skip the menu
#   ./setup.sh --list          show the profiles
#   ./setup.sh router --yes    non-interactive, take every default

source "$(dirname "${BASH_SOURCE[0]}")/scripts/setup/lib.sh"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROFILE=""
PASSTHROUGH=()

while [ $# -gt 0 ]; do
  case "$1" in
    action|secrets|router|worker|doctor) PROFILE="$1"; shift ;;
    --list|-l) PROFILE="list"; shift ;;
    --help|-h) PROFILE="help"; shift ;;
    --yes|-y) GQUAY_YES=1; export GQUAY_YES; PASSTHROUGH+=("--yes"); shift ;;
    *) PASSTHROUGH+=("$1"); shift ;;
  esac
done

show_profiles() {
  cat <<'TXT'

  action    The GitHub Action. No server, no public URL, no database.
            Installs a workflow into a repository and sets the secret.
            → Start here. See docs/00-start-smaller.md.

  secrets   Generate .env for this checkout: webhook secret, hook bus
            token, agent credential, optional Teams URL.

  router    The Router host. Build, install to /opt/gquay, systemd unit.
            Needs root, a host that stays up, and a public HTTPS endpoint.

  worker    A dispatch worker, on a machine that is NOT the Router.
            It dials out, so nothing needs to reach it.

  doctor    Check an existing install without changing anything.

TXT
}

case "$PROFILE" in
  list|help)
    say "${BOLD}GQuay setup${RESET}"
    show_profiles
    say "  Usage: ./setup.sh [action|secrets|router|worker|doctor] [--yes]"
    say ""
    exit 0
    ;;
  doctor)
    exec node "$ROOT/dist/cli.js" doctor
    ;;
  action|secrets|router|worker)
    exec bash "$ROOT/scripts/setup/$PROFILE.sh" "${PASSTHROUGH[@]+"${PASSTHROUGH[@]}"}"
    ;;
esac

# ── Interactive ───────────────────────────────────────────────────────────────

say ""
say "${BOLD}GQuay setup${RESET}"
say ""

# Report what already exists, so re-running is obviously safe.
if [ -f "$ROOT/.env" ];       then ok ".env present";       else note "no .env yet"; fi
if [ -f "$ROOT/router.yml" ]; then ok "router.yml present"; else note "no router.yml yet"; fi
if [ -d "$ROOT/dist" ];       then ok "built";              else note "not built yet"; fi

say ""
say "  The question that decides this:"
say ""
say "    ${BOLD}Do your issues get resolved in one pass, or become conversations?${RESET}"
say ""
say "  One pass    → the Action. No infrastructure at all."
say "  Conversations → the Router. It keeps an agent alive between comments"
say "                  with its context intact. That is the only thing it buys."
say ""
note "docs/00-start-smaller.md has the row-by-row comparison."
show_profiles

choice="$(ask "Which? (action/secrets/router/worker/doctor)" "action")"

case "$choice" in
  action|secrets|router|worker)
    exec bash "$ROOT/scripts/setup/$choice.sh" "${PASSTHROUGH[@]+"${PASSTHROUGH[@]}"}"
    ;;
  doctor)
    [ -d "$ROOT/dist" ] || { step "Building first"; ( cd "$ROOT" && npm run build >/dev/null ); }
    exec node "$ROOT/dist/cli.js" doctor
    ;;
  *)
    die "unknown profile: $choice  (try ./setup.sh --list)"
    ;;
esac
