import { describe, expect, it } from "bun:test";
import { Collection, EventFactory } from "../src/domain/collection";
import type { Review } from "../src/domain/events";
import { CODE_LENGTH, formatSyncCode, isSyncCode, needsReplay, newSyncCode, pairingLink, parseSyncCode } from "../src/domain/sync";

function review(ts: number, device = "a", id = `r-${ts}-${device}`): Review {
  return {
    event_id: id,
    type: "review",
    ts,
    device_id: device,
    payload: { card_id: 1, note_id: 2, deck_id: 3, preset_id: 4, rating: 3, duration_ms: 1000, tz_offset_min: 0 },
  };
}

describe("sync codes", () => {
  it("generates valid, distinct codes", () => {
    const codes = new Set(Array.from({ length: 200 }, newSyncCode));
    expect(codes.size).toBe(200);
    for (const c of codes) {
      expect(c).toHaveLength(CODE_LENGTH);
      expect(isSyncCode(c)).toBe(true);
    }
  });

  it("parses what people type or paste", () => {
    const code = "ABCDEFGHIJKLMN23";
    expect(parseSyncCode(code)).toBe(code);
    expect(parseSyncCode(formatSyncCode(code))).toBe(code);
    expect(parseSyncCode(" abcd efgh-ijkl mn23 ")).toBe(code);
    expect(parseSyncCode(pairingLink("https://rcfc.example", code))).toBe(code);
    expect(parseSyncCode("#k=ABCD-EFGH-IJKL-MN23")).toBe(code);
  });

  it("reads look-alike digits as the letters they resemble", () => {
    expect(parseSyncCode("6UK6-U6WP-YJFS-03TD")).toBe("6UK6U6WPYJFSO3TD");
    expect(parseSyncCode("1JKL8MNOPQRSTUV2")).toBe("IJKLBMNOPQRSTUV2");
  });

  it("rejects malformed codes", () => {
    expect(parseSyncCode("")).toBeNull();
    expect(parseSyncCode("ABCDEFGHIJKLMN2")).toBeNull(); // 15 chars
    expect(parseSyncCode("ABCDEFGHIJKLMN9Z")).toBeNull(); // 9 is not base32
    expect(parseSyncCode("https://rcfc.example/")).toBeNull();
    expect(isSyncCode("abcdefghijklmn23")).toBe(false); // canonical form is upper case
  });

  it("formats in groups of four", () => {
    expect(formatSyncCode("ABCDEFGHIJKLMN23")).toBe("ABCD-EFGH-IJKL-MN23");
  });
});

describe("needsReplay", () => {
  it("is false with no reviews processed yet", () => {
    expect(needsReplay(undefined, [review(5)])).toBe(false);
  });

  it("is false when every pulled review is newer", () => {
    expect(needsReplay(review(10), [review(11), review(12, "b")])).toBe(false);
  });

  it("is true when a pulled review sorts before the newest processed one", () => {
    expect(needsReplay(review(10), [review(12), review(9, "b")])).toBe(true);
  });

  it("breaks equal timestamps by device id, like the fold", () => {
    expect(needsReplay(review(10, "b"), [review(10, "a")])).toBe(true);
    expect(needsReplay(review(10, "a"), [review(10, "b")])).toBe(false);
  });

  it("ignores non-review events", () => {
    const f = new EventFactory("d", () => 1);
    expect(needsReplay(review(10), f.note(1, { front: "x", back: "y" }, { from: "es", to: "en" }))).toBe(false);
  });
});

describe("default preset after pairing", () => {
  it("is the same on every device whatever order events arrive in", () => {
    const a = new EventFactory("dev-a", () => 1);
    const b = new EventFactory("dev-b", () => 2);
    const presetA = a.preset({ preset_id: 500, new_per_day: 15 });
    const presetB = b.preset({ preset_id: 100 }); // B's unused default, lower id
    const deck = a.deck("Spanish", 500, { from: "es", to: "en" });

    const onA = new Collection();
    for (const e of [presetA, deck, presetB]) onA.apply(e);
    const onB = new Collection();
    for (const e of [presetB, presetA, deck]) onB.apply(e);

    expect(onA.defaultPreset()?.preset_id).toBe(500);
    expect(onB.defaultPreset()?.preset_id).toBe(500);
  });

  it("falls back to the lowest id when no deck exists", () => {
    const f = new EventFactory("d", () => 1);
    const c = new Collection();
    c.apply(f.preset({ preset_id: 9 }));
    c.apply(f.preset({ preset_id: 3 }));
    expect(c.defaultPreset()?.preset_id).toBe(3);
  });
});
