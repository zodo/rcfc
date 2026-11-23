// Current state = fold over the event log. Pure and synchronous; the whole log
// is folded at startup (cheap: ~100k events is well under a second).
import type { AppEvent, CardTemplate, EventEnvelope, LangPair, NoteFields, NoteSource, PresetUpdatedPayload, Review } from "./events";
import { newEntityId, uuidv7, type EntityId } from "./ids";

export interface Deck {
  id: EntityId;
  name: string;
  preset_id: EntityId;
  lang_pair: LangPair;
}

export type Preset = PresetUpdatedPayload;

export interface Note {
  id: EntityId;
  deck_id: EntityId;
  fields: NoteFields;
  lang_pair: LangPair;
  source?: NoteSource;
  deleted: boolean;
  /** Fold order, for stable "oldest first". */
  order: number;
}

export interface Card {
  id: EntityId;
  note_id: EntityId;
  template: CardTemplate;
  order: number;
  reviews: number;
  /** ts of the first and last review. */
  first_review_ts?: number;
  /** Rating of the first review (4 = already known when first seen). */
  first_rating?: number;
  last_review_ts?: number;
}

export const DEFAULT_PRESET: Omit<Preset, "preset_id"> = {
  desired_retention: 0.9,
  day_rollover_hour: 4,
  new_per_day: 10,
};

/** Total order of events with equal-ish clocks: (ts, device_id, event_id). */
export function eventOrder(a: EventEnvelope<string, unknown>, b: EventEnvelope<string, unknown>): number {
  return a.ts - b.ts || (a.device_id < b.device_id ? -1 : a.device_id > b.device_id ? 1 : 0) || (a.event_id < b.event_id ? -1 : a.event_id > b.event_id ? 1 : 0);
}

export class Collection {
  readonly decks = new Map<EntityId, Deck>();
  readonly presets = new Map<EntityId, Preset>();
  readonly notes = new Map<EntityId, Note>();
  readonly cards = new Map<EntityId, Card>();
  readonly cardsByNote = new Map<EntityId, EntityId[]>();
  /** All reviews in replay order. */
  readonly reviews: Review[] = [];
  readonly eventIds = new Set<string>();
  private order = 0;
  /** Last-write-wins stamps for mutable fields, key → [ts, device_id]. */
  private stamps = new Map<string, [number, string]>();

  /** Apply one event. Returns false if it was already applied. */
  apply(e: AppEvent): boolean {
    if (this.eventIds.has(e.event_id)) return false;
    this.eventIds.add(e.event_id);
    const p = e.payload;
    switch (e.type) {
      case "preset_updated":
        if (this.wins(`preset:${e.payload.preset_id}`, e)) this.presets.set(e.payload.preset_id, { ...e.payload });
        break;
      case "deck_created":
        this.decks.set(e.payload.deck_id, { id: e.payload.deck_id, name: e.payload.name, preset_id: e.payload.preset_id, lang_pair: e.payload.lang_pair });
        this.wins(`deck:${e.payload.deck_id}:name`, e);
        break;
      case "deck_renamed": {
        const d = this.decks.get(e.payload.deck_id);
        if (d && this.wins(`deck:${d.id}:name`, e)) d.name = e.payload.name;
        break;
      }
      case "note_created":
        this.notes.set(e.payload.note_id, {
          id: e.payload.note_id,
          deck_id: e.payload.deck_id,
          fields: { ...e.payload.fields },
          lang_pair: e.payload.lang_pair,
          source: e.payload.source,
          deleted: false,
          order: this.order++,
        });
        break;
      case "note_edited": {
        const n = this.notes.get(e.payload.note_id);
        if (n && !n.deleted && this.wins(`note:${n.id}:${e.payload.field}`, e)) n.fields[e.payload.field] = e.payload.value;
        break;
      }
      case "note_deleted": {
        const n = this.notes.get(e.payload.note_id);
        if (n) n.deleted = true;
        break;
      }
      case "card_created": {
        this.cards.set(e.payload.card_id, { id: e.payload.card_id, note_id: e.payload.note_id, template: e.payload.template, order: this.order++, reviews: 0 });
        const list = this.cardsByNote.get(e.payload.note_id) ?? [];
        list.push(e.payload.card_id);
        this.cardsByNote.set(e.payload.note_id, list);
        break;
      }
      case "review": {
        // Late (out-of-order) reviews only come with sync; keep the list sorted.
        let i = this.reviews.length;
        while (i > 0 && eventOrder(this.reviews[i - 1], e) > 0) i--;
        this.reviews.splice(i, 0, e);
        const c = this.cards.get(e.payload.card_id);
        if (c) {
          c.reviews++;
          if (c.first_review_ts === undefined || e.ts < c.first_review_ts) {
            c.first_review_ts = e.ts;
            c.first_rating = e.payload.rating;
          }
          c.last_review_ts = Math.max(c.last_review_ts ?? -Infinity, e.ts);
        }
        break;
      }
      default: {
        const never: never = e;
        void never;
        void p;
      }
    }
    return true;
  }

