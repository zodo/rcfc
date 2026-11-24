// Which card next. Mirrors the RWKV4Anki live session in spirit: a review card
// is due when its RWKV P(recall) is below desired retention, the lowest P goes
// first, a just-answered card waits `reentryDelay` answers before it can come
// back, and new cards are interleaved under a daily limit.
import type { EntityId } from "./ids";

/**
 * Target P(recall): a card is due once its prediction falls below this. Fixed,
 * not a setting: 90% is the usual sweet spot between workload and forgetting.
 * (Presets still carry `desired_retention` from older versions; it is ignored.)
 */
export const TARGET_RECALL = 0.9;

export interface PickInput {
  /** Current P(recall) of reviewed cards. */
  preds: ReadonlyMap<EntityId, number>;
  /** Cards answered this session, oldest first. */
  recent: readonly EntityId[];
  /** New cards that may be introduced now, in introduction order. */
  newQueue: readonly EntityId[];
  /** New cards still allowed today. */
  newLeft: number;
  /** Answers since the last new card was introduced. */
  sinceNew: number;
  desired: number;
  /** Keep going past the due threshold (lowest P first). */
  ahead?: boolean;
  reentryDelay?: number;
  /** With due reviews waiting, introduce a new card every `newEvery` answers. */
  newEvery?: number;
}

export type Pick = { card: EntityId; kind: "due" | "new" | "ahead"; p?: number };

export function pickNext(i: PickInput): Pick | null {
  const blocked = new Set(i.recent.slice(-(i.reentryDelay ?? 2)));
  let best: EntityId | undefined;
  let bestP = Infinity;
  for (const [card, p] of i.preds) {
    if (!blocked.has(card) && p < bestP) {
      best = card;
      bestP = p;
    }
  }
  const due = best !== undefined && bestP < i.desired;
  const nextNew = i.newLeft > 0 ? i.newQueue.find((c) => !blocked.has(c)) : undefined;
  if (nextNew !== undefined && (!due || i.sinceNew >= (i.newEvery ?? 4))) return { card: nextNew, kind: "new" };
  if (due) return { card: best!, kind: "due", p: bestP };
  if (i.ahead && best !== undefined) return { card: best, kind: "ahead", p: bestP };
  return null;
}

export function dueCount(preds: ReadonlyMap<EntityId, number>, desired: number): number {
  let n = 0;
  for (const p of preds.values()) if (p < desired) n++;
  return n;
}

/** How far ahead "known" looks: a word is known if you would still recall it then. */
export const KNOWN_HORIZON_MS = 7 * 86_400_000;

export type WordStatus = "new" | "learning" | "known";

/**
 * A word's progress for the word list, stable from minute to minute (unlike
 * P(recall) now, which is ~100% right after any answer): new until a card is
 * studied; known once every studied card either was last answered Easy (the
 * user said they know it, until a later answer says otherwise) or is predicted
 * at or above the target a week ahead (`weekAhead`, from `Store.predictAt`);
 * learning otherwise. Undefined while a needed prediction is missing.
 */
export function wordStatus(cards: readonly { id: EntityId; reviews: number; last_rating?: number }[], weekAhead: ReadonlyMap<EntityId, number>): WordStatus | undefined {
  const studied = cards.filter((c) => c.reviews > 0);
  if (!studied.length) return "new";
  const unsure = studied.filter((c) => c.last_rating !== 4);
  const ps = unsure.map((c) => weekAhead.get(c.id));
  if (ps.some((p) => p === undefined)) return undefined;
  return ps.every((p) => p! >= TARGET_RECALL) ? "known" : "learning";
}
