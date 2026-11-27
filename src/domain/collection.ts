// Current state = fold over the event log. Pure and synchronous; the whole log
// is folded at startup (cheap: ~100k events is well under a second).
import type { AppEvent, AssetAttachedPayload, CardTemplate, EventEnvelope, LangPair, NoteFields, NoteSource, PresetUpdatedPayload, Review } from "./events";
import { newEntityId, uuidv7, type EntityId } from "./ids";
import { nameKey } from "./labels";

/**
 * A pile key as the app now names it. Language piles were once one per pair
 * (`lang:es>en`); now one per studied language (`lang:es`), so older events
 * read as the pile of their studied language.
 */
export function pileKey(pile: string): string {
  const m = /^lang:([^>]+)>/.exec(pile);
  return m ? `lang:${m[1]}` : pile;
}

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
  /** Current picture, if any. */
  picture?: Picture;
  /** The user removed the picture: never draw one automatically. */
  noPicture?: boolean;
  /** Fold order, for stable "oldest first". */
  order: number;
  /** ts of the latest "learn these next" (notes_prioritized): new words go out latest first. */
  priority?: number;
  /**
   * Word, translation and translation language it had before they were edited:
   * the importer and add_words take a row matching one of them as this word, so
   * pasting the old list again after translating the cards adds nothing.
   */
  former?: { front: string; back: string; to: string }[];
}

/** Keeps the note's word, translation and translation language as they are now in `former`, before one of them changes. */
function remember(n: Note): void {
  const now = { front: n.fields.front, back: n.fields.back, to: n.lang_pair.to };
  const list = (n.former ??= []);
  if (!list.some((f) => f.front === now.front && f.back === now.back && f.to === now.to)) list.push(now);
}

export type Picture = Omit<AssetAttachedPayload, "note_id" | "kind" | "r2_key"> & { key: string };

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
  /** Rating of the latest review (4 after "I know these"). */
  last_rating?: number;
  /** Pile of the latest review, if it was answered from one. */
  last_pile?: string;
  /** Pile of the first review (where a new word was introduced). */
  first_pile?: string;
}

/** A sticker. Deleted ones stay, so their ids are never reused. */
export interface Label {
  id: EntityId;
  name: string;
  deleted: boolean;
  /** Picked in the pencil sheet; unset = the default for its id (labels.ts labelColor). */
  color?: string;
}

