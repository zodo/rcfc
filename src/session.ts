// One sitting at a pile: which card lies on top, which one under it, and what
// an answer changes. The pile rules live in src/domain/piles.ts; this adds what
// only this device knows: the cards on screen. UI-free (src/screens/study.ts
// renders it), so tests drive it with a stub engine.
import type { Card } from "./domain/collection";
import type { CardTemplate, PileDealt, ReviewPayload } from "./domain/events";
import type { EntityId } from "./domain/ids";
import { pileLabel } from "./domain/labels";
import { languagePile, MORE, pileSize, PileView, type Draw } from "./domain/piles";
import { studyDay } from "./domain/rows";
import type { Store } from "./store";

/** Answered cards whose predictions are refreshed after each answer. */
const HOT = 50;
/** Stalest predictions refreshed in the background after each answer. */
const REFRESH = 100;

/**
 * What is on screen per device and pile, kept while the app runs: the top
 * card, the one under it, and the colour (which side lies up) of each card
 * further down whose edge shows. Those colours are fixed once shown; which
 * card fills each spot is still chosen when it is drawn.
 */
interface OnScreen {
  top: Draw | null;
  under: Draw | null;
  /** Spots 2, 3, … under the top card. */
  faces: CardTemplate[];
  /** A finished pile gathered to go through once more ("Go through these N again"): the cards left, top first, and the day it was gathered. */
  again: { day: number; cards: EntityId[] } | null;
}
const shown = new Map<string, OnScreen>();

export class StudySession {
  /** The pile key: `lang:es` or `label:<id>`. */
  readonly pile: string;
  /** The studied language, for a language's pile. */
  readonly lang?: string;
  /** The sticker, for a sticker's pile. */
  readonly label?: EntityId;
  /** Answers this sitting. */
  answered = 0;
  /** Cards answered this sitting, in order of first answer: "Again, these N". */
  readonly sitting: EntityId[] = [];
  private recent: EntityId[] = [];
  private size = 0;
  private screen: OnScreen;

  constructor(
    private store: Store,
    /** A pile key, or a studied language ("es": its words, whatever their translations are in). */
    pile: string,
  ) {
    this.pile = pile.includes(":") ? pile : languagePile(pile);
    this.label = pileLabel(this.pile);
    if (this.label === undefined) this.lang = this.pile.slice("lang:".length);
    const key = `${store.deviceId}|${this.pile}`;
    this.screen = shown.get(key) ?? { top: null, under: null, faces: [], again: null };
    shown.set(key, this.screen);
  }

  /** The pile's words: a language's, or those wearing the sticker. */
  source(): Card[] {
    const { col } = this.store;
    if (this.label !== undefined) return col.labelNotes(this.label).flatMap((n) => (col.cardsByNote.get(n.id) ?? []).map((id) => col.cards.get(id)!));
    return col.liveCards().filter((c) => col.notes.get(c.note_id)!.lang_pair.from === this.lang);
  }

  /**
   * The pile as it lies today. `asking`: as if "more" were asked now: a
   * language's pile may go MORE new words past today's limit (what dealing
   * them raises it by), a sticker's pile goes wide.
   */
  view(asking = false): PileView {
    const { store } = this;
    const { col } = store;
    const source = this.source();
    const clock = store.clock();
    const today = studyDay(clock.now, clock.tzOffsetMin, clock.rolloverHour);
    const more = (pile: string) => col.deals.get(pile)?.get(today)?.more ?? 0;
    const perDay = store.preset().new_per_day;
    // Sticker piles asked for more today draw new words freely, and those don't count toward any language's limit.
    const notCounted = new Set<string>();
    for (const [pile, days] of col.deals) if (pileLabel(pile) !== undefined && (days.get(today)?.more ?? 0) > 0) notCounted.add(pile);
    const wide = this.label !== undefined && (asking || notCounted.has(this.pile));
    const extra = asking ? MORE : 0;
    const newLimit = wide ? () => Infinity : this.lang !== undefined ? () => perDay + more(this.pile) + extra : (l: string) => perDay + more(languagePile(l));
    return new PileView({
      col,
      pile: this.pile,
      source,
      preds: store.predsOf(source),
      clock,
      size: this.size || pileSize(col, this.pile, clock),
      newLimit,
      notCounted,
      wide,
      avoid: this.onTopElsewhere(),
      skip: (c) => c.last_rating === 1 && c.last_pile !== undefined && c.last_pile !== this.pile && this.holds(c.last_pile, c),
    });
  }

