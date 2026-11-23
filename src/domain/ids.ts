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
