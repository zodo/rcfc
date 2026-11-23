import { readFileSync, existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseCsv } from "../src/import/csv";
import {
  DuocardsFormatError,
  guessSourceLang,
  importDuocardsCsv,
  type DuocardsImportOptions,
} from "../src/import/duocards";
import type { CardCreated, NoteCreated } from "../src/domain/events";

const sample = readFileSync(new URL("./fixtures/duocards_sample.csv", import.meta.url), "utf8");
const opts: DuocardsImportOptions = {
  deckId: 42,
  langPair: { from: "es", to: "en" },
  deviceId: "test-device",
  now: () => 1_700_000_000_000,
};
const notes = (evs: { type: string }[]) => evs.filter((e): e is NoteCreated => e.type === "note_created");
const cards = (evs: { type: string }[]) => evs.filter((e): e is CardCreated => e.type === "card_created");

describe("parseCsv", () => {
  it("handles quotes, escaped quotes, embedded commas and newlines", () => {
    const r = parseCsv('a,b\n"x, y","say ""hi""\nthere"\n');
    expect(r).toEqual([
      { line: 1, values: ["a", "b"] },
      { line: 2, values: ["x, y", 'say "hi"\nthere'] },
    ]);
  });
  it("handles CRLF, BOM, missing final newline and empty trailing field", () => {
    expect(parseCsv("﻿a,b\r\n1,\r\n2,3").map((r) => r.values)).toEqual([["a", "b"], ["1", ""], ["2", "3"]]);
  });
  it("rejects an unterminated quote", () => {
    expect(() => parseCsv('a\n"oops')).toThrow(/unterminated/);
  });
});

describe("importDuocardsCsv", () => {
  const res = importDuocardsCsv(sample, opts);

  it("imports valid rows, skips duplicates, reports bad rows", () => {
    expect(res.notes).toBe(8);
    expect(res.cards).toBe(16);
    expect(res.skipped).toEqual([
      { line: 8, front: "Ya", back: "ALREADY", reason: "duplicate_in_file" },
    ]);
    expect(res.errors.map((e) => e.line)).toEqual([10, 11]);
  });

  it("maps fields and keeps the original text", () => {
    const byFront = Object.fromEntries(notes(res.events).map((n) => [n.payload.fields.front, n.payload]));
    expect(byFront["ponerse las pilas"].fields).toEqual({
      front: "ponerse las pilas",
      back: "get energized, get to work",
      example: "¡Ponte las pilas!",
    });
    expect(byFront['decir "hola"'].fields).toEqual({ front: 'decir "hola"', back: 'to say "hello"' });
    expect(byFront["el columpio"].fields.example).toBe("Los niños\njuegan en el columpio.");
    expect(byFront["enrollarse"].fields.back).toBe("болтать/замутить");
    expect(byFront["la torre"].source).toEqual({ kind: "duocards", created_at: "2026-06-11T07:50:32.408Z" });
    expect(byFront["sin fecha"].source).toEqual({ kind: "duocards" });
    expect(byFront["hola"].deck_id).toBe(42);
    expect(byFront["hola"].lang_pair).toEqual({ from: "es", to: "en" });
  });

  it("orders notes oldest first, undated last", () => {
    expect(notes(res.events).map((n) => n.payload.fields.front)).toEqual([
      "hola", "enrollarse", "ya", 'decir "hola"', "el columpio", "ponerse las pilas", "la torre", "sin fecha",
    ]);
  });

  it("emits each note's cards right after it, with distinct safe-integer ids", () => {
    const evs = res.events;
    for (let i = 0; i < evs.length; i += 3) {
      const n = evs[i] as NoteCreated;
      expect(n.type).toBe("note_created");
      expect((evs[i + 1] as CardCreated).payload).toMatchObject({ note_id: n.payload.note_id, template: "forward" });
      expect((evs[i + 2] as CardCreated).payload).toMatchObject({ note_id: n.payload.note_id, template: "reverse" });
    }
    const ids = [...notes(evs).map((n) => n.payload.note_id), ...cards(evs).map((c) => c.payload.card_id)];
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(Number.isSafeInteger(id) && id > 0).toBe(true);
    expect(new Set(evs.map((e) => e.event_id)).size).toBe(evs.length);
    for (const e of evs) {
      expect(e.event_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(e.ts).toBe(1_700_000_000_000);
      expect(e.device_id).toBe("test-device");
    }
  });

  it("is safe to re-import: existing notes are skipped", () => {
    const existing = notes(res.events).map((n) => n.payload.fields);
    const again = importDuocardsCsv(sample, { ...opts, existing });
    expect(again.notes).toBe(0);
    expect(again.events).toEqual([]);
    expect(again.skipped.filter((s) => s.reason === "already_exists")).toHaveLength(9);
  });

  it("supports a single template", () => {
    const r = importDuocardsCsv(sample, { ...opts, templates: ["forward"] });
    expect(r.cards).toBe(8);
  });

  it("gives the same result with CRLF line endings", () => {
    const r = importDuocardsCsv(sample.replace(/\n/g, "\r\n"), opts);
    expect(notes(r.events).map((n) => n.payload.fields)).toEqual(notes(res.events).map((n) => n.payload.fields));
  });

  it("rejects files that are not Duocards exports", () => {
    expect(() => importDuocardsCsv("word,translation\na,b\n", opts)).toThrow(DuocardsFormatError);
    expect(() => importDuocardsCsv("", opts)).toThrow(DuocardsFormatError);
  });
});

describe("guessSourceLang", () => {
  it("reads the language from the export file name", () => {
    expect(guessSourceLang("duo_cards_es_export.csv")).toBe("es");
    expect(guessSourceLang("/x/duo_cards_pt-br_export (1).csv")).toBe("pt-br");
    expect(guessSourceLang("cards.csv")).toBeUndefined();
  });
});

// Optional check against a real export (not committed: it is personal data).
//   RCFC_DUOCARDS_EXPORT=/path/to/duo_cards_es_export.csv npm test
const real = process.env.RCFC_DUOCARDS_EXPORT;
describe.skipIf(!real || !existsSync(real))("real Duocards export", () => {
  it("imports every row without errors", () => {
    const r = importDuocardsCsv(readFileSync(real!, "utf8"), opts);
    expect(r.errors).toEqual([]);
    expect(r.notes + r.skipped.length).toBe(parseCsv(readFileSync(real!, "utf8")).length - 1);
  });
});
