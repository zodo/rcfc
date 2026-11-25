// Pictures API. POST /api/pictures draws one card picture (scene LLM →
// FLUX.2 klein 4B), stores it in R2 and returns its key; the client records it
// as an `asset_attached` event. GET /api/media/<key> serves stored pictures.
//
// Spending is capped per UTC day in D1 (ai_budget) below the free Workers AI
// allocation: past the cap the API answers 429 with Retry-After, never a bill.
// Without an AI binding (local dev) it draws a placeholder instead.
import { budgetDay, DEFAULT_DAILY_NEURONS, IMAGE_MODEL, imagePrompt, MAX_DETAILS, meanings, NEURONS_PER_PICTURE, parseScene, parseSense, PICTURE_H, PICTURE_W, SCENE_MODEL, sceneMessages, secondsToReset, senseFor, senseMessages, type PictureRequest } from "../src/domain/pictures";
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
  return { word, translation, example: str(b.example, MAX_FIELD), sense: str(b.sense, 100), details: str(b.details, MAX_DETAILS) };
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

async function chat(ai: AiRunner, messages: { role: string; content: string }[], maxTokens: number): Promise<unknown> {
  const res = (await ai.run(SCENE_MODEL, { messages, response_format: { type: "json_object" }, max_tokens: maxTokens, temperature: 0.3 })) as {
    response?: unknown;
    choices?: { message?: { content?: unknown } }[];
  };
  return res.response ?? res.choices?.[0]?.message?.content;
}

/** The meaning (decided in code, else picked from the listed ones by the example), then a scene from word + meaning only. */
async function drawScene(ai: AiRunner, r: PictureRequest): Promise<{ sense: string; scene: string }> {
  const sense = senseFor(r) ?? parseSense(await chat(ai, senseMessages(r), 20), r);
  return { sense, scene: parseScene(await chat(ai, sceneMessages(r, sense), 400), sense) };
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

async function create(request: Request, env: PictureEnv): Promise<Response> {
  const body = await request.json().catch(() => null);
  const r = parseRequest(body);
  if (!r) return json({ error: "word and translation are required" }, 400);
  const now = (env.now ?? Date.now)();
  if (!env.AI) {
    const sense = senseFor(r) ?? meanings(r.translation)[0] ?? r.translation;
    const scene = parseScene(null, sense);
    const key = `pics/${crypto.randomUUID()}.svg`;
    await env.MEDIA.put(key, placeholder(r.word, sense), { httpMetadata: { contentType: "image/svg+xml" } });
    return json({ key, sense, scene });
  }
  if (!(await reserve(env.DB, budgetDay(now), NEURONS_PER_PICTURE, env.budget ?? DEFAULT_DAILY_NEURONS))) {
    const wait = secondsToReset(now);
    return new Response(JSON.stringify({ error: "daily picture limit reached", retry_after: wait }), {
      status: 429,
      headers: { "content-type": "application/json", "cache-control": "no-store", "retry-after": String(wait) },
    });
  }
  try {
    const { sense, scene } = await drawScene(env.AI, r);
    const jpeg = await drawImage(env.AI, imagePrompt(scene));
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
