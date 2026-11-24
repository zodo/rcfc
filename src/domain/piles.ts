// Piles (docs/design.md, "Piles, labels and languages"). Like real cards dealt
// on a table:
//
// 1. Every study day each pile is dealt its size (`pile_dealt` events).
// 2. A pile fixes how many cards, not which: a card is chosen when drawn, the
//    one in the pile's words that needs the user most right then.
// 3. A seen card stays fixed. Again tucks it under its pile (it waits there,
//    past the rollover too, until answered right); the top card and the one
//    peeked under it are fixed by the session (src/session.ts).
// 4. Got it or Easy puts the card in the done tray for the day, in every pile.
//
// Everything here is derived from the log, so it syncs. Pure: a function of
// the folded collection, predictions and a clock.
import type { Card, Collection } from "./collection";
import type { CardTemplate } from "./events";
import type { EntityId } from "./ids";
import { newQueue, type DayClock } from "./newcards";
import { studyDay } from "./rows";
import { TARGET_RECALL } from "./scheduler";

/** A pile's size before it has history, and how it learns: +STEP after "more", -STEP when left unfinished. */
export const PILE_START = 20;
export const PILE_STEP = 5;
export const PILE_MIN = 10;
export const PILE_MAX = 50;
/** Cards "more" deals. */
export const MORE = 5;
/** A face is not drawn this soon after its twin was answered (its answer was just on screen). */
export const TWIN_GAP_MS = 3_600_000;

/** The pile of every word in one studied language, whatever its translations are in. */
export function languagePile(lang: string): string {
  return `lang:${lang}`;
}

export type DrawKind = "again" | "due" | "new";
export interface Draw {
  card: EntityId;
  kind: DrawKind;
  /** P(recall) now, for reviewed cards. */
  p?: number;
}

function today(clock: DayClock): number {
  return studyDay(clock.now, clock.tzOffsetMin, clock.rolloverHour);
}

/** Cards answered right (Got it, Easy; Hard counts too) from `pile`, per study day. */
function doneFromPile(col: Collection, pile: string, rolloverHour: number, sinceDay = -Infinity): Map<number, Set<EntityId>> {
  const out = new Map<number, Set<EntityId>>();
  for (let i = col.reviews.length - 1; i >= 0; i--) {
    const r = col.reviews[i];
    const day = studyDay(r.ts, r.payload.tz_offset_min, rolloverHour);
    if (day < sinceDay - 1) break; // reviews are in time order; one day of slack for time zones
    if (day < sinceDay || r.payload.pile !== pile || r.payload.rating < 2) continue;
    const set = out.get(day) ?? new Set<EntityId>();
    set.add(r.payload.card_id);
    out.set(day, set);
  }
  return out;
}

/**
 * Today's size: replays the pile's past days. Starts at PILE_START; a day with
 * "more" grows it, a day that ended with cards left shrinks it. Days the pile
 * was not dealt change nothing.
 */
export function pileSize(col: Collection, pile: string, clock: DayClock): number {
  const t = today(clock);
  const days = [...(col.deals.get(pile)?.entries() ?? [])].filter(([d]) => d < t).sort((a, b) => a[0] - b[0]);
  if (!days.length) return PILE_START;
  const done = doneFromPile(col, pile, clock.rolloverHour, days[0][0]);
  let size = PILE_START;
  for (const [day, { deal, more }] of days) {
    const unfinished = (done.get(day)?.size ?? 0) < deal + more;
    size += (more > 0 ? PILE_STEP : 0) - (unfinished ? PILE_STEP : 0);
    size = Math.max(PILE_MIN, Math.min(PILE_MAX, size));
  }
  return size;
}

export interface PileInput {
  col: Collection;
  pile: string;
  /** The pile's words (live cards). */
  source: readonly Card[];
  /** Current P(recall) of reviewed cards. */
  preds: ReadonlyMap<EntityId, number>;
  clock: DayClock;
  /** Today's size (pileSize). */
  size: number;
  /** New words a day; undefined = no limit (a label pile). */
  newPerDay?: number;
}

/** A pile as it lies on the table today. */
export class PileView {
  readonly today: number;
  /** Dealt today (deal + more); 0 = not dealt yet. */
  readonly dealt: number;
  /** Dealt today by "more". */
  readonly more: number;
  /** Cards answered right from this pile today. */
  readonly completed: Set<EntityId>;
  /** Under the pile since an earlier day (on top of today's deal), oldest first. */
  readonly carried: EntityId[] = [];
  /** Tucked under the pile today, oldest first. */
  readonly againToday: EntityId[] = [];
  private readonly waiting = new Set<EntityId>();
  private readonly doneToday = new Set<EntityId>();

  constructor(private i: PileInput) {
    const { col, pile, clock } = i;
    this.today = today(clock);
    const d = col.deals.get(pile)?.get(this.today);
    this.dealt = d ? d.deal + d.more : 0;
    this.more = d?.more ?? 0;
    this.completed = doneFromPile(col, pile, clock.rolloverHour, this.today).get(this.today) ?? new Set();
    const tucked: Card[] = [];
    for (const c of i.source) {
      if (c.last_review_ts === undefined) continue;
      if (c.last_rating === 1 && c.last_pile === pile) tucked.push(c);
      else if (c.last_rating! >= 2 && this.dayOf(c.last_review_ts) === this.today) this.doneToday.add(c.id);
    }
    tucked.sort((a, b) => a.last_review_ts! - b.last_review_ts!);
    for (const c of tucked) {
      this.waiting.add(c.id);
      (this.dayOf(c.last_review_ts!) < this.today ? this.carried : this.againToday).push(c.id);
    }
  }

