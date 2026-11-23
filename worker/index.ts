// API Worker. Static assets (the PWA) are served by the assets binding;
// only /api/* reaches this code (see run_worker_first in wrangler.jsonc).
import { isSyncCode } from "../src/domain/sync";

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

// ---------- sync (docs/design.md, "Sync") ----------
// The server is an ordered mailbox per user code: push appends events it has
// not seen, pull pages through them by server seq. It never interprets payloads.

export const PUSH_MAX = 500;
export const PULL_PAGE = 500;
const BODY_MAX = 2 * 1024 * 1024;
/** D1 allows 100 bound parameters per statement; 4 per row. */
const ROWS_PER_INSERT = 25;

interface WireEvent {
  event_id: string;
  type: string;
  ts: number;
  device_id: string;
  payload: unknown;
}

function validEvent(e: unknown): e is WireEvent {
  if (!e || typeof e !== "object") return false;
  const v = e as Record<string, unknown>;
  return (
    typeof v.event_id === "string" && v.event_id.length > 0 && v.event_id.length <= 64 &&
    typeof v.type === "string" && v.type.length > 0 && v.type.length <= 40 &&
    typeof v.ts === "number" && Number.isFinite(v.ts) &&
    typeof v.device_id === "string" && v.device_id.length <= 64 &&
    typeof v.payload === "object" && v.payload !== null
  );
}

function userCode(request: Request): string | null {
  const code = request.headers.get("x-user-code");
  return code && isSyncCode(code) ? code : null;
}

async function push(request: Request, env: Env, code: string): Promise<Response> {
  if (Number(request.headers.get("content-length") ?? 0) > BODY_MAX) return json({ error: "body too large" }, 413);
  const text = await request.text();
  if (text.length > BODY_MAX) return json({ error: "body too large" }, 413);
  let body: { events?: unknown };
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }
  const events = body.events;
  if (!Array.isArray(events)) return json({ error: "events must be an array" }, 400);
  if (events.length > PUSH_MAX) return json({ error: `at most ${PUSH_MAX} events per push` }, 413);
  if (!events.every(validEvent)) return json({ error: "malformed event" }, 400);
  if (!events.length) return json({ accepted: 0 });

  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < events.length; i += ROWS_PER_INSERT) {
    const chunk = events.slice(i, i + ROWS_PER_INSERT);
    const sql = `INSERT OR IGNORE INTO events (user_code, event_id, ts, body) VALUES ${chunk.map(() => "(?, ?, ?, ?)").join(", ")}`;
    const args = chunk.flatMap((e) => [code, e.event_id, Math.trunc(e.ts), JSON.stringify(e)]);
    stmts.push(env.DB.prepare(sql).bind(...args));
  }
  const results = await env.DB.batch(stmts);
  const accepted = results.reduce((n, r) => n + (r.meta.changes ?? 0), 0);
  return json({ accepted });
}

async function pull(url: URL, env: Env, code: string): Promise<Response> {
  const after = Math.max(0, Math.trunc(Number(url.searchParams.get("after") ?? 0)) || 0);
  const { results } = await env.DB.prepare("SELECT seq, body FROM events WHERE user_code = ? AND seq > ? ORDER BY seq LIMIT ?")
    .bind(code, after, PULL_PAGE + 1)
    .all<{ seq: number; body: string }>();
  const more = results.length > PULL_PAGE;
  const page = more ? results.slice(0, PULL_PAGE) : results;
  return json({
    events: page.map((r) => JSON.parse(r.body)),
    next: page.length ? page[page.length - 1].seq : after,
    more,
  });
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/health") return health(env);
    if (url.pathname === "/api/sync/push" || url.pathname === "/api/sync/pull") {
      const code = userCode(request);
      if (!code) return json({ error: "missing or invalid X-User-Code" }, 401);
      if (url.pathname === "/api/sync/push") return request.method === "POST" ? push(request, env, code) : json({ error: "method not allowed" }, 405);
      return request.method === "GET" ? pull(url, env, code) : json({ error: "method not allowed" }, 405);
    }
    return json({ error: "not found" }, 404);
  },
} satisfies ExportedHandler<Env>;
