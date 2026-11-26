import { describe, expect, it } from "bun:test";
import { applyOption, askKey, clearAuto, FILL_MODEL, fillAsk, fillKey, fillKind, fillMessages, filledPlace, parseFill, type FillPlace, type FillRequest } from "../src/domain/fill";
import { handleFill, type FillEnv } from "../worker/fill";
import type { AiRunner, BlobStore } from "../worker/pictures";
import { sqliteD1 } from "./support/d1";
import { T0 } from "./support/harness";

const CODE = "ABCDEFGHIJKLMN23";
const es = (o: Partial<FillRequest>): FillRequest => ({ from: "es", to: "en", ...o });

describe("fill prompts", () => {
  it("asks by what was typed: the word, the translation, or both (for an example)", () => {
    expect(fillKind(es({ word: "banco" }))).toBe("word");
    expect(fillKind(es({ translation: "bench" }))).toBe("translation");
    expect(fillKind(es({ word: "gato", translation: "cat" }))).toBe("example");
    expect(fillKind(es({ word: "  " }))).toBeNull();
    expect(fillKind(es({ word: "x".repeat(121) }))).toBeNull();
  });

  it("asks for the article where nouns are learned with one", () => {
    const [sys, user] = fillMessages(es({ word: "banco" }));
    expect(sys.content).toContain("el, la, los, las");
    expect(sys.content).toContain("learning Spanish who knows English");
    expect(user.content).toBe("Spanish word: banco");
    expect(fillMessages({ from: "ru", to: "en", word: "тоска" })[0].content).not.toContain("article (");
    expect(fillMessages(es({ translation: "bench" }))[1].content).toBe("English word: bench");
    expect(fillMessages(es({ word: "gato", translation: "cat" }))[1].content).toBe("Spanish word: gato\nEnglish translation: cat");
  });

  it("reads a reply: one option per meaning, the typed side kept, repeats and blanks dropped, at most three", () => {
    const reply = {
      suggest: null,
      options: [
        { word: "el banco", translation: "bank", example: "Voy al banco." },
        { word: "el banco", translation: "Bank", example: "again" },
        { word: "el banco", translation: "", example: "no translation" },
        { word: "el banco", translation: "bench", example: "Me siento en el banco." },
        { word: "el banco", translation: "shoal", example: "Un banco de peces." },
        { word: "el banco", translation: "bank 4", example: "x" },
      ],
    };
    const f = parseFill(reply, es({ word: "banco" }));
    expect(f.options.map((o) => o.translation)).toEqual(["bank", "bench", "shoal"]);
    expect(f.suggest).toBe("el banco"); // left out, taken from the word the options give
  });

  it("suggests only a different form, and never for a translation's word", () => {
    expect(parseFill({ suggest: "comer", options: [{ word: "comer", translation: "to eat", example: "Me gusta comer." }] }, es({ word: "comí" })).suggest).toBe("comer");
    expect(parseFill({ suggest: "La Mano", options: [{ word: "la mano", translation: "hand", example: "" }] }, es({ word: "la mano" })).suggest).toBeUndefined();
    expect(parseFill({ suggest: "null", options: [{ word: "madrugar", translation: "to get up early", example: "" }] }, es({ word: "madrugar" })).suggest).toBeUndefined();
    const t = parseFill({ suggest: "x", options: [{ word: "el banco", translation: "", example: "Nos sentamos en el banco." }] }, es({ translation: "bench" }));
    expect(t).toEqual({ options: [{ word: "el banco", translation: "bench", example: "Nos sentamos en el banco." }] });
  });

  it("keeps both typed words when asked for an example", () => {
    const f = parseFill({ suggest: "el gato", options: [{ word: "el gato", translation: "the cat", example: "El gato duerme." }, { word: "x", translation: "y", example: "z" }] }, es({ word: "gato", translation: "cat" }));
    expect(f).toEqual({ options: [{ word: "gato", translation: "cat", example: "El gato duerme." }], suggest: "el gato" });
  });

  it("survives junk replies", () => {
    expect(parseFill(null, es({ word: "a" }))).toEqual({ options: [] });
    expect(parseFill("not json", es({ word: "a" }))).toEqual({ options: [] });
    expect(parseFill({ options: "no" }, es({ word: "a" }))).toEqual({ options: [] });
    const fenced = '```json\n{"suggest": null, "options": [{"word": "la vela", "translation": "\\"candle\\"", "example": "La vela."}]}\n```';
    expect(parseFill(fenced, es({ word: "vela" })).options[0].translation).toBe("candle");
    expect(parseFill('Sure! {"options": [{"word": "a", "translation": "b", "example": "c"}]} Hope it helps', es({ word: "a" })).options).toHaveLength(1);
  });

  it("keys a fill by version, model, languages and the typed text", async () => {
    const k = await fillKey(es({ word: "banco" }));
    expect(k).toMatch(/^fill\/[0-9a-f]{64}\.json$/);
    expect(await fillKey(es({ word: " banco " }))).toBe(k);
    expect(await fillKey(es({ translation: "banco" }))).not.toBe(k);
    expect(await fillKey({ from: "es", to: "ru", word: "banco" })).not.toBe(k);
    expect(await fillKey(es({ word: "banco" }), "@cf/other")).not.toBe(k);
  });
});

