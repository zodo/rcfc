// Words managed from outside the app: the Claude connector (worker/mcp.ts)
// reads and changes a user's words through this. Pure: a folded collection in,
// events out. Each write applies its events to the collection as it makes
// them, so later writes in the same request see them, and the views returned
// show the words as they are now.
//
// It writes the same events the app does (Add, Save, the bin, stickers, "I
// know" / "Don't know", Import from anything), so the app needs nothing new:
// the events arrive on its next sync like another device's.
import type { Collection, EventFactory, Note } from "./collection";
import { draftOf, MEMO_KNOWN, MEMO_TARGET, saveEvents } from "./cards";
import type { AppEvent, LabelCreated, LabelDeleted, LabelRenamed, LangPair, NoteDeleted, NoteRestored, NotesLabeled, NotesPrioritized, Review } from "./events";
import { derivedEntityId, type EntityId } from "./ids";
import { freshColor, labelIdFor, labelName } from "./labels";
import { knownCards, unknownPlan } from "./newcards";
import { languagePile } from "./piles";
import { wordStatus, type WordStatus } from "./scheduler";
import { IMPORT_LANGS, importEvents, langCode, noteKey, planImport, type ImportRow } from "../import/anything";

/** "I know" / "Don't know" answers take this long (as in the app's Store). */
const MARKED_DURATION_MS = 2000;

/** A word as the connector shows it. */
export interface WordView {
  id: EntityId;
  word: string;
  translation: string;
  example?: string;
  /** The user's own note on the word side / the translation side. */
  note?: string;
  translation_note?: string;
  /** Studied language and the translation's language (codes). */
  language: string;
  translation_language: string;
  stickers: string[];
  status: WordStatus;
  has_picture: boolean;
  deleted?: true;
}

export interface WordQuery {
  language?: string;
  sticker?: string;
  status?: WordStatus;
  /** Text anywhere in the word, translation, example or notes (case and accents aside). */
  text?: string;
  /** Deleted words instead of live ones (to restore them). */
  deleted?: boolean;
  limit?: number;
  offset?: number;
}

export interface NewWord {
  word: string;
  translation: string;
  /** The studied language: a code or a name ("es", "Spanish"). */
  language: string;
  /** The translation's language; default: the one this language's words use. */
  translation_language?: string;
  example?: string;
  note?: string;
  translation_note?: string;
  /** What the picture should show, when the word alone is ambiguous. */
  picture?: string;
  stickers?: string[];
  status?: WordStatus;
}

export interface WordChanges {
  word?: string;
  translation?: string;
  example?: string;
  note?: string;
  translation_note?: string;
}

/**
 * A clock for the factory that never repeats a millisecond: one request makes
 * several events on one device, and a later write to the same field (a sticker
 * stuck on, then peeled off) must sort after the earlier one.
 */
export function monotonicClock(now: () => number = Date.now): () => number {
  let last = 0;
  return () => (last = Math.max(now(), last + 1));
}

/** Wrong input from the caller: the message is for the model that called. */
export class WordbookError extends Error {}

const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase();

export class Wordbook {
  /** Events made so far, in order: what the caller stores. */
  readonly made: AppEvent[] = [];

  constructor(
    readonly col: Collection,
    private f: EventFactory,
  ) {}

  private emit(...events: AppEvent[]): void {
    for (const e of events) {
      this.col.apply(e);
      this.made.push(e);
    }
  }

  // ---------------------------------------------------------------- reading

  status(n: Note): WordStatus {
    const cards = (this.col.cardsByNote.get(n.id) ?? []).map((id) => this.col.cards.get(id)!);
    // The app also counts as known a word the model predicts recalled a week
    // ahead; the server has no model, so those read as learning here.
    return wordStatus(cards, new Map()) ?? "learning";
  }

  view(n: Note): WordView {
    const f = n.fields;
    return {
      id: n.id,
      word: f.front,
      translation: f.back,
      ...(f.example ? { example: f.example } : {}),
      ...(f[MEMO_TARGET] ? { note: f[MEMO_TARGET] } : {}),
      ...(f[MEMO_KNOWN] ? { translation_note: f[MEMO_KNOWN] } : {}),
      language: n.lang_pair.from,
      translation_language: n.lang_pair.to,
      stickers: this.col.labelsOf(n.id).map((l) => l.name),
      status: this.status(n),
      has_picture: !!n.picture,
      ...(n.deleted ? { deleted: true as const } : {}),
    };
  }

