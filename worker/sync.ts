// Sync API (docs/design.md, "Sync"). The server is an ordered mailbox per user
// code: push appends events it has not seen, pull pages through them by server
// seq. It never interprets payloads (the Claude connector does, worker/mcp.ts:
// it reads and appends through `loadEvents` / `appendEvents`).
//
// Written against the small slice of D1 it uses (`SqlDb`), so tests run it on
// bun:sqlite with the real migrations (test/support/d1.ts).
import { isSyncCode, PULL_PAGE, PUSH_MAX } from "../src/domain/sync";

export interface SqlStatement {
  bind(...values: unknown[]): SqlStatement;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
}
export interface SqlDb {
  prepare(sql: string): SqlStatement;
  batch(statements: SqlStatement[]): Promise<{ meta: { changes?: number } }[]>;
}

const BODY_MAX = 2 * 1024 * 1024;
/** D1 allows 100 bound parameters per statement; 4 per row. */
const ROWS_PER_INSERT = 25;

export const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

export interface WireEvent {
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

async function push(request: Request, db: SqlDb, code: string): Promise<Response> {
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

  return json({ accepted: await appendEvents(db, code, events) });
}

/** Store events for a user (those it has already are skipped); returns how many were new. */
export async function appendEvents(db: SqlDb, code: string, events: WireEvent[]): Promise<number> {
  const stmts: SqlStatement[] = [];
  for (let i = 0; i < events.length; i += ROWS_PER_INSERT) {
    const chunk = events.slice(i, i + ROWS_PER_INSERT);
    const sql = `INSERT OR IGNORE INTO events (user_code, event_id, ts, body) VALUES ${chunk.map(() => "(?, ?, ?, ?)").join(", ")}`;
    const args = chunk.flatMap((e) => [code, e.event_id, Math.trunc(e.ts), JSON.stringify(e)]);
    stmts.push(db.prepare(sql).bind(...args));
  }
  if (!stmts.length) return 0;
  const results = await db.batch(stmts);
  return results.reduce((n, r) => n + (r.meta.changes ?? 0), 0);
}

/** Every event of a user, in server order (the worker's own reads: the connector, worker/mcp.ts). */
export async function loadEvents(db: SqlDb, code: string): Promise<unknown[]> {
  const out: unknown[] = [];
  const PAGE = 5000;
  for (let after = 0; ; ) {
    const { results } = await db.prepare("SELECT seq, body FROM events WHERE user_code = ? AND seq > ? ORDER BY seq LIMIT ?").bind(code, after, PAGE).all<{ seq: number; body: string }>();
    for (const r of results) out.push(JSON.parse(r.body));
    if (results.length < PAGE) return out;
    after = results[results.length - 1].seq;
  }
}

async function pull(url: URL, db: SqlDb, code: string): Promise<Response> {
  const after = Math.max(0, Math.trunc(Number(url.searchParams.get("after") ?? 0)) || 0);
  const { results } = await db
    .prepare("SELECT seq, body FROM events WHERE user_code = ? AND seq > ? ORDER BY seq LIMIT ?")
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

/** Handles /api/sync/push and /api/sync/pull; null for any other path. */
export async function handleSync(request: Request, db: SqlDb): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/api/sync/push" && url.pathname !== "/api/sync/pull") return null;
  const code = request.headers.get("x-user-code");
  if (!code || !isSyncCode(code)) return json({ error: "missing or invalid X-User-Code" }, 401);
  if (url.pathname === "/api/sync/push") return request.method === "POST" ? push(request, db, code) : json({ error: "method not allowed" }, 405);
  return request.method === "GET" ? pull(url, db, code) : json({ error: "method not allowed" }, 405);
}