describe("filling the card editor", () => {
  const pair = { from: "es", to: "en" };
  const text = (front = "", back = "", example = "") => ({ front, back, example });
  const none = new Set<FillPlace>();

  it("asks from what the user typed, never from what a fill wrote", () => {
    expect(fillAsk(text("banco"), none, pair)).toEqual(es({ word: "banco" }));
    expect(fillAsk(text("", "bench"), none, pair)).toEqual(es({ translation: "bench" }));
    expect(fillAsk(text("gato", "cat"), none, pair)).toEqual(es({ word: "gato", translation: "cat" }));
    expect(fillAsk(text("gato", "cat", "Mi gato."), none, pair)).toBeUndefined(); // nothing left to fill
    expect(fillAsk(text("banco", "bank", "Voy al banco."), new Set<FillPlace>(["back", "example"]), pair)).toEqual(es({ word: "banco" }));
    expect(fillAsk(text("gato", "cat", "El gato."), new Set<FillPlace>(["example"]), pair)).toEqual(es({ word: "gato", translation: "cat" }));
    expect(fillAsk(text(), none, pair)).toBeUndefined();
    expect(askKey(fillAsk(text(" banco"), none, pair))).toBe(askKey(es({ word: "banco" })));
  });

  it("writes the other word and the example, never over what the user typed", () => {
    const r = es({ word: "banco" });
    const bank = { word: "el banco", translation: "bank", example: "Voy al banco." };
    const bench = { word: "el banco", translation: "bench", example: "Me siento en el banco." };
    expect(filledPlace(r)).toBe("back");
    const a = applyOption(text("banco"), none, r, bank);
    expect(a.text).toEqual(text("banco", "bank", "Voy al banco."));
    expect([...a.auto].sort()).toEqual(["back", "example"]);
    // Another meaning swaps in over what a fill wrote.
    expect(applyOption(a.text, a.auto, r, bench).text).toEqual(text("banco", "bench", "Me siento en el banco."));
    // The user's own example stays.
    const b = applyOption(text("banco", "", "Mi banco."), none, r, bank);
    expect(b.text).toEqual(text("banco", "bank", "Mi banco."));
    expect([...b.auto]).toEqual(["back"]);
    // A typed translation: the word is filled in.
    const c = applyOption(text("", "bench"), none, es({ translation: "bench" }), bench);
    expect(c.text).toEqual(text("el banco", "bench", "Me siento en el banco."));
    // Both typed: only the example.
    expect(applyOption(text("gato", "cat"), none, es({ word: "gato", translation: "cat" }), { word: "gato", translation: "cat", example: "El gato." }).text).toEqual(text("gato", "cat", "El gato."));
  });

  it("takes back what it wrote when the word it was asked from is emptied", () => {
    expect(clearAuto(text("", "bank", "Voy al banco."), new Set<FillPlace>(["back", "example"]))).toEqual(text());
    expect(clearAuto(text("", "bank", "Mine."), new Set<FillPlace>(["back"]))).toEqual(text("", "", "Mine."));
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

class FakeAi implements AiRunner {
  calls: { model: string; input: Record<string, unknown> }[] = [];
  fail = false;
  reply: unknown = { suggest: "el banco", options: [{ word: "el banco", translation: "bank", example: "Voy al banco." }, { word: "el banco", translation: "bench", example: "Me siento en el banco." }] };
  async run(model: string, input: unknown) {
    this.calls.push({ model, input: input as Record<string, unknown> });
    if (this.fail) throw new Error("5000: model down");
    return { response: this.reply };
  }
}

function server(over: Partial<FillEnv> = {}) {
  const env: FillEnv = { DB: sqliteD1(), MEDIA: new MemoryBucket(), AI: new FakeAi(), now: () => T0, ...over };
  const fetch = async (body: unknown, init: RequestInit = {}) =>
    (await handleFill(new Request("https://rcfc.test/api/fill", { method: "POST", headers: { "content-type": "application/json", "x-user-code": CODE }, body: JSON.stringify(body), ...init }), env))!;
  return { env, fetch, ai: env.AI as FakeAi };
}

describe("fill API", () => {
  it("fills a card, and the same words cost nothing the second time", async () => {
    const { fetch, ai } = server();
    const r1 = await fetch({ from: "es", to: "en", word: "banco" });
    expect(r1.status).toBe(200);
    expect(await r1.json()).toEqual({ options: [{ word: "el banco", translation: "bank", example: "Voy al banco." }, { word: "el banco", translation: "bench", example: "Me siento en el banco." }], suggest: "el banco" });
    expect(ai.calls).toHaveLength(1);
    expect(ai.calls[0].model).toBe(FILL_MODEL);
    expect(ai.calls[0].input.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect((ai.calls[0].input.response_format as { type: string }).type).toBe("json_schema");
    const r2 = await fetch({ from: "es", to: "en", word: " banco" });
    expect((await r2.json()).suggest).toBe("el banco");
    expect(ai.calls).toHaveLength(1);
  });

  it("names another model only outside production", async () => {
    const pre = server();
    await pre.fetch({ from: "es", to: "en", word: "banco", model: "@cf/other/model" });
    expect(pre.ai.calls[0].model).toBe("@cf/other/model");
    const prod = server({ production: true });
    await prod.fetch({ from: "es", to: "en", word: "banco", model: "@cf/other/model" });
    expect(prod.ai.calls[0].model).toBe(FILL_MODEL);
  });

  it("stops at the daily neuron budget shared with pictures", async () => {
    const { fetch } = server({ budget: 20 });
    expect((await fetch({ from: "es", to: "en", word: "uno" })).status).toBe(200);
    const r = await fetch({ from: "es", to: "en", word: "dos" });
    expect(r.status).toBe(429);
    expect(Number(r.headers.get("retry-after"))).toBeGreaterThan(0);
    // Kept fills are still served.
    expect((await fetch({ from: "es", to: "en", word: "uno" })).status).toBe(200);
  });

  it("fails cleanly, and keeps neither a failure nor an empty answer", async () => {
    const { fetch, ai, env } = server();
    ai.fail = true;
    expect((await fetch({ from: "es", to: "en", word: "banco" })).status).toBe(502);
    ai.fail = false;
    ai.reply = "nonsense";
    expect(await (await fetch({ from: "es", to: "en", word: "banco" })).json()).toEqual({ options: [] });
    expect((env.MEDIA as MemoryBucket).objects.size).toBe(0);
  });

  it("answers a placeholder without an AI binding (local dev)", async () => {
    const { fetch } = server({ AI: undefined });
    const f = await (await fetch({ from: "es", to: "en", word: "banco" })).json();
    expect(f.options[0].translation).toBe("banco (en)");
    expect((await (await fetch({ from: "es", to: "en", translation: "bench" })).json()).options[0].word).toBe("bench (es)");
  });

  it("rejects bad requests", async () => {
    const { fetch } = server();
    expect((await fetch({ from: "es", to: "en" })).status).toBe(400);
    expect((await fetch({ from: "spanish!", to: "en", word: "a" })).status).toBe(400);
    expect((await fetch({ from: "es", to: "en", word: "a" }, { headers: { "x-user-code": "nope" } })).status).toBe(401);
    expect((await fetch(null, { method: "GET", body: undefined })).status).toBe(405);
  });
});

describe("a side's language switched", () => {
  it("the refill leaves a kept example alone", () => {
    const r = { from: "es", to: "en", word: "el perro" };
    const o = { word: "el perro", translation: "dog", example: "El perro corre." };
    const a = applyOption({ front: "el perro", back: "", example: "Mi perro duerme." }, new Set(["back", "example"]), r, o, new Set(["example"]));
    expect(a.text).toEqual({ front: "el perro", back: "dog", example: "Mi perro duerme." });
  });
});
