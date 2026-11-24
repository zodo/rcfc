// Devices (real Store + Sync on fake-indexeddb) syncing through the real
// Worker handler (worker/sync.ts) on bun:sqlite.
import { describe, expect, it } from "bun:test";
import { PULL_PAGE, PUSH_MAX } from "../src/domain/sync";
import { StudySession } from "../src/session";
import { Clock, DAY, Device, Server } from "./support/harness";

async function pair(clock = new Clock()) {
  const server = new Server();
  const a = await Device.open(clock, server);
  const b = await Device.open(clock, server);
  return { server, a, b, clock };
}

const ids = async (d: Device) => new Set((await d.store.allEvents()).map((e) => e.event_id));

describe("sync end to end", () => {
  it("pairing merges both devices into one account", async () => {
    const { server, a, b } = await pair();
    await a.deck(3);
    await b.deck(2, "German");
    await a.sync.now();
    expect(server.count(a.sync.code)).toBe((await a.store.allEvents()).length);

    await b.sync.join(a.sync.code);
    await a.sync.now();
    expect(await ids(a)).toEqual(await ids(b));
    expect(a.store.col.liveNotes()).toHaveLength(5);
    // Each device made a default preset; both settle on the same one.
    expect(a.store.col.presets.size).toBe(2);
    expect(a.store.preset().preset_id).toBe(b.store.preset().preset_id);
    expect(server.count(b.sync.code)).toBe((await a.store.allEvents()).length);
  });

  it("a pile is shared: cards answered on one device are done on the other", async () => {
    const { a, b } = await pair();
    await a.deck(6);
    await a.sync.now();
    await b.sync.join(a.sync.code);
    const sa = new StudySession(a.store, "es");
    await sa.start();
    for (let i = 0; i < 2; i++) {
      const card = a.store.col.cards.get(sa.next()!.pick.card)!;
      await sa.answer(card, 3, 1000);
    }
    await a.sync.now();
    await b.sync.now();
    const sb = new StudySession(b.store, "es");
    await sb.start();
    // One deal (made on a), two of its six cards done there.
    expect([...b.store.col.deals.values()].map((m) => [...m.values()])).toEqual([[{ deal: 6, more: 0 }]]);
    expect(sb.next()!.left).toBe(4);
  });

  it("pushes and pulls in pages", async () => {
    const { server, a, b } = await pair();
    await a.deck(PUSH_MAX); // 1 + 3 × 500 events with the preset and deck
    const total = (await a.store.allEvents()).length;
    await a.sync.now();
    expect(server.count(a.sync.code)).toBe(total);
    server.requests = 0;
    await b.sync.join(a.sync.code);
    // b pushes its own preset (1 request), then pulls every page.
    expect(server.requests).toBe(1 + Math.ceil((total + 1) / PULL_PAGE));
    expect(b.store.col.liveNotes()).toHaveLength(PUSH_MAX);
  });

  it("does not echo pulled events back, and re-pushing is harmless", async () => {
    const { server, a, b } = await pair();
    await a.deck(2);
    await a.sync.now();
    await b.sync.join(a.sync.code);
    const n = server.count();
    await b.sync.now();
    expect((await b.store.outbox(0, 1000)).events.length).toBe(1); // only b's own preset
    // Lost cursor: everything goes again, the server ignores duplicates.
    await b.store.setMeta("sync_pushed", 0);
    await b.store.markAllLocal();
    await b.sync.now();
    expect(server.count()).toBe(n);
  });

  it("feeds new reviews from the other device incrementally", async () => {
    const { a, b, clock } = await pair();
    await a.deck(2);
    await a.sync.now();
    await b.sync.join(a.sync.code);
    b.pulls = 0;
    const [card] = a.store.col.liveCards();
    clock.advance(1000);
    await a.store.answer(card, 3, 1000);
    await a.sync.now();
    await b.sync.now();
    expect(b.pulls).toBe(1);
    expect(b.replays).toBe(0);
    expect(b.engine.applied).toEqual([card.id]);
    expect(b.store.preds.get(card.id)).toBeGreaterThan(0.9);
  });

  it("asks for a replay when the other device's review is older than local ones", async () => {
    const { a, b, clock } = await pair();
    await a.deck(2);
    await a.sync.now();
    await b.sync.join(a.sync.code);
    const [c1, c2] = a.store.col.liveCards();
    // a answers offline; b answers later and syncs first.
    clock.advance(DAY);
    await a.store.answer(c1, 3, 1000);
    clock.advance(1000);
    await b.store.answer(b.store.col.cards.get(c2.id)!, 3, 1000);
    await b.sync.now();
    await a.sync.now();
    expect(a.replays).toBe(0); // b's review is newer than a's: in order for a
    await b.sync.now();
    expect(b.replays).toBe(1);
    expect(b.store.stale).toBe(true);
    // The reload replays the merged log in order.
    const info = await b.reopen();
    expect(info.replayed).toBe(2);
    expect(b.engine.applied).toEqual([c1.id, c2.id]);
  });

  it("reports server errors and stays retryable", async () => {
    const { a } = await pair();
    await a.deck(1);
    a.sync.fetch = async () => new Response(JSON.stringify({ error: "boom" }), { status: 500 });
    await a.sync.now();
    expect(a.sync.status).toMatchObject({ state: "error", error: "boom" });
    a.sync.fetch = async () => {
      throw new TypeError("fetch failed");
    };
    await a.sync.now();
    expect(a.sync.status.state).toBe("offline");
    const server = new Server();
    a.sync.fetch = server.fetch;
    await a.sync.now();
    expect(a.sync.status.state).toBe("idle");
    expect(server.count()).toBe((await a.store.allEvents()).length);
  });
});

