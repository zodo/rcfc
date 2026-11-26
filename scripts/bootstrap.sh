#!/usr/bin/env bash
# Idempotently create the D1 databases, R2 buckets and KV namespaces for preview + production,
# and write the D1 ids into wrangler.jsonc. Run via: bun run cf:bootstrap
set -euo pipefail
cd "$(dirname "$0")/.."

for db in rcfc-preview rcfc; do
  id=$(wrangler d1 list --json | bun -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s).find(x=>x.name===process.argv[1]);process.stdout.write(r?r.uuid:"")})' "$db")
  if [[ -z "$id" ]]; then
    echo "creating D1 $db"
    wrangler d1 create "$db" >/dev/null
    id=$(wrangler d1 info "$db" --json | bun -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).uuid))')
  fi
  echo "D1 $db = $id"
  bun -e '
    const fs=require("fs"), [name,id]=process.argv.slice(1);
    let s=fs.readFileSync("wrangler.jsonc","utf8");
    const re=new RegExp(`("database_name": "${name}", "database_id": ")[^"]*(")`);
    if(!re.test(s)) { console.error("no D1 entry for "+name+" in wrangler.jsonc"); process.exit(1); }
    fs.writeFileSync("wrangler.jsonc", s.replace(re, `$1${id}$2`));
  ' "$db" "$id"
done

existing=$(wrangler r2 bucket list 2>/dev/null | awk '/^name:/{print $2}')
for b in rcfc-preview rcfc; do
  if grep -qx "$b" <<<"$existing"; then echo "R2 $b exists"; else echo "creating R2 $b"; wrangler r2 bucket create "$b" >/dev/null; fi
done

# OAuth grants of the Claude connector (worker/oauth.ts); their ids are in wrangler.jsonc.
kvs=$(wrangler kv namespace list)
for k in rcfc-preview-oauth rcfc-oauth; do
  if grep -q "\"$k\"" <<<"$kvs"; then echo "KV $k exists"; else echo "creating KV $k: put its id in wrangler.jsonc"; wrangler kv namespace create "$k"; fi
done

echo "bootstrap done; commit wrangler.jsonc if ids changed: git diff wrangler.jsonc"
