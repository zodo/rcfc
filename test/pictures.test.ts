import { describe, expect, it } from "bun:test";
import { Collection, EventFactory } from "../src/domain/collection";
import type { AssetAttached, NoteCreatedPayload } from "../src/domain/events";
import { budgetDay, imagePrompt, meanings, parseScene, sceneMessages, secondsToReset, senseFor } from "../src/domain/pictures";
import { Pictures } from "../src/pictures";
import { handlePictures, type AiRunner, type BlobStore, type PictureEnv } from "../worker/pictures";
import { sqliteD1 } from "./support/d1";
import { Device, T0 } from "./support/harness";

const CODE = "ABCDEFGHIJKLMN23";

class MemoryBucket implements BlobStore {
  objects = new Map<string, { data: Uint8Array; type?: string }>();
  async put(key: string, value: ArrayBuffer | Uint8Array | string, o?: { httpMetadata?: { contentType?: string } }) {
    const data = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
    this.objects.set(key, { data, type: o?.httpMetadata?.contentType });
  }
  async get(key: string) {
    const o = this.objects.get(key);
    return o ? { body: new Response(new Blob([o.data as Uint8Array<ArrayBuffer>])).body!, httpMetadata: { contentType: o.type } } : null;
  }
}

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]);

/** Scene LLM + image model stand-in. `flagged` = how many image calls fail with 3030 first. */
class FakeAi implements AiRunner {
  calls: { model: string; input: unknown }[] = [];
  flagged = 0;
  fail = false;
  async run(model: string, input: unknown) {
    this.calls.push({ model, input });
    if (model.includes("granite")) {
      const user = (input as { messages: { content: string }[] }).messages[1].content;
      const word = /Word: (.*)/.exec(user)![1];
      return { response: JSON.stringify({ sense: "llm sense", scene: `A scene for ${word}.` }) };
    }
    if (this.fail) throw new Error("5000: model down");
    if (this.flagged > 0) {
      this.flagged--;
      throw new Error("3030: Output has been flagged");
    }
    return { image: btoa(String.fromCharCode(...JPEG)) };
  }
}

function server(over: Partial<PictureEnv> = {}) {
  const env = { DB: sqliteD1(), MEDIA: new MemoryBucket(), AI: new FakeAi() as AiRunner | undefined, now: () => T0, ...over };
  const fetch = async (url: string, init: RequestInit = {}) => (await handlePictures(new Request(new URL(url, "https://rcfc.test"), init), env)) ?? new Response("no route", { status: 404 });
  return { env, fetch, ai: env.AI as FakeAi };
}

const post = (body: unknown, code = CODE) => ({ method: "POST", headers: { "content-type": "application/json", "x-user-code": code }, body: JSON.stringify(body) });

describe("picture prompts", () => {
  it("splits a translation into meanings", () => {
    expect(meanings("bank, bench")).toEqual(["bank", "bench"]);
    expect(meanings("candle; sail / veil")).toEqual(["candle", "sail", "veil"]);
    expect(meanings("the tower")).toEqual(["the tower"]);
  });

  it("decides the meaning in code: user's choice, else the example, else the first one", () => {
    expect(senseFor({ word: "la vela", translation: "candle, sail", sense: "sail" })).toBe("sail");
    expect(senseFor({ word: "la vela", translation: "candle, sail" })).toBe("candle");
    expect(senseFor({ word: "el banco", translation: "bank, bench", example: "Me senté en el banco del parque." })).toBeUndefined();
  });

  it("passes example, sense and details to the scene writer", () => {
    const [, user] = sceneMessages({ word: "la vela", translation: "candle, sail", details: "on a birthday cake" });
    expect(user.content).toBe("Word: la vela\nTranslation: candle, sail\nSense: candle\nDetails: on a birthday cake");
  });

  it("keeps the sense it asked for over the LLM's label, and survives junk replies", () => {
    const r = { word: "la vela", translation: "candle, sail" };
    expect(parseScene('{"sense":"sail","scene":"A boat."}', r)).toEqual({ sense: "candle", scene: "A boat." });
    expect(parseScene('```json\n{"sense":"bench","scene":"A park bench."}\n```', { ...r, example: "x" })).toEqual({ sense: "bench", scene: "A park bench." });
    expect(parseScene({ scene: "Obj." }, r).scene).toBe("Obj.");
    expect(parseScene("not json at all", r).scene).toBe("not json at all");
    expect(parseScene(undefined, r).scene).toBe("candle, sail: la vela");
  });

  it("names the medium before the scene", () => {
    expect(imagePrompt("A cat.").indexOf("Cut-paper")).toBe(0);
    expect(imagePrompt("A cat.")).toContain("white paper background");
  });

  it("budgets by UTC day", () => {
    expect(budgetDay(Date.UTC(2026, 10, 23, 23, 59))).toBe("2026-11-23");
    expect(secondsToReset(Date.UTC(2026, 10, 23, 23, 0))).toBe(3600);
  });
});

