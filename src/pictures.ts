// Card pictures on the client: a persistent queue of pictures to draw, run
// against POST /api/pictures while online, and a local copy of every picture
// for offline study (IndexedDB, via Store).
//
// When pictures are queued:
// - a typed word: right after it is added (the add screen shows it arriving);
// - any other word without one (imports, words from other devices): the first
//   time it is shown in study, so pictures fill in gradually as you practice;
// - a redraw the user asked for, with their meaning and details.
// A word whose picture the user removed is never drawn automatically.
import type { AssetAttached } from "./domain/events";
import type { EntityId } from "./domain/ids";
import { flattenPaper } from "./domain/paper";
import type { PicBlob, PicJob, Store } from "./store";

export type PicState = "queued" | "drawing" | "waiting" | "failed";

const MAX_TRIES = 5;
const JPEG_QUALITY = 0.82;
/** Bump when downloaded pictures should be processed again. */
export const BLOB_VERSION = 3;

export interface Prepared {
  data: ArrayBuffer;
  type: string;
  flat: boolean;
}

export interface PictureView {
  url: string;
  /** White paper background: blend into the card instead of framing it. */
  flat: boolean;
}

export interface DrawOptions {
  sense?: string;
  details?: string;
}

/** Cards per pile whose pictures are drawn ahead, so they are there when the card comes up (offline too). */
export const AHEAD = 10;

/** Which job is drawn first: redraws, then pictures needed now, then ones drawn ahead. */
function rank(j: PicJob): number {
  return j.force ? 2 : j.ahead ? 0 : 1;
}

export class Pictures {
  /** How requests reach the API; tests route them to the Worker handler. */
  fetch: (url: string, init?: RequestInit) => Promise<Response> = (url, init) => fetch(url, init);
  /** Process downloaded pictures before storing (browser: white paper, smaller JPEG). */
  prepare: (data: ArrayBuffer, type: string) => Promise<Prepared> = browserPrepare;
  now: () => number = Date.now;

  private jobs = new Map<EntityId, PicJob>();
  private states = new Map<EntityId, PicState>();
  private listeners = new Set<(noteId: EntityId) => void>();
  private urls = new Map<string, PictureView>();
  private haveBlobs: Set<string> | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private prefetching: Promise<void> | null = null;
  /** The server's daily limit was hit: no requests before this (ms epoch). */
  pausedUntil = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  private constructor(
    private store: Store,
    private code: () => string,
  ) {}

  static async open(store: Store, code: () => string): Promise<Pictures> {
    const p = new Pictures(store, code);
    for (const j of await store.picJobs()) {
      p.jobs.set(j.note_id, j);
      p.states.set(j.note_id, "queued");
    }
    return p;
  }

  /** Start background work: drawing queued pictures and downloading missing ones. */
  start(): void {
    window.addEventListener("online", () => {
      this.kick();
      void this.prefetch();
    });
    this.kick();
    void this.prefetch();
  }

  /** Stop the retry timer (tests). */
  stop(): void {
    clearTimeout(this.timer);
  }

  /** Called with a note id whenever its picture or picture state changes. Returns an unsubscribe. */
  subscribe(f: (noteId: EntityId) => void): () => void {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  }

  private emit(noteId: EntityId) {
    for (const f of this.listeners) f(noteId);
  }

  private setState(noteId: EntityId, s: PicState | undefined) {
    if (s) this.states.set(noteId, s);
    else this.states.delete(noteId);
    this.emit(noteId);
  }

  state(noteId: EntityId): PicState | undefined {
    return this.states.get(noteId);
  }

  /**
   * Queue a picture for a note that has none (no-op if it has one or was
   * removed). `ahead`: for a card coming up, drawn after pictures needed now;
   * needed now, a job queued ahead moves up.
   */
  async ensure(noteId: EntityId, ahead = false): Promise<void> {
    const n = this.store.col.liveNote(noteId);
    if (!n || n.picture || n.noPicture) return;
    const queued = this.jobs.get(noteId);
    if (queued) {
      if (queued.ahead && !ahead) {
        queued.ahead = false;
        await this.store.putPicJob(queued);
        this.kick();
      }
      return;
    }
    await this.enqueue({ note_id: noteId, tries: 0, not_before: 0, created: this.now(), ...(ahead ? { ahead } : {}) });
  }

