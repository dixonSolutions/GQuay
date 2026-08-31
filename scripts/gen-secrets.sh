#!/usr/bin/env bash
#
# Generate the two shared secrets GQuay needs and print them in .env form.
# The webhook secret must match what you set on the GitHub App; the hook bus
# token is internal and only ever crosses loopback.

set -euo pipefail

echo "GITHUB_WEBHOOK_SECRET=$(openssl rand -hex 32)"
echo "HOOK_BUS_TOKEN=$(openssl rand -hex 32)"
echo "GQUAY_WORKER_TOKEN_KINGSPAN=$(openssl rand -hex 32)"
echo
echo "# Paste the GITHUB_WEBHOOK_SECRET value into the GitHub App's webhook settings too."