/** A pile's deals on one study day: the deal (largest, if devices dealt it twice offline) and "more" added on top. */
export interface DayDeal {
  deal: number;
  more: number;
  /** The part of `more` dealt by "All N" (which doesn't grow the next deal, unlike "10 more"). */
  all: number;
  /** When the latest "All N" was dealt. */
  allTs?: number;
  /** How many times more was dealt ("10 more", a handful, "All N"): the bonus check's ×N. */
  rounds: number;
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
  /** pile → study day → what was dealt. */
  readonly deals = new Map<string, Map<number, DayDeal>>();
  readonly labels = new Map<EntityId, Label>();
  /** sticker → the notes wearing it (deleted notes included). */
  private stuck = new Map<EntityId, Set<EntityId>>();
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
        if (n && !n.deleted && this.wins(`note:${n.id}:${e.payload.field}`, e)) {
          if (e.payload.field === "front" || e.payload.field === "back") remember(n);
          n.fields[e.payload.field] = e.payload.value;
        }
        break;
      }
      case "note_lang_changed": {
        const n = this.notes.get(e.payload.note_id);
        // A new object: the old one is the note_created event's own payload.
        if (n && !n.deleted && this.wins(`note:${n.id}:to`, e)) {
          remember(n);
          n.lang_pair = { from: n.lang_pair.from, to: e.payload.to };
        }
        break;
      }
      case "note_deleted":
      case "note_restored": {
        // The later of a delete and its undo wins, whatever order they arrive in.
        const n = this.notes.get(e.payload.note_id);
        if (n && this.wins(`note:${n.id}:deleted`, e)) n.deleted = e.type === "note_deleted";
        break;
      }
      case "notes_prioritized":
        for (const id of e.payload.note_ids) {
          const n = this.notes.get(id);
          if (n) n.priority = Math.max(n.priority ?? 0, e.ts);
        }
        break;
      case "card_created": {
        this.cards.set(e.payload.card_id, { id: e.payload.card_id, note_id: e.payload.note_id, template: e.payload.template, order: this.order++, reviews: 0 });
        const list = this.cardsByNote.get(e.payload.note_id) ?? [];
        list.push(e.payload.card_id);
        this.cardsByNote.set(e.payload.note_id, list);
        break;
      }
      case "asset_attached": {
        const n = this.notes.get(e.payload.note_id);
        if (n && e.payload.kind === "image" && this.wins(`note:${n.id}:image`, e)) {
          const { r2_key, sense, details, scene } = e.payload;
          n.picture = r2_key ? { key: r2_key, sense, details, scene } : undefined;
          n.noPicture = !r2_key;
        }
        break;
      }
      case "review": {
        // Older pile names read as today's; the stored event is left as it is.
        if (e.payload.pile !== undefined && pileKey(e.payload.pile) !== e.payload.pile) e = { ...e, payload: { ...e.payload, pile: pileKey(e.payload.pile) } };
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
            c.first_pile = e.payload.pile;
          }
          if (c.last_review_ts === undefined || e.ts >= c.last_review_ts) {
            c.last_review_ts = e.ts;
            c.last_rating = e.payload.rating;
            c.last_pile = e.payload.pile;
          }
        }
        break;
      }
      case "pile_dealt": {
        const { day, n, more } = e.payload;
        const pile = pileKey(e.payload.pile);
        const days = this.deals.get(pile) ?? new Map<number, DayDeal>();
        this.deals.set(pile, days);
        const d = days.get(day) ?? { deal: 0, more: 0, all: 0, rounds: 0 };
        if (more) {
          d.more += n;
          d.rounds++;
          if (e.payload.all) {
            d.all += n;
            d.allTs = Math.max(d.allTs ?? 0, e.ts);
          }
        } else d.deal = Math.max(d.deal, n);
        days.set(day, d);
        break;
      }
      case "label_created": {
        const { label_id: id, name } = e.payload;
        if (!this.labels.has(id)) this.labels.set(id, { id, name, deleted: false });
        const l = this.labels.get(id)!;
        if (this.wins(`label:${id}:name`, e)) l.name = name;
        if (e.payload.color && this.wins(`label:${id}:color`, e)) l.color = e.payload.color;
        break;
      }
      case "label_renamed": {
        const l = this.labels.get(e.payload.label_id);
        if (l && this.wins(`label:${l.id}:name`, e)) l.name = e.payload.name;
        break;
      }
      case "label_deleted": {
        const l = this.labels.get(e.payload.label_id);
        if (l) l.deleted = true;
        else this.labels.set(e.payload.label_id, { id: e.payload.label_id, name: "", deleted: true });
        break;
      }
      case "label_colored": {
        const l = this.labels.get(e.payload.label_id);
        if (l && this.wins(`label:${l.id}:color`, e)) l.color = e.payload.color;
        break;
      }
      case "notes_labeled": {
        const { label_id, note_ids, on } = e.payload;
        const set = this.stuck.get(label_id) ?? new Set<EntityId>();
        this.stuck.set(label_id, set);
        for (const id of note_ids) {
          if (!this.wins(`stuck:${label_id}:${id}`, e)) continue;
          if (on) set.add(id);
          else set.delete(id);
        }
        break;
      }
      default: {
        // An event type from a newer app version: ignore it.
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

  /**
   * The preset settings edit and daily limits use. Every device creates one on
   * first launch, so after pairing there can be several: pick the same one on
   * every device (lowest id among presets that decks use, else lowest id).
   */
  defaultPreset(): Preset | undefined {
    const used = new Set([...this.decks.values()].map((d) => d.preset_id));
    const pick = (ps: Preset[]) => ps.sort((a, b) => a.preset_id - b.preset_id)[0];
    const all = [...this.presets.values()];
    return pick(all.filter((p) => used.has(p.preset_id))) ?? pick(all);
  }

  /** Stickers not deleted, by name. */
  liveLabels(): Label[] {
    return [...this.labels.values()].filter((l) => !l.deleted).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }) || a.id - b.id);
  }

  liveLabel(id: EntityId): Label | undefined {
    const l = this.labels.get(id);
    return l && !l.deleted ? l : undefined;
  }

  /** The live sticker with this name (case and spaces aside). */
  labelByName(name: string): Label | undefined {
    const k = nameKey(name);
    return this.liveLabels().find((l) => nameKey(l.name) === k);
  }

  /** Whether a live word wears a live sticker. */
  wears(noteId: EntityId, labelId: EntityId): boolean {
    return !!this.liveLabel(labelId) && !!this.stuck.get(labelId)?.has(noteId) && !!this.liveNote(noteId);
  }

  /** Live words wearing a sticker, oldest first. */
  labelNotes(labelId: EntityId): Note[] {
    if (!this.liveLabel(labelId)) return [];
    const out: Note[] = [];
    for (const id of this.stuck.get(labelId) ?? []) {
      const n = this.liveNote(id);
      if (n) out.push(n);
    }
    return out.sort((a, b) => a.order - b.order);
  }

  /** The live stickers a word wears, by name. */
  labelsOf(noteId: EntityId): Label[] {
    return this.liveLabels().filter((l) => this.stuck.get(l.id)?.has(noteId));
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

  deck(name: string, preset_id: EntityId, lang_pair: LangPair, deck_id: EntityId = newEntityId()): AppEvent {
    return this.make("deck_created", { deck_id, name, preset_id, lang_pair });
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