  private dayOf(ts: number): number {
    return studyDay(ts, this.i.clock.tzOffsetMin, this.i.clock.rolloverHour);
  }

  /** Waiting cards that hold one of today's slots (not answered right from it today). */
  private get waitingOpen(): number {
    let n = 0;
    for (const id of this.waiting) if (!this.completed.has(id)) n++;
    return n;
  }

  /**
   * Slots today's deal still has for cards chosen when drawn. Before the deal
   * is recorded (the table shows the pile before anyone studies it), the deal
   * it would get.
   */
  private get freshSlots(): number {
    this.preview ??= this.dealt || this.dealSize();
    return Math.max(0, this.preview - this.completed.size - this.waitingOpen);
  }
  private preview?: number;

  /** Cards left in the pile (the visible top card included). Before today's deal: what a deal would give. */
  left(): number {
    if (!this.dealt) return this.dealSize();
    return Math.min(this.freshSlots, this.available()) + this.waiting.size;
  }

  /** What dealing now would put in the pile: waiting cards plus cards to draw, up to the size. */
  dealSize(): number {
    return Math.min(this.i.size, this.waiting.size + this.available());
  }

  /** New words allowed now: the daily limit plus today's "more". */
  private newLimit(): number {
    return this.i.newPerDay === undefined ? Infinity : this.i.newPerDay + this.more;
  }

  private dueCards(): { card: Card; p: number }[] {
    const out: { card: Card; p: number }[] = [];
    for (const c of this.i.source) {
      const p = this.i.preds.get(c.id);
      if (c.reviews > 0 && p !== undefined && p < TARGET_RECALL && !this.doneToday.has(c.id) && !this.waiting.has(c.id)) out.push({ card: c, p });
    }
    return out.sort((a, b) => a.p - b.p);
  }

  private newCards(): Card[] {
    return newQueue(this.i.col, this.i.clock, this.newLimit(), this.i.source);
  }

  /** Cards that could be drawn into the pile now (twin gap ignored): due ones, then new words. */
  available(): number {
    return this.dueCards().length + this.newCards().length;
  }

  /** Whether a sibling of this card was answered within the twin gap. */
  private twinHot(c: Card): boolean {
    for (const id of this.i.col.cardsByNote.get(c.note_id) ?? []) {
      const s = this.i.col.cards.get(id);
      if (id !== c.id && s?.last_review_ts !== undefined && this.i.clock.now - s.last_review_ts < TWIN_GAP_MS) return true;
    }
    return false;
  }

  /**
   * The next card under the `visible` ones (the top card, the one peeked under
   * it). Order: cards carried over from an earlier day, then cards chosen now
   * (due ones weakest first, then new words), then cards tucked under today.
   * With `face`, the card must lie that side up (its spot already showed that
   * colour), unless no card of that colour is left.
   */
  next(visible: readonly EntityId[] = [], face?: CardTemplate): Draw | null {
    if (face) return this.pick(visible, (c) => c.template === face) ?? this.pick(visible, () => true);
    return this.pick(visible, () => true);
  }

  private pick(visible: readonly EntityId[], fits: (c: Card) => boolean): Draw | null {
    const vis = new Set(visible);
    const ok = (id: EntityId) => !vis.has(id) && fits(this.i.col.cards.get(id)!);
    const carried = this.carried.find(ok);
    if (carried !== undefined) return this.draw(carried, "again");
    const visibleFresh = visible.filter((id) => !this.waiting.has(id)).length;
    if (this.freshSlots - visibleFresh > 0) {
      const notes = new Set(visible.map((id) => this.i.col.cards.get(id)?.note_id));
      const free = (c: Card) => !vis.has(c.id) && !notes.has(c.note_id) && fits(c);
      const due = this.dueCards().filter((d) => free(d.card));
      const cool = due.find((d) => !this.twinHot(d.card));
      if (cool) return { card: cool.card.id, kind: "due", p: cool.p };
      const fresh = this.newCards().filter(free);
      const coolNew = fresh.find((c) => !this.twinHot(c));
      if (coolNew) return { card: coolNew.id, kind: "new" };
      // Only twins of just-answered cards left: better than nothing.
      if (due[0]) return { card: due[0].card.id, kind: "due", p: due[0].p };
      if (fresh[0]) return { card: fresh[0].id, kind: "new" };
    }
    const again = this.againToday.find(ok);
    return again === undefined ? null : this.draw(again, "again");
  }

  private draw(id: EntityId, kind: DrawKind): Draw {
    const p = this.i.preds.get(id);
    return p === undefined ? { card: id, kind } : { card: id, kind, p };
  }

  /** Whether a card is done for today (answered right, in any pile). */
  isDone(id: EntityId): boolean {
    return this.doneToday.has(id);
  }
}
