import { describe, expect, it } from "bun:test";
import type { NoteCreatedPayload } from "../src/domain/events";
import { parseSummary, SUMMARY_MODEL, summaryMessages, summaryRequestOk, summaryText, type Summary, type SummaryRequest } from "../src/domain/summary";
import { Summaries } from "../src/summaries";
import type { FillEnv } from "../worker/fill";
import type { AiRunner, BlobStore } from "../worker/pictures";
import { handleSummary } from "../worker/summary";
import { sqliteD1 } from "./support/d1";
import { Device, T0 } from "./support/harness";

const CODE = "ABCDEFGHIJKLMN23";
const req = (o: Partial<SummaryRequest> = {}): SummaryRequest => ({ from: "es", to: "en", in: "es", word: "tener", translation: "to have", ...o });

describe("summary prompts", () => {
  it("writes in the studied language by default, simply, or in the known one", () => {
    const own = summaryMessages(req())[0].content;
    expect(own).toContain("Write everything in Spanish, in simple Spanish");
    const known = summaryMessages(req({ in: "en" }))[0].content;
    expect(known).toContain("Write in English; Spanish words, forms and phrases stay in Spanish.");
    expect(summaryMessages(req())[1].content).toBe("Spanish word: tener\nEnglish translation: to have");
  });

  it("takes only the pair's languages, and both words", () => {
    expect(summaryRequestOk(req())).toBe(true);
    expect(summaryRequestOk(req({ in: "en" }))).toBe(true);
    expect(summaryRequestOk(req({ in: "ru" }))).toBe(false);
    expect(summaryRequestOk(req({ translation: " " }))).toBe(false);
    expect(summaryRequestOk(req({ word: "x".repeat(121) }))).toBe(false);
  });

  it("keys the words, the pair and the language written in", () => {
    expect(summaryText(req())).toBe(summaryText(req({ word: " tener  " })));
    expect(summaryText(req())).not.toBe(summaryText(req({ in: "en" })));
    expect(summaryText(req())).not.toBe(summaryText(req({ translation: "to hold" })));
  });

  it("reads the reply, dropping empty, markdown and overlong bits", () => {
    const s = parseSummary(
      '```json\n{"gist":"verbo irregular · poseer","forms":[{"label":"presente","value":"tengo, tienes"},{"label":"","value":"x"}],"notes":[{"title":"**Uso**","lines":["- tener hambre","","' +
        "x".repeat(201) +
        '"]},{"title":"vacío","lines":[]}]}\n```',
    );
    expect(s).toEqual({ gist: "verbo irregular · poseer", forms: [["presente", "tengo, tienes"]], notes: [{ title: "Uso", lines: ["tener hambre"] }] });
    expect(parseSummary("nonsense")).toBeNull();
    expect(parseSummary({ gist: "", forms: [], notes: [] })).toBeNull();
  });
});

class MemoryBucket implements BlobStore {
  objects = new Map<string, string>();
  async put(key: string, value: ArrayBuffer | Uint8Array | string) {
    this.objects.set(key, typeof value === "string" ? value : new TextDecoder().decode(value));
  }
  async get(key: string) {
    const o = this.objects.get(key);
    return o === undefined ? null : { body: new Response(o).body! };
  }
}

const REPLY = { gist: "verbo irregular · poseer", forms: [{ label: "presente", value: "tengo, tienes, tiene" }], notes: [{ title: "Uso", lines: ["tener hambre, tener sed"] }] };
const SUMMARY: Summary = { gist: "verbo irregular · poseer", forms: [["presente", "tengo, tienes, tiene"]], notes: [{ title: "Uso", lines: ["tener hambre, tener sed"] }] };

class FakeAi implements AiRunner {
  calls: { model: string; input: Record<string, unknown> }[] = [];
  fail = false;
  reply: unknown = REPLY;
  async run(model: string, input: unknown) {
    this.calls.push({ model, input: input as Record<string, unknown> });
    if (this.fail) throw new Error("5000: model down");
    return { choices: [{ message: { content: JSON.stringify(this.reply) } }] };
  }
}

function server(over: Partial<FillEnv> = {}) {
  const env: FillEnv = { DB: sqliteD1(), MEDIA: new MemoryBucket(), AI: new FakeAi(), now: () => T0, ...over };
  const call = async (body: unknown, init: RequestInit = {}) =>
    (await handleSummary(new Request("https://rcfc.test/api/summary", { method: "POST", headers: { "content-type": "application/json", "x-user-code": CODE }, body: JSON.stringify(body), ...init }), env))!;
  return { env, call, ai: env.AI as FakeAi };
}

