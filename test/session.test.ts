import { describe, expect, it } from "bun:test";
import type { PileDealt } from "../src/domain/events";
import { StudySession } from "../src/session";
import { Clock, DAY, Device } from "./support/harness";

const ES = { from: "es", to: "en" };
const HOUR = 3_600_000;

/** Answer the pile's cards in order (`rate` picks the rating per card) until it is empty or `max` answers. */
async function run(s: StudySession, max = 200, rate: (front: string, i: number) => 1 | 3 = () => 3): Promise<string[]> {
  const seen: string[] = [];
  for (let i = 0; i < max; i++) {
    const n = s.next();
    if (!n) break;
    const card = s["store"].col.cards.get(n.pick.card)!;
    const note = s["store"].col.notes.get(card.note_id)!;
    const name = `${note.fields.front}${card.template === "reverse" ? "'" : ""}`;
    seen.push(name);
    s.peek();
    await s.answer(card, rate(name, i), 2000);
    await s.refresh(card);
  }
  return seen;
}

async function sitting(d: Device): Promise<StudySession> {
  const s = new StudySession(d.store, ES);
  await s.start();
  return s;
}

function deals(d: Device) {
  return [...d.store.col.deals.get("lang:es>en")?.entries() ?? []].map(([, v]) => v);
}

async function newPerDay(d: Device, n: number) {
  await d.store.append([d.store.factory.preset({ ...d.store.preset(), new_per_day: n })]);
}

