// Word statuses as Words shows them (new / learning / known). Known needs the
// model's recall a week ahead (`Store.predictAt`), kept here between visits so
// the list, the words file and a reply's plan all read the same.
import { app } from "./app";
import type { Note } from "./domain/collection";
import type { EntityId } from "./domain/ids";
import { KNOWN_HORIZON_MS, wordStatus, type WordStatus } from "./domain/scheduler";

/** P(recall) a week ahead per studied card. */
export const weekAhead = new Map<EntityId, number>();

/** A word's status; undefined while its prediction hasn't come yet. */
export function statusOf(n: Note): WordStatus | undefined {
  const { col } = app.store;
  return wordStatus((col.cardsByNote.get(n.id) ?? []).map((id) => col.cards.get(id)!), weekAhead);
}

/** As `statusOf`, by id; a word not predicted yet counts as learning (never as known). */
export function statusById(id: EntityId): WordStatus {
  const n = app.store.col.notes.get(id);
  return (n && statusOf(n)) ?? "learning";
}

/** Predict a week ahead for these words' cards (default: every word). */
export async function refreshStatuses(lang?: string | null): Promise<void> {
  const { store } = app;
  const { col } = store;
  const cards = col.liveCards().filter((c) => !lang || col.notes.get(c.note_id)!.lang_pair.from === lang);
  for (const [id, p] of await store.predictAt(cards, Date.now() + KNOWN_HORIZON_MS)) weekAhead.set(id, p);
}
