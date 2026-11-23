// Client sync loop (docs/design.md, "Sync"): push the outbox, then pull pages
// after the stored cursor. Runs on start, on reconnect, when the app comes back
// to the foreground, every 30 s while visible, and shortly after local writes.
import type { AppEvent } from "./domain/events";
import { newSyncCode } from "./domain/sync";
import type { Store } from "./store";

const PUSH_BATCH = 500; // matches the Worker's PUSH_MAX
const INTERVAL_MS = 30_000;
const AFTER_WRITE_MS = 2_000;

export type SyncState = "idle" | "syncing" | "offline" | "error";

export interface SyncStatus {
  state: SyncState;
  /** ms epoch of the last complete push + pull. */
  lastOk?: number;
  error?: string;
}

export class Sync {
  status: SyncStatus = { state: "idle" };
  /** New events arrived from other devices (re-render the screen). */
  onPulled: () => void = () => {};
  /** Pulled events need a full RWKV replay; the app should reload when convenient. */
  onReplay: () => void = () => {};
  onStatus: (s: SyncStatus) => void = () => {};

  private running: Promise<void> | null = null;
  private again = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  private constructor(
    private store: Store,
    public code: string,
  ) {}

  static async open(store: Store): Promise<Sync> {
    let code = await store.getMeta<string>("sync_code");
    if (!code) {
      code = newSyncCode();
      await store.setMeta("sync_code", code);
    }
    const s = new Sync(store, code);
    s.status.lastOk = await store.getMeta<number>("sync_last_ok");
    return s;
  }

  start(): void {
    this.store.onLocalWrite = () => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.now(), AFTER_WRITE_MS);
    };
    window.addEventListener("online", () => void this.now());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") void this.now();
    });
    setInterval(() => {
      if (document.visibilityState === "visible") void this.now();
    }, INTERVAL_MS);
    void this.now();
  }

  /** Sync now; concurrent calls coalesce into one extra run. */
  now(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        await this.once();
      } while (this.again);
    })().finally(() => (this.running = null));
    return this.running;
  }

  /**
   * Switch this device to another account (pairing). Local events are pushed
   * to it, and everything already there is pulled.
   */
  async join(code: string): Promise<void> {
    await this.running;
    this.code = code;
    await this.store.setMeta("sync_code", code);
    await this.store.setMeta("sync_pushed", 0);
    await this.store.setMeta("sync_cursor", 0);
    await this.store.markAllLocal();
    await this.now();
  }

  private setStatus(s: Partial<SyncStatus>) {
    this.status = { ...this.status, ...s };
    this.onStatus(this.status);
  }

  private async once(): Promise<void> {
    if (navigator.onLine === false) return this.setStatus({ state: "offline" });
    this.setStatus({ state: "syncing", error: undefined });
    try {
      await this.push();
      const { added, replay } = await this.pull();
      const lastOk = Date.now();
      await this.store.setMeta("sync_last_ok", lastOk);
      this.setStatus({ state: "idle", lastOk });
      if (replay) this.onReplay();
      else if (added) this.onPulled();
    } catch (e) {
      const offline = e instanceof TypeError; // fetch network failure
      this.setStatus({ state: offline ? "offline" : "error", error: offline ? undefined : e instanceof Error ? e.message : String(e) });
    }
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`/api/sync/${path}`, { ...init, headers: { ...init.headers, "x-user-code": this.code, "content-type": "application/json" } });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? `HTTP ${res.status}`);
    }
    return (await res.json()) as T;
  }

  private async push(): Promise<void> {
    let after = (await this.store.getMeta<number>("sync_pushed")) ?? 0;
    for (;;) {
      const { events, upTo } = await this.store.outbox(after, PUSH_BATCH);
      if (upTo === after) return;
      if (events.length) await this.request("push", { method: "POST", body: JSON.stringify({ events }) });
      after = upTo;
      await this.store.setMeta("sync_pushed", after);
    }
  }

  private async pull(): Promise<{ added: number; replay: boolean }> {
    let cursor = (await this.store.getMeta<number>("sync_cursor")) ?? 0;
    let added = 0;
    let replay = false;
    for (;;) {
      const page = await this.request<{ events: AppEvent[]; next: number; more: boolean }>(`pull?after=${cursor}`);
      const r = await this.store.ingest(page.events);
      added += r.added;
      replay ||= r.replay;
      cursor = page.next;
      await this.store.setMeta("sync_cursor", cursor);
      if (!page.more) return { added, replay };
    }
  }
}
