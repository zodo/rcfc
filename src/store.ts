// App state: the event log in IndexedDB (Dexie), its fold, and the RWKV engine.
import Dexie, { type Table } from "dexie";
import { Collection, EventFactory, type Card, type Preset } from "./domain/collection";
import type { AppEvent, Review, ReviewPayload } from "./domain/events";
import type { EntityId } from "./domain/ids";
import { RowBuilder, ROWS_VERSION, ROW_WIDTH, localTzOffsetMin, studyDay } from "./domain/rows";
import { Engine } from "./engine/client";
import type { InitResult } from "./engine/protocol";

type StoredEvent = AppEvent & { seq?: number };

class AppDb extends Dexie {
  events!: Table<StoredEvent, number>;
  meta!: Table<{ key: string; value: unknown }, string>;
  constructor() {
    super("rcfc");
    this.version(1).stores({ events: "++seq, &event_id, type", meta: "key" });
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

export class Store {
  readonly col = new Collection();
  private rows = new RowBuilder();
  readonly engine = new Engine();
  readonly factory: EventFactory;
  /** Latest P(recall) per reviewed card, and when each was computed. */
  readonly preds = new Map<EntityId, number>();
  private predAt = new Map<EntityId, number>();
  private configKey = "";

  private constructor(
    private db: AppDb,
    readonly deviceId: string,
  ) {
    this.factory = new EventFactory(deviceId);
  }

  static async open(onProgress?: Progress): Promise<{ store: Store; info: StartupInfo }> {
    const t0 = performance.now();
    const db = new AppDb();
    let deviceId = (await db.meta.get("device_id"))?.value as string | undefined;
    if (!deviceId) {
      deviceId = crypto.randomUUID();
      await db.meta.put({ key: "device_id", value: deviceId });
    }
    const s = new Store(db, deviceId);
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
      onProgress?.(end - from, reviews.length - from);
    }
    if (reviews.length > from) await s.engine.flush();
    return { store: s, info: { events: events.length, reviews: reviews.length, replayed: reviews.length - from, engine, ms: performance.now() - t0 } };
  }

  private makeConfigKey(): string {
    const roll = [...this.col.presets.values()].map((p) => `${p.preset_id}:${p.day_rollover_hour}`).sort();
    return `rows${ROWS_VERSION}|${roll.join(",")}`;
  }

  private rolloverOf(p: Pick<ReviewPayload, "preset_id">): number {
    return this.col.presets.get(p.preset_id)?.day_rollover_hour ?? this.preset().day_rollover_hour;
  }

  preset(): Preset {
    return this.col.defaultPreset()!;
  }

  /** Append non-review events (creation, edits, settings). */
  async append(events: AppEvent[]): Promise<void> {
    if (events.some((e) => e.type === "review")) throw new Error("use answer() for reviews");
    const fresh = events.filter((e) => !this.col.eventIds.has(e.event_id));
    await this.db.events.bulkAdd(fresh);
    for (const e of fresh) this.col.apply(e);
    if (fresh.some((e) => e.type === "preset_updated") && this.configKey && this.makeConfigKey() !== this.configKey) {
      // A rollover change re-derives every row: reload replays from scratch.
      location.reload();
    }
  }

  /** Record an answer and feed it to RWKV. Returns the pre-answer P(recall). */
  async answer(card: Card, rating: ReviewPayload["rating"], durationMs: number): Promise<number> {
    const note = this.col.notes.get(card.note_id)!;
    const deck = this.col.decks.get(note.deck_id)!;
    const ev = this.factory.make<Review>("review", {
      card_id: card.id,
      note_id: note.id,
      deck_id: deck.id,
      preset_id: deck.preset_id,
      rating,
      duration_ms: Math.round(durationMs),
      tz_offset_min: localTzOffsetMin(),
    });
    await this.db.events.add(ev);
    this.col.apply(ev);
    const row = this.rows.push(ev, this.rolloverOf(ev.payload));
    const [p] = await this.engine.process(Float64Array.from(row), ev.event_id);
    return p;
  }

  /** Re-predict P(recall) now for the given (reviewed) cards. */
  async predict(cards: Card[]): Promise<void> {
    const now = Date.now();
    const tz = localTzOffsetMin();
    const rows: number[] = [];
    const list = cards.filter((c) => c.reviews > 0);
    for (const c of list) {
      const note = this.col.notes.get(c.note_id)!;
      const deck = this.col.decks.get(note.deck_id)!;
      this.rows.predictRow({ card_id: c.id, note_id: note.id, deck_id: deck.id, preset_id: deck.preset_id }, now, tz, this.rolloverOf(deck), rows);
    }
    if (!list.length) return;
    const ps = await this.engine.predict(Float64Array.from(rows));
    list.forEach((c, i) => {
      this.preds.set(c.id, ps[i]);
      this.predAt.set(c.id, now);
    });
  }

  /** The `n` reviewed cards whose prediction is oldest. */
  stalest(cards: Card[], n: number): Card[] {
    return cards
      .filter((c) => c.reviews > 0)
      .sort((a, b) => (this.predAt.get(a.id) ?? 0) - (this.predAt.get(b.id) ?? 0))
      .slice(0, n);
  }

  today(): number {
    return studyDay(Date.now(), localTzOffsetMin(), this.preset().day_rollover_hour);
  }

  private dayOf(ts: number): number {
    return studyDay(ts, localTzOffsetMin(), this.preset().day_rollover_hour);
  }

  /** Notes whose first card was introduced today (the daily limit counts words). */
  newWordsToday(): number {
    const today = this.today();
    const notes = new Set<EntityId>();
    for (const c of this.col.cards.values()) if (c.first_review_ts !== undefined && this.dayOf(c.first_review_ts) === today) notes.add(c.note_id);
    // A note counts only if none of its cards were seen before today.
    let n = 0;
    for (const id of notes) {
      const cards = (this.col.cardsByNote.get(id) ?? []).map((c) => this.col.cards.get(c)!);
      if (cards.every((c) => c.first_review_ts === undefined || this.dayOf(c.first_review_ts) === today)) n++;
    }
    return n;
  }

  /**
   * New cards that may be shown now: second directions of words introduced on
   * an earlier day (not limited), then fresh words up to the daily limit.
   */
  newQueue(deckId?: EntityId): Card[] {
    const today = this.today();
    const second: Card[] = [];
    const fresh: Card[] = [];
    for (const c of this.col.liveCards(deckId)) {
      if (c.reviews > 0) continue;
      const siblings = (this.col.cardsByNote.get(c.note_id) ?? []).filter((id) => id !== c.id).map((id) => this.col.cards.get(id)!);
      const seen = siblings.filter((s) => s.first_review_ts !== undefined);
      if (seen.length === 0) {
        if (c.template === "forward" || siblings.length === 0 || siblings.every((s) => s.template !== "forward")) fresh.push(c);
      } else if (seen.every((s) => this.dayOf(s.first_review_ts!) < today)) second.push(c);
    }
    const left = Math.max(0, this.preset().new_per_day - this.newWordsToday());
    return [...second, ...fresh.slice(0, left)];
  }

  async allEvents(): Promise<AppEvent[]> {
    return (await this.db.events.orderBy("seq").toArray()).map(({ seq: _seq, ...e }) => e as AppEvent);
  }

  /** Restore from a backup: adds unknown events (any type) and reloads. */
  async importBackup(events: AppEvent[]): Promise<number> {
    const fresh = events.filter((e) => e && typeof e.event_id === "string" && !this.col.eventIds.has(e.event_id));
    await this.db.events.bulkAdd(fresh);
    return fresh.length;
  }
}
