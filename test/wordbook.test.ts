import { describe, expect, it } from "bun:test";
import { Collection, EventFactory } from "../src/domain/collection";
import type { AppEvent } from "../src/domain/events";
import { monotonicClock, Wordbook, WordbookError } from "../src/domain/wordbook";

/** A user's log as the app writes it: a preset, a Spanish deck and two words, one studied. */
function userLog(): { events: AppEvent[]; f: EventFactory } {
  const f = new EventFactory("phone");
  const preset = f.preset({ preset_id: 7 });
  const deck = f.deck("Spanish", 7, { from: "es", to: "ru" }, 11);
  const a = f.note(11, { front: "el perro", back: "собака", example: "El perro ladra." }, { from: "es", to: "ru" });
  const b = f.note(11, { front: "el gato", back: "кошка" }, { from: "es", to: "ru" });
  const cardA = (a[1].payload as { card_id: number }).card_id;
  const noteA = (a[0].payload as { note_id: number }).note_id;
  const review = f.make("review", { card_id: cardA, note_id: noteA, deck_id: 11, preset_id: 7, rating: 3, duration_ms: 3000, tz_offset_min: 180, pile: "lang:es" });
  return { events: [preset, deck, ...a, ...b, review], f };
}

const LOG = userLog().events;

function book(events = LOG): Wordbook {
  const col = new Collection();
  for (const e of events) col.apply(e);
  return new Wordbook(col, new EventFactory("claude", monotonicClock()));
}

/** The events a wordbook made, replayed on the user's log in a fresh fold: what the app will see after a sync. */
function replayed(w: Wordbook, base = LOG): Collection {
  const col = new Collection();
  for (const e of [...base, ...w.made]) col.apply(e);
  return col;
}

describe("wordbook: reading", () => {
  it("lists words with their languages, notes and status", () => {
    const w = book();
    const { total, words } = w.find();
    expect(total).toBe(2);
    expect(words[0]).toMatchObject({ word: "el perro", translation: "собака", example: "El perro ladra.", language: "es", translation_language: "ru", status: "learning", stickers: [] });
    expect(words[1]).toMatchObject({ word: "el gato", status: "new" });
  });

  it("finds by text (case and accents aside), status and language name", () => {
    const w = book();
    expect(w.find({ text: "PERRO" }).words.map((x) => x.word)).toEqual(["el perro"]);
    expect(w.find({ status: "new" }).words.map((x) => x.word)).toEqual(["el gato"]);
    expect(w.find({ language: "Spanish" }).total).toBe(2);
    expect(w.find({ language: "de" }).total).toBe(0);
    expect(() => w.find({ language: "Klingon" })).toThrow(WordbookError);
  });

  it("gives an overview of languages and stickers", () => {
    const w = book();
    w.stick("Animals", w.find().words.map((x) => x.id), true);
    expect(w.overview()).toEqual({ words: 2, languages: [{ language: "es", translation_languages: ["ru"], words: 2, new: 1, learning: 1, known: 0 }], stickers: [{ name: "Animals", words: 2 }] });
  });
});

