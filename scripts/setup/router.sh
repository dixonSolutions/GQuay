#!/usr/bin/env bash
#
# The Router host: build, install, systemd.
#
# Needs root. Does NOT create the GitHub App, the Teams Workflow, or the TLS
# terminator — each needs a decision only you can make, and a script that
# pretends otherwise is worse than one that stops and says so.
#
#   sudo scripts/setup/router.sh [--prefix /opt/gquay] [--user gquay] [--yes]

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

ROOT="$(repo_root)"
PREFIX="${PREFIX:-/opt/gquay}"
SERVICE_USER="${SERVICE_USER:-gquay}"
INSTALL_SERVICE=1

while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) PREFIX="$2"; shift 2 ;;
    --user)   SERVICE_USER="$2"; shift 2 ;;
    --no-service) INSTALL_SERVICE=0; shift ;;
    --yes|-y) GQUAY_YES=1; shift ;;
    *) die "unknown argument: $1" ;;
  esac
done

need node "Node 20+ required."
need git
need npm

node_major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$node_major" -ge 20 ] || die "Node 20+ required; found $(node --version)"

if [ "$INSTALL_SERVICE" = "1" ] && [ "$(id -u)" -ne 0 ]; then
  die "Installing the service needs root. Re-run with sudo, or pass --no-service to build in place."
fi

# ── 1. Prerequisites you have to decide ───────────────────────────────────────

step "Before the install"

manual "Create the GitHub App:" \
  "Settings → Developer settings → GitHub Apps → New" \
  "" \
  "Repository permissions:" \
  "  Contents       read & write   clone, push to the agent's branch" \
  "  Issues         read & write   read the thread, comment, label" \
  "  Pull requests  read & write   open, review, merge" \
  "  Actions        read           read CI results" \
  "  Metadata       read           mandatory" \
  "" \
  "Webhook URL:    https://<your-host>/gquay/webhook" \
  "Webhook secret: the GITHUB_WEBHOOK_SECRET from your .env" \
  "" \
  "Subscribe to: Issues, Issue comment, Pull request, Pull request review," \
  "              Pull request review comment, Workflow run, Push" \
  "" \
  "Then Install it on the repositories you want, and download the private key." \
  "These permissions are the hard ceiling on what any agent can do — grant" \
  "nothing you do not use."

manual "Protect the default branch:" \
  "Require an approving review on the repositories you installed it on." \
  "" \
  "This is the fail-safe behind the merge gate. If the Hook Bus is down or" \
  "misconfigured, GitHub itself still refuses the merge."

# ── 2. Build ──────────────────────────────────────────────────────────────────

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

# ── 3. Install ────────────────────────────────────────────────────────────────

if [ "$INSTALL_SERVICE" = "1" ]; then
  step "Installing to $PREFIX"

  if ! id "$SERVICE_USER" >/dev/null 2>&1; then
    useradd --system --create-home --shell /usr/sbin/nologin "$SERVICE_USER"
    ok "created service user $SERVICE_USER"
  else
    ok "service user $SERVICE_USER exists"
  fi

  mkdir -p "$PREFIX"
  if have rsync; then
    rsync -a --delete-after \
      --exclude node_modules --exclude .git --exclude data \
      --exclude worktrees --exclude mirrors --exclude .env --exclude router.yml \
      "$ROOT/" "$PREFIX/"
  else
    # tar is everywhere; rsync is not.
    ( cd "$ROOT" && tar --exclude=node_modules --exclude=.git --exclude=data \
        --exclude=worktrees --exclude=mirrors --exclude=.env --exclude=router.yml \
        -cf - . ) | ( cd "$PREFIX" && tar -xf - )
  fi
  ok "files copied"

  ( cd "$PREFIX" && npm ci --omit=dev >/dev/null 2>&1 ) || die "dependency install failed in $PREFIX"
  mkdir -p "$PREFIX"/{data,worktrees,mirrors,data/inbox}
  chown -R "$SERVICE_USER:$SERVICE_USER" "$PREFIX"
  ok "runtime directories created"
else
  PREFIX="$ROOT"
  note "--no-service: configuring in place at $PREFIX"
fi

# ── 4. Config ─────────────────────────────────────────────────────────────────

step "Configuration"

