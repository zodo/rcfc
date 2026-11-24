// Promise API over the RWKV worker.
import type { InitResult, Request, Response } from "./protocol";

/** What the app uses of the engine; tests substitute a stub (test/support/fake-engine.ts). */
export type EngineApi = Pick<Engine, keyof Engine>;

export class Engine {
  private worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  private next = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor() {
    this.worker.onmessage = (ev: MessageEvent<Response>) => {
      const r = ev.data;
      const p = this.pending.get(r.id);
      if (!p) return;
      this.pending.delete(r.id);
      if (r.ok) p.resolve(r.value);
      else p.reject(new Error(r.error));
    };
    this.worker.onerror = (ev) => {
      const err = new Error(`RWKV worker failed: ${ev.message || "unknown error"}`);
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    };
  }

  private call<T>(req: Request): Promise<T> {
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker.postMessage({ id, req });
    });
  }

  init(configKey: string) {
    return this.call<InitResult>({ op: "init", configKey });
  }
  reset() {
    return this.call<null>({ op: "reset" });
  }
  rekey(configKey: string) {
    return this.call<null>({ op: "rekey", configKey });
  }
  apply(rows: Float64Array, lastReviewId: string) {
    return this.call<null>({ op: "apply", rows, lastReviewId });
  }
  process(rows: Float64Array, lastReviewId: string) {
    return this.call<Float64Array>({ op: "process", rows, lastReviewId });
  }
  predict(rows: Float64Array) {
    return this.call<Float64Array>({ op: "predict", rows });
  }
  flush() {
    return this.call<void>({ op: "flush" });
  }
  stats() {
    return this.call<{ memoryBytes: number; reviewsProcessed: number }>({ op: "stats" });
  }
}