  /** The words matching, oldest first, and how many match in all. */
  find(q: WordQuery = {}): { total: number; words: WordView[] } {
    const lang = q.language === undefined ? undefined : this.language(q.language);
    const label = q.sticker === undefined ? undefined : this.sticker(q.sticker);
    const text = q.text?.trim() ? fold(q.text.trim()) : undefined;
    const pool = q.deleted ? [...this.col.notes.values()].filter((n) => n.deleted).sort((a, b) => a.order - b.order) : label ? this.col.labelNotes(label.id) : this.col.liveNotes();
    const hits = pool.filter(
      (n) =>
        (lang === undefined || n.lang_pair.from === lang) &&
        (q.status === undefined || this.status(n) === q.status) &&
        (text === undefined || Object.values(n.fields).some((v) => v && fold(v).includes(text))),
    );
    const offset = Math.max(0, q.offset ?? 0);
    const limit = Math.max(1, Math.min(q.limit ?? 50, 500));
    return { total: hits.length, words: hits.slice(offset, offset + limit).map((n) => this.view(n)) };
  }

  /** Languages studied and stickers, with how many words each. */
  overview(): { words: number; languages: { language: string; translation_languages: string[]; words: number; new: number; learning: number; known: number }[]; stickers: { name: string; words: number }[] } {
    const langs = new Map<string, { language: string; translation_languages: string[]; words: number; new: number; learning: number; known: number }>();
    const notes = this.col.liveNotes();
    for (const n of notes) {
      const l = langs.get(n.lang_pair.from) ?? { language: n.lang_pair.from, translation_languages: [], words: 0, new: 0, learning: 0, known: 0 };
      langs.set(n.lang_pair.from, l);
      l.words++;
      l[this.status(n)]++;
      if (!l.translation_languages.includes(n.lang_pair.to)) l.translation_languages.push(n.lang_pair.to);
    }
    return {
      words: notes.length,
      languages: [...langs.values()],
      stickers: this.col.liveLabels().map((l) => ({ name: l.name, words: this.col.labelNotes(l.id).length })),
    };
  }

  // ---------------------------------------------------------------- words

  /**
   * Add words. A word already there with the same translation (or twice in
   * the list) is skipped, so adding a list again adds nothing.
   */
  add(items: NewWord[]): { added: WordView[]; skipped: { word: string; translation: string; reason: "exists" | "repeated"; id?: EntityId }[] } {
    const rows: ImportRow[] = items.map((w, i) => {
      const word = w.word?.trim() ?? "", translation = w.translation?.trim() ?? "";
      if (!word || !translation) throw new WordbookError(`word ${i + 1}: both the word and its translation are needed`);
      const lang = this.language(w.language);
      const to = w.translation_language === undefined ? this.translationFor(lang) : this.language(w.translation_language);
      if (lang === to) throw new WordbookError(`"${word}": the word and its translation are in the same language (${lang})`);
      return { line: i + 1, word, translation, example: w.example?.trim() ?? "", note: w.note?.trim() ?? "", translationNote: w.translation_note?.trim() ?? "", picture: w.picture?.trim() ?? "", stickers: (w.stickers ?? []).map(labelName).filter(Boolean), status: w.status ?? "new", lang, to };
    });
    const plan = planImport({ rows, errors: [], noTable: false }, this.col.notes.values(), { from: "es", to: "en" });
    const decks = new Map<string, EntityId>();
    for (const r of plan.ready) if (!decks.has(r.pair.from)) decks.set(r.pair.from, this.deckFor(r.pair));
    const { events, noteIds } = importEvents(this.f, plan.ready, decks);
    // Made by the connector, not imported from a file.
    for (const e of events) if (e.type === "note_created") delete e.payload.source;
    this.emit(...events);
    const byLabel = new Map<EntityId, EntityId[]>();
    plan.ready.forEach((r, i) => {
      for (const name of r.stickers) {
        const id = this.makeSticker(name);
        byLabel.set(id, [...(byLabel.get(id) ?? []), noteIds[i]]);
      }
    });
    for (const [id, ids] of byLabel) this.emit(this.f.make<NotesLabeled>("notes_labeled", { label_id: id, note_ids: ids, on: true }));
    const learning = noteIds.filter((_, i) => plan.ready[i].status === "learning");
    if (learning.length) this.emit(this.f.make<NotesPrioritized>("notes_prioritized", { note_ids: learning }));
    const known = noteIds.filter((_, i) => plan.ready[i].status === "known");
    if (known.length) this.markKnown(known);
    const existing = (r: ImportRow) => this.col.liveNotes().find((n) => n.lang_pair.from === r.lang && n.lang_pair.to === r.to && noteKey(n.fields.front, n.fields.back) === noteKey(r.word, r.translation))?.id;
    return {
      added: noteIds.map((id) => this.view(this.col.notes.get(id)!)),
      skipped: plan.skipped.map((s) => {
        const r = rows[s.line - 1];
        return { word: r.word, translation: r.translation, reason: s.reason, ...(s.reason === "exists" ? { id: existing(r) } : {}) };
      }),
    };
  }

