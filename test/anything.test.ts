import { readFileSync } from "node:fs";
import { describe, expect, it } from "bun:test";
import { parseCsv } from "../src/import/csv";
import { IMPORT_HEADER, importEvents, importPrompt, intervalStatus, langCode, planImport, readDate, readImport, readStatus, scriptLang } from "../src/import/anything";
import { EventFactory } from "../src/domain/collection";
import type { NoteCreated } from "../src/domain/events";
import { Device } from "./support/harness";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/import/${name}`, import.meta.url), "utf8");
const ES_EN = { from: "es", to: "en" };
const words = (text: string) => readImport(text).rows.map((r) => r.word);

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
  it("takes another separator, and keeps a quote inside an unquoted field", () => {
    expect(parseCsv('a;b\n5" screen;"x;y"', ";").map((r) => r.values)).toEqual([["a", "b"], ['5" screen', "x;y"]]);
  });
  it("rejects an unterminated quote", () => {
    expect(() => parseCsv('a\n"oops')).toThrow(/unterminated/);
  });
});

describe("readImport: what the prompt asks for", () => {
  it("reads an AI reply: the code block out of the chat around it", () => {
    const r = readImport(fixture("reply-anki.md"));
    expect(r.errors).toEqual([]);
    expect(r.rows.map((x) => [x.word, x.status, x.stickers])).toEqual([
      ["el perro", "known", ["Animals"]],
      ["la ventana", "learning", ["House"]],
      ["aprovechar", "learning", ["Verbs"]],
      ["el cajón", "new", ["House"]],
      ["sin embargo", "known", ["Connectors"]],
      ["la cuenta", "learning", ["Restaurant"]],
    ]);
    const cuenta = r.rows.at(-1)!;
    expect(cuenta).toMatchObject({ translation: "the bill / the account", translationNote: "also: a bank account", picture: "a restaurant bill, not a bank account", lang: "es", to: "en" });
    expect(r.rows[1].example).toBe("Abre la ventana, por favor.");
  });

  it("reads notes, stickers and pairs per row", () => {
    const r = readImport(fixture("reply-tutor.md"));
    expect(r.rows).toHaveLength(7);
    expect(r.rows[0]).toMatchObject({ word: "ser", note: expect.stringContaining("identity"), stickers: ["Lesson 12"], lang: "es", to: "en" });
    expect(r.rows.find((x) => x.word === "aprovechar")?.status).toBe("known");
    const g = readImport(fixture("reply-german.md"));
    expect(g.rows.map((x) => `${x.lang}>${x.to}`)).toEqual(Array(5).fill("es>de"));
  });

  it("joins several blocks and skips a header repeated inside one", () => {
    const block = (rows: string) => "```csv\n" + IMPORT_HEADER + "\n" + rows + "\n```";
    const text = `Part 1:\n${block("uno,one,,es,en,,,,,new")}\nPart 2:\n${block("dos,two,,es,en,,,,,new\n" + IMPORT_HEADER + "\ntres,three,,es,en,,,,,new")}`;
    expect(words(text)).toEqual(["uno", "dos", "tres"]);
  });

  it("reads a block whose closing fence was cut off", () => {
    expect(words("Here you go:\n```\nword,translation\nperro,dog\ngato,cat")).toEqual(["perro", "gato"]);
  });

  it("ignores the prompt pasted back, and reads the table under it", () => {
    const text = importPrompt([ES_EN], "en", (c) => c) + "\nword;translation\nperro;dog\n";
    const r = readImport(text);
    expect(r.rows.map((x) => x.word)).toEqual(["perro"]);
  });

  it("says when there is no table", () => {
    expect(readImport("Sure! What topic would you like?").noTable).toBe(true);
    expect(readImport("```python\nprint('hi')\n```").noTable).toBe(true);
  });

  it("reports rows without a word or translation, or with a language it doesn't know", () => {
    const r = readImport("word,translation,lang\nperro,dog,es\n,cat,es\ngato,,es\nkot,cat,Klingon\n");
    expect(r.rows.map((x) => x.word)).toEqual(["perro"]);
    expect(r.errors).toEqual([
      { line: 3, message: "no word" },
      { line: 4, message: "no translation" },
      { line: 5, message: 'unknown language "Klingon"' },
    ]);
  });
});