describe("piles", () => {
  it("deals today's cards once: 10 new words of 15, then the pile is empty", async () => {
    const d = await Device.open();
    await d.deck(15);
    const s = await sitting(d);
    expect(s.next()!.left).toBe(10);
    expect(await run(s)).toHaveLength(10);
    expect(s.next()).toBeNull();
    expect(deals(d)).toEqual([{ deal: 10, more: 0 }]);
    // Opening it again the same day deals nothing new.
    expect((await sitting(d)).next()).toBeNull();
    expect(deals(d)).toHaveLength(1);
    expect(d.store.col.reviews.every((r) => r.payload.pile === "lang:es>en")).toBe(true);
  });

  it("Got it takes a card out, Again tucks it under the pile", async () => {
    const d = await Device.open();
    await d.deck(3);
    const s = await sitting(d);
    const seen = await run(s, 200, (w) => (w === "palabra 0" && !againOnce++ ? 1 : 3));
    expect(seen).toEqual(["palabra 0", "palabra 1", "palabra 2", "palabra 0"]);
    expect(s.answered).toBe(4);
  });
  let againOnce = 0;

  it("counts what is left; the card peeked under the top comes next", async () => {
    const d = await Device.open();
    await d.deck(5);
    const s = await sitting(d);
    for (let i = 0; i < 5; i++) {
      const n = s.next()!;
      expect(n.left).toBe(5 - i);
      const peeked = s.peek();
      expect(peeked).not.toBe(n.pick.card);
      const card = d.store.col.cards.get(n.pick.card)!;
      await s.answer(card, 3, 2000);
      await s.refresh(card);
      expect(s.next()?.pick.card ?? null).toBe(peeked);
    }
  });

  it("keeps the top card when the pile is left and opened again", async () => {
    const d = await Device.open();
    await d.deck(5);
    const top = (await sitting(d)).next()!.pick.card;
    expect((await sitting(d)).next()!.pick.card).toBe(top);
  });

  it("5 more deals from the same words, beyond the new-word limit; the next day's pile is bigger", async () => {
    const clock = new Clock();
    const d = await Device.open(clock);
    await newPerDay(d, 30);
    await d.deck(40);
    const s = await sitting(d);
    expect(await run(s)).toHaveLength(20);
    expect(s.moreCount()).toBe(5);
    await s.more();
    expect(await run(s)).toHaveLength(5);
    expect(deals(d)).toEqual([{ deal: 20, more: 5 }]);
    clock.advance(DAY);
    expect((await sitting(d)).view()["i"].size).toBe(25);
  });

  it("a pile left unfinished comes back smaller", async () => {
    const clock = new Clock();
    const d = await Device.open(clock);
    await newPerDay(d, 30);
    await d.deck(40);
    await run(await sitting(d), 5);
    clock.advance(DAY);
    const s = await sitting(d);
    expect(s.next()!.left).toBe(15);
  });

  it("Got it is done for the day, even if the model would want the card back within minutes", async () => {
    const d = await Device.open();
    await d.deck(2);
    const s = await sitting(d);
    const first = s.next()!.pick.card;
    await s.answer(d.store.col.cards.get(first)!, 3, 2000);
    d.store.preds.set(first, 0.5); // the model's minute-scale noise
    await s.more(); // even with room in the pile
    const rest = await run(s);
    expect(rest.length).toBeGreaterThan(0);
    expect(rest.map((w) => w)).not.toContain(d.store.col.notes.get(d.store.col.cards.get(first)!.note_id)!.fields.front);
  });

  it("cards answered Again stay under the pile overnight, on top of the next deal", async () => {
    const clock = new Clock();
    const d = await Device.open(clock);
    await d.deck(3);
    const s = await sitting(d);
    const first = s.next()!.pick.card;
    await s.answer(d.store.col.cards.get(first)!, 1, 2000);
    clock.advance(DAY);
    const t = await sitting(d);
    t["screen"].top = null; // a reload: nothing on screen
    expect(t.view().carried).toEqual([first]);
    expect(t.next()!.pick).toMatchObject({ card: first, kind: "again" });
  });

  it("does not draw a face within an hour of its twin", async () => {
    const clock = new Clock();
    const d = await Device.open(clock);
    await d.deck(3);
    await run(await sitting(d)); // forward faces learned today
    clock.advance(DAY);
    await run(await sitting(d)); // reverse faces start the next day
    clock.advance(20 * DAY); // both faces of every word are due now
    const s = await sitting(d);
    const order = await run(s);
    expect(order).toHaveLength(6);
    for (let i = 1; i < order.length; i++) expect(order[i].replace("'", "")).not.toBe(order[i - 1].replace("'", ""));
    // Within the first hour, twins of the words answered so far wait until other words are done.
    expect(new Set(order.slice(0, 3).map((w) => w.replace("'", ""))).size).toBe(3);
  });

  it("cards under the top keep the colour their edge showed", async () => {
    const clock = new Clock();
    const d = await Device.open(clock);
    await d.deck(8);
    await run(await sitting(d)); // white sides learned today
    clock.advance(DAY);
    await run(await sitting(d)); // cream sides the next day
    clock.advance(30 * DAY); // both sides of every word due: a mixed pile
    const s = await sitting(d);
    let n = s.next()!;
    let faces = s.faces(5);
    const seen = new Set(faces);
    for (let i = 0; i < 10; i++) {
      await s.answer(d.store.col.cards.get(n.pick.card)!, 3, 1000);
      await s.refresh(d.store.col.cards.get(n.pick.card)!);
      n = s.next()!;
      expect(d.store.col.cards.get(n.pick.card)!.template).toBe(faces[0]); // the peeked card, now on top
      const now = s.faces(5);
      expect(now.slice(0, 4)).toEqual(faces.slice(1, 5)); // every spot moved up one, same colours
      faces = now;
      for (const f of now) seen.add(f);
    }
    expect(seen.size).toBe(2); // the pile went from white sides to cream ones
  });

  it("a spot that showed white gets a white card, even when a cream one became needier", async () => {
    const clock = new Clock();
    const d = await Device.open(clock);
    await d.deck(8);
    await run(await sitting(d));
    clock.advance(DAY);
    await run(await sitting(d));
    clock.advance(30 * DAY);
    const s = await sitting(d);
    const top = s.next()!.pick.card;
    const faces = s.faces(4);
    expect(faces).toEqual(["forward", "forward", "forward", "forward"]);
    const cream = s.source().find((c) => c.template === "reverse" && ![top, s.peek()].includes(c.id))!;
    d.store.preds.set(cream.id, 0.01); // now the neediest card of all
    await s.answer(d.store.col.cards.get(top)!, 3, 1000);
    s.next();
    expect(d.store.col.cards.get(s.peek()!)!.template).toBe("forward"); // spot 2 showed white
  });

  it("Again, these N goes through exactly the same cards once more", async () => {
    const d = await Device.open();
    await d.deck(4);
    const s = await sitting(d);
    const first = await run(s);
    expect(first).toHaveLength(4);
    s.againThese();
    expect(s.next()!.left).toBe(4);
    expect(await run(s)).toEqual(first);
    expect(s.next()).toBeNull();
  });

  it("words marked known are answered Easy and don't count against the daily limit", async () => {
    const d = await Device.open();
    const deckId = await d.deck(12);
    const notes = d.store.col.liveNotes(deckId);
    expect(await d.store.markKnown(notes.slice(0, 4).map((n) => n.id))).toBe(4);
    expect(d.store.col.reviews.map((r) => r.payload.rating)).toEqual([4, 4, 4, 4]);
    expect(d.store.newQueue(deckId)).toHaveLength(8);
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
    clock.advance(18 * HOUR); // forgotten again: due (fake engine: P = 0.9 after half a day)
    const order = await run(await sitting(d));
    expect(order.slice(0, 2)).toEqual(["palabra 0", "palabra 9"]); // due first, then the word asked for
    expect(order.indexOf("palabra 0'")).toBeGreaterThan(1); // its other face waits
  });

  it("two devices dealing the same day offline count the deal once", async () => {
    const d = await Device.open();
    await d.deck(3);
    const day = (await sitting(d)).view().today;
    await d.store.append([d.store.factory.make<PileDealt>("pile_dealt", { pile: "lang:es>en", day, n: 2, more: false })]);
    expect(deals(d)).toEqual([{ deal: 3, more: 0 }]);
  });

});
