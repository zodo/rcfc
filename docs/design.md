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
| `note_restored` | `note_id` | Undo of a delete; the later of `note_deleted` / `note_restored` wins |
| `notes_prioritized` | `note_ids` | "Don't know" on unseen words: learn them before other new words, latest first |
| `asset_attached` | `note_id, kind: image, r2_key, sense?, details?, scene?` | The picture lives in R2; `r2_key` null = removed (never redrawn automatically); last write wins per note |
| `review` | see below | Append-only, never edited |
| `pile_dealt`, `label_created`, `label_renamed`, `label_deleted`, `label_colored`, `notes_labeled` | see [Events and sync](#piles-labels-and-languages) under Piles | Piles and stickers |

Spoken audio is not an event: it is made on demand from the text and cached by its hash (see Pronunciation).

**Review payload (fields rwkv-srs needs)**

The model takes the add-on's `RWKV_SRS_PROCESS_FIELDS`: `review_id, card_id, note_id, deck_id, preset_id, day_offset, elapsed_days, elapsed_seconds, rating, duration, state`. The event stores only raw facts: `card_id, note_id, deck_id, preset_id` as of the answer, `rating` 1 to 4, `duration_ms`, `tz_offset_min` (local day boundaries survive travel), `pile` (which pile it was answered from) and the envelope `ts`. `day_offset`, the elapsed values and `state` are derived at replay (`src/domain/rows.ts`, following RWKV4Anki `review_rows.py`), so a change of rollover hour needs no migration. Changing that derivation bumps `ROWS_VERSION`, which forces a full replay.

**Imports.** One way in for words from elsewhere: [Import from anything](#import-from-anything), through an AI chat. The Duocards importer it replaced is gone (`source.kind: "duocards"` stays readable in old logs). Anki review history (map `revlog` rows to `review` events so RWKV starts warm) is not imported.

## Import from anything

Words come from anywhere (another app's export, a tutor's notes, a topic) through the user's own AI chat. The app writes no importer per app: the AI converts.

- **Screen** (`src/screens/import.ts`, from "Import from anything" under the card editor and in an empty Words): "Copy prompt for your AI chat", then a box to paste the AI's answer ("or pick a file" for a downloaded one). A preview shows as soon as text lands: how many words, per language pair (a language not studied yet says so), how many known / learning, the stickers, the first few words, what's skipped (already in your words, repeated) and rows that couldn't be read. Rows naming no language get pickers (defaults from the script: Cyrillic, kana…, else the last language). "Add N words" adds them and opens Words on their sticker (or language).
- **Prompt** (`importPrompt` in `src/import/anything.ts`), tested on a focus group of fresh Haiku agents playing the AI (exports from Anki, Quizlet, Duolingo, Memrise, Excel; vague, lazy and non-English users). It says what the app and a card are; two ways to help (convert an export keeping tags and progress, or talk through what to learn, asking one or two questions when the request is vague); one CSV code block with a fixed header (`word,translation,example,lang,to,note,translation_note,picture,stickers,status`), no file; languages per row (the user's studied languages only as the usual default, never a constraint); tips a few words long in their side's language; `picture` only when another meaning could be drawn instead; stickers from the source's tags/lessons or on request, else empty, and offered afterwards; where to paste (Words → Add → Import from anything). Reply language: the prompt is English but the user may not speak it. "Reply in the language we usually talk in" sits at the very end, and the last line ("Here's my export, or what I'd like to learn:") is in the language the user's translations are mostly in. With the rule higher up, a German user pasting a bare table got English twice; with both at the end, German.
- **Reader** (`readImport`): far more permissive than the prompt says, and never announced. The code blocks of a whole chat reply (a cut-off last fence too; several blocks joined; a header repeated inside skipped), else the first header line in plain text (the table ends at a blank line); comma, tab, semicolon or a markdown table; column names in other words and languages (`front/back/hint`, `Sort Field/Answer/Tags`, `Wort/Übersetzung/Gelernt?`) or named by language (`Japanese,Kana,English`); language codes, ISO 639-2, regional (`es-MX`) or names in any app language; progress as words in several languages, fractions (`4/4`), percentages, or a scheduler interval (≥ 3 weeks = known); dates in the usual shapes. The prompt itself pasted back is skipped (its header line). Unknown columns are ignored. A raw Duocards export (`front,back,hint,publishedAt`) reads directly, no AI: its studied language comes from the file's name (`duo_cards_es_export.csv`, `fileLang`; also a language name in any file's name), its dates keep the order the words were added in.
- **Plan** (`planImport`): settles each row's pair, skips words already there (same word, translation and pair) or repeated, so pasting twice adds nothing; dated rows go oldest first.
- **Progress** has three honest levels, no made-up history (the model learns from real answers): new; learning = learned before other new words (`notes_prioritized`, as "Don't know" on an unseen word); known = both faces answered Easy once at import (as "I know"), scheduled far out and still checked.
- **Writes** (`Store.importWords`): notes with both cards (`source.kind: "import"`, `created_at` when dated), `note` → `memo_target`, `translation_note` → `memo_known`, `picture` → note field `picture_details` (the queue draws with it when the word comes up, the editor shows it as "how it looks"; nothing is drawn or filled at import; opening a word without a picture in the editor draws it at once, and it stays the card's even if the card is left unsaved), stickers made when new and stuck on.

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
| `POST /api/fill` | `{from, to, word?, translation?}`, header `X-User-Code` | `{options: [{word, translation, example}], suggest?}`; 429 with `retry_after` past the daily budget |
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

Adding a word creates the card immediately; anything the app adds to it later arrives as ordinary events (`asset_attached`), so it syncs and works offline like typed content. Built: filling in the card editor, pictures and pronunciation.

**Filling in**

The card editor fills in what the user didn't type, at the same typing pause that draws the picture. The side typed into says which language it is, so nothing is detected:
- the word typed: its translation, an example and its other meanings ("or: bench", a tap swaps it in with its own example, and the picture follows);
- the translation typed: the word (with its article where nouns take one), an example and other usual words for it;
- both typed: an example, if the user hasn't written one.

While it waits, a short worn pencil draws three dots where the text of the first place being filled in will begin (each a few tight circles: a pencil can't just dot), turns over and rubs them out with its eraser, never quite clean, and draws them again; when the answer comes the smudges go and the same pencil writes each place in turn, letter by letter (the word or translation first, then the example, travelling across the card), and lifts off; what else it offers shows once it is written. A tap anywhere on the card shows everything written at once. Nothing moves when a fill lands: "or:" and "did you mean" sit on the arrow note's line, and a filled example and a picture still to come keep their notes' room. With reduced motion the text just appears.

When the typed word isn't in dictionary form, is misspelled, or is a noun without its article, a pencil note asks "did you mean *el banco*?"; a tap takes it, nothing changes otherwise. A fill never writes over what the user typed; typing in a filled-in place makes it the user's; emptying the words typed takes the fill back. Add waits for a fill still on its way (8 s at most).

One Workers AI call (Gemma 4 26B A4B, thinking off, JSON schema) answers `{suggest, options: [{word, translation, example}]}`, most common meaning first, at most three. Chosen over Mistral Small 3.1 and Llama 4 Scout on 22 words across six languages (they mistranslated, answered in the wrong language, or missed inflected forms); about 1.5 to 4 s and ~15 neurons a fill, from the pictures' daily budget. Replies are kept in R2 by language pair and text (`fill/<sha256>.json`, versioned with the prompt), so the same words cost nothing again, for anyone. Offline, past the limit or on failure the places stay empty for the user to fill.


**Picture**

An LLM (Gemma 4 26B A4B, the same one that fills cards in) writes one concrete scene for one meaning. It replaced Granite 4.0 micro, which drew the wrong meaning of 4 in 26 words that have two (a bench for *banco* = bank, mountains for *sierra* = saw, cola drinks for *cola* = queue) and put rooms and skies behind the subject. The meaning is chosen first: the user's choice, else the only listed meaning, else a separate LLM call picks one of the listed meanings using the example, else the first. The scene is written from the word and the meaning only, never the example (given one, the LLM drew the sentence's situation instead of the word). FLUX.2 klein 4B draws it at 768×512 in one house style: one free-standing cut-paper cut-out with a hand-cut outline on white (the medium first in the prompt, or it drifts to photos). No writing: the picture is on the known side, so a drawn word gives the answer away; quotes and dialogue the LLM writes anyway are stripped in code.

- When: on the card editor while typing (see above); any other word when it comes up: the next 10 cards of each pile are queued from the table and after each card in study, behind pictures needed now, so they are on the device when the card shows, offline too.
- The client keeps jobs in IndexedDB (per device, not synced; the result syncs as `asset_attached`), flattens the photographed paper to pure white so cards show through, and stores the picture for offline study.
- The user can redraw with extra details, or remove it; a removed picture is never redrawn automatically.
- While it draws (about 6 s; FLUX.2 klein takes 5 to 7 s whatever the size, so the wait is filled, not shortened): the server streams the meaning, then the scene as the LLM writes it (first words after ~0.4 s), then the picture, as NDJSON lines on one request. The same worn pencil as the fills writes the meaning and then the scene into the picture's place at a steady handwriting pace; written out, it rests, strikes the scene through with a quick untidy line (the meaning stays), and thinking better of it writes the scene again right after it on the same line, again and again; a full box is rubbed out down to the meaning. Waiting for the scene after the meaning it doodles curls. When the picture comes it is brought in and stuck on over the note, as a camera over the card would see someone do it: from past the top of the screen, bigger (closer to the lens) with its shadow far off and soft, slowing over its place, hovering, then laid down as the shadow slides under it and sharpens (1 s); only then does the note under it go. In the card editor the picture always lies on its piece of white paper with a hand-cut edge (elsewhere a white background blends into the card). One pencil on the card: the note waits, with no pencil of its own, while the fill pencil writes or waits on a field, then goes on where it stopped. In the card editor for new words (a redraw of the same words keeps the old picture until the new one comes), and on a study card whose picture is still drawing. FLUX.1 schnell drew in ~2 s but slipped out of the house style in 4 of 12 words (framed panels, a photo-real hand), so klein stays.
- A forward card shows the picture with the answer (cream side); a reverse card shows it as part of the cue.

**Word notes**

What a good learner's dictionary says about a word in its meaning on the card: its forms (a verb's present and irregular tenses, a noun's plural, an adjective's gender forms), how it is used (prepositions, constructions, collocations), what not to mix it up with, register or region. No example sentences: the card has one.

- On the card: tiny print under the answer, on the answer side whichever side that is (on a reverse card the white side). Not physical, but on the question side it was readable on a sharp screen and gave the answer away. Faint, its room kept from the start, blank until notes are on the device.
- A tap on it (card turned) zooms in: the camera moves into the card (0.28 s), straightening the card's tilt, until the tiny print reads; the page itself, at reading size on the card's paper (grain as big and from the same corner as the zoomed card's), rides in on the card and fades in during the zoom, so when it ends the whole page is there at once and nothing is swapped (lines coming in one by one afterwards read as slow; a swap at the end showed as a blink and a shifted grain). The tiny print is that page scaled down. Switching the notes' language fades the new page in whole. It scrolls; back (button or gesture), Escape or a tap on the paper away from the text zooms out on a curve of its own (pulling away at once, settling softly). No pinch zoom: it is only an effect.
- Written in the studied language, simply (B1); a word on the zoomed page ("English") writes them in the known language instead, remembered per studied language on the device.
- One Workers AI call (DeepSeek V4.1 Flash, thinking off, JSON schema) answers `{gist, forms, notes}`, about 3-4 s and ~100 neurons, from the pictures' daily budget. Chosen on 10 Spanish words written in Spanish: Gemma 4 26B (5x cheaper) wrote things a learner would believe and shouldn't ("coger una decisión"), gpt-oss-120b was slow and often empty, Mistral Small 3.1 repeated lines and slipped into English. Kept in R2 by pair, language written in and words (`summary/<sha256>.json`), so a word costs once, for anyone.
- Not in the event log: the same words always get the same notes, so every device fetches them (free once made) and an edited word gets new ones. Downloaded ahead with the pictures' 10 coming cards, kept in IndexedDB for offline study; a word not downloaded is asked for when its card shows.

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
- A finished pile ends in study, on the table where it lay: its pencil check is drawn in one stroke, with a few bits of coloured paper jumping off it, over "Done for today" and how many cards were done today. The way out is the big button, "Back to the table". More is a small handful lying aside ("+10", "tap for 10 more"), there while there is more to deal: tapped, it drops onto the table where the pile lay and studying goes on. A finished handful ends the same way, with a second, blue check ("Bonus done", "another 10?"); from the second handful a pencil ×N sits by that check (never more than two checks). The finish is first, the extra is quiet, so stopping after any handful is still finishing.
- A finished pile leaves its spot empty with its checks (the same as study drew, ×N too, for the rest of the day). Tapping the spot offers "Deal 10 more", "Go through these N again" (the cards finished from that pile today) and, when nothing is left to learn, "Add words". A sticker's pile offers "Deal 10 more" (when it has more than 10 words), "Deal all N" (every word of the sticker once, one face each: going over a topic before a trip or a test) and "Go through these N again". Either refill drops the cards onto the spot as one handful (bottom card first, the top one last, face up as it lies); studying them takes a tap on the pile, like any pile. Gathered cards lie there until studied, for the rest of that day.

**Piles**

1. Every day (at the rollover hour, 4:00) each pile is dealt its size.
2. A pile fixes how many cards, not which. A card is chosen when it is drawn: the one in the pile's words that needs the user most right then.
3. A card that has been seen stays fixed: the face-up top card, the card peeked under it while throwing, and cards answered Again. Deeper cards show only an edge, so only their colour is fixed: the card drawn into that spot lies the same side up (the neediest card of that colour), unless no card of that colour is left. Again tucks the card under its pile, same face up, and it stays there past the rollover, on top of the next deal.
4. Got it or Easy puts the card in the done tray for the day, in every pile.

What "needs the user most" means:

| Pile | Cards it draws |
| --- | --- |
| Language | Words below target recall now, weakest first; then new words, only into space left after due words, at most 10 a day per studied language |
| Sticker | The same from its words, any language; its new words aren't held back by the daily limit (the pile's size caps them) but count toward their language's 10, so that language's pile gets fewer that day. After "10 more" or "All N" that day: every word once, due or not, weakest first, words done today last, never-seen ones freely, and those new words don't count toward any language's limit |

- A face is not drawn within an hour of its twin being answered (it would be a free point and teach the model a false strength), unless nothing else is left. A new word's second face starts on a later day.
- No two piles show the same word on top, unless the word is all a pile has left. If a pile's top card gets done in another pile, the next card comes up.
- A card answered Again lies under that pile only: other piles don't draw it while it is one of that pile's words (peeled off, or its sticker deleted, it is free again).
- "10 more" (a handful in study, or from the spot) raises the new-word limit of a language's pile by what it deals.
- Size: starts at 20; +5 for the next deal when the user took "10 more" that day, however many times ("All N" is a one-off and doesn't count); -5 when a pile was left unfinished at the rollover; between 10 and 50.
- When a pile is empty, study shows its finish with a handful of 10 more (from the same words); back on the table its spot offers "Go through these N again" (exactly the same cards once more) and "10 more".
- Words marked known in the list need no rule: "I know" answers both faces Easy, so they no longer need the user and are not drawn until the model finds them due, far out. (Marking only the face the user had seen left the other one unseen: drawn as a new card, first among new words and not counted against the limit, so a batch of known words filled the piles.) The daily new-word limit leaves out only words marked known (Easy outside any pile); a new card answered Easy in study counts like any other, so Easy answers can't let new cards in without end. Words marked on one face before this are repaired once per device, after a sync (so another device's repair arrives first): their unseen face is answered Easy.

**Words screen**

- One list. Above it, two lines of chips: languages (when there are two or more), then stickers by name on one line that scrolls sideways (fading at the edge), with a dotted "+ Sticker" at its end; the open one is scrolled into view. One chip open at a time, never combined; the search narrows inside it. To combine, select words and stick a new sticker on them.
- The open sticker's chip has a pencil: a sheet to rename it (or merge, when the name is another sticker's) or delete it.
- With a sticker open, Edit sits next to Select. Only the line above the list changes ("Tap words to stick on or peel off · Done"): the list becomes every word, a yellow dot sticker on those wearing it, a dotted ring on the others, and each tap sticks or peels at once. "+ Sticker" (or New pile on the table) names a sticker, makes it, opens it and starts Edit.
- A sticker with no words: the ruled sheet says "No words yet." and a pencil note, "add words", has an arrow drawn up to Edit. No other buttons; deleting is in the pencil sheet.
- Selecting words offers "Stickers" (with I know, Don't know, Delete): a sheet with every sticker as a box (on for all, some, none; a tap sticks it on all or peels it off all, at once) and a field for a new one. The card editor shows a card's stickers on its corner, a tap peels one off, "+ Sticker" opens the same sheet.
- A card added while a sticker is open starts with it on its corner (a tap peels it off); an import sticks on the stickers its rows name.
- The back gesture closes a sheet, Select or Edit before it leaves the screen.

**The card editor (Add and Edit)**

Add ("Add a card") and Edit ("Edit card") are one screen that looks like the card itself, both sides at once: stacked on a phone, side by side from 900 px. Its bar stays at the top and holds the one action: Add on a new card, a bin on a saved one; nothing sits at the bottom, where the keyboard covers it (with the keyboard open a phone shows 413 of 852 px on an iPhone 14 Pro, 343 of 667 on an SE).

- Adding is deliberate, editing isn't. A new card is written by Add (in the bar, or Enter on the translation, example or a note: a row of cards goes without leaving the keyboard). Leaving a card not added yet (back, the gesture, a tab) asks on a sheet: "*hola* isn't added yet" with Add *hola* and Keep editing; back again throws it away. Nothing typed: it just leaves. An edited card is saved when it is left, and a slip on the screen under it says "Saved *hola* · Undo" (Undo puts the card back as it was opened, picture and stickers included). The bin deletes at once: "Deleted *hola* · Undo" (`note_restored`).
- With the keyboard open and too little room for the whole card (`src/ui/fold.ts`), the side being typed on keeps all its places and the other is tucked under it, only its word or translation showing, like the card under the top one in a pile ("the other side, tap to turn it up" in pencil its first three turns). A tap on it, or Enter moving to it, pulls it out on top and the two slide past each other. The open cream side shows the picture small with "+ how it looks" beside it. Keyboard closed, or room enough (wide screens), the card lies whole.

- White side: the word with its speak button, an example, the user's own note; the card's stickers on its corner with "+ Sticker". Cream side: the translation, the picture with "+ how it looks" under it, the user's own note. Places left empty show nothing in study.
- A blank card has pencil notes with arrows pointing at its places: "the *Spanish* word goes here", "its *English* translation goes here", "an example, if you like". The language names are words that pick the language (a native picker; "Add a language…" opens a sheet and keeps what was typed). Once a place is filled its note shrinks to the arrow and the language. On Edit the languages are plain pencil: a card's pair is fixed.
- The studied language is the last one used (opening a language in Words or studying its pile counts); the translation's language is remembered per studied language.
- Picture: once both words are in, the picture space mirrors the translation in pencil; 1.5 s after typing pauses (at once on Enter or leaving the field) it draws, and typing more draws again. "+ how it looks" opens a details line with Redraw and No picture. There is no meaning to choose: the meaning is the translation. Offline or past the daily budget it says so, and Add leaves the picture to the queue.
- Add takes the picture along; one still drawing follows the card when it arrives (never drawn twice), and the queue draws it only if that drawing fails. After Add: a fresh blank card, same languages, and the cards added this sitting under it (a tap opens Edit).
- Duplicates: the same word with the same translation and pair is refused ("this card is already in your words", with a link); the same word with another translation gets a pencil note ("you already have *banco* · bench"), told as soon as typing pauses.
- Edit: leaving saves only what changed. A removed picture is not redrawn by word edits, only by Redraw. Leaving the editor goes one step back in history, to where it was opened. A card opened from the editor itself (its "you already have" note, or the cards added this sitting) opens on top of the card being filled in: leaving it (back, the gesture, the bin) puts that card back exactly as it was.
- In study, a pencil in the corner of a turned card opens it in the editor; back returns to the same card, still turned over, with the changes, and the time spent editing doesn't count toward the answer.

- Filling in: see [Card enrichment](#card-enrichment).

Planned: the studied language from a sticker's most common language; later maybe drawing on the card and moving its blocks.

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

Later: an LLM summary of the word (forms, usage) behind the cream side; the new-word count predicted by the model from future workload; whether a card's language pair can change (today it is fixed: delete and add it again).

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
4. **Enrichment.** Filling in (the other word, an example, other meanings, the word's dictionary form), pictures and pronunciation done. The word summary not built.
5. **Piles, stickers, no decks.** Done (see [Piles, labels and languages](#piles-labels-and-languages)).
6. **Nice-to-haves.** Import from anything (through an AI chat) done. Not built: Anki import, stats and calibration charts, WebGPU.

**Not built yet**, besides the above: iPhone haptics (Android vibrates; iOS needs the iOS 18 switch-checkbox trick); recurrent states on disk (see RWKV in Wasm, Known limit); the save-your-code prompt and the abuse guard (see Identity and pairing).

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
