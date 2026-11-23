#!/usr/bin/env bash
# Smoke-test a deployment: page, PWA manifest, and /api/health (D1 + R2).
#   scripts/check-deploy.sh <url> [expected-env]
#   scripts/check-deploy.sh preview      (uses the URL saved by the last deploy)
set -euo pipefail
cd "$(dirname "$0")/.."
url="${1:?usage: check-deploy.sh <url|preview|production> [env]}"
want="${2:-}"
if [[ "$url" == preview || "$url" == production ]]; then want="$url"; url=$(cat ".wrangler/url-$url"); fi

fail=0
check() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; fail=1; fi; }

for i in 1 2 3 4 5; do   # new deployments can take a few seconds to propagate
  code=$(curl -s -o /dev/null -w '%{http_code}' "$url/api/health" || true)
  [[ "$code" == 200 ]] && break; sleep 2
done
health=$(curl -s "$url/api/health")
echo "health: $health"
check "GET /api/health ok"     '[[ $(node -pe "JSON.parse(process.argv[1]).ok" "$health") == true ]]'
[[ -z "$want" ]] || check "env is $want" '[[ $(node -pe "JSON.parse(process.argv[1]).env" "$health") == "$want" ]]'
page=$(curl -sf "$url/" || true)
manifest=$(curl -sf "$url/manifest.webmanifest" || true)
check "GET / serves the app"   '[[ "$page" == *"<title>rcfc</title>"* ]]'
check "PWA manifest"           '[[ "$manifest" == *short_name* ]]'
check "service worker"         'curl -sf -o /dev/null "$url/sw.js"'
exit $fail
