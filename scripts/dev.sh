#!/usr/bin/env bash
#
# Development run. Uses tsx with watch, pretty logs, and a local router.yml.
# Point a webhook at it with `gh webhook forward` or an ngrok tunnel — GitHub
# needs a public HTTPS endpoint, and this binds loopback.

set -euo pipefail

cd "$(dirname "$0")/.."

[ -f .env ] || { echo "No .env — copy .env.example and fill it in." >&2; exit 1; }
[ -f router.yml ] || { echo "No router.yml — copy router.example.yml." >&2; exit 1; }

export NODE_ENV=development
export GQUAY_LOG_LEVEL="${GQUAY_LOG_LEVEL:-debug}"

exec npx nodemon
