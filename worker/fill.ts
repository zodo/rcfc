// Filling in a card. POST /api/fill {from, to, word?, translation?} answers
// the other word, an example and the word's other meanings (src/domain/fill.ts).
// With `stream: true` it answers NDJSON (`FillLine`): the first option as its
// places are written out (the translation comes first, before the rest is
// written), then the whole fill. Streamed, the model runs without a JSON mode
// (with one the reply comes whole); a reply that doesn't parse is asked once
// more with it.
// Replies are kept in R2 by language pair and text, so the same words cost
// nothing the second time, for anyone. LLM calls share the pictures' daily
// neuron cap (ai_budget): past it 429, never a bill. Without an AI binding
// (local dev) it answers a recognisable placeholder.
import { budgetDay, DEFAULT_DAILY_NEURONS, secondsToReset } from "../src/domain/pictures";
import { clean, devFill, FILL_MODEL, FILL_SCHEMA, fillKey, fillKind, fillMessages, firstSoFar, NEURONS_PER_FILL, parseFill, type Fill, type FillLine, type FillOption, type FillRequest } from "../src/domain/fill";
import { takeLines } from "../src/domain/pictures";
import { isSyncCode } from "../src/domain/sync";
import { reserve, type AiRunner, type BlobStore } from "./pictures";
import { json, type SqlDb } from "./sync";

export interface FillEnv {
  DB: SqlDb;
  MEDIA: BlobStore;
  AI?: AiRunner;
  /** Daily neuron cap shared with pictures (default DEFAULT_DAILY_NEURONS). */
  budget?: number;
  /** Outside production a request may name another model (comparing models on preview). */
  production?: boolean;
  /** Local dev: how long the placeholder takes, like a real fill (ms). */
  devDelay?: number;
  now?: () => number;
}

const LANG_RE = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/;

function parseRequest(body: unknown): FillRequest | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const r: FillRequest = {
    from: typeof b.from === "string" ? b.from : "",
    to: typeof b.to === "string" ? b.to : "",
    word: typeof b.word === "string" ? clean(b.word) || undefined : undefined,
    translation: typeof b.translation === "string" ? clean(b.translation) || undefined : undefined,
  };
  return LANG_RE.test(r.from) && LANG_RE.test(r.to) && fillKind(r) ? r : null;
}

async function ask(ai: AiRunner, model: string, r: FillRequest): Promise<Fill> {
  // Gemma 4 thinks by default (chatInput turns it off): slower, and no better at a dictionary entry.
  const res = (await ai.run(model, chatInput(model, r, false))) as { response?: unknown; choices?: { message?: { content?: unknown } }[] };
  return parseFill(res.response ?? res.choices?.[0]?.message?.content, r);
}

const chatInput = (model: string, r: FillRequest, stream: boolean): Record<string, unknown> => {
  const input: Record<string, unknown> = { messages: fillMessages(r), max_tokens: 700, temperature: 0.2 };
  if (stream) input.stream = true;
  else input.response_format = { type: "json_schema", json_schema: { name: "card", schema: FILL_SCHEMA } };
  if (model.includes("gemma-4")) input.chat_template_kwargs = { enable_thinking: false };
  return input;
};

/** The reply streamed: `onText` gets all of it so far after each piece. Returns the whole reply. */
async function chatStream(ai: AiRunner, model: string, r: FillRequest, onText: (text: string) => void): Promise<string> {
  const res = await ai.run(model, chatInput(model, r, true));
  if (!(res instanceof ReadableStream)) {
    // A runner that answers whole (tests): one piece.
    const v = res as { response?: unknown; choices?: { message?: { content?: unknown } }[] };
    const whole = v.response ?? v.choices?.[0]?.message?.content;
    const text = typeof whole === "string" ? whole : JSON.stringify(whole ?? "");
    onText(text);
    return text;
  }
  const reader = (res as ReadableStream<Uint8Array>).getReader();
  const dec = new TextDecoder();
  let buf = "", text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buf += dec.decode(value, { stream: !done });
    const { lines, rest } = takeLines(done ? buf + "\n" : buf);
    buf = rest;
    for (const line of lines) {
      const data = line.replace(/^data:\s*/, "");
      if (data === "[DONE]") continue;
      try {
        const j = JSON.parse(data) as { response?: string; choices?: { delta?: { content?: string } }[] };
        const piece = j.response ?? j.choices?.[0]?.delta?.content ?? "";
        if (piece) onText((text += piece));
      } catch {
        // not a data line
      }
    }
    if (done) return text;
  }
}

