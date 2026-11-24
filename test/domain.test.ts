import { describe, expect, it } from "bun:test";
import { Collection, EventFactory } from "../src/domain/collection";
import { derivedEntityId } from "../src/domain/ids";
import type { AppEvent, Review, ReviewPayload } from "../src/domain/events";
import { RowBuilder, ROW_WIDTH, nextPhase, studyDay } from "../src/domain/rows";
import { wordStatus } from "../src/domain/scheduler";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// 2026-11-23 00:00 UTC
const T0 = Date.UTC(2026, 10, 23);

function review(ts: number, card_id: number, rating: ReviewPayload["rating"], tz_offset_min = 60): Review {
  return {
    event_id: `r-${ts}-${card_id}`,
    type: "review",
    ts,
    device_id: "d",
    payload: { card_id, note_id: 100 + card_id, deck_id: 7, preset_id: 9, rating, duration_ms: 4200, tz_offset_min },
  };
}

describe("studyDay", () => {
  it("uses local time shifted by the rollover hour", () => {
    // 02:30 UTC = 03:30 local (+60): before a 4am rollover → previous study day
    const d = studyDay(T0 + 2.5 * HOUR, 60, 4);
    expect(studyDay(T0 + 3.5 * HOUR, 60, 4)).toBe(d + 1); // 04:30 local
    expect(studyDay(T0 - 20 * HOUR, 60, 4)).toBe(d); // 05:00 local the day before
  });
  it("keeps local days across a timezone change", () => {
    // 09:00 local in UTC+1 and 09:00 local next day in UTC-5 are one day apart
    expect(studyDay(T0 + DAY + 14 * HOUR, -300, 4) - studyDay(T0 + 8 * HOUR, 60, 4)).toBe(1);
  });
});

describe("RowBuilder", () => {
  it("derives day_offset, elapsed and state like the add-on", () => {
    const b = new RowBuilder();
    const rows: number[][] = [];
    const t = T0 + 8 * HOUR; // 09:00 local
    for (const r of [
      review(t, 1, 1), // new, fail → learning
      review(t + 600_000, 1, 3), // learning, pass → review
      review(t + 2 * DAY, 1, 1), // review, fail → relearning
      review(t + 2 * DAY + 60_000, 1, 2), // relearning, hard → stays
      review(t + 2 * DAY + 120_000, 2, 3), // other card, new
    ])
      rows.push(b.push(r, 4));
    expect(rows.every((r) => r.length === ROW_WIDTH)).toBe(true);
    // [card, note, deck, preset, day_offset, elapsed_days, elapsed_seconds, rating, duration, state]
    expect(rows[0]).toEqual([1, 101, 7, 9, 0, -1, -1, 1, 4200, 0]);
    expect(rows[1]).toEqual([1, 101, 7, 9, 0, 0, 600, 3, 4200, 1]);
    expect(rows[2]).toEqual([1, 101, 7, 9, 2, 2, 2 * 86400 - 600, 1, 4200, 2]);
    expect(rows[3]).toEqual([1, 101, 7, 9, 2, 0, 60, 2, 4200, 3]);
    expect(rows[4]).toEqual([2, 102, 7, 9, 2, -1, -1, 3, 4200, 0]);
    expect(b.phase(1)).toBe(3);

    const q = b.predictRow({ card_id: 1, note_id: 101, deck_id: 7, preset_id: 9 }, t + 5 * DAY, 60, 4);
    expect(q.slice(0, 7)).toEqual([1, 101, 7, 9, 5, 3, 3 * 86400 - 60]);
    expect(q.slice(7).every(Number.isNaN)).toBe(true);
    const fresh = b.predictRow({ card_id: 3, note_id: 103, deck_id: 7, preset_id: 9 }, t + 5 * DAY, 60, 4);
    expect(fresh.slice(4, 7)).toEqual([5, -1, -1]);
  });
  it("phase machine", () => {
    expect([1, 2, 3, 4].map((r) => nextPhase(0, r))).toEqual([1, 2, 2, 2]);
    expect([1, 2, 3, 4].map((r) => nextPhase(2, r))).toEqual([3, 2, 2, 2]);
    expect([1, 2, 3, 4].map((r) => nextPhase(1, r))).toEqual([1, 1, 2, 2]);
  });
});

