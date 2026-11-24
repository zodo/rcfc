// The recall target and word status. Which card comes next is the pile's
// business (src/domain/piles.ts).
import type { EntityId } from "./ids";

/**
 * Target P(recall): a card is due once its prediction falls below this. Fixed,
 * not a setting: 90% is the usual sweet spot between workload and forgetting.
 * (Presets still carry `desired_retention` from older versions; it is ignored.)
 */
export const TARGET_RECALL = 0.9;

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
