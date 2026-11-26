// App state: the event log in IndexedDB (Dexie), its fold, and the RWKV engine.
// No UI side effects: when the in-memory model falls behind the log (late sync,
// rollover change) writes report `replay` and set `stale`; the app decides when
// to reload.
import type { Summary } from "./domain/summary";
import Dexie, { type DexieOptions, type Table } from "dexie";
import { Collection, EventFactory, eventOrder, type Card, type Preset } from "./domain/collection";
import type { AppEvent, LabelColored, LabelCreated, LabelDeleted, LabelRenamed, NotesLabeled, Review, ReviewPayload } from "./domain/events";
import { freshColor, labelIdFor, labelName } from "./domain/labels";
import type { EntityId } from "./domain/ids";
import { importEvents, type ReadyRow } from "./import/anything";
import { knownCards, newQueue, unknownPlan, unseenCards, type DayClock, type Scope } from "./domain/newcards";
import { RowBuilder, ROWS_VERSION, ROW_WIDTH, localTzOffsetMin } from "./domain/rows";
import { needsReplay } from "./domain/sync";
import { Engine, type EngineApi } from "./engine/client";
import type { InitResult } from "./engine/protocol";

/** Answer time recorded for words marked known or unknown without being shown: a quick, sure answer. */
const MARKED_DURATION_MS = 2000;

/** `remote`: came from the sync server, so it is never pushed back. */
type StoredEvent = AppEvent & { seq?: number; remote?: 1 };

export interface WriteResult {
  added: number;
  /** The model must replay from scratch (late review or rollover change): reload when convenient. */
  replay: boolean;
}

/** A picture to draw (src/pictures.ts). Local to this device; the result syncs as an event. */
export interface PicJob {
  note_id: EntityId;
  sense?: string;
  details?: string;
  /** Redraw even if the note already has a picture. */
  force?: boolean;
  /** Drawn ahead of time (a card coming up in a pile): after pictures needed now. */
  ahead?: boolean;
  tries: number;
  /** ms epoch; not retried before. */
  not_before: number;
  created: number;
}

/** A downloaded picture, kept for offline study. */
export interface PicBlob {
  key: string;
  type: string;
  data: ArrayBuffer;
  /** Paper background made pure white (src/domain/paper.ts): blend it into the card. */
  flat?: boolean;
  /** Processing version; older copies are downloaded and processed again. */
  v?: number;
}

/** Spoken audio of a text, kept for offline study (src/speech.ts); key = `lang|text`. */
export interface TtsBlob {
  key: string;
  data: ArrayBuffer;
}

/** A word's notes, kept for offline study (src/summaries.ts); key = summaryText of the request. */
export interface SumBlob {
  key: string;
  summary: Summary;
}

class AppDb extends Dexie {
  events!: Table<StoredEvent, number>;
  meta!: Table<{ key: string; value: unknown }, string>;
  pic_jobs!: Table<PicJob, EntityId>;
  pic_blobs!: Table<PicBlob, string>;
  tts_blobs!: Table<TtsBlob, string>;
  sum_blobs!: Table<SumBlob, string>;
  constructor(name: string, options?: DexieOptions) {
    super(name, options);
    this.version(1).stores({ events: "++seq, &event_id, type", meta: "key" });
    this.version(2).stores({ pic_jobs: "note_id", pic_blobs: "key" });
    this.version(3).stores({ tts_blobs: "key" });
    this.version(4).stores({ sum_blobs: "key" });
  }
}

export interface StartupInfo {
  events: number;
  reviews: number;
  replayed: number;
  engine: InitResult;
  ms: number;
}

export type Progress = (done: number, total: number) => void;

export interface StoreOptions {
  onProgress?: Progress;
  /** Defaults to the RWKV Web Worker; tests pass a stub. */
  engine?: EngineApi;
  /** IndexedDB database name (default "rcfc"). */
  dbName?: string;
  /** Dexie options, e.g. a fake-indexeddb implementation in tests. */
  dexie?: DexieOptions;
  now?: () => number;
}

export class Store {
  readonly col = new Collection();
  private rows = new RowBuilder();
  readonly factory: EventFactory;
  /** Latest P(recall) per reviewed card, and when each was computed. */
  readonly preds = new Map<EntityId, number>();
  private predAt = new Map<EntityId, number>();
  private configKey = "";
  /** Called after every local write (sync pushes soon after). */
  onLocalWrite: () => void = () => {};
  /** In-memory RWKV state is behind the log until the app reloads. */
  stale = false;

