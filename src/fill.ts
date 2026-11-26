// Filling in a card from the card editor: POST /api/fill (worker/fill.ts).
// Online only; answers are remembered for this run of the app, so going back
// to a word asks nothing. Past the daily AI limit it asks nothing until the reset.
// Streamed: `onFirst` gets the first option as its places are written out, so
// the pencil can write the translation before the rest of the answer comes.
import { askKey, type Fill, type FillLine, type FillOption, type FillRequest } from "./domain/fill";
import { takeLines } from "./domain/pictures";

export type FillResult = { ok: true; fill: Fill } | { ok: false; reason: "offline" | "limit" | "failed" };

export class Filler {
  /** How requests reach the API; tests route them to the Worker handler. */
  fetch: (url: string, init?: RequestInit) => Promise<Response> = (url, init) => fetch(url, init);
  now: () => number = Date.now;
  private known = new Map<string, Fill>();
  private pausedUntil = 0;

  constructor(private code: () => string) {}

  async fill(r: FillRequest, onFirst?: (first: Partial<FillOption>) => void): Promise<FillResult> {
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
        body: JSON.stringify({ from: r.from, to: r.to, word: r.word, translation: r.translation, stream: true }),
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
    const fill = await this.read(res, onFirst).catch(() => null);
    if (!fill || !Array.isArray(fill.options)) return { ok: false, reason: "failed" };
    if (fill.options.length) this.known.set(key, fill);
    return { ok: true, fill };
  }

  /** The streamed lines: the first option as it comes, then the whole fill (or none: failed). */
  private async read(res: Response, onFirst?: (first: Partial<FillOption>) => void): Promise<Fill | null> {
    if (!res.body || !res.headers.get("content-type")?.includes("ndjson")) return (await res.json()) as Fill;
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (value) buf += dec.decode(value, { stream: !done });
      const { lines, rest } = takeLines(done ? buf + "\n" : buf);
      buf = rest;
      for (const l of lines) {
        let line: FillLine;
        try {
          line = JSON.parse(l) as FillLine;
        } catch {
          continue;
        }
        if ("first" in line) onFirst?.(line.first);
        else if ("fill" in line) return line.fill;
        else return null;
      }
      if (done) return null;
    }
  }
}
