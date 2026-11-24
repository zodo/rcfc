// One sitting at a pile: which card lies on top, which one under it, and what
// an answer changes. The pile rules live in src/domain/piles.ts; this adds what
// only this device knows: the cards on screen. UI-free (src/screens/study.ts
// renders it), so tests drive it with a stub engine.
import type { Card } from "./domain/collection";
import type { CardTemplate, LangPair, PileDealt, ReviewPayload } from "./domain/events";
import type { EntityId } from "./domain/ids";
import { languagePile, MORE, pileSize, PileView, type Draw } from "./domain/piles";
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
}
const shown = new Map<string, OnScreen>();

export class StudySession {
  readonly pile: string;
  /** Answers this sitting. */
  answered = 0;
  /** Cards answered this sitting, in order of first answer: "Again, these N". */
  readonly sitting: EntityId[] = [];
  /** Going through `sitting` once more: the cards left, top first. */
  private replay: EntityId[] | null = null;
  private recent: EntityId[] = [];
  private size = 0;
  private screen: OnScreen;

  constructor(
    private store: Store,
    readonly pair: LangPair,
  ) {
    this.pile = languagePile(pair);
    const key = `${store.deviceId}|${this.pile}`;
    this.screen = shown.get(key) ?? { top: null, under: null, faces: [] };
    shown.set(key, this.screen);
  }

  /** The pile's words. */
  source(): Card[] {
    const { from, to } = this.pair;
    return this.store.col.liveCards().filter((c) => {
      const p = this.store.col.notes.get(c.note_id)!.lang_pair;
      return p.from === from && p.to === to;
    });
  }

  view(): PileView {
    const { store } = this;
    const source = this.source();
    return new PileView({ col: store.col, pile: this.pile, source, preds: store.predsOf(source), clock: store.clock(), size: this.size || pileSize(store.col, this.pile, store.clock()), newPerDay: store.preset().new_per_day });
  }

  /** Fresh predictions for the pile's words, and today's deal if it hasn't been dealt. */
  async start(): Promise<void> {
    const { store } = this;
    await store.predict(this.source());
    this.size = pileSize(store.col, this.pile, store.clock());
    const v = this.view();
    if (!v.dealt && v.dealSize() > 0) await this.deal(v.today, v.dealSize(), false);
    // Cards on screen last time: still valid unless deleted or answered right since (e.g. on another device).
    for (const k of ["top", "under"] as const) {
      const d = this.screen[k];
      if (d && (!store.col.liveNote(store.col.cards.get(d.card)?.note_id ?? 0) || v.isDone(d.card))) this.screen[k] = null;
    }
    if (!this.screen.top && this.screen.under) [this.screen.top, this.screen.under] = [this.screen.under, null];
  }

  private async deal(day: number, n: number, more: boolean): Promise<void> {
    await this.store.append([this.store.factory.make<PileDealt>("pile_dealt", { pile: this.pile, day, n, more })]);
  }

  /** The top card and how many cards are left (it included); null when the pile is empty. */
  next(): { pick: Draw; left: number } | null {
    if (this.replay) {
      const id = this.replay[0];
      return id === undefined ? null : { pick: { card: id, kind: "again", p: this.store.preds.get(id) }, left: this.replay.length };
    }
    const v = this.view();
    if (!this.screen.top) {
      this.screen.top = this.screen.under ?? v.next();
      this.screen.under = null;
    }
    if (!this.screen.top) return null;
    return { pick: this.screen.top, left: Math.max(1, v.left()) };
  }

  /** The card under the top one (shown when the top is dragged away); fixed once shown. */
  peek(): EntityId | null {
    if (this.replay) return this.replay[1] ?? null;
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
    if (this.replay) return this.replay.slice(1, count + 1).map((id) => face(id) ?? "forward");
    const under = this.peek();
    if (under === null || count < 1) return [];
    const top = this.screen.top!.card;
    const faces = this.screen.faces;
    faces.length = Math.min(faces.length, count - 1); // spots no longer showing are free again
    const v = this.view();
    const visible = [top, under];
    for (let spot = 0; spot < count - 1; spot++) {
      const d = v.next(visible, faces[spot]);
      if (!d) break;
      visible.push(d.card);
      if (spot >= faces.length) faces.push(face(d.card)!);
    }
    return [face(under)!, ...faces];
  }

  /** Record an answer. If this throws, nothing was saved and the card can be rated again. */
  async answer(card: Card, rating: ReviewPayload["rating"], durationMs: number): Promise<void> {
    await this.store.answer(card, rating, durationMs, this.pile);
    this.answered++;
    if (!this.sitting.includes(card.id)) this.sitting.push(card.id);
    this.recent.push(card.id);
    if (this.recent.length > HOT) this.recent.shift();
    if (this.replay) {
      this.replay.shift();
      if (rating === 1) this.replay.push(card.id); // under the pile
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

  /** Cards "more" would deal now (0 = nothing left to draw). */
  moreCount(): number {
    return Math.min(MORE, this.view().available());
  }

  /** Deal "more" onto the pile. */
  async more(): Promise<void> {
    this.replay = null;
    const v = this.view();
    const n = Math.min(MORE, v.available());
    if (n > 0) await this.deal(v.today, n, true);
  }

  /** Go through this sitting's cards once more, exactly those. */
  againThese(): void {
    this.replay = [...this.sitting];
  }

  /** Words in this pile never studied (none left: offer adding words). */
  unseenLeft(): number {
    return this.store.unseenWords(this.source()).length;
  }
}
