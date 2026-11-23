#!/usr/bin/env bash
# Build the RWKV engine to Wasm and generate JS bindings into src/rwkv/pkg/
# (gitignored). Needs the pinned Rust toolchain and wasm-bindgen-cli 0.2.130:
#   cargo install wasm-bindgen-cli --version 0.2.130 --locked
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="/opt/homebrew/opt/rustup/bin:$HOME/.cargo/bin:$PATH"
want=0.2.130
have=$(wasm-bindgen --version 2>/dev/null | awk '{print $2}' || true)
if [[ "$have" != "$want" ]]; then
  echo "wasm-bindgen-cli $want required (found: ${have:-none}). Install: cargo install wasm-bindgen-cli --version $want --locked" >&2
  exit 1
fi
(cd rwkv/engine && RUSTFLAGS="-C target-feature=+simd128" cargo build --release --target wasm32-unknown-unknown --quiet)
wasm-bindgen --target web --out-dir src/rwkv/pkg rwkv/engine/target/wasm32-unknown-unknown/release/rcfc_rwkv.wasm
