// Event types from docs/design.md ("Data model"). Events are immutable; current
// state is a fold over the log (src/domain/collection.ts).
import type { EntityId } from "./ids";

export interface EventEnvelope<T extends string, P> {
  event_id: string; // UUIDv7
  type: T;
  ts: number; // device wall clock at creation, ms since epoch
  device_id: string;
  payload: P;
}

/** BCP 47 tags. `from` is the studied language (front side) and drives pronunciation. */
export interface LangPair {
  from: string;
  to: string;
}

export interface NoteFields {
  front: string;
  back: string;
  /** Example sentence. */
  example?: string;
  /** The user's own pencil note on the white side (studied language). */
  memo_target?: string;
  /** The user's own pencil note on the cream side (known language). */
  memo_known?: string;
  [field: string]: string | undefined;
}

/** Where a note came from, when it was not typed in this app. */
export interface NoteSource {
  /** "import": Your AI (once Import from anything); "duocards": the old Duocards importer (older logs). */
  kind: "import" | "duocards";
  /** Original creation time in the source app, ISO 8601. */
  created_at?: string;
}

export interface PresetUpdatedPayload {
  preset_id: EntityId;
  /** No longer read: the target is fixed (src/domain/scheduler.ts TARGET_RECALL). Kept for old logs. */
  desired_retention: number;
  /** Local hour when a new study day starts (drives RWKV day_offset). Not user-settable; default 4. */
  day_rollover_hour: number;
  /** New cards introduced per study day, across decks using this preset. Not user-settable; default 10. */
  new_per_day: number;
}

export interface DeckCreatedPayload {
  deck_id: EntityId;
  name: string;
  preset_id: EntityId;
  /** Default language pair for notes added to this deck. */
  lang_pair: LangPair;
}

export interface DeckRenamedPayload {
  deck_id: EntityId;
  name: string;
}

export interface NoteCreatedPayload {
  note_id: EntityId;
  deck_id: EntityId;
  fields: NoteFields;
  lang_pair: LangPair;
  source?: NoteSource;
}

export interface NoteEditedPayload {
  note_id: EntityId;
  field: string;
  value: string;
}

export type CardTemplate = "forward" | "reverse";

export interface CardCreatedPayload {
  card_id: EntityId;
  note_id: EntityId;
  template: CardTemplate;
}

export interface NoteDeletedPayload {
  note_id: EntityId;
}

/**
 * The translation's language changed (the cream side's): `lang_pair.to`.
 * The studied language never changes, since it decides the hidden deck and the pile.
 * Last write wins.
 */
export interface NoteLangChangedPayload {
  note_id: EntityId;
  to: string;
}

/** Undo of a delete: the card is back, reviews and all. The later of the two wins. */
export interface NoteRestoredPayload {
  note_id: EntityId;
}

/** "I don't know these" on words never studied: introduce them before other new words. Latest batch first. */
export interface NotesPrioritizedPayload {
  note_ids: EntityId[];
}

/**
 * One answer. Raw facts only: RWKV inputs (day_offset, elapsed, state) are
 * derived at replay (src/domain/rows.ts). The envelope `ts` is the answer time.
 * note/deck/preset ids are recorded as of the answer, so later moves or
 * re-organisation never change what the model saw.
 */
export interface ReviewPayload {
  card_id: EntityId;
  note_id: EntityId;
  deck_id: EntityId;
  preset_id: EntityId;
  /** 1 again, 2 hard, 3 good, 4 easy. */
  rating: 1 | 2 | 3 | 4;
  duration_ms: number;
  /** Minutes east of UTC at answer time (local day boundaries survive travel). */
  tz_offset_min: number;
  /** The pile it was answered from (src/domain/piles.ts); absent when answered elsewhere (e.g. "I know"). */
  pile?: string;
}

/**
 * Cards dealt to a pile (src/domain/piles.ts): the day's deal (`more` false)
 * or "10 more". Only the count is recorded; cards are chosen when drawn.
 */