describe("wordbook: adding", () => {
  it("adds words into the language's deck, translated as its words are, with stickers", () => {
    const w = book();
    const { added, skipped } = w.add([
      { word: "la casa", translation: "дом", language: "es", stickers: ["Home"] },
      { word: "la mesa", translation: "стол", language: "Spanish", example: "La mesa es grande.", stickers: ["home "] },
    ]);
    expect(skipped).toEqual([]);
    expect(added.map((x) => [x.word, x.translation_language, x.stickers])).toEqual([
      ["la casa", "ru", ["Home"]],
      ["la mesa", "ru", ["Home"]],
    ]);
    const col = replayed(w);
    const n = col.liveNotes().find((x) => x.fields.front === "la mesa")!;
    expect(n.deck_id).toBe(11);
    expect(n.fields.example).toBe("La mesa es grande.");
    expect(n.source).toBeUndefined();
    expect(col.cardsByNote.get(n.id)).toHaveLength(2);
    expect(col.liveLabels().map((l) => l.name)).toEqual(["Home"]);
  });

  it("skips words already there and repeats, so adding a list twice adds nothing", () => {
    const w = book();
    const { added, skipped } = w.add([
      { word: "El Perro ", translation: "собака", language: "es" },
      { word: "el sol", translation: "солнце", language: "es" },
      { word: "el sol", translation: "солнце", language: "es" },
    ]);
    expect(added.map((x) => x.word)).toEqual(["el sol"]);
    expect(skipped.map((s) => [s.word, s.reason])).toEqual([
      ["El Perro", "exists"],
      ["el sol", "repeated"],
    ]);
    expect(skipped[0].id).toBe(w.find({ text: "perro" }).words[0].id);
    expect(w.add([{ word: "el sol", translation: "солнце", language: "es" }]).added).toEqual([]);
  });

  it("a word already there gets the stickers given and the example and notes it lacks, nothing written over", () => {
    const w = book();
    w.stick("Pets", [w.find({ text: "gato" }).words[0].id], true);
    const { added, updated, skipped } = w.add([
      { word: "el perro", translation: "собака", language: "es", example: "Mi perro duerme.", note: "masculine", stickers: ["Pets", "Home"] },
      { word: "el gato", translation: "кошка", language: "es", example: "El gato come.", stickers: ["Pets"] },
    ]);
    expect(added).toEqual([]);
    expect(skipped.map((s) => s.reason)).toEqual(["exists", "exists"]);
    expect(updated.map((x) => x.word)).toEqual(["el perro", "el gato"]);
    const col = replayed(w);
    const note = (front: string) => col.liveNotes().find((n) => n.fields.front === front)!;
    const wears = (front: string) => col.labelsOf(note(front).id).map((l) => l.name).sort();
    expect(note("el perro").fields).toMatchObject({ example: "El perro ladra.", memo_target: "masculine" }); // its example stays
    expect(wears("el perro")).toEqual(["Home", "Pets"]);
    expect(note("el gato").fields.example).toBe("El gato come.");
    expect(wears("el gato")).toEqual(["Pets"]);
    // the same call again changes nothing
    const again = book([...LOG, ...w.made]);
    expect(again.add([{ word: "el gato", translation: "кошка", language: "es", example: "Otro.", stickers: ["Pets"] }]).updated).toEqual([]);
    expect(again.made).toEqual([]);
  });

  it("makes a new language's deck the way the app does, so devices agree", () => {
    const w = book();
    const [word] = w.add([{ word: "der Hund", translation: "dog", language: "German", translation_language: "English" }]).added;
    expect(word).toMatchObject({ language: "de", translation_language: "en" });
    const deck = [...w.col.decks.values()].find((d) => d.lang_pair.from === "de")!;
    expect(deck.preset_id).toBe(7);
    expect(deck.name).toBe("German");
    // Adding German words in a second request reuses that deck.
    const again = book([...LOG, ...w.made]);
    again.add([{ word: "die Katze", translation: "cat", language: "de" }]);
    expect(again.made.some((e) => e.type === "deck_created")).toBe(false);
  });

  it("marks words added as known or learning", () => {
    const w = book();
    const { added } = w.add([
      { word: "sí", translation: "да", language: "es", status: "known" },
      { word: "la luna", translation: "луна", language: "es", status: "learning" },
    ]);
    expect(added.map((x) => x.status)).toEqual(["known", "new"]);
    const col = replayed(w);
    const known = col.liveNotes().find((n) => n.fields.front === "sí")!;
    const reviews = col.reviews.filter((r) => r.payload.note_id === known.id);
    expect(reviews.map((r) => [r.payload.rating, r.payload.pile, r.payload.tz_offset_min])).toEqual([
      [4, undefined, 180],
      [4, undefined, 180],
    ]);
    expect(col.liveNotes().find((n) => n.fields.front === "la luna")!.priority).toBeGreaterThan(0);
  });

  it("refuses words without a translation or in one language", () => {
    const w = book();
    expect(() => w.add([{ word: "hola", translation: " ", language: "es" }])).toThrow(WordbookError);
    expect(() => w.add([{ word: "hola", translation: "hola", language: "es", translation_language: "Spanish" }])).toThrow(WordbookError);
    expect(w.made).toEqual([]);
  });
});

