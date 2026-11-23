import { describe, expect, it } from "bun:test";
import type { Review } from "../src/domain/events";
import { Clock, DAY, Device } from "./support/harness";

/** An event as another device or the server would send it (no local `seq`). */
function wire<E extends object>(e: E, over: Partial<E> = {}): E {
  const { seq: _seq, remote: _remote, ...rest } = e as E & { seq?: number; remote?: 1 };
  return { ...rest, ...over } as E;
}

async function answerAll(d: Device, rating: 1 | 2 | 3 | 4 = 3) {
  for (const c of d.store.col.liveCards()) await d.store.answer(c, rating, 3000);
}

describe("Store", () => {
  it("creates the device id and default preset once", async () => {
    const d = await Device.open();
    const id = d.store.deviceId;
    expect(d.store.col.presets.size).toBe(1);
    await d.reopen();
    expect(d.store.deviceId).toBe(id);
    expect(d.store.col.presets.size).toBe(1);
  });

  it("restores the engine from its checkpoint without replaying", async () => {
    const d = await Device.open();
    await d.deck(2);
    await answerAll(d);
    await d.store.engine.flush();
    const info = await d.reopen();
    expect(info.reviews).toBe(4);
    expect(info.engine.restored).toBe(4);
    expect(info.replayed).toBe(0);
    expect(d.engine.resets).toBe(0);
  });

  it("replays only the reviews after the checkpoint", async () => {
    const d = await Device.open();
    await d.deck(2);
    const [a, b, c] = d.store.col.liveCards();
    await d.store.answer(a, 3, 1000);
    await d.store.engine.flush();
    await d.store.answer(b, 3, 1000);
    await d.store.answer(c, 1, 1000);
    const info = await d.reopen();
    expect(info.engine.restored).toBe(1);
    expect(info.replayed).toBe(2);
    expect(d.engine.applied).toEqual([b.id, c.id]);
  });

  it("replays everything when the log changed under the checkpoint", async () => {
    const clock = new Clock();
    const d = await Device.open(clock);
    await d.deck(1);
    const [card] = d.store.col.liveCards();
    await d.store.answer(card, 3, 1000);
    await d.store.engine.flush();
    // A restored backup brings an older review: the checkpoint no longer ends at the log's last review.
    const older: Review = wire(d.store.col.reviews[0], { event_id: "older", ts: clock.t - DAY });
    await d.store.importBackup([older]);
    const info = await d.reopen();
    expect(d.engine.resets).toBe(1);
    expect(info.replayed).toBe(2);
    expect(d.store.col.reviews.map((r) => r.event_id)[0]).toBe("older");
  });

  it("reports a rollover change as a needed replay instead of reloading", async () => {
    const d = await Device.open();
    const p = d.store.preset();
    // No reviews yet: rollover does not shape any row.
    expect((await d.store.append([d.store.factory.preset({ ...p, day_rollover_hour: 5 })])).replay).toBe(false);
    await d.deck(1);
    await answerAll(d);
    expect((await d.store.append([d.store.factory.preset({ ...p, day_rollover_hour: 5, desired_retention: 0.85 })])).replay).toBe(false);
    const r = await d.store.append([d.store.factory.preset({ ...p, day_rollover_hour: 6 })]);
    expect(r.replay).toBe(true);
    expect(d.store.stale).toBe(true);
    // After the reload the new rollover is the checkpoint key: full replay, then clean.
    const info = await d.reopen();
    expect(info.replayed).toBe(2);
    expect(d.store.stale).toBe(false);
  });

  it("refuses reviews through append", async () => {
    const d = await Device.open();
    await d.deck(1);
    const [card] = d.store.col.liveCards();
    await d.store.answer(card, 3, 1000);
    expect(d.store.append([d.store.col.reviews[0]])).rejects.toThrow("answer()");
  });

  it("feeds in-order pulled reviews to the engine incrementally", async () => {
    const clock = new Clock();
    const a = await Device.open(clock);
    await a.deck(1);
    const b = await Device.open(clock);
    await b.store.ingest(await a.store.allEvents());
    const [card] = a.store.col.liveCards();
    clock.advance(1000);
    await a.store.answer(card, 3, 1000);
    const review = wire(a.store.col.reviews[0]);
    const r = await b.store.ingest([review]);
    expect(r).toEqual({ added: 1, replay: false });
    expect(b.engine.applied).toEqual([card.id]);
    expect(b.store.preds.has(card.id)).toBe(true);
    // Same events again: nothing new.
    expect(await b.store.ingest([review])).toEqual({ added: 0, replay: false });
  });

  it("marks the model stale when a pulled review sorts before processed ones", async () => {
    const clock = new Clock();
    const a = await Device.open(clock);
    await a.deck(1);
    const b = await Device.open(clock);
    await b.store.ingest(await a.store.allEvents());
    const [card] = b.store.col.liveCards();
    clock.advance(DAY);
    await b.store.answer(card, 3, 1000);
    const late: Review = wire(b.store.col.reviews[0], { event_id: "late", device_id: a.store.deviceId, ts: clock.t - 1000 });
    const r = await b.store.ingest([late]);
    expect(r.replay).toBe(true);
    expect(b.store.stale).toBe(true);
    expect(b.engine.applied).toEqual([card.id]); // not fed out of order
    // Further pulls keep reporting it until the reload.
    expect((await b.store.ingest([{ ...late, event_id: "late2" }])).replay).toBe(true);
  });

  it("keeps pulled events out of the outbox until the device joins another account", async () => {
    const a = await Device.open();
    await a.deck(1);
    const b = await Device.open();
    const local = (await b.store.outbox(0, 500)).events.length;
    await b.store.ingest(await a.store.allEvents());
    const out = await b.store.outbox(0, 500);
    expect(out.events.length).toBe(local);
    expect(out.upTo).toBe(local + (await a.store.allEvents()).length);
    await b.store.markAllLocal();
    expect((await b.store.outbox(0, 500)).events.length).toBe(out.upTo);
  });

  it("new cards follow the daily limit through the store's clock", async () => {
    const clock = new Clock();
    const d = await Device.open(clock);
    const p = d.store.preset();
    await d.store.append([d.store.factory.preset({ ...p, new_per_day: 2 })]);
    await d.deck(5);
    expect(d.store.newQueue().length).toBe(2);
    for (const c of d.store.newQueue()) await d.store.answer(c, 3, 1000);
    expect(d.store.newQueue().length).toBe(0);
    clock.advance(DAY);
    // Two fresh words, and the reverse cards of yesterday's two.
    expect(d.store.newQueue().map((c) => c.template)).toEqual(["reverse", "reverse", "forward", "forward"]);
  });
});
