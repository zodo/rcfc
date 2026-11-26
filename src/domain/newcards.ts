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

/** The studied language of a card's word. */
function langOf(col: Collection, c: Card): string {
  return col.notes.get(c.note_id)?.lang_pair.from ?? "";
}

/**
 * Cards introduced today (except ones known on first sight), split into fresh words (no card of the note seen
 * before today) and second directions (a sibling was seen on an earlier day). Only words of `lang`, when given;
 * cards first answered from a pile in `notCounted` (a sticker pile the user asked for more) don't count.
 */
export function introducedToday(col: Collection, clock: DayClock, lang?: string, notCounted?: ReadonlySet<string>): { words: number; second: number } {
  const today = dayOf(clock.now, clock);
  const words = new Set<EntityId>();
  let second = 0;
  for (const c of col.cards.values()) {
    if (c.first_review_ts === undefined || dayOf(c.first_review_ts, clock) !== today) continue;
    if (lang !== undefined && langOf(col, c) !== lang) continue;
    if (c.first_pile !== undefined && notCounted?.has(c.first_pile)) continue;
    // Already known on first sight (Easy, e.g. sorted as known): not a new burden.
    if (c.first_rating === 4) continue;
    if (siblingsOf(col, c).some((s) => s.first_review_ts !== undefined && dayOf(s.first_review_ts, clock) < today)) second++;
    else words.add(c.note_id);
  }
  return { words: words.size, second };
}

/** Which cards to look at: one deck, the given cards, or every live card. */
export type Scope = EntityId | readonly Card[] | undefined;

function inScope(col: Collection, scope: Scope): readonly Card[] {
  return Array.isArray(scope) ? scope : col.liveCards(scope as EntityId | undefined);
}

/** Never-seen live cards: first cards of unseen words, and second directions ready to start. */
export function unseenCards(col: Collection, clock: DayClock, scope?: Scope): { fresh: Card[]; second: Card[] } {
  const today = dayOf(clock.now, clock);
  const second: Card[] = [];
  const fresh: Card[] = [];
  for (const c of inScope(col, scope)) {
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
 * New cards that may be shown now. Each studied language has its own daily
 * limit (`limit`, or `limit(lang)`; Infinity = none). Fresh words and second
 * directions (the other side of a word started on an earlier day) each get
 * it, so a big batch of known words doesn't crowd out new ones.
 */
export function newQueue(col: Collection, clock: DayClock, limit: number | ((lang: string) => number), scope?: Scope, notCounted?: ReadonlySet<string>): Card[] {
  // A limit may include today's extra words ("10 more" when the day's are done).
  const limitOf = typeof limit === "number" ? () => limit : limit;
  const { fresh, second } = unseenCards(col, clock, scope);
  const used = new Map<string, { words: number; second: number }>();
  const usedOf = (l: string) => used.get(l) ?? used.set(l, introducedToday(col, clock, l, notCounted)).get(l)!;
  const take = (cards: Card[], kind: "words" | "second") => {
    const taken = new Map<string, number>();
    return cards.filter((c) => {
      const l = langOf(col, c);
      const k = taken.get(l) ?? 0;
      if (k >= limitOf(l) - usedOf(l)[kind]) return false;
      taken.set(l, k + 1);
      return true;
    });
  };
  return [...take(second, "second"), ...take(fresh, "words")];
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