describe("readImport: more than the prompt asks for", () => {
  it("reads an Anki browser copy: tabs, other column names, intervals as progress", () => {
    const r = readImport(fixture("anki-browser.tsv"));
    expect(r.rows.map((x) => [x.word, x.translation, x.status, x.stickers.join()])).toEqual([
      ["el perro", "the dog", "known", "animals"],
      ["la ventana", "the window", "learning", "house"],
      ["aprovechar", "to take advantage of, make the most of", "learning", "verbs"],
      ["el cajón", "drawer", "new", "house"],
      ["sin embargo", "however", "known", "connectors"],
      ["la cuenta", "the bill / the account", "learning", "restaurant"],
    ]);
  });

  it("reads columns named by language (a Memrise export)", () => {
    const r = readImport(fixture("memrise.csv"));
    expect(r.rows.map((x) => [x.word, x.translation, x.lang, x.to, x.status])).toEqual([
      ["猫", "cat", "ja", "en", "known"],
      ["水", "water", "ja", "en", "known"],
      ["食べる", "to eat", "ja", "en", "new"],
      ["駅", "station", "ja", "en", "new"],
      ["大丈夫", "OK, all right, fine", "ja", "en", "learning"],
    ]);
  });

  it("reads a spreadsheet copy with headers in another language", () => {
    const r = readImport("(aus Excel kopiert)\nWort\tÜbersetzung\tGelernt?\nla mesa\tder Tisch\tja\nla silla\tder Stuhl\tnein\n");
    expect(r.rows.map((x) => [x.word, x.translation, x.status])).toEqual([
      ["la mesa", "der Tisch", "known"],
      ["la silla", "der Stuhl", "new"],
    ]);
  });

  it("reads semicolons, markdown tables and old Duocards columns", () => {
    expect(words("Palabra;Traducción;Ejemplo\nperro;dog;El perro ladra.\n")).toEqual(["perro"]);
    const md = "Here are your cards:\n\n| Word | Translation | Status |\n|---|---|---|\n| perro | dog | known |\n| gato | cat | learning |\n\nEnjoy!";
    expect(readImport(md).rows.map((x) => [x.word, x.status])).toEqual([["perro", "known"], ["gato", "learning"]]);
    const duo = readImport('front,back,hint,publishedAt\nla cuenta,счёт,"La cuenta, por favor.",2026-03-05T10:00:00Z\naprovechar,воспользоваться,,2026-03-01T10:00:00Z\n');
    expect(duo.rows.map((x) => [x.word, x.example, x.created])).toEqual([
      ["la cuenta", "La cuenta, por favor.", Date.parse("2026-03-05T10:00:00Z")],
      ["aprovechar", "", Date.parse("2026-03-01T10:00:00Z")],
    ]);
  });

  it("ends an unfenced table at the blank line before the chat text", () => {
    const r = readImport('word,translation\nperro,dog\n\nLet me know if you want "more" words, or other topics!');
    expect(r.rows.map((x) => x.word)).toEqual(["perro"]);
    expect(r.errors).toEqual([]);
  });

  it("reads language names and other codes", () => {
    for (const [raw, code] of [["es", "es"], ["ES", "es"], ["es-MX", "es"], ["pt_BR", "pt"], ["spa", "es"], ["Spanish", "es"], ["español", "es"], ["испанский", "es"], ["Deutsch", "de"], ["jp", "ja"], ["Japanese", "ja"], ["日本語", "ja"]] as const) expect(langCode(raw)).toBe(code);
    expect(langCode("Klingon")).toBeUndefined();
  });

  it("reads progress in many words", () => {
    for (const s of ["known", "Mastered", "yes", "TRUE", "1", "✓", "Fully grown", "4/4", "Strength: 4/4", "100%", "да", "sí"]) expect(readStatus(s)).toBe("known");
    for (const s of ["learning", "In progress", "seen", "young", "Watering", "2/4", "40%"]) expect(readStatus(s)).toBe("learning");
    for (const s of ["", "new", "no", "0/4", "Seed", "Ignored", "whatever"]) expect(readStatus(s)).toBe("new");
    expect([intervalStatus("142d"), intervalStatus("3 weeks"), intervalStatus("2mo"), intervalStatus("1d"), intervalStatus("10 min"), intervalStatus("")]).toEqual(["known", "known", "known", "learning", "learning", "new"]);
  });

  it("reads dates in many shapes", () => {
    const d = Date.UTC(2026, 2, 5);
    // 05/03/2026 is ambiguous: read day first.
    for (const s of ["2026-03-05", "2026/03/05", "05.03.2026", "5.3.2026", "05/03/2026", String(d / 1000), String(d)]) expect(readDate(s)).toBe(d);
    expect(readDate("12/31/2026")).toBe(Date.UTC(2026, 11, 31));
    expect(readDate("2026-03-05T10:00:00Z")).toBe(Date.parse("2026-03-05T10:00:00Z"));
    expect(readDate("soon")).toBeUndefined();
  });

  it("knows a script's language", () => {
    expect(scriptLang(["счёт", "ящик"])).toBe("ru");
    expect(scriptLang(["рахунок", "їжа"])).toBe("uk");
    expect(scriptLang(["食べる", "猫"])).toBe("ja");
    expect(scriptLang(["the dog"])).toBeUndefined();
  });
});

