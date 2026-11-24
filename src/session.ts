// One study session: which card comes next and what an answer updates.
// UI-free (src/screens/study.ts renders it), so tests drive it with a stub engine.
import type { Card } from "./domain/collection";
import type { ReviewPayload } from "./domain/events";
import type { EntityId } from "./domain/ids";
import { dueCount, pickNext, TARGET_RECALL, type Pick } from "./domain/scheduler";
import type { Store } from "./store";

/** Answered cards remembered for re-entry blocking and fresh predictions. */
const HOT = 50;
/** Stalest predictions refreshed in the background after each answer. */
const REFRESH = 100;

export class StudySession {
  /** Cards answered this session, oldest first (last HOT). */
  readonly recent: EntityId[] = [];
  /** Answers since the last new card (starts high so a new card can come first). */
  sinceNew = 99;
  answered = 0;
  /** Keep practicing past the due threshold. */
  ahead = false;
  /** New words allowed today beyond the daily limit ("Learn more"). */
  extraNew = 0;

  constructor(
    private store: Store,
    readonly deckId?: EntityId,
  ) {}

  /** Fresh predictions for every card in scope. */
  async start(): Promise<void> {
    await this.store.predict(this.store.col.liveCards(this.deckId));
  }

  /** Predictions of reviewed cards in scope. */
  preds(): Map<EntityId, number> {
    return this.store.predsOf(this.store.col.liveCards(this.deckId));
  }

  /** The next card, with the due count to show; null when the session is done. */
  next(): { pick: Pick; due: number } | null {
    const newQueue = this.store.newQueue(this.deckId, this.extraNew);
    const preds = this.preds();
    const desired = TARGET_RECALL;
    const pick = pickNext({
      preds,
      recent: this.recent,
      newQueue: newQueue.map((c) => c.id),
      newLeft: newQueue.length,
      sinceNew: this.sinceNew,
      desired,
      ahead: this.ahead,
    });
    return pick && { pick, due: dueCount(preds, desired) };
  }

  /**
   * The card next() would most likely pick once `current` is answered, shown
   * under it in the pile. A guess: the answer and fresh predictions can change
   * the order, and then the real next card simply takes its place.
   */
  peek(current: Pick): EntityId | null {
    const newQueue = this.store
      .newQueue(this.deckId, this.extraNew)
      .map((c) => c.id)
      .filter((id) => id !== current.card);
    const pick = pickNext({
      preds: this.preds(),
      recent: [...this.recent, current.card],
      newQueue,
      newLeft: newQueue.length,
      sinceNew: current.kind === "new" ? 0 : this.sinceNew + 1,
      desired: TARGET_RECALL,
      ahead: this.ahead,
    });
    return pick?.card ?? null;
  }

  /** Cards left in this session, the current one included (for the height of the pile). */
  left(due: number): number {
    return due + this.store.newQueue(this.deckId, this.extraNew).length;
  }

  /** Words never studied in scope, beyond today's queue: what "Learn more" can introduce. */
  unseenLeft(): number {
    return this.store.unseenWords(this.deckId).length;
  }

  /** Record an answer. If this throws, nothing was saved and the card can be rated again. */
  async answer(card: Card, pick: Pick, rating: ReviewPayload["rating"], durationMs: number): Promise<void> {
    await this.store.answer(card, rating, durationMs);
    this.answered++;
    this.sinceNew = pick.kind === "new" ? 0 : this.sinceNew + 1;
    this.recent.push(card.id);
    if (this.recent.length > HOT) this.recent.shift();
  }

  /** After an answer: resolves once the answered card's prediction is fresh. */
  async refresh(card: Card): Promise<void> {
    const { store } = this;
    // The answered card's prediction must be fresh before it can be picked
    // again; others refresh in the background (hot set + stalest).
    await store.predict([card]);
    const scope = store.col.liveCards(this.deckId);
    const hot = this.recent.map((id) => store.col.cards.get(id)!).filter(Boolean);
    void store.predict([...hot, ...store.stalest(scope, REFRESH)]);
  }
}
