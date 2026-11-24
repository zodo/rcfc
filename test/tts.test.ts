import { describe, expect, it } from "bun:test";
import type { NoteCreatedPayload } from "../src/domain/events";
import { audioKey, budgetMonth, ssml, voiceFor } from "../src/domain/tts";
import { Speech, type Player } from "../src/speech";
import type { BlobStore } from "../worker/pictures";
import { handleTts, type TtsEnv } from "../worker/tts";
import { sqliteD1 } from "./support/d1";
import { Device, T0 } from "./support/harness";

const CODE = "ABCDEFGHIJKLMN23";
const MP3 = new Uint8Array([0x49, 0x44, 0x33, 1, 2]);

class MemoryBucket implements BlobStore {
  objects = new Map<string, Uint8Array>();
  async put(key: string, value: ArrayBuffer | Uint8Array | string) {
    this.objects.set(key, typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value));
  }
  async get(key: string) {
    const o = this.objects.get(key);
    return o ? { body: new Response(new Blob([o as Uint8Array<ArrayBuffer>])).body! } : null;
  }
}

/** The Worker with Azure stubbed: `azure` records every text it was asked to say. */
function server(over: Partial<TtsEnv> = {}) {
  const azure: string[] = [];
  let status = 200;
  const env: TtsEnv = {
    DB: sqliteD1(),
    MEDIA: new MemoryBucket(),
    AZURE_SPEECH_KEY: "test-key",
    now: () => T0,
    fetch: async (_url, init) => {
      azure.push(String(init.body));
      return status === 200 ? new Response(MP3) : new Response("no", { status });
    },
    ...over,
  };
  const fetch = async (url: string, init: RequestInit = {}) => (await handleTts(new Request(new URL(url, "https://rcfc.test"), init), env)) ?? new Response("no route", { status: 404 });
  const get = (lang: string, text: string, code = CODE) => fetch(`/api/tts?lang=${lang}&text=${encodeURIComponent(text)}`, { headers: { "x-user-code": code } });
  return { env, fetch, get, azure, fail: (s: number) => (status = s) };
}

describe("voices", () => {
  it("one voice per supported language; the SSML is escaped and a little slow", () => {
    expect(voiceFor("es")).toBe("es-ES-ElviraNeural");
    expect(voiceFor("de-AT")).toBe("de-DE-KatjaNeural");
    expect(voiceFor("xx")).toBeUndefined();
    const s = ssml("  Tom & <Jerry>  ", "es-ES-ElviraNeural");
    expect(s).toContain('xml:lang="es-ES"');
    expect(s).toContain('<prosody rate="-10%">Tom &#38; &#60;Jerry&#62;</prosody>');
  });

  it("the same text in the same voice is one audio, whatever its spacing", async () => {
    expect(await audioKey("la  torre ", "es-ES-ElviraNeural")).toBe(await audioKey("la torre", "es-ES-ElviraNeural"));
    expect(await audioKey("la torre", "es-ES-ElviraNeural")).not.toBe(await audioKey("la torre", "es-MX-DaliaNeural"));
    expect(budgetMonth(T0)).toBe("2026-11");
  });
});

