// Pictures API. POST /api/pictures draws one card picture (scene LLM →
// FLUX.2 klein 4B), stores it in R2 and returns its key; the client records it
// as an `asset_attached` event. With `stream: true` it answers NDJSON instead:
// the meaning, the scene as it is written, then the picture (PictureLine), so
// the card can show the scene while the picture draws.
// GET /api/media/<key> serves stored pictures.
//
// Spending is capped per UTC day in D1 (ai_budget) below the free Workers AI
// allocation: past the cap the API answers 429 with Retry-After, never a bill.
// Without an AI binding (local dev) it draws a placeholder instead.
import { budgetDay, DEFAULT_DAILY_NEURONS, IMAGE_MODEL, MAX_DETAILS, meanings, NEURONS_PER_PICTURE, parsePlan, parseScene, parseSense, planPrompt, planProblem, retryMessages, PICTURE_H, PICTURE_W, SCENE_MODEL, sceneMessages, sceneSoFar, secondsToReset, senseFor, senseMessages, takeLines, type Plan, type PictureLine, type PictureRequest } from "../src/domain/pictures";
import { isSyncCode } from "../src/domain/sync";
import { json, type SqlDb } from "./sync";

export interface BlobStore {
  put(key: string, value: ArrayBuffer | Uint8Array | string, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  get(key: string): Promise<{ body: ReadableStream; httpMetadata?: { contentType?: string } } | null>;
}
export interface AiRunner {
  run(model: string, input: unknown): Promise<unknown>;
}
export interface PictureEnv {
  DB: SqlDb;
  MEDIA: BlobStore;
  AI?: AiRunner;
  /** Daily neuron cap (default DEFAULT_DAILY_NEURONS). */
  budget?: number;
  /** Outside production a request may name another scene model and ask for the scene only (comparing models on preview). */
  production?: boolean;
  /** Local dev: how long the placeholder takes to draw when streamed, like a real picture (ms). */
  devDelay?: number;
  now?: () => number;
}

const KEY_RE = /^pics\/[0-9a-f-]{36}\.(jpg|svg)$/;
const MAX_FIELD = 500;
/** New seeds tried when the safety filter flags a harmless picture (error 3030). */
const FLAG_RETRIES = 3;

function str(v: unknown, max: number): string | undefined {
  return typeof v === "string" && v.trim() && v.length <= max ? v.trim() : undefined;
}

function parseRequest(body: unknown): PictureRequest | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const word = str(b.word, MAX_FIELD);
  const translation = str(b.translation, MAX_FIELD);
  if (!word || !translation) return null;
  return { word, translation, example: str(b.example, MAX_FIELD), sense: str(b.sense, 100), details: str(b.details, MAX_DETAILS), always: b.always === true || undefined };
}

/** Reserve neurons for one AI call (pictures, fills); false when today's cap would be exceeded. */
export async function reserve(db: SqlDb, day: string, cost: number, cap: number): Promise<boolean> {
  const [r] = await db.batch([
    db
      .prepare("INSERT INTO ai_budget (day, neurons) VALUES (?, ?) ON CONFLICT (day) DO UPDATE SET neurons = neurons + excluded.neurons WHERE neurons + excluded.neurons <= ?")
      .bind(day, cost, cap),
  ]);
  return (r.meta.changes ?? 0) > 0;
}

/** Give back what a reservation didn't use (no picture drawn). */
async function refund(db: SqlDb, day: string, cost: number): Promise<void> {
  await db.batch([db.prepare("UPDATE ai_budget SET neurons = max(0, neurons - ?) WHERE day = ?").bind(cost, day)]);
}

/** Of a picture's reservation, what the two short LLM calls (meaning, scene) cost; the rest is the drawing. */
const NEURONS_SCENE = 2;

function chatInput(model: string, messages: { role: string; content: string }[], maxTokens: number): Record<string, unknown> {
  const input: Record<string, unknown> = { messages, max_tokens: maxTokens, temperature: 0.3 };
  // Gemma 4 thinks by default: slower, and no better at one short scene.
  if (model.includes("gemma-4")) input.chat_template_kwargs = { enable_thinking: false };
  return input;
}

async function chat(ai: AiRunner, model: string, messages: { role: string; content: string }[], maxTokens: number): Promise<unknown> {
  const input = { ...chatInput(model, messages, maxTokens), response_format: { type: "json_object" } };
  const res = (await ai.run(model, input)) as {
    response?: unknown;
    choices?: { message?: { content?: unknown } }[];
  };
  return res.response ?? res.choices?.[0]?.message?.content;
}

/** The meaning (decided in code, else picked from the listed ones by the example), then a scene from word + meaning only. */
async function drawScene(ai: AiRunner, r: PictureRequest, model = SCENE_MODEL): Promise<{ sense: string; plan: Plan }> {
  const sense = senseFor(r) ?? parseSense(await chat(ai, model, senseMessages(r), 20), r);
  const reply = await chat(ai, model, sceneMessages(r, sense), 400);
  return { sense, plan: await checked(ai, model, r, sense, reply) };
}

