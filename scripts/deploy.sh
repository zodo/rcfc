#!/usr/bin/env bash
# Build, migrate, deploy and smoke-test one environment.
#   npm run deploy:preview      -> rcfc-preview  (any branch, dirty tree ok)
#   npm run deploy:prod         -> rcfc          (clean tree, pushed commit)
set -euo pipefail
cd "$(dirname "$0")/.."
env="${1:?usage: deploy.sh preview|production}"
[[ "$env" == preview || "$env" == production ]] || { echo "unknown env $env" >&2; exit 2; }

if grep -q '"database_id": "PENDING_BOOTSTRAP"' wrangler.jsonc; then
  echo "D1 ids missing; run: npm run cf:bootstrap" >&2; exit 2
fi

sha=$(git rev-parse --short HEAD)
branch=$(git rev-parse --abbrev-ref HEAD)
dirty=""; [[ -z $(git status --porcelain) ]] || dirty="-dirty"
if [[ "$env" == production && -n "$dirty" ]]; then
  echo "refusing to deploy production from a dirty tree; commit first" >&2; exit 2
fi
msg="$branch@$sha$dirty"

echo "== build ($env, $msg)"
npm run build:wasm
npm run typecheck
CLOUDFLARE_ENV="$env" vite build

echo "== migrate D1 ($env)"
wrangler d1 migrations apply DB --remote -c wrangler.jsonc --env "$env"

echo "== deploy"
log=$(mktemp)
wrangler deploy --message "$msg" 2>&1 | tee "$log"
url=$(grep -Eo 'https://[a-z0-9.-]+\.workers\.dev' "$log" | head -1)
rm -f "$log"
[[ -n "$url" ]] || { echo "could not find deployed URL in wrangler output" >&2; exit 1; }

mkdir -p .wrangler && echo "$url" > ".wrangler/url-$env"
scripts/check-deploy.sh "$url" "$env"
echo "== $env is live: $url"
