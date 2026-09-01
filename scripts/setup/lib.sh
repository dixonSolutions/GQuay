# shellcheck shell=bash
#
# Shared helpers for the setup modules.
#
# Sourced, never executed. Every module can also run standalone, so this must
# not assume the front door ran first.

set -euo pipefail

# Colour only when attached to a terminal — these scripts get piped into logs.
if [ -t 1 ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'
  GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RESET=$'\033[0m'
else
  BOLD=''; DIM=''; RED=''; GREEN=''; YELLOW=''; RESET=''
fi

# GQUAY_YES=1 (or --yes) makes every prompt take its default and never block.
# Set by provisioning pipelines, and by anything running as root unattended.
: "${GQUAY_YES:=0}"

say()   { printf '%s\n' "$*"; }
step()  { printf '\n%s%s%s\n' "$BOLD" "$*" "$RESET"; }
ok()    { printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
warn()  { printf '  %s!%s %s\n' "$YELLOW" "$RESET" "$*"; }
fail()  { printf '  %s✗%s %s\n' "$RED" "$RESET" "$*" >&2; }
note()  { printf '  %s%s%s\n' "$DIM" "$*" "$RESET"; }

die() { fail "$*"; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

need() {
  have "$1" || die "$1 is required but not installed.${2:+ $2}"
}

# ask "Question?" "default"  ->  echoes the answer
ask() {
  local prompt="$1" default="${2:-}" reply
  if [ "$GQUAY_YES" = "1" ]; then
    printf '%s' "$default"
    return
  fi
  if [ -n "$default" ]; then
    read -r -p "  $prompt [$default]: " reply </dev/tty || reply=''
  else
    read -r -p "  $prompt: " reply </dev/tty || reply=''
  fi
  printf '%s' "${reply:-$default}"
}

# confirm "Do the thing?" [y|n]  ->  returns 0 for yes
confirm() {
  local prompt="$1" default="${2:-y}" reply
  [ "$GQUAY_YES" = "1" ] && { [ "$default" = "y" ]; return; }
  local hint='[Y/n]'; [ "$default" = "n" ] && hint='[y/N]'
  read -r -p "  $prompt $hint " reply </dev/tty || reply=''
  reply="${reply:-$default}"
  [[ "$reply" =~ ^[Yy] ]]
}

# Some steps genuinely cannot be scripted — creating a GitHub App, creating a
# Teams Workflow. A setup script that pretends otherwise is worse than one that
# stops and says so.
manual() {
  printf '\n  %s%s%s\n' "$YELLOW" "$1" "$RESET"
  shift
  for line in "$@"; do printf '    %s\n' "$line"; done
  if [ "$GQUAY_YES" = "1" ]; then
    note "(--yes: not waiting. Do this before starting the service.)"
  else
    read -r -p "  Press enter when done… " _ </dev/tty || true
  fi
}

# Write KEY=value into an env file, replacing any existing line for that key.
set_env() {
  local file="$1" key="$2" value="$3"
  touch "$file"; chmod 600 "$file"
  if grep -qE "^${key}=" "$file" 2>/dev/null; then
    # Portable in-place edit: BSD and GNU sed disagree about -i.
    local tmp; tmp="$(mktemp)"
    grep -vE "^${key}=" "$file" > "$tmp"
    printf '%s=%s\n' "$key" "$value" >> "$tmp"
    cat "$tmp" > "$file"
    rm -f "$tmp"
  else
    printf '%s=%s\n' "$key" "$value" >> "$file"
  fi
}

get_env() {
  local file="$1" key="$2"
  [ -f "$file" ] || return 0
  grep -E "^${key}=" "$file" 2>/dev/null | tail -1 | cut -d= -f2- || true
}

random_secret() {
  if have openssl; then openssl rand -hex 32
  elif have node; then node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  else head -c32 /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

repo_root() {
  cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd
}
