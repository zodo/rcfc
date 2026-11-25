import { describe, expect, it } from "bun:test";
import { Collection, EventFactory } from "../src/domain/collection";
import type { AssetAttached, NoteCreatedPayload } from "../src/domain/events";
import { budgetDay, imagePrompt, meanings, parseScene, parseSense, sceneMessages, secondsToReset, senseFor, senseMessages, withoutQuotes } from "../src/domain/pictures";
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
      if (user.includes("Meanings:")) return { response: JSON.stringify({ meaning: 2 }) };
      const word = /Word: (.*)/.exec(user)![1];
      return { response: JSON.stringify({ scene: `A scene for ${word}.` }) };
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

  it("decides the meaning in code: user's choice, else the only one, else (no example) the first", () => {
    expect(senseFor({ word: "la vela", translation: "candle, sail", sense: "sail" })).toBe("sail");
    expect(senseFor({ word: "la vela", translation: "candle, sail" })).toBe("candle");
    expect(senseFor({ word: "un camello", translation: "a camel", example: "Un camello tiene dos jorobas." })).toBe("a camel");
    expect(senseFor({ word: "el banco", translation: "bank, bench", example: "Me senté en el banco del parque." })).toBeUndefined();
  });

  it("with several meanings, the example picks one of them, never another", () => {
    const r = { word: "el banco", translation: "bank, bench", example: "Me senté en el banco del parque." };
    expect(senseMessages(r)[1].content).toBe("Word: el banco\nExample: Me senté en el banco del parque.\nMeanings:\n1. bank\n2. bench");
    expect(parseSense('{"meaning": 2}', r)).toBe("bench");
    expect(parseSense("2", r)).toBe("bench");
    expect(parseSense('{"meaning": "sitting"}', r)).toBe("bank");
    expect(parseSense({ meaning: 7 }, r)).toBe("bank");
  });

  it("writes the scene from word and meaning only: never the example", () => {
    const [, user] = sceneMessages({ word: "la torre", translation: "the tower", example: "En el castillo hay una torre donde vivía la princesa.", details: "at night" }, "the tower");
    expect(user.content).toBe("Word: la torre\nMeaning: the tower\nDetails: at night");
  });

  it("survives junk scene replies", () => {
    expect(parseScene('{"scene":"A boat."}', "sail")).toBe("A boat.");
    expect(parseScene('```json\n{"scene":"A park bench."}\n```', "bench")).toBe("A park bench.");
    expect(parseScene({ scene: "Obj." }, "x")).toBe("Obj.");
    expect(parseScene("not json at all", "x")).toBe("not json at all");
    expect(parseScene(undefined, "candle")).toBe("A simple everyday scene that shows candle.");
  });

  it("drops quoted words and dialogue from the scene, so the picture never spells the answer", () => {
    expect(withoutQuotes("A man at a desk under a calendar highlighting the word 'Monday' above him.")).toBe("A man at a desk under a calendar highlighting above him.");
    expect(withoutQuotes("Three friends, asking each other '¿Vosotros queréis ir al cine?' as they talk.")).toBe("Three friends as they talk.");
    expect(withoutQuotes('A man waves and says "Hola, Pedro!" to his friend.')).toBe("A man waves to his friend.");
    expect(withoutQuotes("The friends' house and a person's dog.")).toBe("The friends' house and a person's dog.");
    expect(withoutQuotes("A person peers at an object, saying 'Aver, let's see what this is!' with a thoughtful expression")).toBe("A person peers at an object with a thoughtful expression");
    expect(parseScene({ scene: "'lunes'" }, "Monday")).not.toContain("lunes");
  });

  it("names the medium before the scene", () => {
    expect(imagePrompt("A cat.").indexOf("Cut-paper")).toBe(0);
    expect(imagePrompt("A cat.")).toContain("irregular and hand-cut");
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

  it("asks which meaning the example uses, then writes the scene without the example", async () => {
    const s = server();
    const body = (await (await s.fetch("/api/pictures", post({ word: "el banco", translation: "bank, bench", example: "Me senté en el banco." }))).json()) as { sense: string };
    expect(body.sense).toBe("bench");
    const texts = s.ai.calls.filter((c) => c.model.includes("granite")).map((c) => (c.input as { messages: { content: string }[] }).messages[1].content);
    expect(texts).toEqual(["Word: el banco\nExample: Me senté en el banco.\nMeanings:\n1. bank\n2. bench", "Word: el banco\nMeaning: bench"]);
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

  it("draws pictures of cards coming up after the ones needed now, and nothing queued near the end is lost", async () => {
    const { d, s, pics, add } = await client();
    const drawn: string[] = [];
    pics.fetch = async (url, init) => {
      drawn.push((JSON.parse(String(init?.body)) as { word: string }).word);
      return s.fetch(url, init);
    };
    const [a, b, c] = [await add("uno", "one"), await add("dos", "two"), await add("tres", "three")];
    pics.pausedUntil = d.clock.now() + 3_600_000; // queue without drawing
    await pics.ensure(a, true);
    await pics.ensure(b, true);
    await pics.ensure(c); // shown now
    await pics.ensure(b); // and this one too, now: it moves up
    pics.pausedUntil = 0;
    await pics.kick();
    expect(drawn).toEqual(["dos", "tres", "uno"]); // needed now, oldest first; then the one still ahead
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
    expect(lastScene.messages[1].content).toBe("Word: el banco\nMeaning: bench\nDetails: in a park");
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

  it("draws for a card still being filled in: stored on the device, nothing written", async () => {
    const { d, pics } = await client();
    const r = await pics.sketcher().draw({ word: "la torre", translation: "the tower", details: " at night " });
    if (!r.ok) throw new Error(r.reason);
    expect(r.picture).toMatchObject({ sense: "the tower", details: "at night" });
    expect(new Uint8Array((await d.store.getPicBlob(r.picture.key))!.data)).toEqual(JPEG);
    expect((await d.store.allEvents()).filter((e) => e.type === "asset_attached")).toEqual([]);
    pics.stop();
  });

  it("a newer drawing on the same card makes the older one's result be ignored; other cards are not affected", async () => {
    const { pics } = await client();
    const a = pics.sketcher(), b = pics.sketcher();
    const first = a.draw({ word: "ben", translation: "ben" });
    const other = b.draw({ word: "mesa", translation: "table" });
    const second = a.draw({ word: "banco", translation: "bench" });
    expect(await first).toEqual({ ok: false, reason: "stale" });
    expect((await second).ok).toBe(true);
    expect((await other).ok).toBe(true);
    const c = pics.sketcher();
    const cancelled = c.draw({ word: "silla", translation: "chair" });
    c.cancel();
    expect(await cancelled).toEqual({ ok: false, reason: "stale" });
    pics.stop();
  });

  it("says why there is no drawing: offline, the daily limit (then no requests until the reset), failure", async () => {
    const { s, pics } = await client({ budget: 70 });
    const sk = pics.sketcher();
    const fetch = pics.fetch;
    pics.fetch = async () => {
      throw new TypeError("Failed to fetch");
    };
    expect(await sk.draw({ word: "uno", translation: "one" })).toEqual({ ok: false, reason: "offline" });
    pics.fetch = fetch;
    expect((await sk.draw({ word: "uno", translation: "one" })).ok).toBe(true);
    const limited = await sk.draw({ word: "dos", translation: "two" });
    expect(limited).toMatchObject({ ok: false, reason: "limit" });
    const calls = s.ai.calls.length;
    let requests = 0;
    pics.fetch = async (url, init) => (requests++, fetch(url, init));
    expect(await sk.draw({ word: "tres", translation: "three" })).toMatchObject({ ok: false, reason: "limit" });
    expect(requests).toBe(0);
    expect(s.ai.calls.length).toBe(calls);
    pics.stop();
    const broken = await client();
    broken.s.ai.fail = true;
    expect(await broken.pics.sketcher().draw({ word: "uno", translation: "one" })).toEqual({ ok: false, reason: "failed" });
    broken.pics.stop();
  });

  it("a card added while its picture is drawing gets that picture, and the queue never draws a second one", async () => {
    const { d, s, pics, add } = await client();
    const pending = pics.sketcher().draw({ word: "la torre", translation: "the tower" });
    const id = await add("la torre", "the tower");
    pics.pausedUntil = Infinity;
    await pics.ensure(id, true); // queued ahead from the table meanwhile
    pics.pausedUntil = 0;
    await pics.adopt(id, pending);
    const r = await pending;
    if (!r.ok) throw new Error(r.reason);
    expect(d.store.col.notes.get(id)!.picture!.key).toBe(r.picture.key);
    expect(await d.store.picJobs()).toEqual([]);
    const images = s.ai.calls.filter((c) => !c.model.includes("granite")).length;
    await pics.kick();
    expect(s.ai.calls.filter((c) => !c.model.includes("granite")).length).toBe(images);
    pics.stop();
  });

  it("when that drawing fails, the queue draws the picture instead", async () => {
    const { d, pics, add } = await client();
    const id = await add("la torre", "the tower");
    await pics.adopt(id, Promise.resolve({ ok: false, reason: "offline" }));
    expect((await d.store.picJobs()).map((j) => j.note_id)).toEqual([id]);
    await pics.kick();
    expect(d.store.col.notes.get(id)!.picture).toBeDefined();
    pics.stop();
  });

  it("a late drawing doesn't replace a picture changed or removed meanwhile", async () => {
    const { d, pics, add } = await client();
    const id = await add("la torre", "the tower");
    const old = await pics.sketcher().draw({ word: "la torre", translation: "the tower" });
    if (!old.ok) throw new Error(old.reason);
    await d.store.append([d.store.factory.make<AssetAttached>("asset_attached", { note_id: id, kind: "image", r2_key: old.picture.key })]);
    // Saved with a redraw of "old"; meanwhile the picture became "other".
    const pending = pics.sketcher().draw({ word: "la torre", translation: "the tower", details: "at night" });
    await d.store.append([d.store.factory.make<AssetAttached>("asset_attached", { note_id: id, kind: "image", r2_key: "pics/other.jpg" })]);
    await pics.adopt(id, pending, old.picture.key);
    expect(d.store.col.notes.get(id)!.picture!.key).toBe("pics/other.jpg");
    await pics.remove(id);
    await pics.adopt(id, pics.sketcher().draw({ word: "la torre", translation: "the tower" }));
    expect(d.store.col.notes.get(id)!.picture).toBeUndefined();
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
    expect((await pics.view(res.key))!.url).toStartWith("blob:");
    pics.stop();
  });
});