  private constructor(
    private db: AppDb,
    readonly deviceId: string,
    readonly engine: EngineApi,
    private now: () => number,
  ) {
    this.factory = new EventFactory(deviceId, now);
  }

  static async open(opts: StoreOptions = {}): Promise<{ store: Store; info: StartupInfo }> {
    const t0 = performance.now();
    const db = new AppDb(opts.dbName ?? "rcfc", opts.dexie);
    let deviceId = (await db.meta.get("device_id"))?.value as string | undefined;
    if (!deviceId) {
      deviceId = crypto.randomUUID();
      await db.meta.put({ key: "device_id", value: deviceId });
    }
    const s = new Store(db, deviceId, opts.engine ?? new Engine(), opts.now ?? Date.now);
    const events = await db.events.orderBy("seq").toArray();
    for (const e of events) s.col.apply(e);
    if (!s.col.defaultPreset()) await s.append([s.factory.preset()]);

    const rows: number[] = [];
    for (const r of s.col.reviews) s.rows.push(r, s.rolloverOf(r.payload), rows);
    s.configKey = s.makeConfigKey();
    let engine = await s.engine.init(s.configKey);
    const reviews = s.col.reviews;
    let from = engine.restored;
    if (from > reviews.length || (from > 0 && reviews[from - 1].event_id !== engine.lastReviewId)) {
      // The log changed under the checkpoint (restore, late sync): replay all.
      await s.engine.reset();
      engine = { ...engine, restored: 0, lastReviewId: null };
      from = 0;
    }
    const CHUNK = 500;
    for (let i = from; i < reviews.length; i += CHUNK) {
      const end = Math.min(reviews.length, i + CHUNK);
      await s.engine.apply(Float64Array.from(rows.slice(i * ROW_WIDTH, end * ROW_WIDTH)), reviews[end - 1].event_id);
      opts.onProgress?.(end - from, reviews.length - from);
    }
    if (reviews.length > from) await s.engine.flush();
    return { store: s, info: { events: events.length, reviews: reviews.length, replayed: reviews.length - from, engine, ms: performance.now() - t0 } };
  }

  /** Close the database (tests reopen the same log). */
  close(): void {
    this.db.close();
  }

  private makeConfigKey(): string {
    // Only presets reviews were made under shape RWKV rows; another device's
    // unused default preset arriving by sync must not force a replay.
    const used = new Set(this.col.reviews.map((r) => r.payload.preset_id));
    const roll = [...this.col.presets.values()].filter((p) => used.has(p.preset_id)).map((p) => `${p.preset_id}:${p.day_rollover_hour}`).sort();
    return `rows${ROWS_VERSION}|${roll.join(",")}`;
  }

  /**
   * The first review under another preset extends the config key; the rows so
   * far are unchanged, so the checkpoint stays valid under the new key.
   */
  private async rekey(): Promise<void> {
    const k = this.makeConfigKey();
    if (k === this.configKey) return;
    this.configKey = k;
    await this.engine.rekey(k);
  }

  private rolloverOf(p: Pick<ReviewPayload, "preset_id">): number {
    return this.col.presets.get(p.preset_id)?.day_rollover_hour ?? this.preset().day_rollover_hour;
  }

  private tz(): number {
    return localTzOffsetMin(new Date(this.now()));
  }

  preset(): Preset {
    return this.col.defaultPreset()!;
  }

  /** Append non-review events (creation, edits, settings). */
  async append(events: AppEvent[]): Promise<WriteResult> {
    if (events.some((e) => e.type === "review")) throw new Error("use answer() for reviews");
    const fresh = events.filter((e) => !this.col.eventIds.has(e.event_id));
    await this.db.events.bulkAdd(fresh);
    for (const e of fresh) this.col.apply(e);
    if (fresh.length) this.onLocalWrite();
    // A rollover change re-derives every row: only a full replay can apply it.
    if (fresh.some((e) => e.type === "preset_updated") && this.configKey && this.makeConfigKey() !== this.configKey) this.stale = true;
    return { added: fresh.length, replay: this.stale };
  }

