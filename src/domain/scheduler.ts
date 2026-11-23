// Which card next. Mirrors the RWKV4Anki live session in spirit: a review card
// is due when its RWKV P(recall) is below desired retention, the lowest P goes
// first, a just-answered card waits `reentryDelay` answers before it can come
// back, and new cards are interleaved under a daily limit.
import type { EntityId } from "./ids";

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
