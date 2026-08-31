#!/usr/bin/env bash
#
# Install GQuay as a systemd service. Run as root on the Router host.
#
# This does not create the GitHub App, the Teams Workflow, or the TLS
# terminator — those are one-time manual steps documented in
# docs/02-deployment.md, and each needs a decision only you can make.

set -euo pipefail

PREFIX="${PREFIX:-/opt/gquay}"
SERVICE_USER="${SERVICE_USER:-gquay}"

[ "$(id -u)" -eq 0 ] || { echo "Run as root." >&2; exit 1; }

if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  echo "Creating service user $SERVICE_USER"
  useradd --system --create-home --shell /usr/sbin/nologin "$SERVICE_USER"
fi

echo "Installing to $PREFIX"
mkdir -p "$PREFIX"
rsync -a --exclude node_modules --exclude .git --exclude data --exclude worktrees \
      --exclude mirrors ./ "$PREFIX/"

cd "$PREFIX"
npm ci --omit=dev
npm run build

mkdir -p "$PREFIX"/{data,worktrees,mirrors,data/inbox}
chown -R "$SERVICE_USER:$SERVICE_USER" "$PREFIX"

if [ ! -f "$PREFIX/.env" ]; then
  cp .env.example .env
  chmod 600 .env
  chown "$SERVICE_USER:$SERVICE_USER" .env
  echo
  echo "Created $PREFIX/.env from the example. Fill it in before starting."
fi

if [ ! -f "$PREFIX/router.yml" ]; then
  cp router.example.yml router.yml
  chown "$SERVICE_USER:$SERVICE_USER" router.yml
  echo "Created $PREFIX/router.yml from the example. Edit public_url and github.app_id."
fi

install -m 644 gquay.service /etc/systemd/system/gquay.service
systemctl daemon-reload

echo
echo "Installed. Next:"
echo "  1. Edit $PREFIX/.env and $PREFIX/router.yml"
echo "  2. sudo -u $SERVICE_USER $PREFIX/node_modules/.bin/tsx $PREFIX/src/cli.ts doctor"
echo "  3. systemctl enable --now gquay"