  /** Record an answer (from `pile`, if any) and feed it to RWKV. Returns the pre-answer P(recall). */
  async answer(card: Card, rating: ReviewPayload["rating"], durationMs: number, pile?: string): Promise<number> {
    const note = this.col.notes.get(card.note_id)!;
    const deck = this.col.decks.get(note.deck_id)!;
    const ev = this.factory.make<Review>("review", {
      card_id: card.id,
      note_id: note.id,
      deck_id: deck.id,
      preset_id: deck.preset_id,
      rating,
      duration_ms: Math.round(durationMs),
      tz_offset_min: this.tz(),
      ...(pile === undefined ? {} : { pile }),
    });
    await this.db.events.add(ev);
    this.col.apply(ev);
    this.onLocalWrite();
    const row = this.rows.push(ev, this.rolloverOf(ev.payload));
    const [p] = await this.engine.process(Float64Array.from(row), ev.event_id);
    await this.rekey();
    return p;
  }

  /** Re-predict P(recall) now for the given (reviewed) cards. */
  async predict(cards: Card[]): Promise<void> {
    const now = this.now();
    const ps = await this.predictAt(cards, now);
    for (const [id, p] of ps) {
      this.preds.set(id, p);
      this.predAt.set(id, now);
    }
  }

  /** P(recall) of the given (reviewed) cards at time `at` (e.g. a week ahead). Changes nothing. */
  async predictAt(cards: Card[], at: number): Promise<Map<EntityId, number>> {
    const tz = this.tz();
    const rows: number[] = [];
    const list = cards.filter((c) => c.reviews > 0);
    for (const c of list) {
      const note = this.col.notes.get(c.note_id)!;
      const deck = this.col.decks.get(note.deck_id)!;
      this.rows.predictRow({ card_id: c.id, note_id: note.id, deck_id: deck.id, preset_id: deck.preset_id }, at, tz, this.rolloverOf(deck), rows);
    }
    if (!list.length) return new Map();
    const ps = await this.engine.predict(Float64Array.from(rows));
    return new Map(list.map((c, i) => [c.id, ps[i]]));
  }

  /** Last predictions of the given cards (reviewed ones only). */
  predsOf(cards: Card[]): Map<EntityId, number> {
    const m = new Map<EntityId, number>();
    for (const c of cards) {
      const p = this.preds.get(c.id);
      if (c.reviews > 0 && p !== undefined) m.set(c.id, p);
    }
    return m;
  }

  /** The `n` reviewed cards whose prediction is oldest. */
  stalest(cards: Card[], n: number): Card[] {
    return cards
      .filter((c) => c.reviews > 0)
      .sort((a, b) => (this.predAt.get(a.id) ?? 0) - (this.predAt.get(b.id) ?? 0))
      .slice(0, n);
  }

  clock(): DayClock {
    return { now: this.now(), tzOffsetMin: this.tz(), rolloverHour: this.preset().day_rollover_hour };
  }

  /** First cards of words never studied, all of them (what "Learn more" can introduce). */
  unseenWords(scope?: Scope): Card[] {
    return unseenCards(this.col, this.clock(), scope).fresh;
  }

  /** New cards that may be shown now (src/domain/newcards.ts); `extra` raises today's limit. */
  newQueue(scope?: Scope, extra = 0): Card[] {
    return newQueue(this.col, this.clock(), this.preset().new_per_day + extra, scope);
  }

  /**
   * The user already knows these words: answer them Easy (src/domain/newcards.ts
   * `knownCards`), so the model schedules them far out. Returns the words marked.
   */
  async markKnown(noteIds: EntityId[]): Promise<number> {
    const cards = knownCards(this.col, noteIds);
    for (const c of cards) await this.answer(c, 4, MARKED_DURATION_MS);
    await this.predict(cards); // the table draws from the last predictions
    return new Set(cards.map((c) => c.note_id)).size;
  }

  /**
   * The user doesn't know these words: studied ones are answered Again (due
   * soon), unseen ones are learned before other new words. Returns how many of each.
   */
  async markUnknown(noteIds: EntityId[]): Promise<{ forgotten: number; next: number }> {
    const { again, next } = unknownPlan(this.col, noteIds);
    for (const c of again) await this.answer(c, 1, MARKED_DURATION_MS);
    await this.predict(again);
    if (next.length) await this.append([this.factory.make("notes_prioritized", { note_ids: next })]);
    return { forgotten: new Set(again.map((c) => c.note_id)).size, next: next.length };
  }

