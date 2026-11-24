import { describe, expect, it } from "bun:test";
import { StudySession } from "../src/session";
import { Clock, DAY, Device } from "./support/harness";

async function run(s: StudySession, max = 100, rating: 1 | 3 = 3): Promise<string[]> {
  const kinds: string[] = [];
  await s.start();
  for (let i = 0; i < max; i++) {
    const n = s.next();
    if (!n) break;
    kinds.push(n.pick.kind);
    const card = s["store"].col.cards.get(n.pick.card)!;
    await s.answer(card, n.pick, rating, 2000);
    await s.refresh(card);
  }
  return kinds;
}

describe("StudySession", () => {
  it("introduces today's new words, then stops", async () => {
    const d = await Device.open();
    await d.deck(15);
    const kinds = await run(new StudySession(d.store));
    expect(kinds).toEqual(Array(10).fill("new")); // new_per_day = 10
    expect(new StudySession(d.store).next()).toBeNull();
  });

  it("peeks the card that comes next (shown under the top card) and counts what is left", async () => {
    const d = await Device.open();
    await d.deck(15);
    const s = new StudySession(d.store);
    await s.start();
    for (let i = 0; i < 10; i++) {
      const n = s.next()!;
      expect(s.left(n.due)).toBe(10 - i);
      const peeked = s.peek(n.pick);
      expect(peeked).not.toBe(n.pick.card);
      const card = d.store.col.cards.get(n.pick.card)!;
      await s.answer(card, n.pick, 3, 2000);
      await s.refresh(card);
      expect(s.next()?.pick.card ?? null).toBe(peeked);
    }
  });

  it("learns more words today on request, then stops again", async () => {
    const d = await Device.open();
    await d.deck(15);
    const s = new StudySession(d.store);
    expect(await run(s)).toHaveLength(10);
    expect(s.unseenLeft()).toBe(5);
    s.extraNew += 3;
    expect(await run(s)).toEqual(["new", "new", "new"]);
    expect(s.next()).toBeNull();
    // A new session the same day starts from the daily limit again: nothing new.
    expect(new StudySession(d.store).next()).toBeNull();
  });

  it("words marked known are answered Easy and don't count against the daily limit", async () => {
    const d = await Device.open();
    const deckId = await d.deck(12);
    const notes = d.store.col.liveNotes(deckId);
    expect(await d.store.markKnown(notes.slice(0, 4).map((n) => n.id))).toBe(4);
    const easy = d.store.col.reviews.map((r) => r.payload.rating);
    expect(easy).toEqual([4, 4, 4, 4]);
    // 8 unseen words left, 10 a day: all of them can still be introduced today.
    expect(d.store.newQueue(deckId)).toHaveLength(8);
    // Marking a started word again answers each card studied so far.
    expect(await d.store.markKnown([notes[0].id])).toBe(1);
    expect(d.store.col.reviews).toHaveLength(5);
  });

  it("don't know: studied words come back due, unseen ones first among new words", async () => {
    const clock = new Clock();
    const d = await Device.open(clock);
    const deckId = await d.deck(12);
    const notes = d.store.col.liveNotes(deckId);
    await d.store.markKnown([notes[0].id]);
    clock.advance(DAY);
    expect(await d.store.markUnknown([notes[0].id, notes[9].id])).toEqual({ forgotten: 1, next: 1 });
    expect(d.store.col.reviews.map((r) => r.payload.rating)).toEqual([4, 1]);
    expect(d.store.col.notes.get(d.store.newQueue(deckId).find((c) => c.template === "forward")!.note_id)!.fields.front).toBe("palabra 9");
  });

  it("brings words back once they are due, with reverse cards the next day", async () => {
    const clock = new Clock();
    const d = await Device.open(clock);
    await d.deck(3);
    await run(new StudySession(d.store));
    clock.advance(DAY);
    const s = new StudySession(d.store);
    const kinds = await run(s);
    // 3 reverse cards are new today; the forward ones (stability 2.5 d) are not due yet.
    expect(kinds).toEqual(["new", "new", "new"]);
    clock.advance(5 * DAY);
    const due = await run(new StudySession(d.store));
    expect(due.filter((k) => k === "due")).toHaveLength(6);
  });

  it("does not show an answered card again right away", async () => {
    const clock = new Clock();
    const d = await Device.open(clock);
    await d.deck(3);
    await run(new StudySession(d.store), 100, 1); // all "Again": stability drops
    clock.advance(3 * DAY);
    const s = new StudySession(d.store);
    await s.start();
    const seen: number[] = [];
    for (let i = 0; i < 6; i++) {
      const n = s.next()!;
      const card = d.store.col.cards.get(n.pick.card)!;
      seen.push(card.id);
      await s.answer(card, n.pick, 1, 1000);
      await s.refresh(card);
    }
    for (let i = 1; i < seen.length; i++) expect(seen[i]).not.toBe(seen[i - 1]);
  });

  it("keeps practicing ahead when asked", async () => {
    const d = await Device.open();
    await d.deck(2);
    await run(new StudySession(d.store));
    const s = new StudySession(d.store);
    await s.start();
    expect(s.next()).toBeNull();
    s.ahead = true;
    expect(s.next()?.pick.kind).toBe("ahead");
  });
});