describe("Collection", () => {
  it("folds creation, edits (last write wins), deletes and keeps reviews ordered", () => {
    let now = 1000;
    const f = new EventFactory("dev-a", () => now++);
    const c = new Collection();
    const preset = f.preset();
    const deck = f.deck("Spanish", (preset.payload as { preset_id: number }).preset_id, { from: "es", to: "en" });
    const deckId = (deck.payload as { deck_id: number }).deck_id;
    const note = f.note(deckId, { front: "hola", back: "hello" }, { from: "es", to: "en" });
    for (const e of [preset, deck, ...note]) expect(c.apply(e)).toBe(true);
    expect(c.apply(preset)).toBe(false); // dedup by event_id
    const [card1, card2] = c.liveCards(deckId);
    expect(card1.template).toBe("forward");
    expect(card2.template).toBe("reverse");
    const noteId = card1.note_id;

    const edit = (value: string, ts: number, device_id: string): AppEvent => ({
      event_id: `e-${value}`,
      type: "note_edited",
      ts,
      device_id,
      payload: { note_id: noteId, field: "back", value },
    });
    c.apply(edit("hi", 5000, "dev-a"));
    c.apply(edit("older", 4000, "dev-b"));
    expect(c.notes.get(noteId)!.fields.back).toBe("hi");

    const r2 = review(9000, card1.id, 3);
    const r1 = review(8000, card1.id, 1);
    c.apply(r2);
    c.apply(r1);
    expect(c.reviews.map((r) => r.ts)).toEqual([8000, 9000]);
    expect(card1.reviews).toBe(2);
    expect(card1.first_review_ts).toBe(8000);
    expect(card1.first_rating).toBe(1);

    c.apply({ event_id: "del", type: "note_deleted", ts: 10000, device_id: "dev-a", payload: { note_id: noteId } });
    expect(c.liveCards()).toEqual([]);
  });
});

describe("wordStatus", () => {
  const card = (id: number, reviews: number) => ({ id, reviews });
  it("new until studied, known when every studied card holds a week ahead, else learning", () => {
    expect(wordStatus([card(1, 0), card(2, 0)], new Map())).toBe("new");
    expect(wordStatus([card(1, 2), card(2, 0)], new Map([[1, 0.95]]))).toBe("known");
    expect(wordStatus([card(1, 2), card(2, 1)], new Map([[1, 0.95], [2, 0.7]]))).toBe("learning");
    expect(wordStatus([card(1, 2)], new Map())).toBeUndefined();
    // Marked known (last answer Easy): known whatever the model says, until answered again.
    expect(wordStatus([{ id: 1, reviews: 1, last_rating: 4 }, card(2, 0)], new Map([[1, 0.8]]))).toBe("known");
    expect(wordStatus([{ id: 1, reviews: 3, last_rating: 1 }], new Map([[1, 0.8]]))).toBe("learning");
  });
});

describe("derived ids", () => {
  it("are the same for the same text, differ otherwise, and fit an entity id", () => {
    const es = derivedEntityId("deck:lang:es>en");
    expect(derivedEntityId("deck:lang:es>en")).toBe(es);
    expect(derivedEntityId("deck:lang:de>en")).not.toBe(es);
    expect(derivedEntityId("deck:lang:en>es")).not.toBe(es);
    for (const id of [es, derivedEntityId(""), derivedEntityId("ü".repeat(500))]) {
      expect(Number.isSafeInteger(id) && id > 0).toBe(true);
    }
  });

  it("a deck made twice with the same id (two devices offline) folds into one", () => {
    const col = new Collection();
    const id = derivedEntityId("deck:lang:de>en");
    for (const dev of ["a", "b"]) col.apply(new EventFactory(dev).deck("German", 1, { from: "de", to: "en" }, id));
    expect([...col.decks.keys()]).toEqual([id]);
  });
});