if [ ! -f "$PREFIX/router.yml" ]; then
  say ""
  say "  Which profile?"
  say "    1) minimal — one local target, no Teams, no workers. Steps 1-3 of the build order."
  say "    2) full    — every target and option, commented. Edit down from here."
  profile="$(ask "1 or 2" "1")"
  if [ "$profile" = "2" ]; then
    cp "$ROOT/router.example.yml" "$PREFIX/router.yml"
    ok "router.yml from router.example.yml"
  else
    cp "$ROOT/examples/minimal-router/router.yml" "$PREFIX/router.yml"
    ok "router.yml from the minimal profile"
  fi

  url="$(ask "Public HTTPS URL GitHub will deliver webhooks to" "")"
  [ -n "$url" ] && sed -i.bak "s|^public_url:.*|public_url: $url|" "$PREFIX/router.yml" && rm -f "$PREFIX/router.yml.bak"
  app_id="$(ask "GitHub App ID" "")"
  [ -n "$app_id" ] && sed -i.bak "s|^  app_id:.*|  app_id: \"$app_id\"|" "$PREFIX/router.yml" && rm -f "$PREFIX/router.yml.bak"
  [ "$INSTALL_SERVICE" = "1" ] && chown "$SERVICE_USER:$SERVICE_USER" "$PREFIX/router.yml"
else
  ok "router.yml already present — left alone"
fi

if [ ! -f "$PREFIX/.env" ]; then
  GQUAY_YES="$GQUAY_YES" bash "$ROOT/scripts/setup/secrets.sh" --env-file "$PREFIX/.env"
  [ "$INSTALL_SERVICE" = "1" ] && chown "$SERVICE_USER:$SERVICE_USER" "$PREFIX/.env"
else
  ok ".env already present — left alone"
fi

manual "Put the App private key where router.yml points:" \
  "  $PREFIX/gquay-app.private-key.pem" \
  "" \
  "chmod 600 it and chown it to $SERVICE_USER."

# ── 5. Service ────────────────────────────────────────────────────────────────

if [ "$INSTALL_SERVICE" = "1" ]; then
  step "systemd"

  # $HOME must be a real writable directory: Claude Code keeps its credential
  # and its session transcripts under $HOME/.claude, and `--resume` reads them.
  USER_HOME="$(getent passwd "$SERVICE_USER" | cut -d: -f6)"
  [ -n "$USER_HOME" ] || USER_HOME="/home/$SERVICE_USER"
  mkdir -p "$USER_HOME"
  chown "$SERVICE_USER:$SERVICE_USER" "$USER_HOME"

  sed "s|/opt/gquay|$PREFIX|g; s|User=gquay|User=$SERVICE_USER|; s|/home/gquay|$USER_HOME|g" \
    "$ROOT/gquay.service" > /etc/systemd/system/gquay.service
  chmod 644 /etc/systemd/system/gquay.service
  systemctl daemon-reload
  ok "gquay.service installed"

  # Enable and start it here rather than printing the command. A Router that is
  # not running is a Router that misses webhooks, and GitHub does not replay
  # them indefinitely — an install that stops one step short of a live daemon is
  # an install that looks finished and is not.
  systemctl enable gquay >/dev/null 2>&1 && ok "enabled at boot"
  if systemctl restart gquay; then
    sleep 2
    if systemctl is-active --quiet gquay; then
      ok "gquay.service is running"
    else
      warn "gquay.service started but is not active — see: journalctl -u gquay -n 50"
    fi
  else
    warn "gquay.service failed to start — see: journalctl -u gquay -n 50"
  fi
fi

# ── 6. Verify ─────────────────────────────────────────────────────────────────

step "Checking"
if ( cd "$PREFIX" && node dist/cli.js doctor ); then
  say ""
  step "Ready"
  if [ "$INSTALL_SERVICE" = "1" ]; then
    say "  systemctl status gquay        # running now, and at boot"
    say "  journalctl -u gquay -f        # follow it"
    say "  systemctl reload gquay        # drop cached repo config (Variables emit no webhook)"
  else
    say "  npm start"
  fi
  say ""
  note "Then label an issue 'gquay' on an installed repository."
else
  say ""
  warn "doctor reported problems. Fix them, then re-run:"
  say "    cd $PREFIX && node dist/cli.js doctor"
fi
