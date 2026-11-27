import { describe, expect, it } from "bun:test";
import { Collection, EventFactory } from "../src/domain/collection";
import type { AppEvent, LabelColored, LabelCreated, LabelDeleted, LabelRenamed, NotesLabeled } from "../src/domain/events";
import { LABEL_COLORS, labelColor, labelIdFor, labelName, labelPile, nameKey } from "../src/domain/labels";
import { MORE as MORE_N, pileSize } from "../src/domain/piles";
import { StudySession } from "../src/session";
import { Clock, DAY, Device } from "./support/harness";

const HOUR = 3_600_000;

/** Answer the pile's cards in order until it is empty or `max` answers; names are the words, ' for a reverse face. */
async function run(s: StudySession, max = 200, rate: (front: string) => 1 | 3 = () => 3): Promise<string[]> {
  const seen: string[] = [];
  for (let i = 0; i < max; i++) {
    const n = s.next();
    if (!n) break;
    const card = s["store"].col.cards.get(n.pick.card)!;
    const note = s["store"].col.notes.get(card.note_id)!;
    const name = `${note.fields.front}${card.template === "reverse" ? "'" : ""}`;
    seen.push(name);
    s.peek();
    await s.answer(card, rate(name), 2000);
    await s.refresh(card);
  }
  return seen;
}

/** Spanish words `palabra 0..n-1` and German `Wort 0..m-1`; returns their note ids. */
async function words(d: Device, es: number, de = 0): Promise<{ es: number[]; de: number[] }> {
  const s = d.store;
  const ids = (evs: AppEvent[]) => evs.flatMap((e) => (e.type === "note_created" ? [e.payload.note_id] : []));
  const a = Array.from({ length: es }, (_, i) => s.factory.note(1, { front: `palabra ${i}`, back: `word ${i}` }, { from: "es", to: "en" })).flat();
  const b = Array.from({ length: de }, (_, i) => s.factory.note(2, { front: `Wort ${i}`, back: `word ${i}` }, { from: "de", to: "en" })).flat();
  await s.append([s.factory.deck("Spanish", s.preset().preset_id, { from: "es", to: "en" }, 1), s.factory.deck("German", s.preset().preset_id, { from: "de", to: "en" }, 2), ...a, ...b]);
  return { es: ids(a), de: ids(b) };
}

async function sticker(d: Device, name: string, notes: number[]): Promise<StudySession> {
  const id = await d.store.makeLabel(name);
  await d.store.stick(id, notes, true);
  return new StudySession(d.store, labelPile(id));
}

describe("sticker names and ids", () => {
  it("names are trimmed, collapsed and cut at 30; the same name ignores case", () => {
    expect(labelName("  my   kitchen ")).toBe("my kitchen");
    expect([...labelName("x".repeat(40))]).toHaveLength(30);
    expect(nameKey("Kitchen ")).toBe(nameKey("kitchen"));
  });

  it("two devices making the same sticker offline make one; a deleted name made again is a new one", () => {
    const a = new EventFactory("a");
    const b = new EventFactory("b");
    const col = new Collection();
    const id1 = labelIdFor(col, "Kitchen").id;
    expect(labelIdFor(new Collection(), "kitchen").id).toBe(id1);
    col.apply(a.make<LabelCreated>("label_created", { label_id: id1, name: "Kitchen" }));
    col.apply(b.make<LabelCreated>("label_created", { label_id: id1, name: "kitchen" }));
    expect(col.liveLabels()).toHaveLength(1);
    expect(labelIdFor(col, " KITCHEN")).toEqual({ id: id1, exists: true });
    col.apply(a.make<LabelDeleted>("label_deleted", { label_id: id1 }));
    expect(col.liveLabels()).toHaveLength(0);
    const again = labelIdFor(col, "kitchen");
    expect(again.exists).toBe(false);
    expect(again.id).not.toBe(id1);
  });

  it("the latest rename and the latest stick or peel per word win", () => {
    let t = 1000;
    const a = new EventFactory("a", () => t);
    const b = new EventFactory("b", () => t);
    const col = new Collection();
    col.apply(a.make<LabelCreated>("label_created", { label_id: 7, name: "food" }));
    const late = (t = 3000, a.make<LabelRenamed>("label_renamed", { label_id: 7, name: "meals" }));
    const early = (t = 2000, b.make<LabelRenamed>("label_renamed", { label_id: 7, name: "dishes" }));
    col.apply(late);
    col.apply(early); // synced later, made earlier
    expect(col.liveLabel(7)!.name).toBe("meals");
    const peel = (t = 5000, b.make<NotesLabeled>("notes_labeled", { label_id: 7, note_ids: [1], on: false }));
    const stick = (t = 4000, a.make<NotesLabeled>("notes_labeled", { label_id: 7, note_ids: [1, 2], on: true }));
    col.apply(peel);
    col.apply(stick);
    expect(col.labelNotes(7)).toEqual([]); // no live notes in this collection
    expect([...(col as unknown as { stuck: Map<number, Set<number>> }).stuck.get(7)!]).toEqual([2]);
  });
});

