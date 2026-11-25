// The card editor's rules, apart from the screen (docs/plans/20261125-card-editor.md):
// a card being filled in is a draft; Add and Save turn it into events, and the
// duplicate check compares it with the cards that exist.
import type { EventFactory, Note } from "./collection";
import type { AppEvent, AssetAttached, LangPair, NoteEdited, NoteFields, NotesLabeled } from "./events";
import type { EntityId } from "./ids";
import { noteKey } from "../import/duocards";

/** The user's own pencil notes, one per side: the studied language's (white) and the known language's (cream). */
export const MEMO_TARGET = "memo_target";
export const MEMO_KNOWN = "memo_known";

/** The text places of a card, in the order they are saved. */
export const TEXT_FIELDS = ["front", "back", "example", MEMO_TARGET, MEMO_KNOWN] as const;
export type TextField = (typeof TEXT_FIELDS)[number];

/** A picture drawn for the draft: what Add or Save attaches. */
export interface DraftPicture {
  key: string;
  sense?: string;
  scene?: string;
  details?: string;
}

export interface CardDraft {
  text: Record<TextField, string>;
  lang_pair: LangPair;
  /** Stickers the card wears. */
  labels: EntityId[];
  /** undefined: no change (Edit) / none yet (Add); null: no picture; else the picture drawn for it. */
  picture?: DraftPicture | null;
}

const clean = (s: string | undefined) => (s ?? "").normalize("NFC").trim();

/** Same studied word in the same language pair (case, spaces and Unicode form ignored). */
const wordKey = (front: string, pair: LangPair) => `${pair.from}>${pair.to}\u0000${noteKey(front, "")}`;

/**
 * Cards like the draft. `exact`: same word, translation and pair (Add refuses it).
 * `sameWord`: same word and pair, another translation (allowed; the user is told).
 * `self` is the card being edited, never its own duplicate.
 */
export function duplicates(notes: Iterable<Note>, d: { front: string; back: string; lang_pair: LangPair }, self?: EntityId): { exact?: Note; sameWord: Note[] } {
  const front = clean(d.front);
  if (!front) return { sameWord: [] };
  const word = wordKey(front, d.lang_pair);
  const full = noteKey(front, clean(d.back));
  let exact: Note | undefined;
  const sameWord: Note[] = [];
  for (const n of notes) {
    if (n.deleted || n.id === self || wordKey(n.fields.front, n.lang_pair) !== word) continue;
    if (clean(d.back) && noteKey(n.fields.front, n.fields.back) === full) exact ??= n;
    else sameWord.push(n);
  }
  return { exact, sameWord };
}

/** A blank draft, or one filled from an existing card. */
export function draftOf(lang_pair: LangPair, note?: Note, labels: EntityId[] = []): CardDraft {
  const text = Object.fromEntries(TEXT_FIELDS.map((f) => [f, note?.fields[f] ?? ""])) as Record<TextField, string>;
  return { text, lang_pair: note?.lang_pair ?? lang_pair, labels: [...labels] };
}

/** Add: the card, its two faces, its stickers and its picture, as one batch. */
export function addEvents(f: EventFactory, deckId: EntityId, d: CardDraft): { events: AppEvent[]; noteId: EntityId } {
  const fields: NoteFields = { front: clean(d.text.front), back: clean(d.text.back) };
  for (const k of TEXT_FIELDS) {
    const v = clean(d.text[k]);
    if (k !== "front" && k !== "back" && v) fields[k] = v;
  }
  const events = f.note(deckId, fields, d.lang_pair);
  const noteId = (events[0].payload as { note_id: EntityId }).note_id;
  for (const id of new Set(d.labels)) events.push(f.make<NotesLabeled>("notes_labeled", { label_id: id, note_ids: [noteId], on: true }));
  if (d.picture) events.push(picture(f, noteId, d.picture));
  if (d.picture === null) events.push(f.make<AssetAttached>("asset_attached", { note_id: noteId, kind: "image", r2_key: null }));
  return { events, noteId };
}

/** Save: only what changed against the card as it is (`wears` = the stickers it wears now). */
export function saveEvents(f: EventFactory, note: Note, wears: EntityId[], d: CardDraft): AppEvent[] {
  const events: AppEvent[] = [];
  for (const k of TEXT_FIELDS) {
    const v = clean(d.text[k]);
    if ((k === "front" || k === "back") && !v) continue; // a card keeps its word and translation
    if (clean(note.fields[k]) !== v) events.push(f.make<NoteEdited>("note_edited", { note_id: note.id, field: k, value: v }));
  }
  const now = new Set(wears), want = new Set(d.labels);
  for (const id of want) if (!now.has(id)) events.push(f.make<NotesLabeled>("notes_labeled", { label_id: id, note_ids: [note.id], on: true }));
  for (const id of now) if (!want.has(id)) events.push(f.make<NotesLabeled>("notes_labeled", { label_id: id, note_ids: [note.id], on: false }));
  if (d.picture && d.picture.key !== note.picture?.key) events.push(picture(f, note.id, d.picture));
  if (d.picture === null && !note.noPicture) events.push(f.make<AssetAttached>("asset_attached", { note_id: note.id, kind: "image", r2_key: null }));
  return events;
}

function picture(f: EventFactory, noteId: EntityId, p: DraftPicture): AssetAttached {
  return f.make<AssetAttached>("asset_attached", { note_id: noteId, kind: "image", r2_key: p.key, sense: p.sense, details: p.details, scene: p.scene });
}
