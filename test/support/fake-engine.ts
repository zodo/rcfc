// Stand-in for the RWKV worker (src/engine/worker.ts) with the same contract:
// rows in replay order, a checkpoint keyed by config, predictions per row.
// P(recall) is a simple exponential forgetting curve whose stability grows with
// good answers, so scheduling behaves plausibly. The real model is covered by
// the Rust goldens (rwkv/engine/tests).
import type { EngineApi } from "../../src/engine/client";
import type { InitResult, SpeedResult } from "../../src/engine/protocol";
import { ROW_WIDTH } from "../../src/domain/rows";

interface State {
  reviews: number;
  lastReviewId: string | null;
  /** card id → stability in days (P = 0.9 after that long). */
  stability: Map<number, number>;
}

/** What survives a "reload": share one between engines to reopen a store. */
export interface Disk {
  checkpoint?: State & { configKey: string };
}

const DAY_S = 86_400;

export class FakeEngine implements EngineApi {
  private state: State = { reviews: 0, lastReviewId: null, stability: new Map() };
  private configKey = "";
  /** Card ids of every row applied since init/reset, in order. */
  readonly applied: number[] = [];
  resets = 0;

  constructor(readonly disk: Disk = {}) {}

  async init(configKey: string): Promise<InitResult> {
    this.configKey = configKey;
    const c = this.disk.checkpoint;
    if (!c || c.configKey !== configKey) {
      this.disk.checkpoint = undefined;
      this.state = { reviews: 0, lastReviewId: null, stability: new Map() };
      return { restored: 0, lastReviewId: null, modelSha: "fake", loadMs: 0 };
    }
    this.state = { reviews: c.reviews, lastReviewId: c.lastReviewId, stability: new Map(c.stability) };
    return { restored: c.reviews, lastReviewId: c.lastReviewId, modelSha: "fake", loadMs: 0 };
  }

  async reset(): Promise<null> {
    this.resets++;
    this.disk.checkpoint = undefined;
    this.applied.length = 0;
    this.state = { reviews: 0, lastReviewId: null, stability: new Map() };
    return null;
  }

  async rekey(configKey: string): Promise<null> {
    this.configKey = configKey;
    return null;
  }

  private p(row: Float64Array | number[], at: number): number {
    const card = row[at];
    const elapsedS = row[at + 6];
    if (elapsedS < 0) return 0.5;
    const s = this.state.stability.get(card) ?? 1;
    return Math.exp((Math.log(0.9) * elapsedS) / (s * DAY_S));
  }

  private feed(rows: Float64Array, lastReviewId: string, out?: number[]): void {
    for (let at = 0; at < rows.length; at += ROW_WIDTH) {
      out?.push(this.p(rows, at));
      const card = rows[at];
      const rating = rows[at + 7];
      const s = this.state.stability.get(card) ?? 1;
      this.state.stability.set(card, rating === 1 ? 0.5 : rating === 2 ? s * 1.2 : rating === 3 ? s * 2.5 : s * 4);
      this.applied.push(card);
      this.state.reviews++;
    }
    this.state.lastReviewId = lastReviewId;
  }

  async apply(rows: Float64Array, lastReviewId: string): Promise<null> {
    this.feed(rows, lastReviewId);
    return null;
  }

  async process(rows: Float64Array, lastReviewId: string): Promise<Float64Array> {
    const out: number[] = [];
    this.feed(rows, lastReviewId, out);
    return Float64Array.from(out);
  }

  async predict(rows: Float64Array): Promise<Float64Array> {
    const out: number[] = [];
    for (let at = 0; at < rows.length; at += ROW_WIDTH) out.push(this.p(rows, at));
    return Float64Array.from(out);
  }

  async flush(): Promise<void> {
    this.disk.checkpoint = { ...this.state, stability: new Map(this.state.stability), configKey: this.configKey };
  }

  async stats() {
    return { memoryBytes: 0, reviewsProcessed: this.state.reviews };
  }

  async speedTest(): Promise<SpeedResult> {
    return { reviewsPerSec: 0, predictMsPerCard: 0, memoryMb: 0 };
  }
}
