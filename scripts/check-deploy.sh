#!/usr/bin/env bash
# Smoke-test a deployment: page, PWA manifest, /api/health (D1 + R2), and the Claude connector.
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
health=$(curl -s "$url/api/health" || true)
[[ -n "$health" ]] || { echo "FAIL $url/api/health unreachable (DNS, TLS or network)"; exit 1; }
echo "health: $health"
check "GET /api/health ok"     '[[ $(bun -p "JSON.parse(process.argv[1]).ok" "$health") == true ]]'
[[ -z "$want" ]] || check "env is $want" '[[ $(bun -p "JSON.parse(process.argv[1]).env" "$health") == "$want" ]]'
page=$(curl -sf "$url/" || true)
manifest=$(curl -sf "$url/manifest.webmanifest" || true)
check "GET / serves the app"   '[[ "$page" == *"<title>rcfc</title>"* ]]'
check "PWA manifest"           '[[ "$manifest" == *short_name* ]]'
check "service worker"         'curl -sf -o /dev/null "$url/sw.js"'
# The Claude connector: the whole sign-in and tool calls with a throwaway account, except on production (discovery only).
if [[ "$want" == production || "$url" == *rcfc.220400.xyz* || "$url" == *//rcfc.zzodoo.* ]]; then bun scripts/check-connector.ts "$url" || fail=1
else bun scripts/check-connector.ts "$url" --write || fail=1; fi
exit $fail