describe("summary API", () => {
  it("writes a word's notes once; the same words cost nothing the second time", async () => {
    const { call, ai } = server();
    const r1 = await call(req());
    expect(r1.status).toBe(200);
    expect(await r1.json()).toEqual(SUMMARY);
    expect(ai.calls).toHaveLength(1);
    expect(ai.calls[0].model).toBe(SUMMARY_MODEL);
    expect((ai.calls[0].input.response_format as { type: string }).type).toBe("json_schema");
    expect(await (await call(req({ word: "tener " }))).json()).toEqual(SUMMARY);
    expect(ai.calls).toHaveLength(1);
    // In the other language: other notes.
    await call(req({ in: "en" }));
    expect(ai.calls).toHaveLength(2);
  });

  it("stops at the daily neuron budget shared with pictures, still serving kept notes", async () => {
    const { call } = server({ budget: 150 });
    expect((await call(req())).status).toBe(200);
    const r = await call(req({ word: "ser", translation: "to be" }));
    expect(r.status).toBe(429);
    expect(Number(r.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await call(req())).status).toBe(200);
  });

  it("fails cleanly and keeps nothing that failed", async () => {
    const { call, ai, env } = server();
    ai.fail = true;
    expect((await call(req())).status).toBe(502);
    ai.fail = false;
    ai.reply = "nonsense";
    expect((await call(req())).status).toBe(502);
    expect((env.MEDIA as MemoryBucket).objects.size).toBe(0);
  });

  it("answers a placeholder without an AI binding (local dev)", async () => {
    const { call } = server({ AI: undefined });
    expect((await (await call(req())).json()).gist).toBe("dev notes · to have");
  });

  it("rejects bad requests", async () => {
    const { call } = server();
    expect((await call(req({ translation: "" }))).status).toBe(400);
    expect((await call(req({ in: "ru" }))).status).toBe(400);
    expect((await call(req({ from: "spanish!" }))).status).toBe(400);
    expect((await call(req(), { headers: { "x-user-code": "nope" } })).status).toBe(401);
    expect((await call(null, { method: "GET", body: undefined })).status).toBe(405);
  });
});

async function client(over: Partial<FillEnv> = {}) {
  const d = await Device.open();
  const deckId = await d.deck(0);
  const s = server(over);
  const sums = await Summaries.open(d.store, () => CODE);
  let online = true;
  sums.online = () => online;
  sums.fetch = (url, init) => handleSummary(new Request(`https://rcfc.test${url}`, init), s.env).then((r) => r!);
  const card = async (front: string, back: string) => {
    const evs = d.store.factory.note(deckId, { front, back }, { from: "es", to: "en" });
    await d.store.append(evs);
    const id = (evs[0].payload as NoteCreatedPayload).note_id;
    return { card: d.store.col.cardsByNote.get(id)![0], note: d.store.col.notes.get(id)! };
  };
  return { d, s, sums, card, offline: () => (online = false) };
}

describe("Summaries (client)", () => {
  it("downloads the notes of the cards coming up once, and has them offline", async () => {
    const c = await client();
    const { card, note } = await c.card("tener", "to have");
    expect(c.sums.langFor(note)).toBe("es");
    await c.sums.ahead([card, card]);
    expect(c.s.ai.calls).toHaveLength(1);
    c.offline();
    expect(await c.sums.get(note)).toEqual(SUMMARY);
    // Kept across launches.
    const again = await Summaries.open(c.d.store, () => CODE);
    again.online = () => false;
    expect(await again.stored(note)).toEqual(SUMMARY);
  });

  it("asks on the spot for a word not downloaded, and has nothing offline", async () => {
    const c = await client();
    const a = await c.card("tener", "to have");
    expect(await c.sums.get(a.note)).toEqual(SUMMARY);
    const b = await c.card("ser", "to be");
    c.offline();
    expect(await c.sums.get(b.note)).toBeNull();
  });

  it("waits for the daily limit to reset", async () => {
    const c = await client({ budget: 150 });
    const a = await c.card("tener", "to have");
    const b = await c.card("ser", "to be");
    const d = await c.card("estar", "to be");
    await c.sums.ahead([a.card, b.card, d.card]);
    expect(c.s.ai.calls).toHaveLength(1); // b hit the limit; d was not asked
    expect(await c.sums.get(d.note)).toBeNull();
  });
});