describe("tts API", () => {
  it("makes audio once, then serves it from storage", async () => {
    const s = server();
    const a = await s.get("es", "la torre");
    expect(a.status).toBe(200);
    expect(a.headers.get("content-type")).toBe("audio/mpeg");
    expect(new Uint8Array(await a.arrayBuffer())).toEqual(MP3);
    expect((await s.get("es", " la  torre")).status).toBe(200);
    expect(s.azure).toHaveLength(1);
    expect(s.azure[0]).toContain("es-ES-ElviraNeural");
  });

  it("stops at the monthly character budget", async () => {
    const s = server({ budget: 12 });
    expect((await s.get("es", "la torre")).status).toBe(200); // 8
    expect((await s.get("es", "el loro")).status).toBe(429); // 8 more: over 12
    expect((await s.get("es", "la torre")).status).toBe(200); // stored: free
    expect(s.azure).toHaveLength(1);
  });

  it("answers 404 without a key or a voice, so the app uses the browser's", async () => {
    expect(((await (await server({ AZURE_SPEECH_KEY: undefined }).get("es", "hola")).json()) as { error: string }).error).toBe("no voice service");
    expect((await server().get("xx", "hola")).status).toBe(404);
  });

  it("rejects bad requests, and says when Azure fails", async () => {
    const s = server();
    expect((await s.get("es", "hola", "nope")).status).toBe(401);
    expect((await s.get("es", "")).status).toBe(400);
    expect((await s.get("es", "x".repeat(301))).status).toBe(400);
    expect((await s.fetch("/api/tts", { method: "POST" })).status).toBe(405);
    s.fail(500);
    expect((await s.get("es", "hola")).status).toBe(502);
  });
});

/** A Speech on a device, talking to the Worker; `played` and `browser` record what was said how. */
async function client(over: Partial<TtsEnv> = {}) {
  const d = await Device.open();
  const deckId = await d.deck(0);
  const s = server(over);
  const played: string[] = [];
  const player: Player = { play: async (key) => (played.push(key), true), stop: () => {} };
  const speech = await Speech.open(d.store, () => CODE, player);
  speech.fetch = s.fetch;
  const browser: string[] = [];
  speech.fallback = (text) => browser.push(text);
  const card = async (front: string, example?: string) => {
    const evs = d.store.factory.note(deckId, { front, back: "x", ...(example ? { example } : {}) }, { from: "es", to: "en" });
    await d.store.append(evs);
    const id = (evs[0].payload as NoteCreatedPayload).note_id;
    return d.store.col.cardsByNote.get(id)![0];
  };
  return { d, s, speech, played, browser, card };
}

describe("Speech (client)", () => {
  it("downloads the word and example of the cards coming up, once, and plays them from the device", async () => {
    const c = await client();
    const id = await c.card("la torre", "En el castillo hay una torre.");
    await c.speech.ahead([id, id]);
    expect(c.s.azure).toHaveLength(2);
    await c.speech.say("la torre", "es");
    await c.speech.say("En el castillo hay una torre.", "es");
    expect(c.played).toEqual(["es|la torre", "es|En el castillo hay una torre."]);
    expect(c.s.azure).toHaveLength(2); // nothing fetched to play
    const again = await Speech.open(c.d.store, () => CODE, { play: async () => true, stop: () => {} });
    again.fetch = async () => {
      throw new Error("offline");
    };
    await again.ahead([id]); // already on the device: nothing to fetch
  });

  it("fetches audio not downloaded yet when tapped, else the browser says it", async () => {
    const c = await client();
    await c.speech.say("el loro", "es");
    expect(c.played).toEqual(["es|el loro"]);
    c.speech.fetch = async () => {
      throw new Error("offline");
    };
    await c.speech.say("la manta", "es");
    expect(c.browser).toEqual(["la manta"]);
  });

  it("without a voice service it stops asking and uses the browser", async () => {
    const c = await client({ AZURE_SPEECH_KEY: undefined });
    await c.speech.ahead([await c.card("hola"), await c.card("adiós")]);
    expect(c.s.azure).toHaveLength(0);
    await c.speech.say("hola", "es");
    expect(c.browser).toEqual(["hola"]);
  });

  it("a player that can't play yet (no tap so far) falls back to the browser", async () => {
    const c = await client();
    c.speech.player.play = async () => false;
    await c.speech.say("hola", "es");
    expect(c.browser).toEqual(["hola"]);
  });

  it("a later say wins over a slower earlier one", async () => {
    const c = await client();
    const slow = c.speech.say("la torre", "es");
    const fast = c.speech.say("el loro", "es");
    await Promise.all([slow, fast]);
    expect(c.played).toEqual(["es|el loro"]);
  });
});
