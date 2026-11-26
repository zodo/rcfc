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
export const MORE = 10;
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
  for (const [day, { deal, more, all }] of days) {
    const asked = more - all; // "10 more"; "All N" is a one-off
    const unfinished = (done.get(day)?.size ?? 0) < deal + asked;
    size += (asked > 0 ? PILE_STEP : 0) - (unfinished ? PILE_STEP : 0);
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
  /** New words allowed today per studied language, "more" included (Infinity = no limit). */
  newLimit: (lang: string) => number;
  /** Piles whose new words don't count toward the limit (sticker piles the user asked for more today). */
  notCounted?: ReadonlySet<string>;
  /**
   * Draw every word once, weakest first, due or not and done today or not
   * (those last): a sticker pile after "10 more" or "All N". One face per word.
   */
  wide?: boolean;
  /** Words on top of another pile: not drawn here unless nothing else is left. */
  avoid?: ReadonlySet<EntityId>;
  /** Cards that belong elsewhere (tucked under another pile): never drawn here. */
  skip?: (c: Card) => boolean;
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
  /** The pile's words, without cards tucked under other piles. */
  private readonly source: readonly Card[];
  /** Wide: words answered right from this pile since the latest "All N" (today, without one). */
  private taken?: Set<EntityId>;

  constructor(private i: PileInput) {
    const { col, pile, clock } = i;
    this.source = i.skip ? i.source.filter((c) => !i.skip!(c)) : i.source;
    this.today = today(clock);
    const d = col.deals.get(pile)?.get(this.today);
    this.dealt = d ? d.deal + d.more : 0;
    this.more = d?.more ?? 0;
    this.completed = doneFromPile(col, pile, clock.rolloverHour, this.today).get(this.today) ?? new Set();
    const tucked: Card[] = [];
    for (const c of this.source) {
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

  private dueCards(): { card: Card; p: number }[] {
    const out: { card: Card; p: number }[] = [];
    for (const c of this.source) {
      const p = this.i.preds.get(c.id);
      if (c.reviews > 0 && p !== undefined && p < TARGET_RECALL && !this.doneToday.has(c.id) && !this.waiting.has(c.id)) out.push({ card: c, p });
    }
    return out.sort((a, b) => a.p - b.p);
  }

  private newCards(): Card[] {
    return newQueue(this.i.col, this.i.clock, this.i.newLimit, this.source, this.i.notCounted);
  }

  /** Words answered right from this pile since the latest "All N", or today. */
  private takenNotes(): Set<EntityId> {
    if (this.taken) return this.taken;
    const { col, pile } = this.i;
    const since = col.deals.get(pile)?.get(this.today)?.allTs;
    this.taken = new Set();
    if (since === undefined) for (const id of this.completed) this.taken.add(col.cards.get(id)!.note_id);
    else
      for (let k = col.reviews.length - 1; k >= 0 && col.reviews[k].ts >= since; k--) {
        const r = col.reviews[k];
        if (r.payload.pile === pile && r.payload.rating >= 2) this.taken.add(r.payload.note_id);
      }
    return this.taken;
  }

  /**
   * Wide: one face per word not taken yet and not waiting under the pile, the
   * one needing the user most (a studied face, weakest first; else its new
   * face). Words not done today first, studied before new; then done ones.
   */
  private wideCards(fits: (c: Card) => boolean = () => true): Card[] {
    const { col, clock, preds } = this.i;
    const taken = this.takenNotes();
    const fresh = newQueue(col, clock, Infinity, this.source);
    const freshIds = new Set(fresh.map((c) => c.id));
    const newRank = new Map(fresh.map((c, k) => [c.id, k]));
    const byNote = new Map<EntityId, Card[]>();
    const held = new Set<EntityId>();
    for (const c of this.source) {
      if (this.waiting.has(c.id)) held.add(c.note_id);
      if (!fits(c) || !(c.reviews > 0 ? preds.has(c.id) : freshIds.has(c.id))) continue;
      const list = byNote.get(c.note_id) ?? [];
      list.push(c);
      byNote.set(c.note_id, list);
    }
    const ranked: { card: Card; key: [number, number] }[] = [];
    for (const [note, faces] of byNote) {
      if (taken.has(note) || held.has(note)) continue;
      const open = faces.filter((c) => !this.doneToday.has(c.id));
      const pool = open.length ? open : faces;
      const studied = pool.filter((c) => c.reviews > 0).sort((a, b) => preds.get(a.id)! - preds.get(b.id)!);
      const card = studied[0] ?? pool[0];
      const group = open.length ? 0 : 2;
      ranked.push({ card, key: card.reviews > 0 ? [group, preds.get(card.id)!] : [group + 1, newRank.get(card.id) ?? 0] });
    }
    return ranked.sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1]).map((r) => r.card);
  }

  /** Cards that could be drawn into the pile now (twin gap ignored): due ones, then new words; wide, every word once. */
  available(): number {
    return this.i.wide ? this.wideCards().length : this.dueCards().length + this.newCards().length;
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
      const avoid = this.i.avoid;
      // Words on top of other piles only when nothing else is left.
      for (const spare of avoid?.size ? [true, false] : [false]) {
        const free = (c: Card) => !vis.has(c.id) && !notes.has(c.note_id) && fits(c) && !(spare && avoid!.has(c.note_id));
        const chosen = this.choose(free, fits);
        if (chosen) return chosen;
      }
    }
    const again = this.againToday.find(ok);
    return again === undefined ? null : this.draw(again, "again");
  }

  /** A card chosen now: due ones weakest first, then new words (wide: every word once); twins of just-answered cards last. */
  private choose(free: (c: Card) => boolean, fits: (c: Card) => boolean): Draw | null {
    if (this.i.wide) {
      const cards = this.wideCards(fits).filter(free);
      const c = cards.find((c) => !this.twinHot(c)) ?? cards[0];
      return c ? this.draw(c.id, c.reviews > 0 ? "due" : "new") : null;
    }
    const due = this.dueCards().filter((d) => free(d.card));
    const cool = due.find((d) => !this.twinHot(d.card));
    if (cool) return { card: cool.card.id, kind: "due", p: cool.p };
    const fresh = this.newCards().filter(free);
    const coolNew = fresh.find((c) => !this.twinHot(c));
    if (coolNew) return { card: coolNew.id, kind: "new" };
    // Only twins of just-answered cards left: better than nothing.
    if (due[0]) return { card: due[0].card.id, kind: "due", p: due[0].p };
    if (fresh[0]) return { card: fresh[0].id, kind: "new" };
    return null;
  }

  private draw(id: EntityId, kind: DrawKind): Draw {
    const p = this.i.preds.get(id);
    return p === undefined ? { card: id, kind } : { card: id, kind, p };
  }

  /** Whether a card on screen can no longer lie there: done for today (wide: its word answered right from this pile since "All"). */
  isDone(id: EntityId): boolean {
    if (!this.i.wide) return this.doneToday.has(id);
    return this.takenNotes().has(this.i.col.cards.get(id)?.note_id ?? 0);
  }
}
