// API Worker. Static assets (the PWA) are served by the assets binding;
// only /api/* reaches this code (see run_worker_first in wrangler.jsonc).
import { handleFill } from "./fill";
import { handlePictures, type AiRunner } from "./pictures";
import { handleSync, json } from "./sync";
import { handleTts } from "./tts";

async function health(env: Env): Promise<Response> {
  const checks: Record<string, string> = {};
  let ok = true;
  try {
    const row = await env.DB.prepare("SELECT count(*) AS n FROM events").first<{ n: number }>();
    checks.d1 = `ok (${row?.n ?? 0} events)`;
  } catch (e) {
    ok = false;
    checks.d1 = `error: ${(e as Error).message}`;
  }
  try {
    const key = "_health/ping";
    const stamp = String(Date.now());
    await env.MEDIA.put(key, stamp);
    const back = await (await env.MEDIA.get(key))?.text();
    if (back !== stamp) throw new Error("read-back mismatch");
    checks.r2 = "ok";
  } catch (e) {
    ok = false;
    checks.r2 = `error: ${(e as Error).message}`;
  }
  checks.ai = "AI" in env ? "bound" : "not bound";
  checks.tts = (env as { AZURE_SPEECH_KEY?: string }).AZURE_SPEECH_KEY ? "key set" : "no key (browser voice)";
  return json({ ok, env: env.APP_ENV, version: env.CF_VERSION_METADATA?.id ?? null, checks }, ok ? 200 : 500);
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/health") return health(env);
    const budget = Number(env.PICTURE_NEURONS_PER_DAY) || undefined;
    return (
      (await handleSync(request, env.DB)) ??
      (await handlePictures(request, { DB: env.DB, MEDIA: env.MEDIA, AI: env.AI as AiRunner | undefined, budget, production: env.APP_ENV === "production", devDelay: env.APP_ENV === "dev" ? Number((env as { DEV_PICTURE_DELAY_MS?: string }).DEV_PICTURE_DELAY_MS ?? 900) : 0 })) ??
      (await handleFill(request, { DB: env.DB, MEDIA: env.MEDIA, AI: env.AI as AiRunner | undefined, budget, production: env.APP_ENV === "production", devDelay: env.APP_ENV === "dev" ? Number((env as { DEV_FILL_DELAY_MS?: string }).DEV_FILL_DELAY_MS ?? 900) : 0 })) ??
      (await handleTts(request, { DB: env.DB, MEDIA: env.MEDIA, AZURE_SPEECH_KEY: (env as { AZURE_SPEECH_KEY?: string }).AZURE_SPEECH_KEY, AZURE_SPEECH_REGION: env.AZURE_SPEECH_REGION, budget: Number(env.TTS_CHARS_PER_MONTH) || undefined })) ??
      json({ error: "not found" }, 404)
    );
  },
} satisfies ExportedHandler<Env>;