describe("asset_attached fold", () => {
  it("keeps the latest picture per note and remembers removal", () => {
    let t = 1000;
    const f = new EventFactory("dev", () => t++);
    const col = new Collection();
    const [created] = f.note(1, { front: "la vela", back: "candle, sail" }, { from: "es", to: "en" }, []);
    col.apply(created);
    const id = (created.payload as NoteCreatedPayload).note_id;
    const pic = (key: string | null, sense?: string) => f.make<AssetAttached>("asset_attached", { note_id: id, kind: "image", r2_key: key, sense });
    const a = pic("pics/a.jpg", "candle");
    const b = pic("pics/b.jpg", "sail");
    col.apply(b);
    col.apply(a); // older, arrives late: loses
    expect(col.notes.get(id)!.picture).toEqual({ key: "pics/b.jpg", sense: "sail", details: undefined, scene: undefined });
    col.apply(pic(null));
    expect(col.notes.get(id)!.picture).toBeUndefined();
    expect(col.notes.get(id)!.noPicture).toBe(true);
  });
});

describe("pictures API", () => {
  it("draws, stores and serves a picture", async () => {
    const s = server();
    const res = await s.fetch("/api/pictures", post({ word: "el banco", translation: "bank, bench", sense: "bench" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { key: string; sense: string; scene: string };
    expect(body.sense).toBe("bench");
    expect(body.scene).toBe("A scene for el banco.");
    expect(body.key).toMatch(/^pics\/[0-9a-f-]{36}\.jpg$/);
    const img = await s.fetch(`/api/media/${body.key}`);
    expect(img.headers.get("content-type")).toBe("image/jpeg");
    expect(img.headers.get("cache-control")).toContain("immutable");
    expect(new Uint8Array(await img.arrayBuffer())).toEqual(JPEG);
  });

  it("retries with a new seed when the safety filter flags a harmless picture", async () => {
    const s = server();
    s.ai.flagged = 2;
    const res = await s.fetch("/api/pictures", post({ word: "madrugar", translation: "to get up early" }));
    expect(res.status).toBe(200);
    expect(s.ai.calls.filter((c) => c.model.includes("flux")).length).toBe(3);
  });

  it("fails cleanly when the model is down", async () => {
    const s = server();
    s.ai.fail = true;
    expect((await s.fetch("/api/pictures", post({ word: "torre", translation: "tower" }))).status).toBe(502);
  });

  it("stops at the daily neuron budget until the UTC day ends", async () => {
    let now = Date.UTC(2026, 10, 23, 22);
    const s = server({ budget: 130, now: () => now });
    for (let i = 0; i < 2; i++) expect((await s.fetch("/api/pictures", post({ word: `w${i}`, translation: "x" }))).status).toBe(200);
    const over = await s.fetch("/api/pictures", post({ word: "w3", translation: "x" }));
    expect(over.status).toBe(429);
    expect(((await over.json()) as { retry_after: number }).retry_after).toBe(7200);
    expect(s.ai.calls.length).toBe(4); // nothing called past the cap
    now += 2 * 3600_000;
    expect((await s.fetch("/api/pictures", post({ word: "w3", translation: "x" }))).status).toBe(200);
  });

  it("draws a placeholder without an AI binding (local dev)", async () => {
    const s = server({ AI: undefined });
    const body = (await (await s.fetch("/api/pictures", post({ word: "la vela", translation: "candle, sail" }))).json()) as { key: string; sense: string };
    expect(body.key).toEndWith(".svg");
    expect(body.sense).toBe("candle");
    expect((await s.fetch(`/api/media/${body.key}`)).headers.get("content-type")).toBe("image/svg+xml");
  });

  it("rejects bad requests", async () => {
    const s = server();
    expect((await s.fetch("/api/pictures", post({ word: "x" }))).status).toBe(400);
    expect((await s.fetch("/api/pictures", post({ word: "x", translation: "y" }, "nope"))).status).toBe(401);
    expect((await s.fetch("/api/media/../secret")).status).toBe(404);
    expect((await s.fetch("/api/media/pics/00000000-0000-0000-0000-000000000000.jpg")).status).toBe(404);
    expect(await handlePictures(new Request("https://rcfc.test/api/sync/pull"), s.env)).toBeNull();
  });
});

async function client(over: Partial<PictureEnv> = {}) {
  const d = await Device.open();
  const deckId = await d.deck(0);
  const s = server(over);
  const pics = await Pictures.open(d.store, () => CODE);
  pics.fetch = s.fetch;
  pics.now = d.clock.now;
  const add = async (front: string, back: string) => {
    const evs = d.store.factory.note(deckId, { front, back }, { from: "es", to: "en" });
    await d.store.append(evs);
    return (evs[0].payload as NoteCreatedPayload).note_id;
  };
  return { d, s, pics, add };
}

describe("Pictures (client)", () => {
  it("draws a queued picture, records it as an event and keeps a local copy", async () => {
    const { d, pics, add } = await client();
    const id = await add("el banco", "bank, bench");
    const seen: number[] = [];
    pics.subscribe((n) => seen.push(n));
    await pics.ensure(id);
    await pics.kick();
    const p = d.store.col.notes.get(id)!.picture!;
    expect(p.sense).toBe("bank");
    expect(p.key).toMatch(/\.jpg$/);
    expect(pics.state(id)).toBeUndefined();
    expect(seen).toContain(id);
    expect(new Uint8Array((await d.store.getPicBlob(p.key))!.data)).toEqual(JPEG);
    expect(await d.store.picJobs()).toEqual([]);
    expect((await d.store.allEvents()).filter((e) => e.type === "asset_attached")).toHaveLength(1);
    pics.stop();
  });

  it("does not redraw automatically, but redraws on request with the user's meaning and details", async () => {
    const { d, s, pics, add } = await client();
    const id = await add("el banco", "bank, bench");
    await pics.ensure(id);
    await pics.kick();
    const first = d.store.col.notes.get(id)!.picture!.key;
    await pics.ensure(id);
    await pics.kick();
    expect(d.store.col.notes.get(id)!.picture!.key).toBe(first);
    await pics.draw(id, { sense: "bench", details: " in a park " });
    await pics.kick();
    const p = d.store.col.notes.get(id)!.picture!;
    expect(p.key).not.toBe(first);
    expect(p).toMatchObject({ sense: "bench", details: "in a park" });
    const lastScene = s.ai.calls.filter((c) => c.model.includes("granite")).at(-1)!.input as { messages: { content: string }[] };
    expect(lastScene.messages[1].content).toContain("Sense: bench\nDetails: in a park");
    pics.stop();
  });

  it("never draws a removed picture again by itself", async () => {
    const { d, s, pics, add } = await client();
    const id = await add("la torre", "the tower");
    await pics.ensure(id);
    await pics.kick();
    await pics.remove(id);
    expect(d.store.col.notes.get(id)!.picture).toBeUndefined();
    const calls = s.ai.calls.length;
    await pics.ensure(id);
    await pics.kick();
    expect(s.ai.calls.length).toBe(calls);
    pics.stop();
  });

  it("waits when the daily limit is reached and keeps the queue across reloads", async () => {
    const { d, pics, add } = await client({ budget: 70 });
    const a = await add("uno", "one");
    const b = await add("dos", "two");
    await pics.ensure(a);
    await pics.ensure(b);
    await pics.kick();
    expect(d.store.col.notes.get(a)!.picture).toBeDefined();
    expect(d.store.col.notes.get(b)!.picture).toBeUndefined();
    expect(pics.state(b)).toBe("waiting");
    pics.stop();
    const again = await Pictures.open(d.store, () => CODE);
    expect(again.state(b)).toBe("queued");
    expect((await d.store.picJobs()).map((j) => j.note_id)).toEqual([b]);
  });

  it("drops the job for a deleted word", async () => {
    const { d, s, pics, add } = await client();
    const id = await add("la vela", "candle, sail");
    pics.pausedUntil = Infinity; // queued, not drawn yet
    await pics.ensure(id);
    await d.store.append([d.store.factory.make("note_deleted", { note_id: id })]);
    pics.pausedUntil = 0;
    await pics.kick();
    expect(s.ai.calls.length).toBe(0);
    expect(await d.store.picJobs()).toEqual([]);
    pics.stop();
  });

  it("downloads pictures drawn on other devices", async () => {
    const { d, s, pics, add } = await client();
    const id = await add("la torre", "the tower");
    const res = (await (await s.fetch("/api/pictures", post({ word: "la torre", translation: "the tower" }))).json()) as { key: string };
    await d.store.ingest([{ ...d.store.factory.make<AssetAttached>("asset_attached", { note_id: id, kind: "image", r2_key: res.key }), device_id: "other" }]);
    await pics.prefetch();
    expect(await d.store.getPicBlob(res.key)).toBeDefined();
    expect(await pics.url(res.key)).toStartWith("blob:");
    pics.stop();
  });
});