describe("sticker colours", () => {
  it("one from the id until one is picked; the latest pick wins; renaming keeps it", () => {
    let t = 1000;
    const a = new EventFactory("a", () => t);
    const col = new Collection();
    col.apply(a.make<LabelCreated>("label_created", { label_id: 9, name: "food" }));
    expect(labelColor(col.liveLabel(9)!)).toBe(LABEL_COLORS[9 % LABEL_COLORS.length]);
    const late = (t = 3000, a.make<LabelColored>("label_colored", { label_id: 9, color: "pink" }));
    const early = (t = 2000, a.make<LabelColored>("label_colored", { label_id: 9, color: "mint" }));
    col.apply(late);
    col.apply(early);
    t = 4000;
    col.apply(a.make<LabelRenamed>("label_renamed", { label_id: 9, name: "meals" }));
    expect(labelColor(col.liveLabel(9)!)).toBe("pink");
    expect(labelColor({ id: 9, color: "a colour from a newer app" })).toBe(LABEL_COLORS[9 % LABEL_COLORS.length]);
  });
});

describe("stickers in the store", () => {
  it("a new sticker gets the colour fewest stickers have", async () => {
    const d = await Device.open();
    const made = [];
    for (const n of ["a", "b", "c", "d", "e", "f", "g"]) made.push(labelColor(d.store.col.liveLabel(await d.store.makeLabel(n))!));
    expect(made).toEqual([...LABEL_COLORS, "yellow"]);
  });

  it("renaming to another sticker's name merges into it", async () => {
    const d = await Device.open();
    const w = await words(d, 4);
    const food = await d.store.makeLabel("food");
    const meals = await d.store.makeLabel("meals");
    await d.store.stick(food, w.es.slice(0, 2), true);
    await d.store.stick(meals, w.es.slice(1, 3), true);
    expect(await d.store.makeLabel("Food")).toBe(food);
    expect(await d.store.renameLabel(food, "MEALS")).toBe(meals);
    expect(d.store.col.liveLabels().map((l) => l.name)).toEqual(["meals"]);
    expect(d.store.col.labelNotes(meals).map((n) => n.id)).toEqual(w.es.slice(0, 3));
    expect(await d.store.renameLabel(meals, "Meals")).toBe(meals);
    expect(d.store.col.liveLabel(meals)!.name).toBe("Meals");
  });
});