  /** Queue pictures for cards coming up next (src/session.ts upcoming), in that order. */
  async ahead(cardIds: Iterable<EntityId>): Promise<void> {
    for (const id of cardIds) {
      const c = this.store.col.cards.get(id);
      if (c) await this.ensure(c.note_id, true);
    }
  }

  /** Draw (or redraw) a note's picture with the user's meaning and details. */
  async draw(noteId: EntityId, o: DrawOptions = {}): Promise<void> {
    const sense = o.sense?.trim() || undefined;
    const details = o.details?.trim() || undefined;
    await this.enqueue({ note_id: noteId, sense, details, force: true, tries: 0, not_before: 0, created: this.now() });
  }

  /** Remove a note's picture; it will not be drawn again automatically. */
  async remove(noteId: EntityId): Promise<void> {
    this.jobs.delete(noteId);
    await this.store.deletePicJob(noteId);
    await this.store.append([this.store.factory.make<AssetAttached>("asset_attached", { note_id: noteId, kind: "image", r2_key: null })]);
    this.setState(noteId, undefined);
  }

  private async enqueue(j: PicJob) {
    this.jobs.set(j.note_id, j);
    await this.store.putPicJob(j);
    this.setState(j.note_id, this.pausedUntil > this.now() ? "waiting" : "queued");
    this.kick();
  }

