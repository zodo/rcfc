#!/usr/bin/env bash
# Run a command with Cloudflare credentials available. Two supported modes:
#  1. API token (preferred, never expires): ~/.config/rcfc/cloudflare.env, mode 600
#       CLOUDFLARE_API_TOKEN=...
#       CLOUDFLARE_ACCOUNT_ID=...
#     Override the location with RCFC_CF_ENV_FILE.
#  2. OAuth: `bunx wrangler login` once in an interactive terminal. Wrangler keeps
#     and refreshes the token itself; if it lapses, run `wrangler login` again.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$PWD/node_modules/.bin:$PATH"

f="${RCFC_CF_ENV_FILE:-$HOME/.config/rcfc/cloudflare.env}"
if [[ -z "${CLOUDFLARE_API_TOKEN:-}" && -f "$f" ]]; then
  perm=$(stat -f %Lp "$f" 2>/dev/null || stat -c %a "$f")
  [[ "$perm" == "600" || "$perm" == "400" ]] || echo "cf.sh: warning: $f is mode $perm, run: chmod 600 $f" >&2
  set -a; # shellcheck disable=SC1090
  source "$f"; set +a
fi

if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  # OAuth mode: fail fast with a clear message instead of a mid-deploy auth error.
  if ! out=$(wrangler whoami 2>&1); then
    # A failed whoami is not always a lapsed login: Cloudflare's API can be down (e.g. 504 on /memberships).
    api=$(grep -oE '(GET|POST) /[^ ]+ -> [0-9]{3}[A-Za-z ]*' <<<"$out" | head -1 || true)
    if [[ -n "$api" && "$api" != *" 401"* && "$api" != *" 403"* ]]; then
      echo "cf.sh: Cloudflare's API failed ($api); the login is fine, try again later." >&2
      exit 3
    fi
    echo "cf.sh: not authenticated. Either run 'bunx wrangler login' in a terminal," >&2
    echo "       or create $f with CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID (see CLAUDE.md)." >&2
    exit 2
  fi
fi
[[ $# -gt 0 ]] || set -- wrangler whoami
exec "$@"
