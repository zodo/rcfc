import { describe, expect, it } from "bun:test";
import { Collection, EventFactory } from "../src/domain/collection";
import type { AppEvent, Review } from "../src/domain/events";
import { introducedToday, knownCards, newQueue, unseenCards, type DayClock } from "../src/domain/newcards";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 10, 23, 12);

function setup(words: number) {
  let t = T0 - 10 * DAY;
  const f = new EventFactory("dev", () => t++);
  const col = new Collection();
  const add = (evs: AppEvent[]) => evs.forEach((e) => col.apply(e));
  const preset = f.preset();
  add([preset]);
  const deck = f.deck("es", (preset.payload as { preset_id: number }).preset_id, { from: "es", to: "en" });
  add([deck]);
  const deckId = (deck.payload as { deck_id: number }).deck_id;
  for (let i = 0; i < words; i++) add(f.note(deckId, { front: `w${i}`, back: `t${i}` }, { from: "es", to: "en" }));
  const answer = (cardId: number, at: number, rating: Review["payload"]["rating"] = 3) => {
    t = at;
    const c = col.cards.get(cardId)!;
    col.apply(f.make<Review>("review", { card_id: c.id, note_id: c.note_id, deck_id: deckId, preset_id: 0, rating, duration_ms: 1, tz_offset_min: 0 }));
  };
  const clock = (now: number): DayClock => ({ now, tzOffsetMin: 0, rolloverHour: 4 });
  return { col, f, deckId, answer, clock, add };
}

describe("new cards", () => {
  it("offers the forward card of each unseen word, up to the daily limit", () => {
    const { col, clock } = setup(5);
    const q = newQueue(col, clock(T0), 3);
    expect(q.map((c) => c.template)).toEqual(["forward", "forward", "forward"]);
    expect(unseenCards(col, clock(T0)).fresh).toHaveLength(5);
  });

  it("counts words introduced today against the limit", () => {
    const { col, clock, answer } = setup(5);
    const [first] = newQueue(col, clock(T0), 3);
    answer(first.id, T0);
    expect(introducedToday(col, clock(T0))).toEqual({ words: 1, second: 0 });
    expect(newQueue(col, clock(T0), 3)).toHaveLength(2);
  });

  it("does not count words known on first sight (Easy)", () => {
    const { col, clock, answer } = setup(5);
    for (const c of newQueue(col, clock(T0), 3)) answer(c.id, T0, 4);
    expect(introducedToday(col, clock(T0)).words).toBe(0);
    expect(newQueue(col, clock(T0), 3)).toHaveLength(2); // only 2 unseen words left
  });

  it("starts the reverse card on a later study day, under its own limit", () => {
    const { col, clock, answer } = setup(4);
    for (const c of newQueue(col, clock(T0), 2)) answer(c.id, T0);
    // Same day: reverse cards wait, two fresh words remain but the limit is used.
    expect(newQueue(col, clock(T0), 2)).toHaveLength(0);
    // 03:00 next day is still the same study day (rollover at 04:00).
    const nextNight = Date.UTC(2026, 10, 24, 3);
    expect(newQueue(col, clock(nextNight), 2)).toHaveLength(0);
    const nextDay = Date.UTC(2026, 10, 24, 5);
    expect(newQueue(col, clock(nextDay), 2).map((c) => c.template)).toEqual(["reverse", "reverse", "forward", "forward"]);
  });

  it("skips deleted words and filters by deck", () => {
    const { col, f, clock, add } = setup(2);
    const other = f.deck("de", 0, { from: "de", to: "en" });
    add([other]);
    const otherId = (other.payload as { deck_id: number }).deck_id;
    add(f.note(otherId, { front: "Haus", back: "house" }, { from: "de", to: "en" }));
    expect(newQueue(col, clock(T0), 10, otherId).map((c) => col.notes.get(c.note_id)!.fields.front)).toEqual(["Haus"]);
    const victim = col.liveNotes()[0];
    add([f.make("note_deleted", { note_id: victim.id })]);
    expect(newQueue(col, clock(T0), 10).map((c) => col.notes.get(c.note_id)!.fields.front)).toEqual(["w1", "Haus"]);
  });
});

describe("knownCards", () => {
  it("picks the forward card of an unseen word, every studied card of a started one, nothing of a deleted one", () => {
    const { col, f, answer, add } = setup(3);
    const [n0, n1, n2] = col.liveNotes();
    const cardsOf = (id: number) => col.cardsByNote.get(id)!.map((c) => col.cards.get(c)!);
    const [fwd1, rev1] = cardsOf(n1.id);
    answer(fwd1.id, T0);
    answer(rev1.id, T0 + DAY);
    add([f.make("note_deleted", { note_id: n2.id })]);
    const picked = knownCards(col, [n0.id, n1.id, n2.id]);
    expect(picked.map((c) => [c.note_id, c.template])).toEqual([
      [n0.id, "forward"],
      [n1.id, "forward"],
      [n1.id, "reverse"],
    ]);
  });
});