  /** Words lying on top of this device's other piles. */
  private onTopElsewhere(): Set<EntityId> {
    const out = new Set<EntityId>();
    const mine = `${this.store.deviceId}|`;
    for (const [key, on] of shown) {
      if (!key.startsWith(mine) || on === this.screen || !on.top) continue;
      const note = this.store.col.cards.get(on.top.card)?.note_id;
      if (note !== undefined) out.add(note);
    }
    return out;
  }

  /** Whether a card is still one of that pile's words (a card tucked under a pile stays there while it is). */
  private holds(pile: string, c: Card): boolean {
    const { col } = this.store;
    const label = pileLabel(pile);
    if (label !== undefined) return col.wears(c.note_id, label);
    return pile === languagePile(col.notes.get(c.note_id)?.lang_pair.from ?? "");
  }

  /** Fresh predictions for the pile's words, and today's deal if it hasn't been dealt. */
  async start(): Promise<void> {
    await this.prepare();
    const v = this.view();
    if (!v.dealt && v.dealSize() > 0) await this.deal(v.today, v.dealSize(), false);
  }

  /** Fresh predictions and the cards on screen checked, without dealing: the pile as the table shows it. */
  async prepare(): Promise<void> {
    const { store } = this;
    await store.predict(this.source());
    this.size = pileSize(store.col, this.pile, store.clock());
    const v = this.view();
    // Cards on screen last time: still valid unless deleted or answered right since (e.g. on another device).
    for (const k of ["top", "under"] as const) {
      const d = this.screen[k];
      if (d && (!store.col.liveNote(store.col.cards.get(d.card)?.note_id ?? 0) || v.isDone(d.card))) this.screen[k] = null;
    }
    if (!this.screen.top && this.screen.under) [this.screen.top, this.screen.under] = [this.screen.under, null];
  }

  private async deal(day: number, n: number, more: boolean, all = false): Promise<void> {
    await this.store.append([this.store.factory.make<PileDealt>("pile_dealt", all ? { pile: this.pile, day, n, more, all } : { pile: this.pile, day, n, more })]);
  }

  /** The top card and how many cards are left (it included); null when the pile is empty. */
  next(): { pick: Draw; left: number } | null {
    const v = this.view();
    const replay = this.replay(v);
    if (replay) return { pick: { card: replay[0]!, kind: "again", p: this.store.preds.get(replay[0]!) }, left: replay.length };
    if (!this.screen.top) {
      this.screen.top = this.screen.under ?? v.next();
      this.screen.under = null;
    }
    if (!this.screen.top) return null;
    return { pick: this.screen.top, left: Math.max(1, v.left()) };
  }

  /** The card under the top one (shown when the top is dragged away); fixed once shown. */
  peek(): EntityId | null {
    const replay = this.replay();
    if (replay) return replay[1] ?? null;
    const top = this.screen.top;
    if (!top) return null;
    if (!this.screen.under) {
      const v = this.view();
      if (v.left() >= 2) this.screen.under = v.next([top.card], this.screen.faces.shift());
    }
    return this.screen.under?.card ?? null;
  }