  /** Change a word's text; what isn't given stays. The languages stay (delete and add it again to change them). */
  edit(id: EntityId, c: WordChanges): WordView {
    const n = this.note(id);
    const d = draftOf(n.lang_pair, n, this.col.labelsOf(n.id).map((l) => l.id));
    if (c.word !== undefined) d.text.front = c.word;
    if (c.translation !== undefined) d.text.back = c.translation;
    if (c.example !== undefined) d.text.example = c.example;
    if (c.note !== undefined) d.text[MEMO_TARGET] = c.note;
    if (c.translation_note !== undefined) d.text[MEMO_KNOWN] = c.translation_note;
    if (c.word !== undefined && !c.word.trim()) throw new WordbookError("a word can't be emptied");
    if (c.translation !== undefined && !c.translation.trim()) throw new WordbookError("a translation can't be emptied");
    this.emit(...saveEvents(this.f, n, d.labels, d));
    return this.view(n);
  }

  /** Delete words (they can be restored, progress and all). Returns those deleted. */
  remove(ids: EntityId[]): WordView[] {
    const notes = this.unique(ids).map((id) => this.note(id));
    this.emit(...notes.map((n) => this.f.make<NoteDeleted>("note_deleted", { note_id: n.id })));
    return notes.map((n) => this.view(n));
  }

  restore(ids: EntityId[]): WordView[] {
    const notes = this.unique(ids).map((id) => {
      const n = this.col.notes.get(id);
      if (!n) throw new WordbookError(`no word with id ${id}`);
      return n;
    });
    this.emit(...notes.filter((n) => n.deleted).map((n) => this.f.make<NoteRestored>("note_restored", { note_id: n.id })));
    return notes.map((n) => this.view(n));
  }

  // ---------------------------------------------------------------- progress

  /** The user knows these words: both faces answered Easy, as "I know" does. */
  markKnown(ids: EntityId[]): WordView[] {
    const notes = this.unique(ids).map((id) => this.note(id));
    this.emit(...knownCards(this.col, notes.map((n) => n.id)).map((c) => this.review(c.id, 4)));
    return notes.map((n) => this.view(n));
  }

  /** The user doesn't know these: studied faces answered Again, unseen words learned next, as "Don't know" does. */
  markUnknown(ids: EntityId[]): WordView[] {
    const notes = this.unique(ids).map((id) => this.note(id));
    const { again, next } = unknownPlan(this.col, notes.map((n) => n.id));
    this.emit(...again.map((c) => this.review(c.id, 1)));
    if (next.length) this.emit(this.f.make<NotesPrioritized>("notes_prioritized", { note_ids: next }));
    return notes.map((n) => this.view(n));
  }

  // ---------------------------------------------------------------- stickers

  /** Stick a sticker on words (made when new), or peel it off. */
  stick(name: string, ids: EntityId[], on: boolean): { sticker: string; words: WordView[] } {
    const notes = this.unique(ids).map((id) => this.note(id));
    const id = on ? this.makeSticker(name) : this.sticker(name).id;
    const change = notes.filter((n) => this.col.wears(n.id, id) !== on).map((n) => n.id);
    if (change.length) this.emit(this.f.make<NotesLabeled>("notes_labeled", { label_id: id, note_ids: change, on }));
    return { sticker: this.col.liveLabel(id)!.name, words: notes.map((n) => this.view(n)) };
  }

