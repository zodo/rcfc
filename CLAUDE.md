# rcfc

Offline-first spaced-repetition PWA with an RWKV scheduler in Wasm. Design: `docs/design.md`.

## Layout

- `src/` PWA client (Vite + vite-plugin-pwa, Dexie, no UI framework)
  - `ui/` DOM helpers and the paper look: `paper.ts` (textures, cut edges, haptics), `light.ts` (tilt light), `body.ts` (card physics), `turn.ts` (turning a card over), `picture.ts`
  - `domain/` pure logic: event fold, RWKV row derivation, piles (`piles.ts`: deals, draws, sizes), new-card daily limits (`newcards.ts`)
  - `engine/` RWKV Web Worker + checkpoints; `EngineApi` is what the app uses (tests stub it)
  - `store.ts` ties log + engine. No UI side effects: writes return `{ replay }` / set `stale`, the app decides when to reload
  - `session.ts` one sitting at a pile (UI-free; the cards on screen); `sync.ts` sync loop; `pictures.ts` picture queue + offline picture store
  - `app.ts` shell shared by screens: `app` (store, sync, current screen), `go.*` navigation, `page()` / `fullScreen()`, `setKeys()`
  - `router.ts` `go.*` as browser history, so the phone's back gesture matches the back buttons: Study at the bottom, tabs and study one level up (tabs replace each other), add/import/edit/addLanguage on top of Words; going up = `history.go(-n)`; a reload shows the screen history was on
  - `screens/` one module per screen; they navigate through `go`, never import each other (except helpers in `languages.ts`). Three tabs: Study (`home.ts`: the table), Words (`words.ts`: every word in one list, rendered in chunks on scroll, language chips once there are two or more, with new/learning/known; select → know / don't know / delete; add/import/edit are sub-pages with a back button), Settings (sync + backup only)
  - `main.ts` boot only; `dev/` dev-only URL hooks (`?reset`, `?seed=N`), excluded from production builds
- `rwkv/engine/` Rust RWKV-SRS V1 inference (→ Wasm), checked against upstream goldens in `rwkv/golden/`; `rwkv/models/` weights
- `worker/` Cloudflare Worker: API under `/api/*`; everything else is static assets. `sync.ts` is the sync API, written against a small `SqlDb` slice of D1 so tests run it on bun:sqlite; `pictures.ts` draws and serves card pictures
- `test/` bun tests; `test/support/` harness: fake-indexeddb, `FakeEngine`, in-process sync server (`Device`, `Server`, `Clock`)
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
- `bun test` all tests (`bun:test`): pure domain, Store/StudySession on fake-indexeddb + fake engine, multi-device sync through the real Worker handler. `RCFC_DUOCARDS_EXPORT=/path/to/export.csv bun test` also runs the importer over a real export (never commit real exports: personal data)
- `bun run smoke [url]` UI smoke test in headless Chromium (Chromium.app, else Chrome; `RCFC_CHROMIUM` overrides) over the DevTools Protocol, no deps: starts a dev server on :5199 unless given one, walks language → add → table → study → finished spot → the same cards again → words → settings/sync → seeded replay with the real model → select/know/delete → a second language (Add picker, Words chips, a second pile), fails on page errors; screenshot on failure in `.wrangler/smoke/`. `RCFC_HEADFUL=1` to watch, `RCFC_TRACE=1` to log clicks, `RCFC_SHOTS=1` to save screenshots of the add/study/table screens. Against preview/production it draws real pictures (~60 neurons each). ~4 s after the dev server is up
- Dev URL hooks (dev server only): `/?reset` wipes this origin's data, `/?seed=60` adds a demo deck with a month of reviews
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
- Importers are pure (text in, events out) and dedup on normalized front+back so re-imports are safe. Imported notes must not auto-queue enrichment at import time (pictures are queued the first time a word is shown in study).

## UX notes

- Look: everything is cut from paper (`src/style.css` header). Sage table, white card stock, coloured paper buttons/tabs with hand-cut edges (`--cut-1..4`), Balsamiq Sans (self-hosted via `@fontsource`, precached; has Cyrillic). Textures are canvas bitmaps made at boot (`src/ui/paper.ts`), never SVG filters. Anything that moves per frame changes only transform/translate/opacity; tilt light writes `translate` on `[data-light]` elements (`src/ui/light.ts`), never a custom property on a screen root.
- Piles (`src/domain/piles.ts`, design: docs/design.md "Piles, labels and languages"): every study day a language's pile is dealt its size (`pile_dealt`; 20 to start, +5 after "more", -5 when left unfinished, 10..50). The pile fixes how many, not which: a card is chosen when drawn (due weakest first, then new words within the daily limit), except seen ones (top and peeked card per device, Again'd cards wait under the pile, past the rollover too). Got it/Easy = done for the day in every pile (the model's minute-scale predictions are noise). A face is not drawn within an hour of its twin. Reviews record their `pile`.
- The table (`src/screens/home.ts`): a spot printed on the table per language, two per row, with its pile: thickness = cards left (1.5 px each, up to 30 edges), the top card face up, edge colours from `StudySession.faces` (the same fixed colours study shows). The table deals nothing (`StudySession.prepare`; an undealt pile draws as if dealt); study deals. A finished pile goes straight back to the table, where its spot draws a pencil check with paper bits (`app.cleared`); tapping a finished spot opens a sheet: "Deal N more", "Go through these N again" (today's cards from that pile, `StudySession.againThese`, kept per device and pile with the cards on screen, for that day), "Add words" when nothing is left to learn. A refill stays on the table: the cards drop onto the spot (`app.refilled`), and a tap on the pile studies them.
- Study (`src/screens/study.ts`): a real pile (each card has a fixed pose; its height is the cards left; the one under the top card shows `StudySession.peek()`, fixed once shown; deeper cards show only their colour, white or cream side up, fixed once their edge shows: the card drawn into that spot must lie that side up unless none is left), tap, Show answer or a sideways drag turns the card over (the drag turns it up to its edge, never past, so the answer stays hidden until let go; `src/ui/turn.ts`), then drag right = Got it (3), left = Again (1, tucked under the pile), up = Easy (4); arrow keys too. Once turned, a tap or Space turns it over again (onwards the same way) to look at the other side; the ratings stay. Pencil notes on the back teach the throws and retire per direction after 3 throws (localStorage `rcfc:throws`). Android haptics (`navigator.vibrate`) incl. a detent tick when a release would answer; iPhone has none yet.
- Cards are physical: one card per word, the studied language on the white side (word, speak button, example), the known language and the picture on the cream side (`--card-known`). A forward card lies white side up, a reverse card cream side up. No language label on the card.
- Fewer buttons, no study settings. No decks in the UI: a language is a pair ("Spanish" = es→en) that lives on each word (`note.lang_pair`) and exists while it has words (`languages.ts`), named after the studied language. Words shows every word; with two or more languages, chips narrow it to one (per device, localStorage). The Add screen adds to the last language used, switchable by a native picker whose last option, "Add a language…", picks a new pair; nothing is made until its first word. Underneath, one hidden deck per pair stays, because the model takes a deck id: `deckFor` reuses the pair's deck (lowest id), else makes one whose id is derived from the pair (`derivedEntityId`), so two devices adding the same new language offline make the same deck.
- Target recall is fixed (`TARGET_RECALL` 0.9 in `src/domain/scheduler.ts`; presets' `desired_retention` is ignored). Day rollover (4) and new words per day (10) stay in the preset but have no UI; "more" on an empty pile raises today's new-word limit by what it deals.
- Selected words: "I know" (`Store.markKnown`) answers Easy (the forward card of an unseen word, else every studied card); "Don't know" (`Store.markUnknown`) answers Again on studied cards and queues unseen words to be learned next (`notes_prioritized` event, latest request first).
- The list status (`wordStatus`) is new / learning / known: known = every studied card last answered Easy, or ≥ target recall a week ahead. Never show P(recall) now as progress: it is ~100% right after any answer and dips minutes later.

## Picture notes

- Pipeline (`src/domain/pictures.ts`): Granite 4.0 micro writes one scene, FLUX.2 klein 4B draws it at 768×512 in the house cut-paper style (medium first in the prompt, or it drifts to photos). The meaning is chosen in code (user's choice, else the example decides, else the first listed meaning): LLMs ignore that rule.
- No writing in pictures: the picture is on the known side, so a drawn word gives the answer away. The scene LLM ignores the rule and writes quotes and dialogue, so `withoutQuotes` strips them in code. The style asks for one free-standing cut-out with an irregular hand-cut outline on white, not a full-frame panel.
- Cost: must stay inside the free 10,000 neurons/day (UTC). The Worker reserves ~60 neurons per picture in D1 `ai_budget` and answers 429 past `PICTURE_NEURONS_PER_DAY`; the client queue waits for the reset. Error 3030 (false safety flag) is retried with new seeds.
- When: typed words right after adding; any other word the first time it is shown in study redraws on request with meaning + details. A removed picture (`asset_attached` with `r2_key: null`) is never redrawn automatically.
- Client (`src/pictures.ts`): jobs in Dexie `pic_jobs` (per device, not synced; the result syncs as `asset_attached`), downloaded pictures get their photographed paper flattened to pure white (`src/domain/paper.ts`, so light cards show through with multiply blending; dark mode pastes them as a light cut-out), are re-encoded and kept in `pic_blobs` for offline study. Local dev has no AI binding: the Worker draws an SVG placeholder for free.

## Sync notes

- The sync code (16 base32 chars, `src/domain/sync.ts`) is the account: no sign-in, whoever has it reads and writes that user's events. Every device gets one on first launch, so sync (and the server copy, which is the cloud backup) is always on. Pairing = `#k=<code>` link or QR in Settings, or typing the code; joining pushes this device's events to that account and pulls everything.
- Worker: `POST /api/sync/push` (≤500 events, `INSERT OR IGNORE`), `GET /api/sync/pull?after=<seq>` (pages of 500), header `X-User-Code`. The server never reads payloads.
- Client (`src/sync.ts`): push cursor = local Dexie seq; pulled events are stored with `remote: 1` and never pushed back. Pulled reviews that sort after everything processed feed RWKV incrementally; an older one (or a rollover change of a used preset) sets `store.stale` and the app reloads at the next safe moment (home screen) for a full replay.
- Several presets can exist after pairing (each device makes a default): `defaultPreset()` picks deterministically (lowest id among presets decks use).

## RWKV notes

- Review events store raw facts; `src/domain/rows.ts` derives RWKV inputs (day_offset from first review day, elapsed, state) following RWKV4Anki `review_rows.py`. Changing that derivation: bump `ROWS_VERSION` (forces a full replay).
- Engine checkpoint lives in IndexedDB `rcfc-engine`, keyed by model sha + rows config; on mismatch the app replays the log.
- Known scale limit: all recurrent state is held in memory (~70 KB/card, ~0.5 GB after a year of daily use). Fine for months; needs on-disk/evicted states before then.

## Rust / Wasm

Toolchain pinned in `rust-toolchain.toml` (1.97.0 + wasm32-unknown-unknown). Rustup comes from Homebrew (keg-only): if `cargo` is not on PATH use `export PATH="/opt/homebrew/opt/rustup/bin:$PATH"`.

## Conventions

- Pin exact dependency versions.
- With the Vite plugin, the Cloudflare env is chosen at build time (`CLOUDFLARE_ENV=preview vite build`), not with `wrangler deploy --env`. Wrangler commands that read config directly (d1, r2) use `-c wrangler.jsonc --env <env>`.
