// Event types from docs/design.md ("Data model"). Only what is used so far;
// extend as features land.
import type { EntityId } from "./ids";

export interface EventEnvelope<T extends string, P> {
  event_id: string; // UUIDv7
  type: T;
  ts: number; // device wall clock at creation, ms since epoch
  device_id: string;
  payload: P;
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

export interface NoteCreatedPayload {
  note_id: EntityId;
  deck_id: EntityId;
  fields: NoteFields;
  /** BCP 47 tags, e.g. { from: "es", to: "en" }. `from` drives pronunciation. */
  lang_pair: { from: string; to: string };
  source?: NoteSource;
}

export type CardTemplate = "forward" | "reverse";

export interface CardCreatedPayload {
  card_id: EntityId;
  note_id: EntityId;
  template: CardTemplate;
}

export type NoteCreated = EventEnvelope<"note_created", NoteCreatedPayload>;
export type CardCreated = EventEnvelope<"card_created", CardCreatedPayload>;
export type AppEvent = NoteCreated | CardCreated;