  /** Process the queue now; concurrent calls coalesce. Resolves when the queue is idle. */
  kick(): Promise<void> {
    this.again = true;
    // Checking for another round and stopping happen in one step, so a kick near the end is never lost.
    this.running ??= (async () => {
      try {
        while (this.again) {
          this.again = false;
          await this.runQueue();
        }
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  private nextJob(): PicJob | undefined {
    const now = this.now();
    let best: PicJob | undefined;
    for (const j of this.jobs.values()) {
      if (j.not_before > now || this.states.get(j.note_id) === "failed") continue;
      // Pictures the user is waiting for (redraws, then typed or shown words) go first, cards coming up last; else oldest first.
      if (!best || rank(j) > rank(best) || (rank(j) === rank(best) && j.created < best.created)) best = j;
    }
    return best;
  }

  private async runQueue(): Promise<void> {
    clearTimeout(this.timer);
    for (;;) {
      if (typeof navigator !== "undefined" && navigator.onLine === false) return;
      if (this.pausedUntil > this.now()) return this.retryAt(this.pausedUntil);
      const j = this.nextJob();
      if (!j) {
        const later = [...this.jobs.values()].filter((x) => this.states.get(x.note_id) !== "failed").map((x) => x.not_before);
        if (later.length) this.retryAt(Math.min(...later));
        return;
      }
      const n = this.store.col.liveNote(j.note_id);
      if (!n || (!j.force && (n.picture || n.noPicture))) {
        await this.finish(j.note_id);
        continue;
      }
      this.setState(j.note_id, "drawing");
      let res: Response;
      try {
        res = await this.fetch("/api/pictures", {
          method: "POST",
          headers: { "content-type": "application/json", "x-user-code": this.code() },
          body: JSON.stringify({ word: n.fields.front, translation: n.fields.back, example: n.fields.example, sense: j.sense, details: j.details }),
        });
      } catch {
        this.setState(j.note_id, "queued"); // offline: retried on reconnect
        return this.retryAt(this.now() + 60_000);
      }
      if (res.status === 429) {
        const body = (await res.json().catch(() => ({}))) as { retry_after?: number };
        this.pausedUntil = this.now() + (body.retry_after ?? 3600) * 1000;
        for (const id of this.jobs.keys()) this.setState(id, "waiting");
        continue;
      }
      if (!res.ok) {
        j.tries++;
        j.not_before = this.now() + 60_000 * 2 ** j.tries;
        await this.store.putPicJob(j);
        this.setState(j.note_id, j.tries >= MAX_TRIES ? "failed" : "queued");
        continue;
      }
      const { key, sense, scene } = (await res.json()) as { key: string; sense: string; scene: string };
      // Keep the picture for offline use before it appears anywhere.
      await this.download(key).catch(() => {});
      // Edited away while drawing: drop the result.
      if (this.jobs.get(j.note_id) !== j) continue;
      if (this.store.col.liveNote(j.note_id)) {
        await this.store.append([this.store.factory.make<AssetAttached>("asset_attached", { note_id: j.note_id, kind: "image", r2_key: key, sense, details: j.details, scene })]);
      }
      await this.finish(j.note_id);
    }
  }

  private async finish(noteId: EntityId) {
    this.jobs.delete(noteId);
    await this.store.deletePicJob(noteId);
    this.setState(noteId, undefined);
  }

  private retryAt(t: number) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.kick(), Math.max(1000, Math.min(t - this.now(), 6 * 3600_000)));
  }

  /** Give a failed picture another go. */
  async retry(noteId: EntityId): Promise<void> {
    const j = this.jobs.get(noteId);
    if (!j) return;
    j.tries = 0;
    j.not_before = 0;
    await this.store.putPicJob(j);
    this.setState(noteId, "queued");
    this.kick();
  }

  private current(b: PicBlob | undefined): b is PicBlob {
    return !!b && b.v === BLOB_VERSION;
  }

  private async download(key: string): Promise<void> {
    if (this.haveBlobs?.has(key) || this.current(await this.store.getPicBlob(key))) return;
    const res = await this.fetch(`/api/media/${key}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = res.headers.get("content-type") ?? "image/jpeg";
    const ready = await this.prepare(await res.arrayBuffer(), type);
    await this.store.putPicBlob({ key, ...ready, v: BLOB_VERSION });
    this.haveBlobs?.add(key);
  }

  /** Download every picture not stored yet (pictures drawn on other devices, a fresh install). */
  prefetch(): Promise<void> {
    if (this.prefetching) return this.prefetching;
    this.prefetching = (async () => {
      this.haveBlobs ??= await this.store.picBlobKeys(BLOB_VERSION);
      for (const n of this.store.col.liveNotes()) {
        const key = n.picture?.key;
        if (!key || this.haveBlobs.has(key)) continue;
        if (typeof navigator !== "undefined" && navigator.onLine === false) return;
        try {
          await this.download(key);
        } catch {
          return; // offline or server trouble: next time
        }
      }
    })().finally(() => (this.prefetching = null));
    return this.prefetching;
  }

  /** A stored picture as an object URL, downloading it first if needed; undefined if unavailable. */
  async view(key: string): Promise<PictureView | undefined> {
    const cached = this.urls.get(key);
    if (cached) return cached;
    let b = await this.store.getPicBlob(key);
    if (!this.current(b)) {
      try {
        await this.download(key);
      } catch {
        return undefined;
      }
      b = await this.store.getPicBlob(key);
      if (!b) return undefined;
    }
    const view = { url: URL.createObjectURL(new Blob([b.data], { type: b.type })), flat: !!b.flat };
    this.urls.set(key, view);
    return view;
  }
}

/** Whiten the paper background (if the picture has one) and re-encode as a smaller JPEG. */
async function browserPrepare(data: ArrayBuffer, type: string): Promise<Prepared> {
  if (type !== "image/jpeg" || typeof createImageBitmap === "undefined" || typeof document === "undefined") return { data, type, flat: false };
  try {
    const bmp = await createImageBitmap(new Blob([data], { type }));
    const c = document.createElement("canvas");
    c.width = bmp.width;
    c.height = bmp.height;
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    const img = ctx.getImageData(0, 0, c.width, c.height);
    const flat = flattenPaper(img.data, c.width, c.height);
    if (flat) ctx.putImageData(img, 0, 0);
    const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/jpeg", JPEG_QUALITY));
    if (!blob) return { data, type, flat: false };
    return { data: await blob.arrayBuffer(), type: "image/jpeg", flat };
  } catch {
    return { data, type, flat: false };
  }
}
