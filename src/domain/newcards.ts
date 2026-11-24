// Which never-seen cards may be introduced now. Pure: a function of the folded
// collection and a clock, so the daily-limit rules are unit-tested without
// IndexedDB or RWKV (test/newcards.test.ts).
import type { Card, Collection } from "./collection";
import type { EntityId } from "./ids";
import { studyDay } from "./rows";

/** "Now" in study-day terms: local timezone and the preset's rollover hour. */
export interface DayClock {
  now: number;
  tzOffsetMin: number;
  rolloverHour: number;
}

function dayOf(ts: number, c: DayClock): number {
  return studyDay(ts, c.tzOffsetMin, c.rolloverHour);
}

function siblingsOf(col: Collection, c: Card): Card[] {
  return (col.cardsByNote.get(c.note_id) ?? []).filter((id) => id !== c.id).map((id) => col.cards.get(id)!);
}

/**
 * Cards introduced today (except ones known on first sight), split into fresh words (no card of the note seen
 * before today) and second directions (a sibling was seen on an earlier day).
 */
export function introducedToday(col: Collection, clock: DayClock): { words: number; second: number } {
  const today = dayOf(clock.now, clock);
  const words = new Set<EntityId>();
  let second = 0;
  for (const c of col.cards.values()) {
    if (c.first_review_ts === undefined || dayOf(c.first_review_ts, clock) !== today) continue;
    // Already known on first sight (Easy, e.g. sorted as known): not a new burden.
    if (c.first_rating === 4) continue;
    if (siblingsOf(col, c).some((s) => s.first_review_ts !== undefined && dayOf(s.first_review_ts, clock) < today)) second++;
    else words.add(c.note_id);
  }
  return { words: words.size, second };
}

/** Never-seen live cards: first cards of unseen words, and second directions ready to start. */
export function unseenCards(col: Collection, clock: DayClock, deckId?: EntityId): { fresh: Card[]; second: Card[] } {
  const today = dayOf(clock.now, clock);
  const second: Card[] = [];
  const fresh: Card[] = [];
  for (const c of col.liveCards(deckId)) {
    if (c.reviews > 0) continue;
    const siblings = siblingsOf(col, c);
    const seen = siblings.filter((s) => s.first_review_ts !== undefined);
    if (seen.length === 0) {
      if (c.template === "forward" || siblings.length === 0 || siblings.every((s) => s.template !== "forward")) fresh.push(c);
    } else if (seen.every((s) => dayOf(s.first_review_ts!, clock) < today)) second.push(c);
  }
  // Words asked for ("I don't know these") first, latest request first; then creation order (sort is stable).
  const prio = (c: Card) => col.notes.get(c.note_id)!.priority ?? 0;
  fresh.sort((a, b) => prio(b) - prio(a));
  return { fresh, second };
}

/**
 * New cards that may be shown now. Fresh words and second directions (the
 * other side of a word started on an earlier day) each get the daily limit,
 * so a big batch of known words doesn't crowd out new ones.
 */
export function newQueue(col: Collection, clock: DayClock, limit: number, deckId?: EntityId): Card[] {
  // `limit` may include today's extra words ("Learn more" when the day's are done).
  const { fresh, second } = unseenCards(col, clock, deckId);
  const today = introducedToday(col, clock);
  return [...second.slice(0, Math.max(0, limit - today.second)), ...fresh.slice(0, Math.max(0, limit - today.words))];
}

/**
 * Cards to answer "Easy" when the user says they already know these words: the
 * first card of a never-studied word (the other direction then starts on a
 * later day), else every card of it studied so far.
 */
export function knownCards(col: Collection, noteIds: Iterable<EntityId>): Card[] {
  const out: Card[] = [];
  for (const id of noteIds) {
    if (!col.liveNote(id)) continue;
    const cards = (col.cardsByNote.get(id) ?? []).map((c) => col.cards.get(c)!);
    const studied = cards.filter((c) => c.reviews > 0);
    if (studied.length) out.push(...studied);
    else {
      const first = cards.find((c) => c.template === "forward") ?? cards[0];
      if (first) out.push(first);
    }
  }
  return out;
}

/**
 * "I don't know these": studied cards get an Again answer (the model brings
 * them back soon); words never studied are queued to be learned next.
 */
export function unknownPlan(col: Collection, noteIds: Iterable<EntityId>): { again: Card[]; next: EntityId[] } {
  const again: Card[] = [];
  const next: EntityId[] = [];
  for (const id of noteIds) {
    if (!col.liveNote(id)) continue;
    const studied = (col.cardsByNote.get(id) ?? []).map((c) => col.cards.get(c)!).filter((c) => c.reviews > 0);
    if (studied.length) again.push(...studied);
    else next.push(id);
  }
  return { again, next };
}
