# rcfc

Offline-first spaced-repetition PWA with an RWKV scheduler in Wasm. Design: `docs/design.md`.

## Layout

- `src/` PWA client (Vite + vite-plugin-pwa, Dexie, no UI framework). `domain/` pure logic (event fold, RWKV row derivation, card picking), `engine/` RWKV Web Worker + checkpoints, `store.ts` ties log + engine, `main.ts` screens
- `rwkv/engine/` Rust RWKV-SRS V1 inference (→ Wasm), checked against upstream goldens in `rwkv/golden/`; `rwkv/models/` weights
- `worker/` Cloudflare Worker: API under `/api/*`; everything else is static assets
- `migrations/` D1 SQL migrations (applied automatically on deploy)
- `scripts/` deploy tooling (below)
- `wrangler.jsonc` the single Worker config: top level = local dev, `env.preview`, `env.production`

## Environments

| Env | Worker | D1 / R2 | Use |
|---|---|---|---|
| dev | (local only) | `.wrangler/state` | `bun run dev` |
| preview | `rcfc-preview` → https://rcfc-preview.zzodoo.workers.dev | `rcfc-preview` | deploy freely to show work |
| production | `rcfc` → https://rcfc.220400.xyz (custom domain; also rcfc.zzodoo.workers.dev, but browser data is per origin, so use the domain) | `rcfc` | real user data |

Preview and production never share data. Bindings are not inherited by named envs, so add any new binding to all three blocks in `wrangler.jsonc`, then `bun run cf-typegen`.

## Commands

Bun is the package manager, script runner and test runner (`bun.lock`; never use npm/npx/node). `bun install` to set up. Exception: `bun run dev` runs vite on Node, because the Cloudflare plugin's Miniflare hangs on Bun's incomplete `ws` support; production builds run on Bun (`bun --bun vite build`).

- `bun run build:wasm` builds the engine into `src/rwkv/pkg/` (gitignored; dev/build/deploy run it). Needs `cargo install wasm-bindgen-cli --version 0.2.130 --locked`
- `cd rwkv/engine && cargo test --release` engine goldens + checkpoint round trip; `cargo run --release --example bench` year-of-use benchmark
- `bun run dev` local dev with local D1/R2 (`bun run db:migrate:local` first on a fresh checkout)
- `bun run build` typecheck + build
- `scripts/build-icons.sh` re-rasterize `public/icon.svg` into the committed PNG icons (manifest + iOS) after changing it
- `bun test` unit tests (`bun:test`). `RCFC_DUOCARDS_EXPORT=/path/to/export.csv bun test` also runs the importer over a real export (never commit real exports: personal data)
- `bun run deploy:preview` build → remote D1 migrations → deploy → smoke test; prints the URL
- `bun run deploy:prod` same for production; refuses a dirty tree. **Only on explicit user request.**
- `bun run check:deploy preview|production|<url>` re-run the smoke test
- `bun run cf wrangler <cmd>` any wrangler command with credentials loaded
- `bun run cf:bootstrap` one-time (idempotent): creates D1 + R2 for preview/prod, writes D1 ids into `wrangler.jsonc`

Last deployed URLs are saved in `.wrangler/url-preview` and `.wrangler/url-production`.

## Credentials

`scripts/cf.sh` supports two modes:
- **OAuth** (current): the user ran `bunx wrangler login`; wrangler stores and refreshes the token in `~/Library/Preferences/.wrangler/`. It lapses after long idle periods.
- **API token**: `~/.config/rcfc/cloudflare.env` (mode 600) with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`; takes precedence when present.

Never print, copy or commit credentials. If cf.sh reports "not authenticated", ask the user to run `bunx wrangler login` in their terminal (it needs a browser; you can't do it).

## Domain notes

- Entity ids are random positive integers < 2^53 (`src/domain/ids.ts`), not full 64-bit: fit rwkv-srs `i64`, exact in JS, JSON-safe.
- Importers are pure (text in, events out) and dedup on normalized front+back so re-imports are safe. Imported notes must not auto-queue enrichment.

## RWKV notes

- Review events store raw facts; `src/domain/rows.ts` derives RWKV inputs (day_offset from first review day, elapsed, state) following RWKV4Anki `review_rows.py`. Changing that derivation: bump `ROWS_VERSION` (forces a full replay).
- Engine checkpoint lives in IndexedDB `rcfc-engine`, keyed by model sha + rows config; on mismatch the app replays the log.
- Known scale limit: all recurrent state is held in memory (~70 KB/card, ~0.5 GB after a year of daily use). Fine for months; needs on-disk/evicted states before then.

## Rust / Wasm

Toolchain pinned in `rust-toolchain.toml` (1.97.0 + wasm32-unknown-unknown). Rustup comes from Homebrew (keg-only): if `cargo` is not on PATH use `export PATH="/opt/homebrew/opt/rustup/bin:$PATH"`.

## Conventions

- Pin exact dependency versions.
- With the Vite plugin, the Cloudflare env is chosen at build time (`CLOUDFLARE_ENV=preview vite build`), not with `wrangler deploy --env`. Wrangler commands that read config directly (d1, r2) use `-c wrangler.jsonc --env <env>`.
