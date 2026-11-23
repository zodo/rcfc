// Real Store + Sync over fake-indexeddb, the fake engine and an in-process
// sync server (worker/sync.ts on bun:sqlite). Each device has its own
// IndexedDB and engine checkpoint; `reopen()` simulates an app reload.
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { Store, type StartupInfo } from "../../src/store";
import { Sync } from "../../src/sync";
import { handleSync, type SqlDb } from "../../worker/sync";
import { sqliteD1 } from "./d1";
import { FakeEngine, type Disk } from "./fake-engine";

export const DAY = 86_400_000;
/** 2026-11-23 12:00 UTC */
export const T0 = Date.UTC(2026, 10, 23, 12);

/**
 * A clock shared by a test's devices. Each reading ticks 1 ms, so events made
 * one after another never share a timestamp (their order would be random).
 */
export class Clock {
  constructor(public t = T0) {}
  now = () => this.t++;
  advance(ms: number) {
    this.t += ms;
  }
}

export class Server {
  readonly db: SqlDb & { sqlite: import("bun:sqlite").Database } = sqliteD1();
  requests = 0;
  fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    this.requests++;
    const res = await handleSync(new Request(new URL(url, "https://rcfc.test"), init), this.db);
    if (!res) throw new Error(`no route for ${url}`);
    return res;
  };
  count(code?: string): number {
    const row = code
      ? this.db.sqlite.query("SELECT count(*) AS n FROM events WHERE user_code = ?").get(code)
      : this.db.sqlite.query("SELECT count(*) AS n FROM events").get();
    return (row as { n: number }).n;
  }
}

export class Device {
  store!: Store;
  sync!: Sync;
  engine!: FakeEngine;
  info!: StartupInfo;
  readonly disk: Disk = {};
  private idb = new IDBFactory();
  replays = 0;
  pulls = 0;

  private constructor(
    readonly clock: Clock,
    readonly server?: Server,
  ) {}

  static async open(clock = new Clock(), server?: Server): Promise<Device> {
    const d = new Device(clock, server);
    await d.reopen();
    return d;
  }

  /** Close and open again on the same IndexedDB and checkpoint (an app reload). */
  async reopen(): Promise<StartupInfo> {
    this.store?.close();
    this.engine = new FakeEngine(this.disk);
    const { store, info } = await Store.open({ engine: this.engine, dbName: "rcfc", dexie: { indexedDB: this.idb, IDBKeyRange }, now: this.clock.now });
    this.store = store;
    this.info = info;
    this.sync = await Sync.open(store);
    if (this.server) this.sync.fetch = this.server.fetch;
    this.sync.onReplay = () => this.replays++;
    this.sync.onPulled = () => this.pulls++;
    return info;
  }

  /** A deck with `words` notes (two cards each). Returns the deck id. */
  async deck(words: number, name = "Spanish"): Promise<number> {
    const s = this.store;
    const deck = s.factory.deck(name, s.preset().preset_id, { from: "es", to: "en" });
    await s.append([deck]);
    const deckId = (deck.payload as { deck_id: number }).deck_id;
    const notes = Array.from({ length: words }, (_, i) => s.factory.note(deckId, { front: `palabra ${i}`, back: `word ${i}` }, { from: "es", to: "en" })).flat();
    await s.append(notes);
    return deckId;
  }
}
