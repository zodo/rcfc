// Filling in a card from the card editor: POST /api/fill (worker/fill.ts).
// Online only; answers are remembered for this run of the app, so going back
// to a word asks nothing. Past the daily AI limit it asks nothing until the reset.
import { askKey, type Fill, type FillRequest } from "./domain/fill";

export type FillResult = { ok: true; fill: Fill } | { ok: false; reason: "offline" | "limit" | "failed" };

export class Filler {
  /** How requests reach the API; tests route them to the Worker handler. */
  fetch: (url: string, init?: RequestInit) => Promise<Response> = (url, init) => fetch(url, init);
  now: () => number = Date.now;
  private known = new Map<string, Fill>();
  private pausedUntil = 0;

  constructor(private code: () => string) {}

  async fill(r: FillRequest): Promise<FillResult> {
    const key = askKey(r);
    const kept = this.known.get(key);
    if (kept) return { ok: true, fill: kept };
    if (this.pausedUntil > this.now()) return { ok: false, reason: "limit" };
    if (typeof navigator !== "undefined" && navigator.onLine === false) return { ok: false, reason: "offline" };
    let res: Response;
    try {
      res = await this.fetch("/api/fill", {
        method: "POST",
        headers: { "content-type": "application/json", "x-user-code": this.code() },
        body: JSON.stringify({ from: r.from, to: r.to, word: r.word, translation: r.translation }),
      });
    } catch {
      return { ok: false, reason: "offline" };
    }
    if (res.status === 429) {
      const body = (await res.json().catch(() => ({}))) as { retry_after?: number };
      this.pausedUntil = this.now() + (body.retry_after ?? 3600) * 1000;
      return { ok: false, reason: "limit" };
    }
    if (!res.ok) return { ok: false, reason: "failed" };
    const fill = (await res.json().catch(() => null)) as Fill | null;
    if (!fill || !Array.isArray(fill.options)) return { ok: false, reason: "failed" };
    if (fill.options.length) this.known.set(key, fill);
    return { ok: true, fill };
  }
}
