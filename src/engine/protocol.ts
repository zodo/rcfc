// Messages between the app and the RWKV worker (src/engine/worker.ts).

export interface InitResult {
  /** Reviews already applied by the restored checkpoint (0 = fresh). */
  restored: number;
  /** event_id of the last review in the checkpoint, to verify it matches the log. */
  lastReviewId: string | null;
  modelSha: string;
  loadMs: number;
}

export interface SpeedResult {
  reviewsPerSec: number;
  predictMsPerCard: number;
  memoryMb: number;
}

export type Request =
  | { op: "init"; configKey: string }
  | { op: "reset" }
  /** The rows config grew (first review under another preset): save checkpoints under this key. */
  | { op: "rekey"; configKey: string }
  /** Replay: state only. */
  | { op: "apply"; rows: Float64Array; lastReviewId: string }
  /** Live answer: returns the pre-answer P per row. */
  | { op: "process"; rows: Float64Array; lastReviewId: string }
  | { op: "predict"; rows: Float64Array }
  | { op: "flush" }
  | { op: "stats" }
  | { op: "speedTest"; reviews: number; cards: number };

export type Response =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: string };
