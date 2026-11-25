# Card editor: Add and Edit as one blank card

## Overview

Add and Edit become one screen that looks like the card itself: a blank card with pencil arrow notes pointing at the places to fill in. Both sides are visible at once: stacked on phones (white side above the cream side), side by side on wide screens. The picture draws itself from the two words while the card is filled in, and is changed on the card itself. A pencil on a turned-over card in study opens the same editor.

It replaces today's two plain forms (Add, Edit) and the separate picture editor box. Guiding rule: fewest taps; anything redoable happens automatically, buttons only change the result.

Mockups: https://claude.ai/artifact/2amCHokAgdXWZZynNPjzcV (layout A "Stacked"; the "Picture" row; the "Languages" row, variant 2 "In the arrow notes").

## Agreed behaviour

**The screen**
- Header: back + "Add a card" / "Edit card".
- White side: the word, centred, with the speak button in its line; the example; a "✎ a note of your own" line; stickers stuck on the top corner next to the dotted "+ Sticker" chip from Words (tap a sticker to peel it off; with a sticker open in Words, a new card starts with it on).
- Cream side: the translation; the picture with "+ how it looks" under it; a "✎ a note of your own" line.

**Arrow notes and languages**
- An empty place has a pencil note with an arrow: "the *Spanish* word goes here", "its *English* translation goes here", "an example, if you like".
- The language name in the note is blue with a dotted underline and picks the language (the list ends with "Add a language…"). Once the place is filled, the note shrinks to the arrow and the language name.
- On Edit the language names are plain pencil: a card's languages never change.
- In study, empty places show nothing.

**Picture**
- Once both words are in, the picture space shows in pencil what will be drawn.
- About 1.5 s after typing stops (at once on Enter or leaving the field) it starts drawing; typing more drops that drawing and draws again after the next pause. An occasional wasted drawing is accepted.
- "+ how it looks" opens a details line on the card with Redraw and No picture.
- The meaning drawn is the translation; no meaning choices.
- Offline or past today's free pictures: the picture space says so, and the picture arrives after Add as today.
- Later, an LLM fills the translation after the same pause, and the picture follows it.

**Saving**
- Add on a new card, Save on Edit. Back without saving drops every change, a redrawn picture included.
- "Delete card" is quiet, under Save.
- The editor says "card"; the Words tab keeps its name.

**After Add**
- A fresh blank card at once, keyboard on the word.
- The cards added this sitting are listed under it (word · translation · small picture); a tap opens Edit.

**Duplicates**
- Add refuses an exact repeat: same word, same translation, same language pair (case, spaces and Unicode form ignored), with "this card is already in your words" and a link to it.
- The same word in the same pair with another translation is allowed, but a pencil note says "you already have *banco* · bench" (opens that card) as soon as typing the word pauses.
- The importer's duplicate rule stays as it is.

**Own notes**
- One optional pencil note per side, shown in pencil on that side in study.

**From study**
- Once the card is turned over, a small pencil lies in its corner; it opens the editor on that word.
- Back returns to study: the same card on top, still turned over, with the changes; it is answered as usual.

## Architecture

- **Draft until Add or Save.** The card being filled in lives only on the screen. Add writes the card, its stickers and its picture together; Save writes only what changed. Nothing syncs before that; leaving writes nothing.
- **Draft pictures.** Drawing while typing goes straight to the picture service, outside the picture queue (which only knows cards that already exist). The result is downloaded and kept on the device like any picture, shown as the draft, and becomes the card's picture on Add or Save. A newer drawing makes an older one's result be ignored. An abandoned drawing stays unused on the server; accepted at this scale. Offline or past the limit, Add falls back to the queue.
- **Own notes** are two new optional text fields on a card. Existing cards need no change.
- **Room to grow.** Every place on the card is named after the field it shows, so moving blocks (a layout event) or drawing on the card (a stored image per side) can come later without redoing existing cards.
- **Study → Edit** is a step in the browser history above study, so back returns to study. Study already keeps the top card fixed per device; it also remembers that the card was turned over.
- **What Add and Save write** is worked out apart from the screen (no browser needed), so tests cover it directly; the editor screen only draws and collects input.
- **A picture still drawing at Add or Save** never causes a second drawing: the card is saved without it, and the drawing becomes its picture when it arrives (if the card still has none). The picture queue takes over only when drawing failed, is offline or hit the limit. Giving a card its picture this way also cancels any drawing the queue had waiting for that card, so the queue can't overwrite it later.
- **Picture states on Edit:** waiting for the limit, failed with "Try again", queued: shown on the card, replacing what the old picture box showed.
- **A removed picture** ("No picture") is not brought back by editing the words; only Redraw does that. Editing nothing, or just leaving a field, never redraws.
- **Stickers on a draft:** sticking and peeling are part of the draft (Add/Save write them). A new sticker made from the sheet exists at once, like stickers made in Words.
- **Languages on a draft:** picking another language, or adding a new one, changes the draft in place (the new-language form opens as a sheet); nothing typed is lost.
- **Leaving the editor** (back, Save, Delete) goes one step back in history: to study when opened from study, to Words otherwise, also after a reload.
- **Study round trip:** the turned-over state belongs to that card; if it is no longer on top when study comes back (deleted, answered on another device), nothing comes up turned. Time spent in the editor doesn't count toward the answer's time (the model uses it).
- **Same-word note** never counts the card being edited.
- **Unchanged:** the picture service on the server, the speak button, the importer.

