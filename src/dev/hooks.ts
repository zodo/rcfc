// Dev-only URL hooks (never in production builds: main.ts imports this under
// import.meta.env.DEV). Used by scripts/smoke.ts and handy by hand:
//   ?reset        wipe this origin's data (log, RWKV checkpoint, localStorage)
//   ?seed=N       add a demo deck of N words with a month of reviews
//   ?reset&seed=N both, in that order
// Each hook reloads without its parameter. Errors are collected in
// window.__rcfcErrors for the smoke test to read.
import Dexie from "dexie";
import { Store } from "../store";
import type { EngineApi } from "../engine/client";
import { seedEvents } from "./seed";

declare global {
  interface Window {
    __rcfcErrors: string[];
  }
}

/** Accepts writes and predicts nothing: seeding only needs the log. */
const noEngine = {
  init: async () => ({ restored: 0, lastReviewId: null, modelSha: "", loadMs: 0 }),
  reset: async () => null,
  rekey: async () => null,
  apply: async () => null,
  process: async () => new Float64Array(1),
  predict: async (rows: Float64Array) => new Float64Array(rows.length / 10),
  flush: async () => {},
  stats: async () => ({ memoryBytes: 0, reviewsProcessed: 0 }),
  speedTest: async () => ({ reviewsPerSec: 0, predictMsPerCard: 0, memoryMb: 0 }),
} satisfies EngineApi;

function without(params: URLSearchParams, key: string): string {
  params.delete(key);
  const q = params.toString();
  return location.pathname + (q ? `?${q}` : "") + location.hash;
}

/** Runs the hooks in the URL. True when the page is about to reload. */
export async function devHooks(): Promise<boolean> {
  window.__rcfcErrors ??= [];
  window.addEventListener("error", (e) => window.__rcfcErrors.push(String(e.message)));
  window.addEventListener("unhandledrejection", (e) => window.__rcfcErrors.push(String(e.reason?.stack ?? e.reason)));

  const params = new URLSearchParams(location.search);
  if (params.has("reset")) {
    await Promise.all([Dexie.delete("rcfc"), Dexie.delete("rcfc-engine")]);
    localStorage.clear();
    location.replace(without(params, "reset"));
    return true;
  }
  const seed = params.get("seed");
  if (seed !== null) {
    const { store } = await Store.open({ engine: noEngine });
    const events = seedEvents({ deviceId: store.deviceId, presetId: store.preset().preset_id, words: Number(seed) || 40, now: Date.now() });
    await store.importBackup(events);
    store.close();
    location.replace(without(params, "seed"));
    return true;
  }
  return false;
}