  /**
   * Which side lies up on the cards under the top one, for the `count` spots
   * whose edges show (the peeked card first). A spot seen for the first time
   * gets the colour of the card expected there; then it keeps it.
   */
  faces(count: number): CardTemplate[] {
    const { col } = this.store;
    const face = (id: EntityId | null | undefined) => (id == null ? undefined : col.cards.get(id)?.template);
    const replay = this.replay();
    if (replay) return replay.slice(1, count + 1).map((id) => face(id) ?? "forward");
    const under = this.peek();
    if (under === null || count < 1) return [];
    const top = this.screen.top!.card;
    const faces = this.screen.faces;
    const v = this.view();
    faces.length = Math.min(faces.length, Math.max(0, v.left() - 2)); // spots below the pile's bottom are gone
    const visible = [top, under];
    for (let spot = 0; spot < count - 1; spot++) {
      const d = v.next(visible, faces[spot]);
      if (!d) break;
      visible.push(d.card);
      if (spot >= faces.length) faces.push(face(d.card)!);
    }
    return [face(under)!, ...faces].slice(0, count);
  }

  /** Record an answer. If this throws, nothing was saved and the card can be rated again. */
  async answer(card: Card, rating: ReviewPayload["rating"], durationMs: number): Promise<void> {
    await this.store.answer(card, rating, durationMs, this.pile);
    this.answered++;
    if (!this.sitting.includes(card.id)) this.sitting.push(card.id);
    this.recent.push(card.id);
    if (this.recent.length > HOT) this.recent.shift();
    const replay = this.replay();
    if (replay) {
      replay.shift();
      if (rating === 1) replay.push(card.id); // under the pile
    } else if (this.screen.top?.card === card.id) this.screen.top = null;
  }

  /** After an answer: resolves once the answered card's prediction is fresh. */
  async refresh(card: Card): Promise<void> {
    const { store } = this;
    // The answered card's prediction must be fresh before the next draw; others
    // refresh in the background (recently answered + stalest).
    await store.predict([card]);
    const hot = this.recent.map((id) => store.col.cards.get(id)!).filter(Boolean);
    void store.predict([...hot, ...store.stalest(this.source(), REFRESH)]);
  }

  /** Cards "more" would deal now (0 = nothing left to draw). A sticker pile deals its weakest words, due or not. */
  moreCount(): number {
    return Math.min(MORE, this.view(true).available());
  }

  /** Deal "more" onto the pile. */
  async more(): Promise<void> {
    this.screen.again = null;
    const v = this.view(true);
    const n = Math.min(MORE, v.available());
    if (n > 0) await this.deal(v.today, n, true);
  }

  /** A sticker pile's words, all of them: what "All N" deals. */
  allCount(): number {
    return this.label === undefined ? 0 : this.store.col.labelNotes(this.label).length;
  }

  /** "All N": every word of the sticker once more, one face each. */
  async all(): Promise<void> {
    this.screen.again = null;
    const n = this.allCount();
    if (n > 0) await this.deal(this.view().today, n, true, true);
  }

  /** Go through these cards once more, exactly those: this sitting's, or the given ones. */
  againThese(cards: EntityId[] = this.sitting): void {
    this.screen.again = cards.length ? { day: this.view().today, cards: [...cards] } : null;
  }

  /** The gathered cards still to go through, top first; null when there are none (gone through, or gathered on an earlier day). */
  private replay(v?: PileView): EntityId[] | null {
    const a = this.screen.again;
    if (a && a.cards.length && a.day === (v ?? this.view()).today) return a.cards;
    this.screen.again = null;
    return null;
  }

  /**
   * The cards coming next, top first, as far as they are known now (at most
   * `n`): the top card, the one peeked under it, then what the pile would
   * draw if nothing changed. For work done ahead, such as drawing pictures.
   */
  upcoming(n: number): EntityId[] {
    const replay = this.replay();
    if (replay) return replay.slice(0, n);
    const v = this.view();
    const out = [this.screen.top?.card, this.screen.under?.card].filter((id): id is EntityId => id !== undefined);
    const max = Math.min(n, Math.max(v.left(), out.length));
    while (out.length < max) {
      const d = v.next(out);
      if (!d) break;
      out.push(d.card);
    }
    return out.slice(0, n);
  }

  /** Cards answered right from this pile today, in the order they were answered. */
  doneToday(): EntityId[] {
    return [...this.view().completed].reverse();
  }

  /** Words in this pile never studied (none left: offer adding words). */
  unseenLeft(): number {
    return this.store.unseenWords(this.source()).length;
  }
}
