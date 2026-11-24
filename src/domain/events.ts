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
  /** Example sentence (Duocards calls it "hint"). */
  example?: string;
  [field: string]: string | undefined;
}

/** Where a note came from, when it was not typed in this app. */
export interface NoteSource {
  kind: "duocards";
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
export type NoteDeleted = EventEnvelope<"note_deleted", NoteDeletedPayload>;
export type NotesPrioritized = EventEnvelope<"notes_prioritized", NotesPrioritizedPayload>;
export type CardCreated = EventEnvelope<"card_created", CardCreatedPayload>;
export type Review = EventEnvelope<"review", ReviewPayload>;
export type AssetAttached = EventEnvelope<"asset_attached", AssetAttachedPayload>;

export type AppEvent =
  | PresetUpdated
  | DeckCreated
  | DeckRenamed
  | NoteCreated
  | NoteEdited
  | NoteDeleted
  | NotesPrioritized
  | CardCreated
  | Review
  | AssetAttached;

export type EventType = AppEvent["type"];
