#!/usr/bin/env bash
#
# A dispatch worker.
#
# Runs on a DIFFERENT machine from the Router — that is the whole point of the
# target. The worker dials out; nothing needs to reach it, so no inbound
# firewall rule and no public address.
#
#   sudo scripts/setup/worker.sh --router wss://gquay.example.com --labels internal-net
#
# The token must match the value of that target's worker_token_env on the
# Router. Get it from the Router's .env.

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

ROOT="$(repo_root)"
PREFIX="${PREFIX:-/opt/gquay-worker}"
SERVICE_USER="${SERVICE_USER:-gquay}"
WORKDIR="${WORKDIR:-/var/lib/gquay-worker}"
ROUTER_URL=""
LABELS=""
CAPACITY="2"
TOKEN=""
INSTALL_SERVICE=1

while [ $# -gt 0 ]; do
  case "$1" in
    --router)   ROUTER_URL="$2"; shift 2 ;;
    --labels)   LABELS="$2"; shift 2 ;;
    --capacity) CAPACITY="$2"; shift 2 ;;
    --token)    TOKEN="$2"; shift 2 ;;
    --prefix)   PREFIX="$2"; shift 2 ;;
    --user)     SERVICE_USER="$2"; shift 2 ;;
    --workdir)  WORKDIR="$2"; shift 2 ;;
    --no-service) INSTALL_SERVICE=0; shift ;;
    --yes|-y)   GQUAY_YES=1; shift ;;
    *) die "unknown argument: $1" ;;
  esac
done

need node
need git
need npm
node_major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$node_major" -ge 20 ] || die "Node 20+ required; found $(node --version)"

step "Dispatch worker setup"
note "This machine dials out to the Router. Nothing needs to reach it."

