#!/usr/bin/env bash
#
# PreModelSwitch guard.
#
# The Router resolves the model at spawn time from labels and passes --model.
# A mid-session switch would make the audit line written into the transcript at
# SessionStart untrue, and would quietly change the cost and capability of work
# a human already approved.
#
# This hook fails closed by design: PreModelSwitch is the one event where a hook
# cancelled at its timeout *blocks* the switch rather than allowing it. There is
# also no $CLAUDE_MODEL environment variable to read, which is why the expected
# model is passed as an argument instead.

set -uo pipefail

EXPECTED="${1:-}"
PAYLOAD="$(cat)"

requested=""
if command -v jq >/dev/null 2>&1; then
  requested="$(printf '%s' "$PAYLOAD" | jq -r '.model // .to_model // empty' 2>/dev/null)"
fi

if [ -n "$EXPECTED" ] && [ -n "$requested" ] && [ "$requested" = "$EXPECTED" ]; then
  exit 0
fi

cat <<EOF >&2
This session is pinned to ${EXPECTED:-its assigned model} by GQuay. The model was
chosen at spawn from the work item's labels, and the choice is recorded in the
transcript. If a different model is genuinely needed, say so on the issue thread
and let a human relabel the item — GQuay will use the new model on the next spawn.
EOF

# Exit 2 blocks the switch and returns the message above to Claude.
exit 2