describe("planImport", () => {
  it("fills languages a row doesn't name, skips what exists or repeats, orders dated rows oldest first", () => {
    const read = readImport("word,translation,lang,to,date\nb,B,,,2026-02-01\na,A,,,2026-01-01\nperro,dog,es,en,\nc,C,de,,\nC,c,de,ru,\n");
    const plan = planImport(read, [{ fields: { front: "Perro ", back: "Dog" }, lang_pair: ES_EN }], { from: "es", to: "ru" });
    expect(plan.ready.map((r) => [r.word, `${r.pair.from}>${r.pair.to}`])).toEqual([
      ["a", "es>ru"],
      ["b", "es>ru"],
      ["c", "de>ru"],
    ]);
    expect(plan.skipped.map((s) => s.reason)).toEqual(["exists", "repeated"]);
    expect(plan.unnamed).toBe(3);
  });

  it("refuses a pair in one language", () => {
    const plan = planImport(readImport("word,translation,lang,to\nperro,dog,es,es\n"), [], ES_EN);
    expect(plan.errors).toEqual([{ line: 2, message: "word and translation in the same language" }]);
  });
});

describe("importEvents", () => {
  it("makes a note with both cards per word, carrying notes and the picture's details", () => {
    const plan = planImport(readImport(fixture("reply-anki.md")), [], ES_EN);
    const { events, noteIds } = importEvents(new EventFactory("dev", () => 1), plan.ready, new Map([["es", 7]]));
    expect(noteIds).toHaveLength(6);
    expect(events.filter((e) => e.type === "card_created")).toHaveLength(12);
    const cuenta = events.find((e): e is NoteCreated => e.type === "note_created" && e.payload.fields.front === "la cuenta")!;
    expect(cuenta.payload).toMatchObject({ deck_id: 7, lang_pair: ES_EN, source: { kind: "import" }, fields: { back: "the bill / the account", memo_known: "also: a bank account", picture_details: "a restaurant bill, not a bank account" } });
  });
});

describe("importPrompt", () => {
  const name = (c: string) => ({ es: "Spanish", de: "German", en: "English", ru: "Russian" })[c] ?? c;
  it("names the usual languages, and ends in the language spoken", () => {
    const p = importPrompt([{ from: "es", to: "en" }, { from: "de", to: "en" }], "ru", name);
    expect(p).toContain("learning Spanish (es) or German (de), with translations in English (en).");
    expect(p).toContain(IMPORT_HEADER);
    expect(p.trim().endsWith("Вот мой экспорт или то, что я хочу выучить:")).toBe(true);
    expect(importPrompt([{ from: "es", to: "en" }, { from: "de", to: "ru" }], "en", name)).toContain("Spanish (es) with translations in English (en) or German (de) with translations in Russian (ru).");
    expect(importPrompt([], "xx", name)).not.toContain("I'm usually");
  });
});

describe("Store.importWords", () => {
  it("adds the words with their stickers and progress", async () => {
    const d = await Device.open();
    const plan = planImport(readImport(fixture("reply-anki.md")), [], ES_EN);
    const deck = d.store.factory.deck("Spanish", d.store.preset().preset_id, ES_EN);
    await d.store.append([deck]);
    const deckId = (deck.payload as { deck_id: number }).deck_id;
    const res = await d.store.importWords(plan.ready, async () => deckId);
    expect(res.words).toBe(6);
    const col = d.store.col;
    const names = res.labels.map((id) => col.labels.get(id)!.name).sort();
    expect(names).toEqual(["Animals", "Connectors", "House", "Restaurant", "Verbs"]);
    const note = (w: string) => col.liveNotes().find((n) => n.fields.front === w)!;
    // Known: answered Easy once; learning: queued first; new: untouched.
    const reviewed = new Set(col.reviews.map((r) => r.payload.note_id));
    expect(reviewed.has(note("el perro").id) && reviewed.has(note("sin embargo").id)).toBe(true);
    expect(col.reviews.every((r) => r.payload.rating === 4)).toBe(true);
    expect(reviewed.size).toBe(2);
    expect(note("la ventana").priority).toBeDefined();
    expect(note("el cajón").priority).toBeUndefined();
    expect(note("la cuenta").fields.picture_details).toBe("a restaurant bill, not a bank account");
  });
});