  /**
   * Import from anything: adds the words, sticks their stickers on (made when
   * new), and sets their progress: known = both faces answered Easy once (as "I know"),
   * learning = learned before other new words (as "Don't know" on an unseen one).
   * `deckFor` gives a studied language's hidden deck (made when new).
   */
  async importWords(rows: ReadyRow[], deckFor: (lang: string) => Promise<EntityId>): Promise<{ words: number; labels: EntityId[] }> {
    const decks = new Map<string, EntityId>();
    for (const r of rows) if (!decks.has(r.pair.from)) decks.set(r.pair.from, await deckFor(r.pair.from));
    const { events, noteIds } = importEvents(this.factory, rows, decks);
    await this.append(events);
    const byLabel = new Map<EntityId, EntityId[]>();
    for (const [i, r] of rows.entries())
      for (const name of r.stickers) {
        const id = await this.makeLabel(name);
        byLabel.set(id, [...(byLabel.get(id) ?? []), noteIds[i]]);
      }
    for (const [id, ids] of byLabel) await this.stick(id, ids, true);
    const learning = noteIds.filter((_, i) => rows[i].status === "learning");
    if (learning.length) await this.append([this.factory.make("notes_prioritized", { note_ids: learning })]);
    const known = noteIds.filter((_, i) => rows[i].status === "known");
    if (known.length) await this.markKnown(known);
    return { words: noteIds.length, labels: [...byLabel.keys()] };
  }

  /** A sticker with this name: the one there is, else a new one. Returns its id. */
  async makeLabel(name: string): Promise<EntityId> {
    const { id, exists } = labelIdFor(this.col, name);
    if (!exists) await this.append([this.factory.make<LabelCreated>("label_created", { label_id: id, name: labelName(name), color: freshColor(this.col) })]);
    return id;
  }

  /**
   * Rename a sticker; to the name of another one, merge into it (its words get
   * that one, this one is deleted). Returns the sticker the words wear now.
   */
  async renameLabel(id: EntityId, name: string): Promise<EntityId> {
    const other = this.col.labelByName(name);
    if (other && other.id !== id) {
      const notes = this.col.labelNotes(id).map((n) => n.id);
      await this.append([
        ...(notes.length ? [this.factory.make<NotesLabeled>("notes_labeled", { label_id: other.id, note_ids: notes, on: true })] : []),
        this.factory.make<LabelDeleted>("label_deleted", { label_id: id }),
      ]);
      return other.id;
    }
    if (this.col.liveLabel(id)?.name !== labelName(name)) await this.append([this.factory.make<LabelRenamed>("label_renamed", { label_id: id, name: labelName(name) })]);
    return id;
  }

  async colorLabel(id: EntityId, color: string): Promise<void> {
    await this.append([this.factory.make<LabelColored>("label_colored", { label_id: id, color })]);
  }

  async deleteLabel(id: EntityId): Promise<void> {
    await this.append([this.factory.make<LabelDeleted>("label_deleted", { label_id: id })]);
  }

  /** Stick a sticker on words, or peel it off. */
  async stick(labelId: EntityId, noteIds: EntityId[], on: boolean): Promise<void> {
    if (noteIds.length) await this.append([this.factory.make<NotesLabeled>("notes_labeled", { label_id: labelId, note_ids: noteIds, on })]);
  }

  async allEvents(): Promise<AppEvent[]> {
    return (await this.db.events.orderBy("seq").toArray()).map(({ seq: _seq, remote: _remote, ...e }) => e as AppEvent);
  }

  /** Restore from a backup: adds unknown events (any type). The app must reload to replay them. */
  async importBackup(events: AppEvent[]): Promise<number> {
    const fresh = events.filter((e) => e && typeof e.event_id === "string" && !this.col.eventIds.has(e.event_id));
    await this.db.events.bulkAdd(fresh);
    return fresh.length;
  }

  // ---------- pictures (src/pictures.ts) ----------

  picJobs(): Promise<PicJob[]> {
    return this.db.pic_jobs.toArray();
  }

  putPicJob(j: PicJob): Promise<unknown> {
    return this.db.pic_jobs.put(j);
  }