## Development approach

- One task at a time, one commit per task; tests written in the same task and passing before the next.
- The UI smoke test is the end-to-end test; UI tasks update its walk in the same task.
- Old cards and old events keep working.
- Keep this plan in sync: ✓ done items, ➕ for new tasks, ⚠️ for blockers.

## Implementation steps

### Task 1: Duplicate rules and own notes
- [x] the duplicate rule: exact repeat (word + translation + language pair) and same word (word + language pair)
- [x] the two own-note fields on cards
- [x] what Add and Save write, worked out from a draft without the screen (used from task 3 on)
- [x] tests: exact repeat, same word with another translation, another language pair, deleted cards, the edited card itself; notes stored and edited; what Add/Save write for a few drafts
- [x] all tests pass

### Task 2: Draft pictures
- [x] draw a picture for words that aren't a card yet, keep it on the device, hand it to Add/Save
- [x] a newer drawing supersedes an older one; offline, limit reached and failure are reported
- [x] a drawing that finishes after Add/Save becomes that card's picture (if it has none yet); the queue only takes over on offline/limit/failure
- [x] giving a card its picture cancels any queued drawing for that card
- [x] tests: success, a superseded drawing ignored, offline, limit, failure, finishing after Add, a queued drawing cancelled
- [x] all tests pass

### Task 3: The card editor as the Add screen
- [x] the blank card: both sides stacked, arrow notes with the languages in them, stickers corner, own notes
- [x] the Stickers sheet and the language picker (incl. adding a language) work on a draft without losing what was typed
- [x] the picture space and its states (hint, pencil mirror, drawing, drawn, details, offline/limit)
- [x] the same-word note and the exact-repeat refusal
- [x] Add writes everything at once; then a fresh card and the "added just now" list
- [x] tests: what Add writes (with and without a picture, with a sticker, with notes), duplicates (in task 1's rules tests; the screen itself is covered by the smoke test)
- [x] smoke test: fill in a card, picture appears, Add, fresh card and list; every other step of the walk that used the old Add form (picture status, a second language, a translation into another language) moved to the editor
- [x] all tests and the smoke test pass

### Task 4: Edit on the same editor
- [ ] Edit opens the card filled in, languages fixed, stickers and picture changeable on the card
- [ ] the card shows the queue's picture states (waiting, failed with Try again); a removed picture is not redrawn by word edits
- [ ] back, Save and Delete go one step back in history
- [ ] Save writes only the changes; back writes nothing; Delete card
- [ ] the old Edit form and the separate picture editor removed
- [ ] tests: what Save writes (nothing changed, one field, picture, stickers, removed picture kept removed), back, delete; leaving the editor returns to where it was opened from
- [ ] smoke test: open a word from Words, change it, Save
- [ ] all tests and the smoke test pass

### Task 5: Study: own notes and the pencil
- [ ] own notes shown in pencil on their sides
- [ ] the pencil on a turned-over card opens the editor; back returns to the same card, still turned over, with the changes
- [ ] the turned state belongs to that card only; editing time doesn't count toward the answer's time
- [ ] tests: back from the editor returns to study (also after a reload); the top card and its turned state survive the round trip; a card replaced meanwhile doesn't come up turned; answer time excludes editing
- [ ] smoke test: study, turn over, pencil, change, Save, back on the same card
- [ ] all tests and the smoke test pass

### Task 6: Wide screens and final pass
- [ ] side by side on wide screens
- [ ] a final clean-up pass over the editor and the study pencil (`/unslop-ui`)
- [ ] screenshots of the phone and wide layouts checked
- [ ] all tests and the smoke test pass

### Task 7: Verify
- [ ] everything under "Agreed behaviour" works in the dev server
- [ ] edge cases: offline add, limit reached, Add while the picture is still drawing, abandoned card, edit from study and back, two languages, a removed picture
- [ ] build, tests and smoke test pass

### Task 8: Documentation
- [ ] `docs/design.md`: a "Card editor" section; picture timing; own notes in the data model
- [ ] `CLAUDE.md`: layout and UX notes for the editor and the study pencil
- [ ] move this plan to `docs/plans/completed/`

## Post-completion

- Try it on the Android phone and the iPhone: keyboard Enter/Next, the pause before drawing, the added list, study → pencil → back (back gesture too), and a wide screen.
- Deploy to preview; production only when asked.