  /** Rename a sticker; to another sticker's name, merges into it (as the app does). Returns the name its words wear now. */
  renameSticker(name: string, to: string): string {
    const l = this.sticker(name);
    const next = labelName(to);
    if (!next) throw new WordbookError("a sticker needs a name");
    const other = this.col.labelByName(next);
    if (other && other.id !== l.id) {
      const notes = this.col.labelNotes(l.id).map((n) => n.id);
      if (notes.length) this.emit(this.f.make<NotesLabeled>("notes_labeled", { label_id: other.id, note_ids: notes, on: true }));
      this.emit(this.f.make<LabelDeleted>("label_deleted", { label_id: l.id }));
      return other.name;
    }
    if (l.name !== next) this.emit(this.f.make<LabelRenamed>("label_renamed", { label_id: l.id, name: next }));
    return next;
  }

  /** Delete a sticker (its words stay). */
  deleteSticker(name: string): void {
    this.emit(this.f.make<LabelDeleted>("label_deleted", { label_id: this.sticker(name).id }));
  }

  // ---------------------------------------------------------------- helpers

  private note(id: EntityId): Note {
    const n = this.col.liveNote(id);
    if (!n) throw new WordbookError(this.col.notes.get(id) ? `word ${id} is deleted` : `no word with id ${id}`);
    return n;
  }

  private unique(ids: EntityId[]): EntityId[] {
    if (!ids.length) throw new WordbookError("no word ids given");
    return [...new Set(ids)];
  }

  private sticker(name: string) {
    const l = this.col.labelByName(name);
    if (!l) throw new WordbookError(`no sticker named "${name}"${this.col.liveLabels().length ? ` (there are: ${this.col.liveLabels().map((l) => l.name).join(", ")})` : " (there are none yet)"}`);
    return l;
  }

  private makeSticker(name: string): EntityId {
    const clean = labelName(name);
    if (!clean) throw new WordbookError("a sticker needs a name");
    const { id, exists } = labelIdFor(this.col, clean);
    if (!exists) this.emit(this.f.make<LabelCreated>("label_created", { label_id: id, name: clean, color: freshColor(this.col) }));
    return id;
  }

  /** A language as its code, from a code or a name. */
  language(raw: string): string {
    const code = langCode(raw ?? "");
    if (!code) throw new WordbookError(`unknown language "${raw}"; use one of ${IMPORT_LANGS.join(", ")}`);
    return code;
  }

  /** The language this language's words are translated into: its latest word's, else any word's. */
  private translationFor(lang: string): string {
    const notes = this.col.liveNotes();
    return (notes.findLast((n) => n.lang_pair.from === lang) ?? notes.at(-1))?.lang_pair.to ?? (lang === "en" ? "es" : "en");
  }

  /** The hidden deck of a studied language, made as the app makes it (src/screens/languages.ts deckFor). */
  private deckFor(pair: LangPair): EntityId {
    const same = [...this.col.decks.values()].filter((d) => d.lang_pair.from === pair.from).sort((a, b) => a.id - b.id)[0];
    if (same) return same.id;
    let preset = this.col.defaultPreset();
    if (!preset) {
      this.emit(this.f.preset());
      preset = this.col.defaultPreset()!;
    }
    const id = derivedEntityId(`deck:${languagePile(pair.from)}`);
    this.emit(this.f.deck(englishName(pair.from), preset.preset_id, pair, id));
    return id;
  }

  /** An answer made here ("I know" / "Don't know"): outside any pile, in the user's time zone as of their last answer. */
  private review(cardId: EntityId, rating: 1 | 4): Review {
    const card = this.col.cards.get(cardId)!;
    const note = this.col.notes.get(card.note_id)!;
    const deck = this.col.decks.get(note.deck_id)!;
    return this.f.make<Review>("review", {
      card_id: card.id,
      note_id: note.id,
      deck_id: deck.id,
      preset_id: deck.preset_id,
      rating,
      duration_ms: MARKED_DURATION_MS,
      tz_offset_min: this.col.reviews.at(-1)?.payload.tz_offset_min ?? 0,
    });
  }
}

function englishName(code: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}