[ -n "$ROUTER_URL" ] || ROUTER_URL="$(ask "Router URL (wss://host)" "")"
[ -n "$ROUTER_URL" ] || die "--router is required"
[[ "$ROUTER_URL" == wss://* || "$ROUTER_URL" == ws://* ]] || \
  warn "expected a wss:// URL — ws:// sends the worker token in the clear"

[ -n "$LABELS" ] || LABELS="$(ask "Labels this worker advertises (comma separated)" "internal-net")"

if [ -z "$TOKEN" ]; then
  if [ "$GQUAY_YES" = "1" ]; then
    warn "--yes: no token given. Put GQUAY_WORKER_TOKEN in $PREFIX/.env before starting."
  else
    note "From the Router's .env — the value of that target's worker_token_env."
    TOKEN="$(ask "Worker token" "")"
  fi
fi

# ── Build ─────────────────────────────────────────────────────────────────────

step "Building"
# Build with devDependencies present — tsup and typescript live there. Running
# `npm ci --omit=dev` here would strip the very tools the build needs; the
# production-only install happens at the destination, after dist/ exists.
build_log="$(mktemp)"
# Test for the build tool, not for node_modules. A checkout where someone has
# already run `npm ci --omit=dev` has a node_modules directory and no tsup in
# it, and "directory exists" would sail straight past that into a confusing
# "tsup: not found".
if [ ! -x "$ROOT/node_modules/.bin/tsup" ]; then
  ( cd "$ROOT" && npm ci ) >"$build_log" 2>&1 || {
    tail -20 "$build_log" >&2; rm -f "$build_log"
    die "npm ci failed in $ROOT"
  }
fi
( cd "$ROOT" && npm run build ) >"$build_log" 2>&1 || {
  tail -20 "$build_log" >&2; rm -f "$build_log"
  die "build failed in $ROOT"
}
rm -f "$build_log"
ok "built"

# ── Install ───────────────────────────────────────────────────────────────────

if [ "$INSTALL_SERVICE" = "1" ]; then
  [ "$(id -u)" -eq 0 ] || die "Installing the service needs root. Re-run with sudo, or pass --no-service."

  step "Installing to $PREFIX"
  id "$SERVICE_USER" >/dev/null 2>&1 || \
    useradd --system --create-home --shell /usr/sbin/nologin "$SERVICE_USER"

  mkdir -p "$PREFIX" "$WORKDIR"
  if have rsync; then
    rsync -a --exclude node_modules --exclude .git --exclude data \
      --exclude worktrees --exclude mirrors --exclude .env "$ROOT/" "$PREFIX/"
  else
    ( cd "$ROOT" && tar --exclude=node_modules --exclude=.git --exclude=data \
        --exclude=worktrees --exclude=mirrors --exclude=.env -cf - . ) \
      | ( cd "$PREFIX" && tar -xf - )
  fi
  ( cd "$PREFIX" && npm ci --omit=dev >/dev/null 2>&1 ) || die "dependency install failed"
  ok "files installed"

  # The worker needs the agent credential too — it spawns the sessions.
  ENV_FILE="$PREFIX/.env"
  touch "$ENV_FILE"; chmod 600 "$ENV_FILE"
  [ -n "$TOKEN" ] && set_env "$ENV_FILE" GQUAY_WORKER_TOKEN "$TOKEN"
  for key in CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY; do
    val="$(get_env "$ROOT/.env" "$key")"
    [ -n "$val" ] && { set_env "$ENV_FILE" "$key" "$val"; ok "copied $key from this checkout"; }
  done
  if [ -z "$(get_env "$ENV_FILE" CLAUDE_CODE_OAUTH_TOKEN)" ] && \
     [ -z "$(get_env "$ENV_FILE" ANTHROPIC_API_KEY)" ]; then
    warn "No agent credential in $ENV_FILE — sessions here will fail to authenticate."
    note "Set CLAUDE_CODE_OAUTH_TOKEN (from \`claude setup-token\`) or ANTHROPIC_API_KEY."
  fi

  chown -R "$SERVICE_USER:$SERVICE_USER" "$PREFIX" "$WORKDIR"

  step "systemd"

  # $HOME must be real and writable — Claude Code stores its credential and the
  # session transcripts `--resume` reads under $HOME/.claude.
  USER_HOME="$(getent passwd "$SERVICE_USER" | cut -d: -f6)"
  [ -n "$USER_HOME" ] || USER_HOME="/home/$SERVICE_USER"
  mkdir -p "$USER_HOME"
  chown "$SERVICE_USER:$SERVICE_USER" "$USER_HOME"

  sed -e "s|/opt/gquay-worker|$PREFIX|g" \
      -e "s|/var/lib/gquay-worker|$WORKDIR|g" \
      -e "s|User=gquay|User=$SERVICE_USER|" \
      -e "s|/home/gquay|$USER_HOME|g" \
      -e "s|wss://gquay.example.com/gquay/worker|${ROUTER_URL%/}/gquay/worker|" \
      -e "s|--labels internal-net|--labels $LABELS|" \
      -e "s|--capacity 2|--capacity $CAPACITY|" \
      "$ROOT/gquay-worker.service" > /etc/systemd/system/gquay-worker.service
  chmod 644 /etc/systemd/system/gquay-worker.service
  systemctl daemon-reload
  ok "gquay-worker.service installed"

  systemctl enable gquay-worker >/dev/null 2>&1 && ok "enabled at boot"
  if systemctl restart gquay-worker && sleep 2 && systemctl is-active --quiet gquay-worker; then
    ok "gquay-worker.service is running"
  else
    warn "gquay-worker.service is not active — see: journalctl -u gquay-worker -n 50"
  fi

  step "Ready"
  say "  systemctl status gquay-worker    # running now, and at boot"
  say "  journalctl -u gquay-worker -f    # follow it"
  say ""
  note "On the Router, confirm it attached:  gquay status  → \"workers\": 1"
else
  step "Run it"
  say "  node dist/worker.js \\"
  say "    --router ${ROUTER_URL%/}/gquay/worker \\"
  say "    --labels $LABELS --capacity $CAPACITY \\"
  say "    --workdir $WORKDIR"
  say ""
  note "Export GQUAY_WORKER_TOKEN, and an agent credential, first."
fi

say ""
note "The Router also needs a matching target in router.yml:"
say "    kingspan-win:"
say "      kind: dispatch"
say "      labels: [${LABELS//,/, }]"
say "      worker_token_env: GQUAY_WORKER_TOKEN_KINGSPAN"
