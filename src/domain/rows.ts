// Review events → RWKV input rows, following the RWKV4Anki add-on
// (review_rows.py `_append_review_values_to_context`):
//
// - day_offset: study day (local time, shifted by the rollover hour) relative to
//   the collection's first review day, so the first review is day 0.
// - elapsed_days: difference of study days since the card's previous review;
//   elapsed_seconds: whole seconds since it. Both -1 for a card's first review.
// - state: the card's phase before this answer, in the benchmark convention
//   0 new (first review), 1 learning, 2 review, 3 relearning.
//
// Row layout must match rwkv/engine/src/wasm.rs.
import type { Review } from "./events";
import type { EntityId } from "./ids";

export const ROW_WIDTH = 10;
/** Bump when the derivation below changes: invalidates RWKV checkpoints. */
export const ROWS_VERSION = 1;

const DAY = 86_400;

export type Phase = 0 | 1 | 2 | 3;

/** Absolute study-day number of a timestamp. */
export function studyDay(tsMs: number, tzOffsetMin: number, rolloverHour: number): number {
  return Math.floor((Math.floor(tsMs / 1000) + tzOffsetMin * 60 - rolloverHour * 3600) / DAY);
}

/** Minutes east of UTC right now on this device. */
export function localTzOffsetMin(at: Date = new Date()): number {
  return -at.getTimezoneOffset();
}

export function nextPhase(phase: Phase, rating: number): Phase {
  switch (phase) {
    case 0:
      return rating === 1 ? 1 : 2;
    case 1:
    case 3:
      return rating >= 3 ? 2 : phase;
    case 2:
      return rating === 1 ? 3 : 2;
  }
}

export interface CardRefs {
  card_id: EntityId;
  note_id: EntityId;
  deck_id: EntityId;
  preset_id: EntityId;
}

interface CardHistory {
  day: number;
  ts: number;
  phase: Phase;
}

/**
 * Incremental row builder. Feed reviews in replay order with `push`; ask for
 * prediction rows at any time with `predictRow`.
 */
export class RowBuilder {
  private origin: number | null = null;
  private cards = new Map<EntityId, CardHistory>();

  /** @param rolloverHour study-day boundary (from the review's preset) */
  push(r: Review, rolloverHour: number, out: number[] = []): number[] {
    const p = r.payload;
    const day = studyDay(r.ts, p.tz_offset_min, rolloverHour);
    if (this.origin === null) this.origin = day;
    const prev = this.cards.get(p.card_id);
    const phase: Phase = prev?.phase ?? 0;
    out.push(
      p.card_id,
      p.note_id,
      p.deck_id,
      p.preset_id,
      day - this.origin,
      prev ? day - prev.day : -1,
      prev ? Math.floor((r.ts - prev.ts) / 1000) : -1,
      p.rating,
      Math.max(0, p.duration_ms),
      phase,
    );
    this.cards.set(p.card_id, { day, ts: r.ts, phase: nextPhase(phase, p.rating) });
    return out;
  }

  predictRow(c: CardRefs, nowMs: number, tzOffsetMin: number, rolloverHour: number, out: number[] = []): number[] {
    const day = studyDay(nowMs, tzOffsetMin, rolloverHour);
    const prev = this.cards.get(c.card_id);
    out.push(
      c.card_id,
      c.note_id,
      c.deck_id,
      c.preset_id,
      this.origin === null ? 0 : day - this.origin,
      prev ? day - prev.day : -1,
      prev ? Math.max(0, Math.floor((nowMs - prev.ts) / 1000)) : -1,
      NaN,
      NaN,
      NaN,
    );
    return out;
  }

  phase(cardId: EntityId): Phase {
    return this.cards.get(cardId)?.phase ?? 0;
  }

  lastReviewDay(cardId: EntityId): number | undefined {
    return this.cards.get(cardId)?.day;
  }
}
