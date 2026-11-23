// Sync identity and ordering rules (docs/design.md, "Sync" and "Identity and
// pairing"). Pure: shared by the client and the Worker.
import { eventOrder } from "./collection";
import type { AppEvent, Review } from "./events";

/** RFC 4648 base32 alphabet: no 0/1/8/9, so codes survive being read aloud or typed. */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
/** 16 chars × 5 bits = 80 bits: unguessable, and the code is the whole account. */
export const CODE_LENGTH = 16;

export function newSyncCode(): string {
  const b = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => ALPHABET[x & 31]).join("");
}

export function isSyncCode(s: string): boolean {
  return s.length === CODE_LENGTH && [...s].every((c) => ALPHABET.includes(c));
}

/** Digits people read into a code: base32 has no 0, 1 or 8, so they mean O, I, B. */
const LOOKALIKES: Record<string, string> = { "0": "O", "1": "I", "8": "B" };

/** Accepts what a person types or pastes: any case, spaces, dashes, look-alike digits, a full link. */
export function parseSyncCode(input: string): string | null {
  const fromLink = /[#&]k=([A-Za-z0-9 -]+)/.exec(input)?.[1];
  const s = (fromLink ?? input).toUpperCase().replace(/[\s-]/g, "").replace(/[018]/g, (d) => LOOKALIKES[d]);
  return isSyncCode(s) ? s : null;
}

/** "ABCDEFGHIJKLMNOP" → "ABCD-EFGH-IJKL-MNOP" for display. */
export function formatSyncCode(code: string): string {
  return code.match(/.{1,4}/g)!.join("-");
}

export function pairingLink(origin: string, code: string): string {
  return `${origin}/#k=${code}`;
}

/**
 * Whether incoming reviews can be fed to RWKV incrementally. RWKV state depends
 * on review order, so a review that sorts before the newest one already
 * processed means the model must replay (from the start; checkpoints are only
 * at the end of the log).
 */
export function needsReplay(newestProcessed: Review | undefined, incoming: AppEvent[]): boolean {
  if (!newestProcessed) return false;
  return incoming.some((e) => e.type === "review" && eventOrder(e, newestProcessed) < 0);
}