describe("sync API", () => {
  const code = "ABCDEFGHIJKLMN23";
  const ev = (i: number) => ({ event_id: `e${i}`, type: "x", ts: i, device_id: "d", payload: {} });
  const push = (s: Server, body: unknown, headers: Record<string, string> = { "x-user-code": code }) =>
    s.fetch("/api/sync/push", { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });

  it("requires a valid user code", async () => {
    const s = new Server();
    expect((await push(s, { events: [] }, {})).status).toBe(401);
    expect((await push(s, { events: [] }, { "x-user-code": "short" })).status).toBe(401);
  });

  it("rejects malformed requests", async () => {
    const s = new Server();
    expect((await push(s, "{nope")).status).toBe(400);
    expect((await push(s, { events: "x" })).status).toBe(400);
    expect((await push(s, { events: [{ ...ev(1), payload: null }] })).status).toBe(400);
    expect((await push(s, { events: Array.from({ length: PUSH_MAX + 1 }, (_, i) => ev(i)) })).status).toBe(413);
    expect((await s.fetch("/api/sync/push", { headers: { "x-user-code": code } })).status).toBe(405);
    expect((await s.fetch("/api/sync/pull", { method: "POST", headers: { "x-user-code": code } })).status).toBe(405);
  });

  it("stores each event once per account and pages by server order", async () => {
    const s = new Server();
    expect(await (await push(s, { events: [ev(1), ev(2)] })).json()).toEqual({ accepted: 2 });
    expect(await (await push(s, { events: [ev(2), ev(3)] })).json()).toEqual({ accepted: 1 });
    // Another account may use the same event ids.
    expect(await (await push(s, { events: [ev(1)] }, { "x-user-code": "ZZZZZZZZZZZZZZZZ" })).json()).toEqual({ accepted: 1 });
    const page = await (await s.fetch("/api/sync/pull?after=0", { headers: { "x-user-code": code } })).json();
    expect(page.events.map((e: { event_id: string }) => e.event_id)).toEqual(["e1", "e2", "e3"]);
    expect(page.more).toBe(false);
    const rest = await (await s.fetch(`/api/sync/pull?after=${page.next}`, { headers: { "x-user-code": code } })).json();
    expect(rest).toEqual({ events: [], next: page.next, more: false });
    const junk = await (await s.fetch("/api/sync/pull?after=abc", { headers: { "x-user-code": code } })).json();
    expect(junk.events).toHaveLength(3);
  });
});