  deletePicJob(noteId: EntityId): Promise<void> {
    return this.db.pic_jobs.delete(noteId);
  }

  getPicBlob(key: string): Promise<PicBlob | undefined> {
    return this.db.pic_blobs.get(key);
  }

  putPicBlob(b: PicBlob): Promise<unknown> {
    return this.db.pic_blobs.put(b);
  }

  /** Keys of stored pictures processed at version `v`. */
  async picBlobKeys(v: number): Promise<Set<string>> {
    const keys = new Set<string>();
    await this.db.pic_blobs.each((b) => {
      if (b.v === v) keys.add(b.key);
    });
    return keys;
  }

  getTts(key: string): Promise<TtsBlob | undefined> {
    return this.db.tts_blobs.get(key);
  }

  putTts(b: TtsBlob): Promise<unknown> {
    return this.db.tts_blobs.put(b);
  }

  /** Keys of every stored audio. */
  ttsKeys(): Promise<string[]> {
    return this.db.tts_blobs.toCollection().primaryKeys();
  }

  getSummary(key: string): Promise<SumBlob | undefined> {
    return this.db.sum_blobs.get(key);
  }

  putSummary(b: SumBlob): Promise<unknown> {
    return this.db.sum_blobs.put(b);
  }

  /** Keys of every stored summary. */
  summaryKeys(): Promise<string[]> {
    return this.db.sum_blobs.toCollection().primaryKeys();
  }

  // ---------- sync ----------

  async getMeta<T>(key: string): Promise<T | undefined> {
    return (await this.db.meta.get(key))?.value as T | undefined;
  }

  async setMeta(key: string, value: unknown): Promise<void> {
    await this.db.meta.put({ key, value });
  }

  /**
   * Local events after the push cursor, up to `limit` log entries. `upTo` is
   * the last local seq scanned, to store as the new cursor once pushed (pulled
   * events in that range are skipped, not re-sent).
   */
  async outbox(after: number, limit: number): Promise<{ events: AppEvent[]; upTo: number }> {
    const rows = await this.db.events.where("seq").above(after).limit(limit).toArray();
    const events = rows.filter((e) => !e.remote).map(({ seq: _seq, remote: _remote, ...e }) => e as AppEvent);
    return { events, upTo: rows.length ? rows[rows.length - 1].seq! : after };
  }

  /** Mark every event local again, so joining another account pushes all of them. */
  async markAllLocal(): Promise<void> {
    await this.db.events.toCollection().modify((e) => {
      delete e.remote;
    });
  }

  /** Add events pulled from the server. Reviews feed RWKV when in order. */
  async ingest(events: AppEvent[]): Promise<WriteResult> {
    const seen = new Set<string>();
    const fresh = events.filter((e) => !this.col.eventIds.has(e.event_id) && !seen.has(e.event_id) && seen.add(e.event_id));
    if (!fresh.length) return { added: 0, replay: this.stale };
    await this.db.events.bulkAdd(fresh.map((e) => ({ ...e, remote: 1 as const })));
    // Decide and apply synchronously, so a local answer cannot slip in between.
    let replay = needsReplay(this.col.reviews[this.col.reviews.length - 1], fresh);
    const reviews = fresh.filter((e): e is Review => e.type === "review").sort(eventOrder);
    // Rows already processed used these rollover hours; a change re-derives them all.
    const used = new Set(this.col.reviews.map((r) => r.payload.preset_id));
    const hours = new Map([...used].map((id) => [id, this.col.presets.get(id)?.day_rollover_hour]));
    for (const e of fresh) this.col.apply(e);
    for (const [id, h] of hours) if (this.col.presets.get(id)?.day_rollover_hour !== h) replay = true;
    if (replay) this.stale = true;
    if (this.stale) return { added: fresh.length, replay: true };
    if (reviews.length) {
      const rows: number[] = [];
      for (const r of reviews) this.rows.push(r, this.rolloverOf(r.payload), rows);
      await this.engine.apply(Float64Array.from(rows), reviews[reviews.length - 1].event_id);
      await this.rekey();
      await this.engine.flush();
      await this.predict(reviews.map((r) => this.col.cards.get(r.payload.card_id)).filter((c): c is Card => !!c));
    }
    return { added: fresh.length, replay: false };
  }
}
