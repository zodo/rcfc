# RWKV SRS PWA design doc

Nov 23, 2026 · @Egor

## Overview

An offline-first spaced repetition PWA, Duocards style, whose scheduler is the RWKV-P model from [rwkv-srs](https://github.com/zaguk/rwkv-srs) running in the browser via Wasm. It is a standalone app, not an Anki client.

**Goals**

- Review fully offline on phone and desktop; sync when online
- RWKV-P predictions refreshed after every answer (live session), the main reason the project exists
- Fast word entry with automatic translation, an LLM description, a generated image and pronunciation
- Same data on all of a user's devices without sign-up

**Non-goals**

- Anki compatibility, add-ons or AnkiWeb sync (an import of an Anki revlog is a nice-to-have, see Data model)
- Shared or subscribed decks, collaboration, accounts with passwords or email
- Scale. Expect about 3 users; choose the simplest thing that works at that size

**Stack in one line.** Vite PWA + IndexedDB (Dexie) on the client, rwkv-srs compiled to wasm32, a Cloudflare Worker with D1 and R2 for sync and media, Workers AI for enrichment, the Web Speech API for pronunciation.

## Architecture

&#91;embedded content: system architecture, device and Cloudflare\]

The device does everything a review needs: UI, storage, scheduling and pronunciation, so the app works with no network. RWKV predictions flow back to the UI after each answer. Cloudflare is touched only to sync events, store images and run enrichment, and the app degrades to "pending" for those when offline.

## Data model

Everything is an immutable event; current state is a fold over the log. Each device replays events into IndexedDB tables for the UI and feeds `review` events to RWKV in time order.

**Envelope (every event)**

| Field | Type | Notes |
| --- | --- | --- |
| `event_id` | UUIDv7 | Generated on device; dedup key; time-sortable |
| `type` | string | One of the types below |
| `ts` | int, ms since epoch | Device wall clock at creation |
| `device_id` | UUID | Tie-breaker for equal `ts` |
| `payload` | JSON | Type-specific |

Entity ids (`note_id`, `card_id`, `deck_id`, `preset_id`) are random 64-bit integers, never counters, so two offline devices cannot collide. Integers because rwkv-srs takes integer ids.

**Event types**

| Type | Payload | Notes |
| --- | --- | --- |
| `deck_created` | `deck_id, name, preset_id` | One preset per deck is fine to start |
| `deck_renamed` | `deck_id, name` | Last write wins |
| `preset_updated` | `preset_id, desired_retention, day_rollover_hour` | Rollover drives `day_offset` |
| `note_created` | `note_id, deck_id, fields{front, back, ...}, lang_pair` | Emits its cards in the same batch |
| `card_created` | `card_id, note_id, template` | E.g. forward and reverse card per note |
| `note_edited` | `note_id, field, value` | One event per field; last write wins per field |
| `card_moved` | `card_id, deck_id` |  |
| `card_deleted` / `note_deleted` | id | Tombstone only; history stays usable by RWKV |
| `asset_attached` | `note_id, kind (image or audio), r2_key` | Media lives in R2, not in events |
| `review` | see below | Append-only, never edited |

**Review payload (fields rwkv-srs needs)**

Taken from the add-on's `RWKV_SRS_PROCESS_FIELDS`: `review_id, card_id, note_id, deck_id, preset_id, day_offset, elapsed_days, elapsed_seconds, rating, duration, state`. Store raw facts (`card_id`, `rating` 1 to 4, `duration_ms`, `state` new, learning, review or relearn, `ts`) and derive `day_offset` and the elapsed values at replay time, so a change of rollover hour needs no migration.

Anki import (optional, later). Map Anki `revlog` rows to `review` events and notes or cards to the creation events. RWKV then starts warm on years of history.

## Sync

Sync is a union of append-only events per user, so there are no merge conflicts to resolve on the server. The server is a dumb, ordered mailbox.

**D1 schema**

```sql
CREATE TABLE events (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT, -- server order, used as cursor
  user_code  TEXT NOT NULL,
  event_id   TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  body       TEXT NOT NULL,                     -- full event JSON
  UNIQUE (user_code, event_id)
);
CREATE INDEX events_user_seq ON events (user_code, seq);
```

**Endpoints (Worker)**

| Route | Request | Response |
| --- | --- | --- |
| `POST /sync/push` | `{events: [...]}`, header `X-User-Code` | `{accepted: n}`; duplicates ignored via `INSERT OR IGNORE` |
| `GET /sync/pull?after=<seq>` | header `X-User-Code` | `{events: [...], next: <seq>, more: bool}`, pages of 500 |
| `PUT /media/<key>` | image or audio bytes | `{r2_key}` |
| `GET /media/<key>` |  | the bytes, long cache headers |

**Client loop**

1. Every local write goes to the local log and an outbox.
2. On app start, on reconnect, and every 30 s while online: push the outbox, then pull after the stored cursor until `more` is false.
3. Apply pulled events to the local tables; store the new cursor.

The service worker does not need Background Sync; the loop above is enough at this scale.

**Conflict rules**

- Reviews, creations, tombstones: no conflicts, set union.
- `note_edited`, `deck_renamed`, `card_moved`, `preset_updated`: last write wins, ordered by `(ts, device_id)`.
- A deleted entity stays deleted; later edits to it are ignored.

**RWKV replay on late events**

RWKV state depends on review order. When a pull brings a `review` older than the newest review already processed, rewind to the newest checkpoint before it and replay from there (see RWKV in Wasm, checkpoints). Pulls that only contain newer reviews just process them incrementally.

## RWKV in Wasm

Port the Rust crate `rust/rwkv-srs-cpu` from [rwkv-srs v0.1.1](https://github.com/zaguk/rwkv-srs) to `wasm32-unknown-unknown`, starting with the scalar Oracle CPU path, single-threaded. Not yet build-tested; the list below comes from reading the source.

**What helps**

- Model weights are small: each `.safetensors` file is about 11 MB (two V1 models, one V5o-a).
- Core deps are pure Rust and Wasm-friendly: `candle-core` 0.9, `safetensors`, `half`, `bytemuck`, `serde`, `sha2`.
- Start with V1: it supports both RWKV-P (immediate) and forgetting curves; V5o-a is marked experimental.

**What must change**

| Blocker | Where | Plan |
| --- | --- | --- |
| PyO3 is a hard dependency | 26 of 100 `.rs` files | Put bindings behind a `python` cargo feature; add a `wasm` feature with wasm-bindgen exports |
| x86 and ARM intrinsics, `pulp` with `x86-v3` | `ops.rs`, `model.rs`, `model/binary_cpu.rs` | `cfg`-gate them; use Oracle (scalar) on wasm first, add `simd128` later if needed |
| `rayon` threads | crate-wide | Single-threaded on wasm (`cfg`), optional wasm-bindgen-rayon later |
| `std::fs` checkpoints | 11 files | Serialize state to bytes; the JS side stores them in IndexedDB |
| `wgpu` with blocking `pollster` | GPU path | Leave out of the first build; WebGPU needs an async rewrite |

**Wasm API (proposed)**

```ts
class Rwkv {
  static load(weights: Uint8Array): Rwkv
  process(reviews: ReviewRow[]): void            // advance state in time order
  predict(cards: PredictRow[]): Float32Array     // P(recall now) per card
  saveState(): Uint8Array                        // checkpoint
  loadState(bytes: Uint8Array): void
}
```

Run it in a dedicated Web Worker so the UI never blocks.

**Checkpoints**

- Save state every 500 reviews and at the end of each session; keep the last 5, keyed by the last processed `review_id`.
- Late reviews from another device trigger a rewind to the newest checkpoint before them, then a replay.
- First launch on a new device: replay the full log once. Speed on a phone is unknown; measure it in milestone 1.

**Live session (what the user feels)**

Mirror the add-on's engine (`live_review_engine.py`): after each answer, process that review, re-predict a hot set of candidate cards (add-on defaults: 50 hot, refresh limit 247), and show the card with the lowest predicted recall below desired retention. New cards are interleaved by a simple daily limit.

## Card enrichment

Adding a word creates the card immediately; enrichment fills it in afterwards as ordinary `note_edited` and `asset_attached` events, so it syncs and works offline like typed content.

**Flow**

1. User types a word and picks the language pair.
2. Client emits `note_created` with just the word; the card is usable at once.
3. Client queues an enrichment job (kept in IndexedDB, retried when online).
4. Worker `POST /enrich {word, from, to}` calls Workers AI and returns JSON; the image is stored in R2.
5. Client writes the results as events.

**Text (one LLM call)**

A Workers AI chat model returns strict JSON: `translation, part_of_speech, gender_or_article, definition, examples[2]`. One call replaces a separate translation model and handles context and gender better. Cache responses in D1 by `(word, from, to)` so a second user adding the same word pays nothing.

**Image**

A fast Workers AI text-to-image model (FLUX class) prompted with the first example sentence, rendered at 512 or 1024 px, stored in R2 as WebP, referenced by `asset_attached`. Optional per card; the user can regenerate.

**Pronunciation**

Use the browser's Web Speech API (`speechSynthesis`) with the note's language tag. No download, no server, works offline where the OS has a local voice. Pick the best available voice per language and let the user override it in settings. Check Spanish and Russian voices on the target phones early.

**Cost at this scale**

Workers AI bills $0.011 per 1,000 neurons with 10,000 free per day ([pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)). FLUX.2 klein is listed at $0.015 per 1024 px image, so 100 illustrated words cost about $1.50; text calls cost cents per thousand words.

## Identity and pairing

No sign-in. The user code is the account: whoever holds it can read and write that user's events.

- **First launch.** Generate a random 16-character code (base32, about 80 bits) and store it locally.
- **New device.** The settings screen shows a QR code of `https://<app>/#k=<code>` plus the code as text. Scanning the QR or opening the link stores the code and starts a full pull. The `#` fragment never reaches the server logs.
- **Requests.** Every sync and enrichment call sends `X-User-Code`; the Worker uses it as the partition key.
- **Lost code.** Data is unrecoverable if every device and the code are lost. Show the code once at first launch with a prompt to save it.
- **Abuse guard.** Per-IP rate limit on code creation and on `/enrich`, plus a per-user storage cap in R2.

No encryption at rest beyond what Cloudflare provides; acceptable for about 3 users.

## Milestones and risks

RWKV goes first because it is the reason for the project and the biggest unknown.

**Milestones**

1. **RWKV runs in the browser.** Wasm build of the Oracle path; process an exported Anki revlog and match the add-on's predictions on a sample. Measure full-replay time on a phone.
2. **Local app.** PWA shell, event log in Dexie, decks, notes, review screen, live session driven by RWKV. No network.
3. **Sync.** Worker + D1 push and pull, user code, QR pairing, late-review rewind.
4. **Enrichment.** `/enrich` with LLM text, image to R2, Web Speech pronunciation.
5. **Nice-to-haves.** Anki import, SIMD or WebGPU speedups, stats and calibration charts.

**Risks**

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Full replay too slow on a phone in scalar Wasm | First launch on a new device takes long | Upload a state checkpoint to R2 so new devices download it instead of replaying; or add `simd128` |
| rwkv-srs API and checkpoint format are pre-1.0 | Upstream changes break the port | Pin to v0.1.1 and vendor the crate |
| Mobile browser evicts IndexedDB storage | Local log lost | Server is the durable copy; call `navigator.storage.persist()` |
| Weak or missing OS voices for a language | Poor pronunciation | Allow voice choice; Piper in Wasm or stored audio as a later fallback |
| Card content edits racing across devices | A field edit lost | Per-field last write wins is accepted at this scale |

**Open questions**

- Desired retention default and whether to add a daily new-card limit per deck.
- Card templates beyond forward and reverse (typing answers, cloze).

## References

- [RWKV4Anki](https://github.com/zaguk/RWKV4Anki), the Anki add-on this design borrows from (live session engine, review schema)
- [rwkv-srs](https://github.com/zaguk/rwkv-srs), the Rust RWKV runtime and model weights
- [srs-benchmark RWKV](https://github.com/open-spaced-repetition/srs-benchmark/tree/main/rwkv), the original model and its benchmark results
- [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)
