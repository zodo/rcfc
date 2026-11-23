// API Worker. Static assets (the PWA) are served by the assets binding;
// only /api/* reaches this code (see run_worker_first in wrangler.jsonc).

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

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
  return json({ ok, env: env.APP_ENV, version: env.CF_VERSION_METADATA?.id ?? null, checks }, ok ? 200 : 500);
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/health") return health(env);
    return json({ error: "not found" }, 404);
  },
} satisfies ExportedHandler<Env>;
