// Id minting. All entity ids go through here so the representation can change in one place.

/**
 * Entity id (note, card, deck, preset). docs/design.md asks for random 64-bit
 * integers because rwkv-srs takes integer ids (it uses i64). We use random
 * positive integers below 2^53 instead: they fit i64, stay exact as JS numbers
 * and survive JSON without BigInt. ~2^53 values is collision-free at our scale.
 */
export type EntityId = number;

export function newEntityId(): EntityId {
  const b = new Uint32Array(2);
  crypto.getRandomValues(b);
  // 21 high bits + 32 low bits = 53 bits; reject 0.
  const id = (b[0] & 0x1fffff) * 2 ** 32 + b[1];
  return id === 0 ? newEntityId() : id;
}

/** UUIDv7 (RFC 9562): 48-bit ms timestamp + random; time-sortable event ids. */
export function uuidv7(nowMs: number = Date.now()): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  let t = nowMs;
  for (let i = 5; i >= 0; i--) {
    b[i] = t % 256;
    t = Math.floor(t / 256);
  }
  b[6] = (b[6] & 0x0f) | 0x70; // version 7
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * An id every device derives from the same text (cyrb53), so things named by
 * content, like the hidden deck of a language pair, get one id without asking
 * each other. Positive, below 2^53, like `newEntityId`.
 */
export function derivedEntityId(text: string): EntityId {
  let h1 = 0xdeadbeef ^ 0x5bd1e995;
  let h2 = 0x41c6ce57 ^ 0x5bd1e995;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const id = (h2 & 0x1fffff) * 2 ** 32 + (h1 >>> 0);
  return id === 0 ? 1 : id;
}
