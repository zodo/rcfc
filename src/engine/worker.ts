/// <reference lib="webworker" />
// RWKV engine worker: owns the Wasm runtime and its checkpoint in IndexedDB.
//
// Checkpoint layout (database "rcfc-engine"): one `meta` row with the feature
// state blob and cursor, plus one `states` row per (kind, id) recurrent state.
// Dirty states and meta are written in one transaction, so a checkpoint is
// always consistent, whenever the tab dies.
import Dexie, { type Table } from "dexie";
import init, { Rwkv } from "../rwkv/pkg/rcfc_rwkv.js";
import wasmUrl from "../rwkv/pkg/rcfc_rwkv_bg.wasm?url";
import modelUrl from "../../rwkv/models/RWKV_trained_on_101_4999.safetensors?url";
import type { InitResult, Request, Response, SpeedResult } from "./protocol";

interface Meta {
  key: "checkpoint";
  configKey: string;
  modelSha: string;
  reviews: number;
  lastReviewId: string | null;
  features: Uint8Array;
}
interface StateRow {
  kind: number;
  id: number;
  bytes: Uint8Array;
}

class EngineDb extends Dexie {
  meta!: Table<Meta, string>;
  states!: Table<StateRow, [number, number]>;
  constructor() {
    super("rcfc-engine");
    this.version(1).stores({ meta: "key", states: "[kind+id]" });
  }
}

const db = new EngineDb();
let rt: Rwkv | null = null;
let weights: Uint8Array | null = null;
let configKey = "";
let modelSha = "";
let lastReviewId: string | null = null;
let unsaved = 0;
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let chain: Promise<unknown> = Promise.resolve();

const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");

async function loadModel(): Promise<Uint8Array> {
  if (!weights) {
    await init({ module_or_path: wasmUrl });
    const res = await fetch(modelUrl);
    if (!res.ok) throw new Error(`model download failed: HTTP ${res.status}`);
    weights = new Uint8Array(await res.arrayBuffer());
    modelSha = hex(await crypto.subtle.digest("SHA-256", weights as Uint8Array<ArrayBuffer>));
  }
  return weights;
}

async function clearCheckpoint() {
  await db.transaction("rw", db.meta, db.states, async () => {
    await db.meta.clear();
    await db.states.clear();
  });
}

async function doInit(key: string): Promise<InitResult> {
  const t0 = performance.now();
  rt?.free();
  rt = new Rwkv(await loadModel());
  configKey = key;
  lastReviewId = null;
  const meta = await db.meta.get("checkpoint");
  if (!meta || meta.configKey !== configKey || meta.modelSha !== modelSha) {
    if (meta) await clearCheckpoint();
    return { restored: 0, lastReviewId: null, modelSha, loadMs: performance.now() - t0 };
  }
  try {
    rt.loadFeatures(meta.features);
    await db.states.each((s) => rt!.loadState(s.kind, s.id, s.bytes));
    if (rt.reviewsProcessed !== meta.reviews) throw new Error("review count mismatch");
    rt.takeDirty(); // loaded states are already saved
    lastReviewId = meta.lastReviewId;
    return { restored: meta.reviews, lastReviewId, modelSha, loadMs: performance.now() - t0 };
  } catch (e) {
    console.warn("rcfc: discarding unreadable RWKV checkpoint", e);
    rt.free();
    rt = new Rwkv(await loadModel());
    await clearCheckpoint();
    return { restored: 0, lastReviewId: null, modelSha, loadMs: performance.now() - t0 };
  }
}

async function flush() {
  clearTimeout(flushTimer);
  flushTimer = undefined;
  if (!rt || unsaved === 0) return;
  const dirty = rt.takeDirty();
  const rows: StateRow[] = [];
  for (let i = 0; i < dirty.length; i += 2) {
    const bytes = rt.stateBytes(dirty[i], dirty[i + 1]);
    if (bytes) rows.push({ kind: dirty[i], id: dirty[i + 1], bytes });
  }
  const meta: Meta = { key: "checkpoint", configKey, modelSha, reviews: rt.reviewsProcessed, lastReviewId, features: rt.featuresBytes() };
  unsaved = 0;
  await db.transaction("rw", db.meta, db.states, async () => {
    await db.states.bulkPut(rows);
    await db.meta.put(meta);
  });
}

function scheduleFlush(n: number) {
  unsaved += n;
  // During long replays save every ~2000 reviews; otherwise shortly after activity.
  if (unsaved >= 2000) void flush();
  else if (!flushTimer) flushTimer = setTimeout(() => void enqueue(flush), 1500);
}

function need(): Rwkv {
  if (!rt) throw new Error("engine not initialised");
  return rt;
}

async function speedTest(reviews: number, cards: number): Promise<SpeedResult> {
  const r = new Rwkv(await loadModel());
  try {
    const W = Rwkv.rowWidth();
    const rows = new Float64Array(reviews * W);
    for (let i = 0; i < reviews; i++) {
      const c = (i % cards) + 1;
      const first = i < cards;
      rows.set([c, 1e6 + (c >> 1), 1, 1, Math.floor(i / 150), first ? -1 : 2, first ? -1 : 172800, 3, 4000, first ? 0 : 2], i * W);
    }
    let t = performance.now();
    r.apply(rows);
    const reviewsPerSec = reviews / ((performance.now() - t) / 1000);
    const q = new Float64Array(cards * W);
    for (let c = 1; c <= cards; c++) q.set([c, 1e6 + (c >> 1), 1, 1, 30, 3, 260000, NaN, NaN, NaN], (c - 1) * W);
    t = performance.now();
    r.predict(q);
    return { reviewsPerSec, predictMsPerCard: (performance.now() - t) / cards, memoryMb: r.memoryBytes / 1e6 };
  } finally {
    r.free();
  }
}

async function handle(m: Request): Promise<unknown> {
  switch (m.op) {
    case "init":
      return doInit(m.configKey);
    case "reset":
      need().reset();
      lastReviewId = null;
      unsaved = 0;
      await clearCheckpoint();
      return null;
    case "apply": {
      need().apply(m.rows);
      lastReviewId = m.lastReviewId;
      scheduleFlush(m.rows.length / Rwkv.rowWidth());
      return null;
    }
    case "process": {
      const p = need().process(m.rows);
      lastReviewId = m.lastReviewId;
      scheduleFlush(m.rows.length / Rwkv.rowWidth());
      return p;
    }
    case "predict":
      return need().predict(m.rows);
    case "flush":
      return flush();
    case "stats":
      return { memoryBytes: rt?.memoryBytes ?? 0, reviewsProcessed: rt?.reviewsProcessed ?? 0 };
    case "speedTest":
      return speedTest(m.reviews, m.cards);
  }
}

/** Serialize all work: the runtime is single-threaded state. */
function enqueue<T>(f: () => Promise<T>): Promise<T> {
  const p = chain.then(f);
  chain = p.catch(() => {});
  return p;
}

self.onmessage = (ev: MessageEvent<{ id: number; req: Request }>) => {
  const { id, req } = ev.data;
  enqueue(() => handle(req)).then(
    (value) => {
      const transfer = value instanceof Float64Array ? [value.buffer] : [];
      (self as unknown as Worker).postMessage({ id, ok: true, value } satisfies Response, transfer);
    },
    (e) => (self as unknown as Worker).postMessage({ id, ok: false, error: e instanceof Error ? e.message : String(e) } satisfies Response),
  );
};
