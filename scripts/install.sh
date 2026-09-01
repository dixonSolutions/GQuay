#!/usr/bin/env bash
#
# Kept for the path documented before setup.sh existed. Delegates to the
# Router module, which does the same install plus config and verification.
#
# Prefer:  sudo ./setup.sh router

exec bash "$(dirname "${BASH_SOURCE[0]}")/setup/router.sh" "$@"
