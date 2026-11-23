#!/usr/bin/env bash
# Regenerate the golden reference from upstream rwkv-srs v0.1.1 (native, no Python install).
# Usage: rwkv/golden/regenerate.sh   (needs cargo; ~2 min first build)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
git clone -q --depth 1 --branch v0.1.1 https://github.com/zaguk/rwkv-srs "$work/rwkv-srs"
crate="$work/rwkv-srs/rust/rwkv-srs-cpu"
cp "$here/golden_dump.rs" "$crate/src/model/golden_dump.rs"
sed -i.bak 's/^mod validation;/mod validation;\n#[cfg(test)]\nmod golden_dump;/' "$crate/src/model.rs"
(cd "$crate" && GOLDEN_OUT="$here/v1_101_4999.json" cargo test --release --locked --lib golden_dump -- --nocapture)
rm -rf "$work"
