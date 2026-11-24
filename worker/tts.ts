// Spoken audio. GET /api/tts?lang=es&text=… answers an MP3 of the text in that
// language's voice: from R2 when it was made before, else made once by Azure
// Speech and kept. Characters sent to Azure are capped per UTC month in D1
// (tts_budget) below the free tier: past it the API answers 429, never a bill.
// Without a key (local dev) it answers 404 and the app uses the browser voice.
import { isSyncCode } from "../src/domain/sync";
import { audioKey, AUDIO_FORMAT, budgetMonth, DEFAULT_TTS_CHARS_PER_MONTH, MAX_TTS_TEXT, spokenText, ssml, voiceFor } from "../src/domain/tts";
import type { BlobStore } from "./pictures";
import { json, type SqlDb } from "./sync";

export interface TtsEnv {
  DB: SqlDb;
  MEDIA: BlobStore;
  AZURE_SPEECH_KEY?: string;
  AZURE_SPEECH_REGION?: string;
  /** Monthly character cap (default DEFAULT_TTS_CHARS_PER_MONTH). */
  budget?: number;
  now?: () => number;
  /** How requests reach Azure; tests stub it. */
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
}

const AUDIO_HEADERS = { "content-type": "audio/mpeg", "cache-control": "private, max-age=31536000, immutable" };

/** Reserve characters for one text; false when this month's cap would be exceeded. */
async function reserve(db: SqlDb, month: string, chars: number, cap: number): Promise<boolean> {
  const [r] = await db.batch([
    db
      .prepare("INSERT INTO tts_budget (month, chars) VALUES (?, ?) ON CONFLICT (month) DO UPDATE SET chars = chars + excluded.chars WHERE chars + excluded.chars <= ?")
      .bind(month, chars, cap),
  ]);
  return (r.meta.changes ?? 0) > 0;
}

async function speak(url: URL, env: TtsEnv): Promise<Response> {
  const text = spokenText(url.searchParams.get("text") ?? "");
  const voice = voiceFor(url.searchParams.get("lang") ?? "");
  if (!text || text.length > MAX_TTS_TEXT) return json({ error: `text of 1 to ${MAX_TTS_TEXT} characters is required` }, 400);
  if (!voice) return json({ error: "no voice for this language" }, 404);
  const key = await audioKey(text, voice);
  const stored = await env.MEDIA.get(key);
  if (stored) return new Response(stored.body, { headers: AUDIO_HEADERS });
  if (!env.AZURE_SPEECH_KEY) return json({ error: "no voice service" }, 404);
  const now = (env.now ?? Date.now)();
  if (!(await reserve(env.DB, budgetMonth(now), text.length, env.budget ?? DEFAULT_TTS_CHARS_PER_MONTH))) return json({ error: "monthly voice limit reached" }, 429);
  const res = await (env.fetch ?? fetch)(`https://${env.AZURE_SPEECH_REGION ?? "westeurope"}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: "POST",
    headers: { "Ocp-Apim-Subscription-Key": env.AZURE_SPEECH_KEY, "content-type": "application/ssml+xml", "x-microsoft-outputformat": AUDIO_FORMAT, "user-agent": "rcfc" },
    body: ssml(text, voice),
  });
  if (!res.ok) return json({ error: `voice service failed (${res.status})` }, 502);
  const mp3 = new Uint8Array(await res.arrayBuffer());
  await env.MEDIA.put(key, mp3, { httpMetadata: { contentType: "audio/mpeg" } });
  return new Response(mp3, { headers: AUDIO_HEADERS });
}

/** Handles /api/tts; null for any other path. */
export async function handleTts(request: Request, env: TtsEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/api/tts") return null;
  if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
  const code = request.headers.get("x-user-code");
  if (!code || !isSyncCode(code)) return json({ error: "missing or invalid X-User-Code" }, 401);
  return speak(url, env);
}
