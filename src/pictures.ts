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
import type { PicJob, Store } from "./store";

export type PicState = "queued" | "drawing" | "waiting" | "failed";

const MAX_TRIES = 5;
const JPEG_QUALITY = 0.8;

export interface DrawOptions {
  sense?: string;
  details?: string;
}

export class Pictures {
  /** How requests reach the API; tests route them to the Worker handler. */
  fetch: (url: string, init?: RequestInit) => Promise<Response> = (url, init) => fetch(url, init);
  /** Re-encode downloaded pictures before storing (browser: smaller JPEG). */
  compress: (data: ArrayBuffer, type: string) => Promise<{ data: ArrayBuffer; type: string }> = browserCompress;
  now: () => number = Date.now;

  private jobs = new Map<EntityId, PicJob>();
  private states = new Map<EntityId, PicState>();
  private listeners = new Set<(noteId: EntityId) => void>();
  private urls = new Map<string, string>();
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

  /** Queue a picture for a note that has none (no-op if it has one, was removed, or is queued). */
  async ensure(noteId: EntityId): Promise<void> {
    const n = this.store.col.liveNote(noteId);
    if (!n || n.picture || n.noPicture || this.jobs.has(noteId)) return;
    await this.enqueue({ note_id: noteId, tries: 0, not_before: 0, created: this.now() });
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
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        await this.runQueue();
      } while (this.again);
    })().finally(() => (this.running = null));
    return this.running;
  }

  private nextJob(): PicJob | undefined {
    const now = this.now();
    let best: PicJob | undefined;
    for (const j of this.jobs.values()) {
      if (j.not_before > now || this.states.get(j.note_id) === "failed") continue;
      // Pictures the user is waiting for (typed words, redraws) go first.
      if (!best || (j.force ?? false) > (best.force ?? false) || (j.force === best.force && j.created < best.created)) best = j;
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

  private async download(key: string): Promise<void> {
    if (this.haveBlobs?.has(key) || (await this.store.getPicBlob(key))) return;
    const res = await this.fetch(`/api/media/${key}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = res.headers.get("content-type") ?? "image/jpeg";
    const small = await this.compress(await res.arrayBuffer(), type);
    await this.store.putPicBlob({ key, ...small });
    this.haveBlobs?.add(key);
  }

  /** Download every picture not stored yet (pictures drawn on other devices, a fresh install). */
  prefetch(): Promise<void> {
    if (this.prefetching) return this.prefetching;
    this.prefetching = (async () => {
      this.haveBlobs ??= await this.store.picBlobKeys();
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

  /** An object URL for a stored picture, downloading it first if needed; undefined if unavailable. */
  async url(key: string): Promise<string | undefined> {
    const cached = this.urls.get(key);
    if (cached) return cached;
    let b = await this.store.getPicBlob(key);
    if (!b) {
      try {
        await this.download(key);
      } catch {
        return undefined;
      }
      b = await this.store.getPicBlob(key);
      if (!b) return undefined;
    }
    const url = URL.createObjectURL(new Blob([b.data], { type: b.type }));
    this.urls.set(key, url);
    return url;
  }
}

/** Re-encode a JPEG at the same size and a lower quality (~4× smaller); anything else is kept. */
async function browserCompress(data: ArrayBuffer, type: string): Promise<{ data: ArrayBuffer; type: string }> {
  if (type !== "image/jpeg" || typeof createImageBitmap === "undefined" || typeof document === "undefined") return { data, type };
  try {
    const bmp = await createImageBitmap(new Blob([data], { type }));
    const c = document.createElement("canvas");
    c.width = bmp.width;
    c.height = bmp.height;
    c.getContext("2d")!.drawImage(bmp, 0, 0);
    bmp.close();
    const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/jpeg", JPEG_QUALITY));
    if (!blob || blob.size >= data.byteLength) return { data, type };
    return { data: await blob.arrayBuffer(), type: "image/jpeg" };
  } catch {
    return { data, type };
  }
}
