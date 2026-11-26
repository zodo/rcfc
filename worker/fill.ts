// Filling in a card. POST /api/fill {from, to, word?, translation?} answers
// the other word, an example and the word's other meanings (src/domain/fill.ts).
// Replies are kept in R2 by language pair and text, so the same words cost
// nothing the second time, for anyone. LLM calls share the pictures' daily
// neuron cap (ai_budget): past it 429, never a bill. Without an AI binding
// (local dev) it answers a recognisable placeholder.
import { budgetDay, DEFAULT_DAILY_NEURONS, secondsToReset } from "../src/domain/pictures";
import { clean, devFill, FILL_MODEL, FILL_SCHEMA, fillKey, fillKind, fillMessages, NEURONS_PER_FILL, parseFill, type Fill, type FillRequest } from "../src/domain/fill";
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
  const input: Record<string, unknown> = {
    messages: fillMessages(r),
    response_format: { type: "json_schema", json_schema: { name: "card", schema: FILL_SCHEMA } },
    max_tokens: 700,
    temperature: 0.2,
  };
  // Gemma 4 thinks by default: slower, and no better at a dictionary entry.
  if (model.includes("gemma-4")) input.chat_template_kwargs = { enable_thinking: false };
  const res = (await ai.run(model, input)) as { response?: unknown; choices?: { message?: { content?: unknown } }[] };
  return parseFill(res.response ?? res.choices?.[0]?.message?.content, r);
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
    if (env.devDelay) await new Promise((res) => setTimeout(res, env.devDelay));
    return json(devFill(r));
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
  const kept = await env.MEDIA.get(key);
  if (kept) return json(await new Response(kept.body).json());

  const now = (env.now ?? Date.now)();
  if (!(await reserve(env.DB, budgetDay(now), NEURONS_PER_FILL, env.budget ?? DEFAULT_DAILY_NEURONS))) {
    const wait = secondsToReset(now);
    return new Response(JSON.stringify({ error: "daily AI limit reached", retry_after: wait }), {
      status: 429,
      headers: { "content-type": "application/json", "cache-control": "no-store", "retry-after": String(wait) },
    });
  }
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
