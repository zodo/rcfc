// A word's notes on the client (src/domain/summary.ts). They come from POST
// /api/summary (written once by an LLM and kept on the server for anyone,
// worker/summary.ts) and are downloaded ahead for the cards coming up, like
// spoken audio, then kept in IndexedDB so the card shows them at once, offline
// too. Not in the event log: the same words always get the same notes, so
// every device can fetch them, and a word edited gets new ones.
//
// Written in the studied language unless the user switched that language's
// notes to the known one (per device, from the zoomed page).
import type { EntityId } from "./domain/ids";
import type { Note } from "./domain/collection";
import { summaryRequestOk, summaryText, type Summary, type SummaryRequest } from "./domain/summary";
import type { Store } from "./store";

const LANG_KEY = "rcfc:notes-in:";

export class Summaries {
  fetch: (url: string, init?: RequestInit) => Promise<Response> = (url, init) => fetch(url, init);
  online: () => boolean = () => typeof navigator === "undefined" || navigator.onLine !== false;
  now: () => number = Date.now;

  private have = new Set<string>();
  /** Words the server could make no notes for this run (bad request, failed twice). */
  private failed = new Map<string, number>();
  /** The server's daily AI limit was hit: no requests before this (ms epoch). */
  private pausedUntil = 0;
  private queue = new Map<string, SummaryRequest>();
  private running: Promise<void> | null = null;
  /** In-flight requests, so the card and the queue never ask twice. */
  private inflight = new Map<string, Promise<Summary | null>>();

  private constructor(
    private store: Store,
    private code: () => string,
  ) {}

  static async open(store: Store, code: () => string): Promise<Summaries> {
    const s = new Summaries(store, code);
    for (const k of await store.summaryKeys()) s.have.add(k);
    return s;
  }

  /** The language a studied language's notes are written in on this device. */
  langFor(note: Note): string {
    const { from, to } = note.lang_pair;
    try {
      return localStorage.getItem(LANG_KEY + from) === to ? to : from;
    } catch {
      return from;
    }
  }

  /** Write this studied language's notes in `lang` from now on (this device). */
  setLang(note: Note, lang: string): void {
    try {
      localStorage.setItem(LANG_KEY + note.lang_pair.from, lang);
    } catch {
      /* this time only */
    }
  }

  request(note: Note, lang = this.langFor(note)): SummaryRequest | null {
    const r = { from: note.lang_pair.from, to: note.lang_pair.to, in: lang, word: note.fields.front, translation: note.fields.back };
    return summaryRequestOk(r) ? r : null;
  }

  /** The notes kept on this device, without asking the server. */
  async stored(note: Note, lang?: string): Promise<Summary | null> {
    const r = this.request(note, lang);
    if (!r) return null;
    const k = summaryText(r);
    return this.have.has(k) ? ((await this.store.getSummary(k))?.summary ?? null) : null;
  }

  /** The notes: kept ones at once, else asked for (online), kept and returned; null when there are none to be had. */
  async get(note: Note, lang?: string): Promise<Summary | null> {
    const r = this.request(note, lang);
    if (!r) return null;
    return (await this.stored(note, lang)) ?? this.download(r);
  }

  /** Download the notes of these cards' words, for when they come up. */
  ahead(cardIds: Iterable<EntityId>): Promise<void> {
    const { col } = this.store;
    for (const id of cardIds) {
      const note = col.notes.get(col.cards.get(id)?.note_id ?? 0);
      const r = note && this.request(note);
      if (r && !this.have.has(summaryText(r))) this.queue.set(summaryText(r), r);
    }
    return this.run();
  }

  private run(): Promise<void> {
    this.running ??= (async () => {
      try {
        for (const [k, r] of this.queue) {
          if (!this.online() || this.now() < this.pausedUntil) break;
          this.queue.delete(k);
          await this.download(r);
        }
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  private download(r: SummaryRequest): Promise<Summary | null> {
    const k = summaryText(r);
    const busy = this.inflight.get(k);
    if (busy) return busy;
    if (!this.online() || this.now() < this.pausedUntil || (this.failed.get(k) ?? 0) >= 2) return Promise.resolve(null);
    const p = (async () => {
      try {
        const res = await this.fetch("/api/summary", { method: "POST", headers: { "content-type": "application/json", "x-user-code": this.code() }, body: JSON.stringify(r) });
        if (res.ok) {
          const summary = (await res.json()) as Summary;
          await this.store.putSummary({ key: k, summary });
          this.have.add(k);
          return summary;
        }
        if (res.status === 429) {
          const wait = Number(((await res.json().catch(() => ({}))) as { retry_after?: number }).retry_after) || 3600;
          this.pausedUntil = this.now() + wait * 1000;
        } else this.failed.set(k, (this.failed.get(k) ?? 0) + (res.status === 400 ? 2 : 1));
      } catch {
        // offline or the request broke: asked again when the word comes up
      } finally {
        this.inflight.delete(k);
      }
      return null;
    })();
    this.inflight.set(k, p);
    return p;
  }
}
