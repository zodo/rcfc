# RWKV SRS PWA design doc

Nov 23, 2026 · @Egor · updated Nov 25, 2026 to match what is built

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

**Stack in one line.** Vite PWA + IndexedDB (Dexie) on the client, an RWKV-SRS V1 engine in Rust compiled to wasm32, a Cloudflare Worker with D1 and R2 for sync and media, Workers AI for pictures, Azure neural voices for pronunciation (the browser voice as fallback).

## Architecture

&#91;embedded content: system architecture, device and Cloudflare\]

The device does everything a review needs: UI, storage, scheduling and playing pronunciation, so the app works with no network. RWKV predictions flow back to the UI after each answer. Cloudflare is touched only to sync events, draw pictures and make spoken audio. Pictures and audio for the cards coming up are downloaded ahead and kept on the device, so study works offline; without them a card shows no picture and the browser voice speaks.

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

Entity ids (`note_id`, `card_id`, `deck_id`, `preset_id`, `label_id`) are random positive integers below 2^53, never counters, so two offline devices cannot collide. Integers because the model takes integer ids (`i64`); below 2^53 so they stay exact in JS and JSON. Two kinds are derived instead of random, so offline devices agree: a studied language's hidden deck (from the language) and a new sticker (from its name).

**Event types**

| Type | Payload | Notes |
| --- | --- | --- |
| `deck_created` | `deck_id, name, preset_id, lang_pair` | Decks are hidden: one per studied language, only to give the model a group (see [Piles, labels and languages](#piles-labels-and-languages)) |
| `deck_renamed` | `deck_id, name` | Last write wins; nothing emits it now |
| `preset_updated` | `preset_id, desired_retention, day_rollover_hour, new_per_day` | Rollover (4) drives `day_offset`; new words a day (10) per studied language; `desired_retention` is no longer read (target recall is fixed at 0.9). No UI sets them |
| `note_created` | `note_id, deck_id, fields{front, back, example?, memo_target?, memo_known?}, lang_pair{from, to}, source?` | Emits its forward and reverse cards in the same batch; `memo_*` are the user's own notes, one per side; `source` marks an import |
| `card_created` | `card_id, note_id, template` | `forward` or `reverse` |
| `note_edited` | `note_id, field, value` | One event per field; last write wins per field |
| `note_deleted` | `note_id` | Tombstone only; history stays usable by RWKV |
| `notes_prioritized` | `note_ids` | "Don't know" on unseen words: learn them before other new words, latest first |
| `asset_attached` | `note_id, kind: image, r2_key, sense?, details?, scene?` | The picture lives in R2; `r2_key` null = removed (never redrawn automatically); last write wins per note |
| `review` | see below | Append-only, never edited |
| `pile_dealt`, `label_created`, `label_renamed`, `label_deleted`, `label_colored`, `notes_labeled` | see [Events and sync](#piles-labels-and-languages) under Piles | Piles and stickers |

Spoken audio is not an event: it is made on demand from the text and cached by its hash (see Pronunciation).

**Review payload (fields rwkv-srs needs)**

The model takes the add-on's `RWKV_SRS_PROCESS_FIELDS`: `review_id, card_id, note_id, deck_id, preset_id, day_offset, elapsed_days, elapsed_seconds, rating, duration, state`. The event stores only raw facts: `card_id, note_id, deck_id, preset_id` as of the answer, `rating` 1 to 4, `duration_ms`, `tz_offset_min` (local day boundaries survive travel), `pile` (which pile it was answered from) and the envelope `ts`. `day_offset`, the elapsed values and `state` are derived at replay (`src/domain/rows.ts`, following RWKV4Anki `review_rows.py`), so a change of rollover hour needs no migration. Changing that derivation bumps `ROWS_VERSION`, which forces a full replay.

**Imports.** A Duocards CSV importer is built: pure (text in, events out), dedups on normalized front + back so a re-import is safe, and sticks a "Duocards" sticker on what came in. Imported words don't queue pictures at import time; they get them when they come up. Anki import (map `revlog` rows to `review` events so RWKV starts warm) is not built.

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
| `POST /api/sync/push` | `{events: [...]}` (at most 500), header `X-User-Code` | `{accepted: n}`; duplicates ignored via `INSERT OR IGNORE` |
| `GET /api/sync/pull?after=<seq>` | header `X-User-Code` | `{events: [...], next: <seq>, more: bool}`, pages of 500 |
| `POST /api/pictures` | `{word, translation, example?, sense?, details?}`, header `X-User-Code` | `{key, sense, scene}`; 429 with `retry_after` past the daily budget |
| `GET /api/media/<key>` |  | the picture bytes, immutable cache headers |
| `GET /api/tts?lang=&text=` | header `X-User-Code` | MP3; 429 past the monthly budget, 404 without a voice service |
| `GET /api/health` |  | D1, R2, AI binding and voice key status, deployed version |

The server never reads event payloads. D1 also holds two budget counters: `ai_budget` (neurons per UTC day) and `tts_budget` (characters per UTC month).

**Client loop**

1. Every local write goes to the local log (Dexie); the push cursor is the local sequence number, so the log is the outbox.
2. On app start, on reconnect, when the app comes back to the foreground, every 30 s while visible and 2 s after a local write: push, then pull after the stored cursor until `more` is false.
3. Pulled events are stored marked remote (never pushed back) and folded into the local state; the new cursor is stored.

The service worker does not need Background Sync; the loop above is enough at this scale.

**Conflict rules**

- Reviews, creations, tombstones: no conflicts, set union.
- `note_edited`, `deck_renamed`, `preset_updated`, `asset_attached`, `label_renamed`, `label_colored`, `notes_labeled`: last write wins, ordered by `(ts, device_id)`.
- Several presets can exist after pairing (each device makes a default one); the app picks deterministically: the lowest id among presets that decks use.
- A deleted entity stays deleted; later edits to it are ignored.

**RWKV replay on late events**

RWKV state depends on review order. Pulled reviews that sort after everything processed are fed to the model incrementally. A pulled review older than the newest one processed, or a changed rollover hour of a preset already used, marks the state stale; the app reloads at the next safe moment (the table) and replays the whole log. There is one checkpoint, not a history of them, so there is no partial rewind; at about 770 reviews a second on the phone this stays fast enough for months.

## RWKV in Wasm

Built. `rwkv/engine/` is a clean reimplementation of the V1 Oracle CPU path of [rwkv-srs v0.1.1](https://github.com/zaguk/rwkv-srs) (RWKV-P only), not a port of the crate: the only dependency is `serde_json` (plus `wasm-bindgen` on wasm32), no candle, PyO3, rayon or intrinsics. It is checked number by number against goldens produced by upstream (`rwkv/golden/`; `cargo test --release`). Scalar and single-threaded; `simd128` was not needed. Weights: one V1 model, about 11 MB (`rwkv/models/`, see `PROVENANCE.md`).

**Wasm API**

```ts
class Rwkv {
  constructor(weights: Uint8Array)
  process(rows: Float64Array): Float64Array   // apply answers in time order; P(recall) just before each
  apply(rows: Float64Array): void             // the same without the predictions (half the work, for replay)
  predict(rows: Float64Array): Float64Array   // P(recall) now per card; state unchanged
  takeDirty(): Float64Array                   // (kind, id) of states changed since the last call
  stateBytes(kind, id) / loadState(kind, id, bytes)
  featuresBytes() / loadFeatures(bytes)
  reset()
  readonly memoryBytes: number
  readonly reviewsProcessed: number
}
```

Rows are flat `Float64Array`s, one fixed-width row per review or card. It runs in a dedicated Web Worker (`src/engine/worker.ts`); the app talks to it through `EngineApi` (tests stub it).

**Checkpoints**

- One checkpoint in IndexedDB `rcfc-engine`: a meta row (feature state, reviews processed, last review id, model sha, rows config) and one row per recurrent state (card, note, deck, preset, global). Only changed states are written, in one transaction with the meta row, so the checkpoint is consistent whenever the tab dies.
- Written about 1.5 s after activity, and every ~2000 reviews during a replay.
- On launch the checkpoint is used when its model sha and rows config match and its last review is in the log; otherwise the log is replayed from the start.
- Speed: about 770 reviews a second on the Android phone (Mac Safari about 1460). A year of daily use (~82k reviews) replays in under two minutes.

**Live session**

The first plan mirrored the add-on's engine (`live_review_engine.py`): after each answer, re-predict a hot set of cards and show the one with the lowest predicted recall. Superseded by [Piles, labels and languages](#piles-labels-and-languages): the model's predictions are unreliable at the minute scale (a simulation with the real weights gave P(recall) of 0.5 to 0.8 seconds after a correct answer, and 8% of Got it cards came back in the same sitting), so the model decides which cards and on which days, and a dealt pile decides the order within a sitting. Each answer is still fed to the model at once, and the table refreshes all piles' predictions in one engine call.

**Known limit.** All recurrent state is held in memory, about 70 KB per card: roughly 0.5 GB after a year of daily use. Fine for months; before then states need to live on disk and be loaded on demand, which matters most for iPhone memory limits.

## Card enrichment

Adding a word creates the card immediately; anything the app adds to it later arrives as ordinary events (`asset_attached`), so it syncs and works offline like typed content. Built today: pictures and pronunciation. The user types the translation and the example.

**Text (not built)**

The plan: one Workers AI chat call returns strict JSON (`translation, part_of_speech, gender_or_article, definition, examples[2]`), filling the field the user did not type. Responses cached in D1 by `(word, from, to)`, so a second user adding the same word pays nothing. A word summary (forms, usage) would sit behind the cream side, stored like pictures; on the white side it would give the answer away.

**Picture**

A small LLM (Granite 4.0 micro) writes one concrete scene for one meaning. The meaning is chosen first: the user's choice, else the only listed meaning, else a separate LLM call picks one of the listed meanings using the example, else the first. The scene is written from the word and the meaning only, never the example (given one, the LLM drew the sentence's situation instead of the word). FLUX.2 klein 4B draws it at 768×512 in one house style: one free-standing cut-paper cut-out with a hand-cut outline on white (the medium first in the prompt, or it drifts to photos). No writing: the picture is on the known side, so a drawn word gives the answer away; quotes and dialogue the LLM writes anyway are stripped in code.

- When: on the card editor while typing (see above); any other word when it comes up: the next 10 cards of each pile are queued from the table and after each card in study, behind pictures needed now, so they are on the device when the card shows, offline too.
- The client keeps jobs in IndexedDB (per device, not synced; the result syncs as `asset_attached`), flattens the photographed paper to pure white so cards show through, and stores the picture for offline study.
- The user can redraw with extra details, or remove it; a removed picture is never redrawn automatically.
- A forward card shows the picture with the answer (cream side); a reverse card shows it as part of the cue.

**Pronunciation**

Azure neural voices, one per language (Spanish, English, Russian and about 15 more), 10% slower than normal. The Worker serves `tts/<voice>/<sha256 of the text>.mp3` from R2, making it once with Azure Speech when missing, so a word costs Azure characters only the first time for anyone. The client downloads the word and example of the cards coming up along with their pictures, keeps them in IndexedDB and plays them with Web Audio (iOS's silent switch doesn't mute it). Audio not on the device is fetched for up to 1.5 s, else the browser voice (Web Speech API) speaks. A forward card says its word when it comes up, a reverse card when turned to the word side; the example has its own speak button. No voice choice: one good voice per language.

**Cost at this scale**

- Pictures: Workers AI bills $0.011 per 1,000 neurons with 10,000 free per day ([pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)). A picture costs about 60 neurons; the Worker reserves them in D1 and answers 429 past the daily budget, and the client queue waits for the UTC reset. So about 160 pictures a day stay free.
- Speech: the key belongs to another app's free Azure resource (F0, 500k characters a month shared between both apps). This app is capped at 100k characters a month in D1; past it, 429 and the browser voice.

## Piles, labels and languages

Nov 24, 2026. Agreed and built, in the order of the plan at the end of this section.

**Guiding rule.** The app behaves like real cards: a box of words, a table with a spot per pile, a dealer who deals each pile in the morning, and a tray for cards done today. Each rule below should make sense in that picture.

**Words, faces and languages**

- A word (note) is one physical card with two faces: the studied language on the white side, the known language on the cream side. Each face is a separate card in the data (forward, reverse) with its own memory in the model.
- The UI shows only the studied language ("Spanish"). Each word also records its translation's language, picked per word when it is added (default: the last pick for that studied language) and never changed: a word added wrong is deleted and added again. The translation's language marks the cream side's language and will choose the language for filled-in translations and explanations; nothing groups by it.
- There are no decks in the UI. The model still gets a group per studied language as `deck_id`, derived from the language (old words keep their deck ids), so two devices that add a language offline get the same group. Nothing else reads it.
- Word ids stay random on every add. The same word added on two offline devices becomes two words after sync, and re-adding a deleted word starts fresh. Both are accepted.

**Labels**

- A label is a name stuck on words (the UI calls it a sticker). Many to many, across languages. Labels never reach the model.
- A sticker has an id and a name. A new name gets an id derived from it (compared ignoring case and extra spaces), so the same sticker made on two offline devices is one; a name whose derived id was used before (renamed or deleted since) gets a random id. Names are at most 30 characters.
- A sticker stays until deleted, even with no words on it. Renaming changes only its name (last write wins), so its words and its pile stay. Renaming to another sticker's name merges into that one (its words get it, this one is deleted). Deleting takes it off every word and its pile off the table; the words stay.
- Each sticker has a paper colour from a small palette (yellow, pink, blue, orange, lilac, mint). A new one gets the colour fewest stickers have, recorded when it is made; the pencil sheet changes it (a row of dot stickers, last write wins). Everywhere a sticker shows takes its colour: its chip (a deeper shade when open), the dots in Edit, its name under its pile, the sheets. Stickers made before colours get one from their id.
- Language is not a label: it cannot be peeled off. Words in the user's own language (a subject such as pharmacology) are Russian words with Russian explanations plus a label.

**The table (Study tab)**

- One pile per studied language, whatever its words' translations are in, then one per sticker (by name). Piles named per pair before (`lang:es>en`) read as the studied language's pile.
- Spots are printed on the table, two per row. A pile is a stack on its spot whose thickness shows how many cards are left, with the count written under it. The top card lies face up, and the cards under it show their edges, white or cream.
- A sticker with no words has its spot printed empty ("no words yet"); a tap opens Words on it, in Edit.
- After the last pile, always, one more spot printed empty with a plus: New pile. It asks for a name, makes the sticker, and opens Words on it in Edit to stick it on words.
- Looking at the table deals nothing: it shows the pile the dealer would deal. The deal is recorded when the pile is first studied that day.
- A finished pile leaves its spot empty with a pencil check (drawn in one stroke when the user comes back from clearing it, with a few bits of coloured paper jumping off it). Tapping the spot offers "Deal 5 more", "Go through these N again" (the cards finished from that pile today) and, when nothing is left to learn, "Add words". A sticker's pile offers "Deal 5 more" (when it has more than 5 words), "Deal all N" (every word of the sticker once, one face each: going over a topic before a trip or a test) and "Go through these N again". Either refill drops the cards onto the spot as one handful (bottom card first, the top one last, face up as it lies); studying them takes a tap on the pile, like any pile. Gathered cards lie there until studied, for the rest of that day.

**Piles**

1. Every day (at the rollover hour, 4:00) each pile is dealt its size.
2. A pile fixes how many cards, not which. A card is chosen when it is drawn: the one in the pile's words that needs the user most right then.
3. A card that has been seen stays fixed: the face-up top card, the card peeked under it while throwing, and cards answered Again. Deeper cards show only an edge, so only their colour is fixed: the card drawn into that spot lies the same side up (the neediest card of that colour), unless no card of that colour is left. Again tucks the card under its pile, same face up, and it stays there past the rollover, on top of the next deal.
4. Got it or Easy puts the card in the done tray for the day, in every pile.

What "needs the user most" means:

| Pile | Cards it draws |
| --- | --- |
| Language | Words below target recall now, weakest first; then new words, only into space left after due words, at most 10 a day per studied language |
| Sticker | The same from its words, any language; its new words aren't held back by the daily limit (the pile's size caps them) but count toward their language's 10, so that language's pile gets fewer that day. After "5 more" or "All N" that day: every word once, due or not, weakest first, words done today last, never-seen ones freely, and those new words don't count toward any language's limit |

- A face is not drawn within an hour of its twin being answered (it would be a free point and teach the model a false strength), unless nothing else is left. A new word's second face starts on a later day.
- No two piles show the same word on top, unless the word is all a pile has left. If a pile's top card gets done in another pile, the next card comes up.
- A card answered Again lies under that pile only: other piles don't draw it while it is one of that pile's words (peeled off, or its sticker deleted, it is free again).
- "5 more" raises the new-word limit of a language's pile by what it deals.
- Size: starts at 20; +5 for the next deal when the user took "5 more" ("All N" is a one-off and doesn't count); -5 when a pile was left unfinished at the rollover; between 10 and 50.
- When a pile is empty, study goes back to the table; its spot offers "Go through these N again" (exactly the same cards once more) and "5 more" (from the same words).
- Words marked known in the list need no rule: they no longer need the user, so they are not drawn.

**Words screen**

- One list. Above it, two lines of chips: languages (when there are two or more), then stickers by name on one line that scrolls sideways (fading at the edge), with a dotted "+ Sticker" at its end; the open one is scrolled into view. One chip open at a time, never combined; the search narrows inside it. To combine, select words and stick a new sticker on them.
- The open sticker's chip has a pencil: a sheet to rename it (or merge, when the name is another sticker's) or delete it.
- With a sticker open, Edit sits next to Select. Only the line above the list changes ("Tap words to stick on or peel off · Done"): the list becomes every word, a yellow dot sticker on those wearing it, a dotted ring on the others, and each tap sticks or peels at once. "+ Sticker" (or New pile on the table) names a sticker, makes it, opens it and starts Edit.
- A sticker with no words: the ruled sheet says "No words yet." and a pencil note, "add words", has an arrow drawn up to Edit. No other buttons; deleting is in the pencil sheet.
- Selecting words offers "Stickers" (with I know, Don't know, Delete): a sheet with every sticker as a box (on for all, some, none; a tap sticks it on all or peels it off all, at once) and a field for a new one. The card editor shows a card's stickers on its corner, a tap peels one off, "+ Sticker" opens the same sheet.
- A card added while a sticker is open starts with it on its corner (a tap peels it off); an import sticks a sticker naming its source ("Duocards").
- The back gesture closes a sheet, Select or Edit before it leaves the screen.

**The card editor (Add and Edit)**

Add ("Add a card") and Edit ("Edit card") are one screen that looks like the card itself, both sides at once: stacked on a phone, side by side from 900 px. Nothing is written until Add or Save; back drops every change, a redrawn picture included.

- White side: the word with its speak button, an example, the user's own note; the card's stickers on its corner with "+ Sticker". Cream side: the translation, the picture with "+ how it looks" under it, the user's own note. Places left empty show nothing in study.
- A blank card has pencil notes with arrows pointing at its places: "the *Spanish* word goes here", "its *English* translation goes here", "an example, if you like". The language names are words that pick the language (a native picker; "Add a language…" opens a sheet and keeps what was typed). Once a place is filled its note shrinks to the arrow and the language. On Edit the languages are plain pencil: a card's pair is fixed.
- The studied language is the last one used (opening a language in Words or studying its pile counts); the translation's language is remembered per studied language.
- Picture: once both words are in, the picture space mirrors the translation in pencil; 1.5 s after typing pauses (at once on Enter or leaving the field) it draws, and typing more draws again. "+ how it looks" opens a details line with Redraw and No picture. There is no meaning to choose: the meaning is the translation. Offline or past the daily budget it says so, and Add leaves the picture to the queue.
- Add takes the picture along; one still drawing follows the card when it arrives (never drawn twice), and the queue draws it only if that drawing fails. After Add: a fresh blank card, same languages, and the cards added this sitting under it (a tap opens Edit).
- Duplicates: the same word with the same translation and pair is refused ("this card is already in your words", with a link); the same word with another translation gets a pencil note ("you already have *banco* · bench"), told as soon as typing pauses.
- Edit: Save writes only what changed; "Delete card" under it. A removed picture is not redrawn by word edits, only by Redraw. Leaving the editor goes one step back in history, to where it was opened. A card opened from the editor itself (its "you already have" note, or the cards added this sitting) opens on top of the card being filled in: leaving it (back, the gesture, Save, Delete) puts that card back exactly as it was.
- In study, a pencil in the corner of a turned card opens it in the editor; back returns to the same card, still turned over, with the changes, and the time spent editing doesn't count toward the answer.

Planned: the LLM filling the other field (the user types in either, the field typed into is the side, so nothing needs detecting); the studied language from a sticker's most common language; later maybe drawing on the card and moving its blocks.

**Events and sync**

Everything above is a fold over the log, so it syncs:

| Addition | Payload | Rule |
| --- | --- | --- |
| `label_created` | `label_id, name` | Made again with an existing id: only the name counts (last write wins) |
| `label_renamed` | `label_id, name` | Last write wins |
| `label_deleted` | `label_id` | For good; the id is never reused |
| `label_colored` | `label_id, color` | Last write wins (`label_created` carries the first colour) |
| `notes_labeled` | `label_id, note_ids, on` | Last write wins per word and sticker |
| `review.pile` | the pile key: `lang:es` (older: `lang:es>en`, read as `lang:es`) or `label:<id>`; absent when not answered from a pile | Which pile the answer came from |
| `pile_dealt` | `pile, day, n, more, all?` | The day's deal (`more` false; two devices dealing offline count the largest once), each "more", and "All N" (`all`) |

Done today, cards waiting under a pile, cards left in a pile and each pile's size are all derived from these. The deal is recorded (not just "more") so that a pile left unfinished can be told from one that ran out of cards. Only what is on screen right now (the top card and the one under it) stays on the device. Two devices studying the same pile offline both deal it; after sync the answers merge and the pile may show none left.

**Plan**

1. This section.
2. Fixed piles inside the current Study screen and its end screen. Hands-on review on a phone.
3. The table on the Study tab (layout B: printed spots; finished spots tapped for choices). Built; hands-on review.
4. No decks: languages on the word, one pile and model group per studied language, the translation's language per word, language chips in Words. Built; hands-on review.
5. Labels as stickers: events, the Words chips, Edit, the pencil and Stickers sheets, sticker piles on the table with "Deal all N", the New pile spot, the back gesture. Sticker colours. Built; hands-on review.

6. The card editor for Add and Edit, with the pencil from study. Built; hands-on review.

Later: the LLM filling the other field on the card editor; an LLM summary of the word (forms, usage) behind the cream side; the new-word count predicted by the model from future workload; whether a card's language pair can change (today it is fixed: delete and add it again).

## Identity and pairing

No sign-in. The user code is the account: whoever holds it can read and write that user's events.

- **First launch.** Generate a random 16-character code (base32, about 80 bits) and store it locally. Sync, and with it the server copy that serves as the backup, is on from the start.
- **New device.** Settings shows a QR code of `https://<app>/#k=<code>` plus the code as text. Scanning the QR, opening the link or typing the code joins that account: this device's events are pushed to it and everything is pulled. The `#` fragment never reaches the server logs.
- **Requests.** Every sync, picture and speech call sends `X-User-Code`; the Worker uses it as the partition key.
- **Lost code.** Data is unrecoverable if every device and the code are lost. Not built: showing the code once at first launch with a prompt to save it.
- **Abuse guard.** Only the shared daily picture budget and monthly speech budget exist. Not built: a per-IP rate limit on new codes and on the AI endpoints, and a per-user storage cap in R2.

No encryption at rest beyond what Cloudflare provides; acceptable for about 3 users.

## Milestones and risks

RWKV goes first because it is the reason for the project and the biggest unknown.

**Milestones**

1. **RWKV runs in the browser.** Done: the V1 engine in Wasm matches upstream goldens; phone replay measured.
2. **Local app.** Done: PWA shell, event log in Dexie, words, study driven by RWKV, no network needed.
3. **Sync.** Done: Worker + D1 push and pull, user code, QR pairing, full replay on late reviews.
4. **Enrichment.** Pictures and pronunciation done. Text (translation, definition, examples, word summary) not built.
5. **Piles, stickers, no decks.** Done (see [Piles, labels and languages](#piles-labels-and-languages)).
6. **Nice-to-haves.** Duocards import done. Not built: Anki import, stats and calibration charts, WebGPU.

**Not built yet**, besides the above: the LLM filling a card's other field; iPhone haptics (Android vibrates; iOS needs the iOS 18 switch-checkbox trick); recurrent states on disk (see RWKV in Wasm, Known limit); the save-your-code prompt and the abuse guard (see Identity and pairing).

**Risks**

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Full replay too slow on a phone in scalar Wasm | First launch on a new device takes long | Measured: ~770 reviews/s on Android, under two minutes for a year. If it grows: upload a checkpoint to R2 for new devices, or `simd128` |
| Recurrent state grows ~70 KB per card in memory | iPhone tab killed after a year or so | States on disk, loaded on demand (not built) |
| rwkv-srs API and checkpoint format are pre-1.0 | Upstream changes break the port | Own reimplementation of V1, checked against goldens from v0.1.1; our own checkpoint format |
| Mobile browser evicts IndexedDB storage | Local log lost | Server is the durable copy; the app calls `navigator.storage.persist()` |
| Weak or missing OS voices for a language | Poor pronunciation | Azure neural voices stored in R2; the browser voice only as fallback |
| Free tiers run out (Workers AI neurons, Azure characters shared with another app) | No new pictures or audio that day/month | Budgets in D1 below the free tiers; the client waits for the reset or uses the browser voice |
| Card content edits racing across devices | A field edit lost | Per-field last write wins is accepted at this scale |

**Open questions**

- Card templates beyond forward and reverse (typing answers, cloze).
- Whether words can be edited beyond their fields (language pair, merging duplicates made on two offline devices).

## References

- [RWKV4Anki](https://github.com/zaguk/RWKV4Anki), the Anki add-on this design borrows from (live session engine, review schema)
- [rwkv-srs](https://github.com/zaguk/rwkv-srs), the Rust RWKV runtime and model weights
- [srs-benchmark RWKV](https://github.com/open-spaced-repetition/srs-benchmark/tree/main/rwkv), the original model and its benchmark results
- [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)