describe("wordbook: changing", () => {
  it("edits only what is given, as Save does", () => {
    const w = book();
    const id = w.find({ text: "perro" }).words[0].id;
    const v = w.edit(id, { example: "Mi perro duerme.", note: "masculine" });
    expect(v).toMatchObject({ word: "el perro", example: "Mi perro duerme.", note: "masculine" });
    expect(w.made.map((e) => e.type)).toEqual(["note_edited", "note_edited"]);
    expect(() => w.edit(id, { word: "" })).toThrow(WordbookError);
  });

  it("translates a word into another language, progress and the pile kept", () => {
    const w = book();
    const id = w.find({ text: "perro" }).words[0].id;
    const v = w.edit(id, { translation: "dog", translation_language: "English" });
    expect(v).toMatchObject({ translation: "dog", language: "es", translation_language: "en", status: "learning" });
    expect(w.made.map((e) => e.type)).toEqual(["note_edited", "note_lang_changed"]);
    const col = replayed(w);
    expect(col.liveNote(id)!.lang_pair).toEqual({ from: "es", to: "en" });
    expect(col.liveNote(id)!.deck_id).toBe(11);
    // The note_created event itself is untouched.
    expect(LOG.find((e) => e.type === "note_created" && e.payload.note_id === id)!.payload).toMatchObject({ lang_pair: { from: "es", to: "ru" } });
    // Same language again: nothing written.
    w.edit(id, { translation_language: "en" });
    expect(w.made).toHaveLength(2);
    expect(() => w.edit(id, { translation_language: "es" })).toThrow(WordbookError);
    expect(() => w.edit(id, { translation_language: "Klingon" })).toThrow(WordbookError);
  });

  it("takes a word by what it was before it was translated: the old list again adds nothing", () => {
    const w = book();
    const id = w.find({ text: "perro" }).words[0].id;
    w.edit(id, { translation: "dog", translation_language: "en", translation_note: "a pet" });
    const again = w.add([{ word: "el perro", translation: "собака", language: "es", translation_language: "ru", translation_note: "питомец", stickers: ["Pets"] }]);
    expect(again.added).toEqual([]);
    expect(again.skipped).toEqual([{ word: "el perro", translation: "собака", reason: "exists", id }]);
    // Its stickers still go on; its Russian note doesn't land on the English side.
    expect(again.updated[0]).toMatchObject({ id, stickers: ["Pets"], translation_note: "a pet" });
    // Once another word is that word now, the row is that one.
    const fresh = w.add([{ word: "el perro", translation: "собака", language: "es", translation_language: "ru" }]);
    expect(fresh.added).toEqual([]);
  });

  it("edits many at once, or none when one can't be made", () => {
    const w = book();
    const [a, b] = w.find().words.map((x) => x.id);
    expect(() => w.editAll([{ id: a, translation: "dog", translation_language: "en" }, { id: b, translation: "" }])).toThrow(new RegExp(`word ${b}`));
    const w2 = book();
    expect(w2.editAll([{ id: a, translation: "dog", translation_language: "en" }, { id: b, translation: "cat", translation_language: "en" }]).map((v) => v.translation_language)).toEqual(["en", "en"]);
  });

  it("deletes and restores, progress kept", () => {
    const w = book();
    const id = w.find({ text: "perro" }).words[0].id;
    w.remove([id]);
    expect(w.find().total).toBe(1);
    expect(w.find({ deleted: true }).words.map((x) => x.id)).toEqual([id]);
    expect(() => w.edit(id, { example: "x" })).toThrow(/deleted/);
    const [back] = w.restore([id]);
    expect(back).toMatchObject({ id, status: "learning" });
    expect(replayed(w).liveNote(id)).toBeDefined();
  });

  it("I know / Don't know write what the app's buttons write", () => {
    const w = book();
    const [perro, gato] = w.find().words.map((x) => x.id);
    w.markUnknown([perro, gato]);
    const col = replayed(w);
    expect(col.reviews.filter((r) => r.payload.note_id === perro).map((r) => r.payload.rating)).toEqual([3, 1]);
    expect(col.notes.get(gato)!.priority).toBeGreaterThan(0);
    const [k] = w.markKnown([gato]);
    expect(k.status).toBe("known");
    expect(() => w.markKnown([])).toThrow(WordbookError);
    expect(() => w.markKnown([12345])).toThrow(/no word/);
  });

  it("sticks, peels, renames (merging into an existing name) and deletes stickers", () => {
    const w = book();
    const [perro, gato] = w.find().words.map((x) => x.id);
    w.stick("Pets", [perro, gato], true);
    w.stick("pets", [gato], false);
    expect(w.find({ sticker: "PETS" }).words.map((x) => x.id)).toEqual([perro]);
    w.stick("Animals", [gato], true);
    expect(w.renameSticker("Pets", "animals")).toBe("Animals");
    expect(w.find({ sticker: "Animals" }).words.map((x) => x.id).sort()).toEqual([perro, gato].sort());
    expect(() => w.stick("Pets", [perro], false)).toThrow(/no sticker named "Pets"/);
    expect(w.renameSticker("Animals", "Zoo")).toBe("Zoo");
    w.deleteSticker("zoo");
    expect(w.overview().stickers).toEqual([]);
    expect(replayed(w).liveLabels()).toEqual([]);
  });
});