describe("sticker piles", () => {
  it("draw only the sticker's words, across languages", async () => {
    const d = await Device.open();
    const w = await words(d, 5, 3);
    const s = await sticker(d, "kitchen", [w.es[3], w.de[1]]);
    await s.start();
    expect(await run(s)).toEqual(["palabra 3", "Wort 1"]);
    expect(d.store.col.reviews.every((r) => r.payload.pile === s.pile)).toBe(true);
  });

  it("new words aren't held back by the daily limit, but count toward their language", async () => {
    const d = await Device.open();
    await d.store.append([d.store.factory.preset({ ...d.store.preset(), new_per_day: 3 })]);
    const w = await words(d, 10, 2);
    const s = await sticker(d, "kitchen", [...w.es.slice(5), ...w.de]);
    await s.start();
    expect(await run(s)).toEqual(["palabra 5", "palabra 6", "palabra 7", "palabra 8", "palabra 9", "Wort 0", "Wort 1"]);
    const es = new StudySession(d.store, "es");
    await es.start();
    expect(es.next()).toBeNull(); // Spanish's 3 went to the sticker
  });

  it("a new sticker shows its new words when the language's are used up", async () => {
    const d = await Device.open();
    await d.store.append([d.store.factory.preset({ ...d.store.preset(), new_per_day: 2 })]);
    const w = await words(d, 5);
    const es = new StudySession(d.store, "es");
    await es.start();
    expect(await run(es)).toEqual(["palabra 0", "palabra 1"]);
    const table = await sticker(d, "kitchen", w.es.slice(2));
    await table.prepare();
    expect(table.next()?.left).toBe(3);
  });

  it("the pile's size caps a big sticker's new words", async () => {
    const d = await Device.open();
    const w = await words(d, 30);
    const s = await sticker(d, "kitchen", w.es);
    await s.start();
    expect(await run(s)).toHaveLength(20);
  });

  it("after more a sticker's new words don't count toward the language", async () => {
    const d = await Device.open();
    await d.store.append([d.store.factory.preset({ ...d.store.preset(), new_per_day: 2 })]);
    const w = await words(d, 40);
    const s = await sticker(d, "kitchen", w.es);
    await s.start();
    expect(await run(s)).toHaveLength(20); // the pile's size
    const es = new StudySession(d.store, "es");
    await es.start();
    expect(es.next()).toBeNull(); // the sticker's 20 used up Spanish's 2
    await s.more();
    expect(await run(s)).toHaveLength(10);
    await es.start();
    expect(await run(es)).toEqual(["palabra 30", "palabra 31"]); // Spanish gets its 2 again
  });

  it("more deals words that aren't due, those done today in other piles last", async () => {
    const clock = new Clock();
    const d = await Device.open(clock);
    const w = await words(d, 3);
    const es = new StudySession(d.store, "es");
    await es.start();
    expect(await run(es, 2)).toEqual(["palabra 0", "palabra 1"]);
    clock.advance(2 * HOUR);
    const s = await sticker(d, "kitchen", w.es);
    await s.start();
    expect(await run(s)).toEqual(["palabra 2"]); // all it needs today
    expect(s.moreCount()).toBe(2);
    await s.more();
    expect(await run(s)).toEqual(["palabra 0", "palabra 1"]);
  });

  it("all N left deals every word not done today, never today's; then they lie crosswise too", async () => {
    const clock = new Clock();
    const d = await Device.open(clock);
    const w = await words(d, 40);
    const s = await sticker(d, "kitchen", w.es);
    await s.start();
    const first = await run(s);
    expect(first.length).toBeGreaterThan(0);
    const done = s.crossed().length;
    expect(done).toBeGreaterThan(0);
    const left = s.restCount();
    expect(left).toBeGreaterThan(MORE_N);
    expect(s.moreCount()).toBe(MORE_N);
    clock.advance(2 * HOUR);
    await s.rest();
    await s.prepare();
    expect(s.next()!.left).toBe(left);
    const rest = await run(s);
    expect(rest.filter((x) => first.includes(x))).toEqual([]); // none of today's again
    expect(s.restCount()).toBe(0);
    expect(s.crossed().length).toBe(done + left);
  });

  it("today's cards gathered up again leave the crosswise ones as they are answered", async () => {
    const d = await Device.open();
    const w = await words(d, 3);
    const s = await sticker(d, "kitchen", w.es);
    await s.start();
    await run(s);
    const today = s.crossed();
    expect(today.length).toBeGreaterThan(0);
    s.againThese(today);
    expect(s.crossed()).toEqual([]);
    await run(s);
    expect(new Set(s.crossed())).toEqual(new Set(today));
  });

  it("a word on top of one pile is not on top of another", async () => {
    const d = await Device.open();
    const w = await words(d, 3);
    const es = new StudySession(d.store, "es");
    await es.prepare();
    const top = d.store.col.cards.get(es.next()!.pick.card)!.note_id;
    const s = await sticker(d, "kitchen", w.es);
    await s.prepare();
    expect(d.store.col.cards.get(s.next()!.pick.card)!.note_id).not.toBe(top);
    // When it is the only word left, it comes up anyway.
    const only = await sticker(d, "one", [top]);
    await only.prepare();
    expect(d.store.col.cards.get(only.next()!.pick.card)!.note_id).toBe(top);
  });

  it("a card answered Again stays under its sticker's pile, not drawn by its language's", async () => {
    const clock = new Clock();
    const d = await Device.open(clock);
    const w = await words(d, 2);
    const s = await sticker(d, "kitchen", [w.es[0]]);
    await s.start();
    const n = s.next()!;
    await s.answer(d.store.col.cards.get(n.pick.card)!, 1, 2000);
    const es = new StudySession(d.store, "es");
    await es.start();
    expect(await run(es)).toEqual(["palabra 1"]);
    // Peeled off, the word is back in its language's pile.
    await d.store.stick(s.label!, [w.es[0]], false);
    clock.advance(DAY);
    const es2 = new StudySession(d.store, "es");
    await es2.start();
    expect(await run(es2)).toContain("palabra 0");
  });
});