/** The fill streamed as NDJSON lines, kept in R2 once whole. */
function streamed(ai: AiRunner, model: string, r: FillRequest, key: string, env: FillEnv): Response {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const w = writable.getWriter();
  const enc = new TextEncoder();
  const send = (line: FillLine) => w.write(enc.encode(JSON.stringify(line) + "\n"));
  void (async () => {
    try {
      let sent = "";
      const text = await chatStream(ai, model, r, (t) => {
        const first: Partial<FillOption> = firstSoFar(t, r);
        const k = JSON.stringify(first);
        if (k !== sent && Object.keys(first).length) {
          sent = k;
          void send({ first });
        }
      });
      let fill = parseFill(text, r);
      if (!fill.options.length) fill = await ask(ai, model, r); // once more, in JSON mode
      if (fill.options.length) await env.MEDIA.put(key, JSON.stringify(fill), { httpMetadata: { contentType: "application/json" } });
      await send({ fill });
    } catch (e) {
      await send({ error: `fill failed: ${e instanceof Error ? e.message : String(e)}` }).catch(() => {});
    } finally {
      await w.close().catch(() => {});
    }
  })();
  return new Response(readable, { headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" } });
}

/**
 * Comparing models for a streamed fill (preview only, `timing: true`): the
 * reply streamed without a JSON mode (with one it comes whole), and when its
 * first piece, its first translation (complete) and its end came, in ms. Nothing kept.
 */
async function timing(ai: AiRunner, model: string, r: FillRequest): Promise<Record<string, unknown>> {
  const input: Record<string, unknown> = { messages: fillMessages(r), max_tokens: 700, temperature: 0.2, stream: true };
  if (model.includes("gemma-4")) input.chat_template_kwargs = { enable_thinking: false };
  const t0 = Date.now();
  const stream = (await ai.run(model, input)) as ReadableStream<Uint8Array>;
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = "", text = "";
  let first: number | undefined, translation: number | undefined, word: number | undefined;
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buf += dec.decode(value, { stream: !done });
    const lines = buf.split("\n");
    buf = done ? "" : (lines.pop() ?? "");
    for (const line of lines) {
      const data = line.replace(/^data:\s*/, "").trim();
      if (!data || data === "[DONE]") continue;
      try {
        const j = JSON.parse(data) as { response?: string; choices?: { delta?: { content?: string } }[] };
        const piece = j.response ?? j.choices?.[0]?.delta?.content ?? "";
        if (!piece) continue;
        first ??= Date.now() - t0;
        text += piece;
        if (word === undefined && /"word"\s*:\s*"[^"]*"/.test(text)) word = Date.now() - t0;
        if (translation === undefined && /"translation"\s*:\s*"[^"]*"/.test(text)) translation = Date.now() - t0;
      } catch {
        // not a data line
      }
    }
    if (done) break;
  }
  let parsed: Fill | undefined;
  try {
    parsed = parseFill(JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)), r);
  } catch {
    parsed = undefined;
  }
  return { first, word, translation, total: Date.now() - t0, chars: text.length, fill: parsed, raw: parsed ? undefined : text.slice(0, 300) };
}

const ndjson = (line: FillLine) => new Response(JSON.stringify(line) + "\n", { headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" } });

/** Handles /api/fill; null for any other path. */
export async function handleFill(request: Request, env: FillEnv): Promise<Response | null> {
  if (new URL(request.url).pathname !== "/api/fill") return null;
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
  const code = request.headers.get("x-user-code");
  if (!code || !isSyncCode(code)) return json({ error: "missing or invalid X-User-Code" }, 401);
  const body = await request.json().catch(() => null);
  const r = parseRequest(body);
  if (!r) return json({ error: "from, to and a word or translation (≤120 characters) are required" }, 400);
  if (!env.AI) {
    const fill = devFill(r);
    const wait = (ms: number) => new Promise((res) => setTimeout(res, ms));
    if ((body as { stream?: unknown }).stream !== true) {
      if (env.devDelay) await wait(env.devDelay);
      return json(fill);
    }
    // Streamed like a real one: the first option's word and translation a little before the rest.
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const w = writable.getWriter();
    const line = (l: FillLine) => w.write(new TextEncoder().encode(JSON.stringify(l) + "\n"));
    void (async () => {
      const o = fill.options[0];
      await wait((env.devDelay ?? 0) * 0.6);
      if (o) await line({ first: { word: o.word, translation: o.translation } });
      await wait((env.devDelay ?? 0) * 0.4);
      await line({ fill });
      await w.close();
    })();
    return new Response(readable, { headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" } });
  }

  const asked = (body as { model?: unknown }).model;
  const model = !env.production && typeof asked === "string" && asked.startsWith("@cf/") ? asked : FILL_MODEL;
  if (!env.production && (body as { timing?: unknown }).timing === true && env.AI) {
    try {
      return json(await timing(env.AI, model, r));
    } catch (e) {
      return json({ error: `timing failed: ${e instanceof Error ? e.message : String(e)}` }, 502);
    }
  }
  const key = await fillKey(r, model);
  const stream = (body as { stream?: unknown }).stream === true;
  const kept = await env.MEDIA.get(key);
  if (kept) {
    const fill = (await new Response(kept.body).json()) as Fill;
    return stream ? ndjson({ fill }) : json(fill);
  }

  const now = (env.now ?? Date.now)();
  if (!(await reserve(env.DB, budgetDay(now), NEURONS_PER_FILL, env.budget ?? DEFAULT_DAILY_NEURONS))) {
    const wait = secondsToReset(now);
    return new Response(JSON.stringify({ error: "daily AI limit reached", retry_after: wait }), {
      status: 429,
      headers: { "content-type": "application/json", "cache-control": "no-store", "retry-after": String(wait) },
    });
  }
  if (stream) return streamed(env.AI, model, r, key, env);
  let fill: Fill;
  try {
    fill = await ask(env.AI, model, r);
  } catch (e) {
    return json({ error: `fill failed: ${e instanceof Error ? e.message : String(e)}` }, 502);
  }
  // An empty answer is not kept: next time may do better.
  if (fill.options.length) await env.MEDIA.put(key, JSON.stringify(fill), { httpMetadata: { contentType: "application/json" } });
  return json(fill);
}