  private wins(key: string, e: AppEvent): boolean {
    const s = this.stamps.get(key);
    if (s && (s[0] > e.ts || (s[0] === e.ts && s[1] >= e.device_id))) return false;
    this.stamps.set(key, [e.ts, e.device_id]);
    return true;
  }

  // ---- queries ----

  liveNote(id: EntityId): Note | undefined {
    const n = this.notes.get(id);
    return n && !n.deleted ? n : undefined;
  }

  /** Live cards, optionally of one deck, in creation order. */
  liveCards(deckId?: EntityId): Card[] {
    const out: Card[] = [];
    for (const c of this.cards.values()) {
      const n = this.liveNote(c.note_id);
      if (n && (deckId === undefined || n.deck_id === deckId)) out.push(c);
    }
    return out.sort((a, b) => a.order - b.order);
  }

  deckOf(card: Card): Deck | undefined {
    const n = this.notes.get(card.note_id);
    return n && this.decks.get(n.deck_id);
  }

  presetOf(card: Card): Preset {
    const d = this.deckOf(card);
    const p = d && this.presets.get(d.preset_id);
    return p ?? { preset_id: d?.preset_id ?? 0, ...DEFAULT_PRESET };
  }

  /** Any preset (there is one per user to start with). */
  defaultPreset(): Preset | undefined {
    return this.presets.values().next().value;
  }

  liveNotes(deckId?: EntityId): Note[] {
    return [...this.notes.values()].filter((n) => !n.deleted && (deckId === undefined || n.deck_id === deckId)).sort((a, b) => a.order - b.order);
  }
}

/** Event factory bound to a device and clock. */
export class EventFactory {
  constructor(
    readonly deviceId: string,
    private now: () => number = Date.now,
  ) {}

  make<E extends AppEvent>(type: E["type"], payload: E["payload"]): E {
    const ts = this.now();
    return { event_id: uuidv7(ts), type, ts, device_id: this.deviceId, payload } as E;
  }

  preset(p: Partial<Omit<Preset, "preset_id">> & { preset_id?: EntityId } = {}): AppEvent {
    return this.make("preset_updated", { ...DEFAULT_PRESET, ...p, preset_id: p.preset_id ?? newEntityId() });
  }

  deck(name: string, preset_id: EntityId, lang_pair: LangPair): AppEvent {
    return this.make("deck_created", { deck_id: newEntityId(), name, preset_id, lang_pair });
  }

  /** A note and its cards, in one batch. */
  note(deck_id: EntityId, fields: NoteFields, lang_pair: LangPair, templates: CardTemplate[] = ["forward", "reverse"]): AppEvent[] {
    const note_id = newEntityId();
    return [
      this.make("note_created", { note_id, deck_id, fields, lang_pair }),
      ...templates.map((template) => this.make("card_created", { card_id: newEntityId(), note_id, template })),
    ];
  }
}