/**
 * The plan from the scene LLM's reply; one that breaks a rule (digits for a
 * year, a lightbulb) is asked for once more; broken again, none.
 */
async function checked(ai: AiRunner, model: string, r: PictureRequest, sense: string, reply: unknown): Promise<Plan> {
  const plan = parsePlan(reply, sense, wants(r));
  const problem = planProblem(plan, sense);
  if (!problem) return plan;
  const text = typeof reply === "string" ? reply : JSON.stringify(reply);
  const again = parsePlan(await chat(ai, model, retryMessages(sceneMessages(r, sense), text, problem), 400).catch(() => null), sense, wants(r));
  // Broken twice: no picture beats a calendar for "year". Asked for by the user: the scene, or the first one.
  if (!planProblem(again, sense)) return again;
  if (!wants(r)) return { kind: "none" };
  return again.kind === "scene" ? again : plan.kind === "scene" ? plan : { kind: "scene", scene: `A simple everyday scene that shows ${sense}.` };
}

/** The user asked for this picture (a tap, or details): never answered with none. */
const wants = (r: PictureRequest) => !!r.always || !!r.details;

/** The scene LLM's reply streamed: `onText` gets all of it so far after each piece. Returns the whole reply. */
async function chatStream(ai: AiRunner, messages: { role: string; content: string }[], maxTokens: number, onText: (text: string) => void): Promise<string> {
  // No json_object here: with it the reply comes whole. The system prompt still asks for JSON.
  const stream = (await ai.run(SCENE_MODEL, { ...chatInput(SCENE_MODEL, messages, maxTokens), stream: true })) as ReadableStream<Uint8Array>;
  const reader = stream.getReader();
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

async function drawImage(ai: AiRunner, prompt: string): Promise<Uint8Array> {
  for (let attempt = 0; ; attempt++) {
    const form = new FormData();
    form.append("prompt", prompt);
    form.append("width", String(PICTURE_W));
    form.append("height", String(PICTURE_H));
    if (attempt) form.append("seed", String(1000 + attempt));
    const body = new Response(form);
    try {
      const res = (await ai.run(IMAGE_MODEL, { multipart: { body: body.body, contentType: body.headers.get("content-type") } })) as { image?: string };
      if (!res.image) throw new Error("no image in response");
      return Uint8Array.from(atob(res.image), (c) => c.charCodeAt(0));
    } catch (e) {
      if (attempt >= FLAG_RETRIES || !/3030|flagged/i.test(String(e))) throw e;
    }
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Local dev has no AI binding: a flat cut-paper-ish card with the scene text. */
function placeholder(word: string, sense: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${PICTURE_W}" height="${PICTURE_H}" viewBox="0 0 ${PICTURE_W} ${PICTURE_H}"><rect width="100%" height="100%" fill="#fdfcf8"/><circle cx="560" cy="170" r="110" fill="#e2a93a"/><path d="M0 380 Q200 300 400 370 T768 340 V512 H0Z" fill="#6f9470"/><path d="M0 440 Q260 390 520 450 T768 430 V512 H0Z" fill="#d0603f"/><text x="40" y="90" font-family="sans-serif" font-size="44" fill="#253126">${esc(word)}</text><text x="40" y="140" font-family="sans-serif" font-size="28" fill="#5f6d5f">${esc(sense)} (dev placeholder)</text></svg>`;
}

/** NDJSON answer: `run` writes lines with `send`; whatever it throws ends the answer with an error line. */
function ndjson(run: (send: (line: PictureLine) => Promise<void>) => Promise<void>): Response {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  const send = (line: PictureLine) => writer.write(enc.encode(JSON.stringify(line) + "\n"));
  void (async () => {
    try {
      await run(send);
    } catch (e) {
      await send({ error: `picture failed: ${e instanceof Error ? e.message : String(e)}` }).catch(() => {});
    } finally {
      await writer.close().catch(() => {});
    }
  })();
  return new Response(readable, { headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" } });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The streamed pipeline: meaning, the scene as it is written, the picture. */
function streamed(ai: AiRunner, r: PictureRequest, env: PictureEnv): Response {
  return ndjson(async (send) => {
    const sense = senseFor(r) ?? parseSense(await chat(ai, SCENE_MODEL, senseMessages(r), 20), r);
    await send({ sense });
    let shown = "";
    const reply = await chatStream(ai, sceneMessages(r, sense), 400, (text) => {
      const s = sceneSoFar(text);
      if (s.length > shown.length) void send({ scene: (shown = s) });
    });
    const plan = await checked(ai, SCENE_MODEL, r, sense, reply);
    if (plan.kind === "none") {
      await refund(env.DB, budgetDay((env.now ?? Date.now)()), NEURONS_PER_PICTURE - NEURONS_SCENE);
      return send({ none: true, sense });
    }
    const scene = plan.scene;
    if (scene !== shown) await send({ scene });
    const jpeg = await drawImage(ai, planPrompt(plan));
    const key = `pics/${crypto.randomUUID()}.jpg`;
    await env.MEDIA.put(key, jpeg, { httpMetadata: { contentType: "image/jpeg" } });
    await send({ key, sense, scene });
  });
}

async function placeholderPicture(r: PictureRequest, env: PictureEnv): Promise<{ key: string; sense: string; scene: string }> {
  const sense = senseFor(r) ?? meanings(r.translation)[0] ?? r.translation;
  const scene = parseScene(null, sense);
  const key = `pics/${crypto.randomUUID()}.svg`;
  await env.MEDIA.put(key, placeholder(r.word, sense), { httpMetadata: { contentType: "image/svg+xml" } });
  return { key, sense, scene };
}

async function create(request: Request, env: PictureEnv): Promise<Response> {
  const body = await request.json().catch(() => null);
  const r = parseRequest(body);
  if (!r) return json({ error: "word and translation are required" }, 400);
  const now = (env.now ?? Date.now)();
  const b = body as { scene_model?: unknown; scene_only?: unknown };
  if (!env.production && env.AI && b.scene_only === true) {
    const model = typeof b.scene_model === "string" && b.scene_model.startsWith("@cf/") ? b.scene_model : SCENE_MODEL;
    try {
      const { sense, plan } = await drawScene(env.AI, r, model);
      return json({ sense, ...plan });
    } catch (e) {
      return json({ error: `scene failed: ${e instanceof Error ? e.message : String(e)}` }, 502);
    }
  }
  const stream = (body as { stream?: unknown }).stream === true;
  // Local dev stands in for the scene model's "none" with a few grammar words, so the card editor's no-picture state shows.
  if (!env.AI && !r.always && !r.details && /^(but|of|the|however|although)$/i.test(senseFor(r) ?? "")) {
    const none = { none: true as const, sense: senseFor(r)! };
    if (!stream) return json(none);
    return ndjson(async (send) => {
      if (env.devDelay) await sleep(env.devDelay);
      await send(none);
    });
  }
  if (!env.AI) {
    if (!stream) return json(await placeholderPicture(r, env));
    // Streamed like a real picture: the scene word by word, the picture a while later.
    return ndjson(async (send) => {
      const p = await placeholderPicture(r, env);
      await send({ sense: p.sense });
      const delay = env.devDelay ?? 0;
      const words = p.scene.split(" ");
      for (let i = 1; i <= words.length; i++) {
        if (delay) await sleep(40);
        await send({ scene: words.slice(0, i).join(" ") });
      }
      if (delay) await sleep(delay);
      await send(p);
    });
  }
  if (!(await reserve(env.DB, budgetDay(now), NEURONS_PER_PICTURE, env.budget ?? DEFAULT_DAILY_NEURONS))) {
    const wait = secondsToReset(now);
    return new Response(JSON.stringify({ error: "daily picture limit reached", retry_after: wait }), {
      status: 429,
      headers: { "content-type": "application/json", "cache-control": "no-store", "retry-after": String(wait) },
    });
  }
  if (stream) return streamed(env.AI, r, env);
  try {
    const { sense, plan } = await drawScene(env.AI, r);
    if (plan.kind === "none") {
      await refund(env.DB, budgetDay(now), NEURONS_PER_PICTURE - NEURONS_SCENE);
      return json({ none: true, sense });
    }
    const scene = plan.scene;
    const jpeg = await drawImage(env.AI, planPrompt(plan));
    const key = `pics/${crypto.randomUUID()}.jpg`;
    await env.MEDIA.put(key, jpeg, { httpMetadata: { contentType: "image/jpeg" } });
    return json({ key, sense, scene });
  } catch (e) {
    return json({ error: `picture failed: ${e instanceof Error ? e.message : String(e)}` }, 502);
  }
}

async function media(key: string, env: PictureEnv): Promise<Response> {
  if (!KEY_RE.test(key)) return json({ error: "not found" }, 404);
  const obj = await env.MEDIA.get(key);
  if (!obj) return json({ error: "not found" }, 404);
  return new Response(obj.body, {
    headers: { "content-type": obj.httpMetadata?.contentType ?? "application/octet-stream", "cache-control": "public, max-age=31536000, immutable" },
  });
}

/** Handles /api/pictures and /api/media/*; null for any other path. */
export async function handlePictures(request: Request, env: PictureEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/api/media/")) return request.method === "GET" ? media(url.pathname.slice("/api/media/".length), env) : json({ error: "method not allowed" }, 405);
  if (url.pathname !== "/api/pictures") return null;
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
  const code = request.headers.get("x-user-code");
  if (!code || !isSyncCode(code)) return json({ error: "missing or invalid X-User-Code" }, 401);
  return create(request, env);
}
