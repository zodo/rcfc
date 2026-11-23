# rcfc

Offline-first spaced-repetition PWA with an RWKV scheduler in Wasm. Design: `docs/design.md`.

## Layout

- `src/` PWA client (Vite + vite-plugin-pwa)
- `worker/` Cloudflare Worker: API under `/api/*`; everything else is static assets
- `migrations/` D1 SQL migrations (applied automatically on deploy)
- `scripts/` deploy tooling (below)
- `wrangler.jsonc` the single Worker config: top level = local dev, `env.preview`, `env.production`

## Environments

| Env | Worker | D1 / R2 | Use |
|---|---|---|---|
| dev | (local only) | `.wrangler/state` | `npm run dev` |
| preview | `rcfc-preview` | `rcfc-preview` | deploy freely to show work |
| production | `rcfc` | `rcfc` | real user data |

Preview and production never share data. Bindings are not inherited by named envs, so add any new binding to all three blocks in `wrangler.jsonc`, then `npm run cf-typegen`.

## Commands

- `npm run dev` local dev with local D1/R2 (`npm run db:migrate:local` first on a fresh checkout)
- `npm run build` typecheck + build
- `npm run deploy:preview` build → remote D1 migrations → deploy → smoke test; prints the URL
- `npm run deploy:prod` same for production; refuses a dirty tree. **Only on explicit user request.**
- `npm run check:deploy -- preview|production|<url>` re-run the smoke test
- `npm run cf -- wrangler <cmd>` any wrangler command with credentials loaded
- `npm run cf:bootstrap` one-time (idempotent): creates D1 + R2 for preview/prod, writes D1 ids into `wrangler.jsonc`

Last deployed URLs are saved in `.wrangler/url-preview` and `.wrangler/url-production`.

## Credentials

`scripts/cf.sh` supports two modes:
- **OAuth** (current): the user ran `npx wrangler login`; wrangler stores and refreshes the token in `~/Library/Preferences/.wrangler/`. It lapses after long idle periods.
- **API token**: `~/.config/rcfc/cloudflare.env` (mode 600) with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`; takes precedence when present.

Never print, copy or commit credentials. If cf.sh reports "not authenticated", ask the user to run `npx wrangler login` in their terminal (it needs a browser; you can't do it).

## Rust / Wasm

Toolchain pinned in `rust-toolchain.toml` (1.97.0 + wasm32-unknown-unknown). Rustup comes from Homebrew (keg-only): if `cargo` is not on PATH use `export PATH="/opt/homebrew/opt/rustup/bin:$PATH"`.

## Conventions

- Pin exact dependency versions.
- With the Vite plugin, the Cloudflare env is chosen at build time (`CLOUDFLARE_ENV=preview vite build`), not with `wrangler deploy --env`. Wrangler commands that read config directly (d1, r2) use `-c wrangler.jsonc --env <env>`.