export interface PileDealtPayload {
  pile: string;
  /** Absolute study day (src/domain/rows.ts studyDay) the deal belongs to. */
  day: number;
  n: number;
  more: boolean;
  /** "All N" on a sticker pile: every word once more. Unlike "10 more" it doesn't grow tomorrow's deal. */
  all?: boolean;
}

/**
 * A sticker (a label stuck on words, docs/design.md "Piles, labels and
 * languages"). Its id is derived from its name when the name is new, so two
 * devices making the same sticker offline make one. Made again with an id
 * that exists: only the name is taken (last write wins).
 */
export interface LabelCreatedPayload {
  label_id: EntityId;
  name: string;
  /** Its colour as made (the one least used then); a later label_colored wins. */
  color?: string;
}

/** A new name for a sticker; its words and pile stay. Last write wins. */
export interface LabelRenamedPayload {
  label_id: EntityId;
  name: string;
}

/** A sticker gone for good: off every word, its pile off the table. */
export interface LabelDeletedPayload {
  label_id: EntityId;
}

/** A sticker's colour, one of LABEL_COLORS (src/domain/labels.ts). Last write wins. */
export interface LabelColoredPayload {
  label_id: EntityId;
  color: string;
}

/** A sticker stuck on (`on`) or peeled off words. Last write wins per word and sticker. */
export interface NotesLabeledPayload {
  label_id: EntityId;
  note_ids: EntityId[];
  on: boolean;
}

/**
 * A picture for a note (`r2_key` null = removed). Last write wins per note.
 * `sense`, `details` and `scene` are what it was drawn from, so a redraw keeps
 * the user's corrections and the edit screen can say what it shows.
 */
export interface AssetAttachedPayload {
  note_id: EntityId;
  kind: "image";
  r2_key: string | null;
  /** The meaning drawn (e.g. "bench" for "bank, bench"). */
  sense?: string;
  /** Extra prompt details the user typed. */
  details?: string;
  /** The scene the image model was given. */
  scene?: string;
}

export type PresetUpdated = EventEnvelope<"preset_updated", PresetUpdatedPayload>;
export type DeckCreated = EventEnvelope<"deck_created", DeckCreatedPayload>;
export type DeckRenamed = EventEnvelope<"deck_renamed", DeckRenamedPayload>;
export type NoteCreated = EventEnvelope<"note_created", NoteCreatedPayload>;
export type NoteEdited = EventEnvelope<"note_edited", NoteEditedPayload>;
export type NoteLangChanged = EventEnvelope<"note_lang_changed", NoteLangChangedPayload>;
export type NoteDeleted = EventEnvelope<"note_deleted", NoteDeletedPayload>;
export type NoteRestored = EventEnvelope<"note_restored", NoteRestoredPayload>;
export type NotesPrioritized = EventEnvelope<"notes_prioritized", NotesPrioritizedPayload>;
export type CardCreated = EventEnvelope<"card_created", CardCreatedPayload>;
export type Review = EventEnvelope<"review", ReviewPayload>;
export type AssetAttached = EventEnvelope<"asset_attached", AssetAttachedPayload>;
export type PileDealt = EventEnvelope<"pile_dealt", PileDealtPayload>;
export type LabelCreated = EventEnvelope<"label_created", LabelCreatedPayload>;
export type LabelRenamed = EventEnvelope<"label_renamed", LabelRenamedPayload>;
export type LabelDeleted = EventEnvelope<"label_deleted", LabelDeletedPayload>;
export type LabelColored = EventEnvelope<"label_colored", LabelColoredPayload>;
export type NotesLabeled = EventEnvelope<"notes_labeled", NotesLabeledPayload>;

export type AppEvent =
  | PresetUpdated
  | DeckCreated
  | DeckRenamed
  | NoteCreated
  | NoteEdited
  | NoteLangChanged
  | NoteDeleted
  | NoteRestored
  | NotesPrioritized
  | CardCreated
  | Review
  | AssetAttached
  | PileDealt
  | LabelCreated
  | LabelRenamed
  | LabelDeleted
  | LabelColored
  | NotesLabeled;

export type EventType = AppEvent["type"];
