import { describe, expect, it } from "bun:test";
import { addEvents, draftOf, duplicates, saveEvents, undoEvents, type CardDraft } from "../src/domain/cards";
import { Collection, EventFactory, type Note } from "../src/domain/collection";
import type { AppEvent, LangPair, NoteEdited, NotesLabeled } from "../src/domain/events";

const ES_EN: LangPair = { from: "es", to: "en" };
const ES_RU: LangPair = { from: "es", to: "ru" };

let t = Date.UTC(2026, 10, 25);
const f = new EventFactory("dev", () => (t += 1000));

function collection(...cards: [string, string, LangPair?][]): Collection {
  const col = new Collection();
  for (const [front, back, pair] of cards) for (const e of f.note(1, { front, back }, pair ?? ES_EN)) col.apply(e);
  return col;
}

function draft(text: Partial<CardDraft["text"]>, rest: Partial<Omit<CardDraft, "text">> = {}): CardDraft {
  const d = draftOf(rest.lang_pair ?? ES_EN);
  return { ...d, ...rest, text: { ...d.text, ...text } };
}

const types = (evs: AppEvent[]) => evs.map((e) => e.type);

describe("duplicates", () => {
  const col = collection(["banco", "bench"], ["mesa", "table"], ["banco", "bank", ES_RU]);
  const notes = () => col.liveNotes();

  it("finds an exact repeat, ignoring case, spaces and Unicode form", () => {
    const r = duplicates(notes(), { front: "  Banco ", back: "BENCH", lang_pair: ES_EN });
    expect(r.exact?.fields.back).toBe("bench");
    expect(r.sameWord).toEqual([]);
    const nfd = "café";
    const c2 = collection([nfd, "coffee"]);
    expect(duplicates(c2.liveNotes(), { front: "café", back: "coffee", lang_pair: ES_EN }).exact).toBeDefined();
  });

  it("tells about the same word with another translation, without refusing it", () => {
    const r = duplicates(notes(), { front: "banco", back: "bank", lang_pair: ES_EN });
    expect(r.exact).toBeUndefined();
    expect(r.sameWord.map((n) => n.fields.back)).toEqual(["bench"]);
  });

  it("finds the same word before a translation is typed", () => {
    expect(duplicates(notes(), { front: "banco", back: "", lang_pair: ES_EN }).sameWord.length).toBe(1);
  });

  it("matches only the same language pair", () => {
    expect(duplicates(notes(), { front: "banco", back: "bench", lang_pair: ES_RU })).toMatchObject({ exact: undefined });
    expect(duplicates(notes(), { front: "banco", back: "bench", lang_pair: ES_RU }).sameWord.map((n) => n.fields.back)).toEqual(["bank"]);
    expect(duplicates(notes(), { front: "banco", back: "bench", lang_pair: { from: "pt", to: "en" } })).toEqual({ exact: undefined, sameWord: [] });
  });

  it("ignores deleted cards and the card being edited", () => {
    const n = notes().find((x) => x.fields.front === "mesa")!;
    expect(duplicates(notes(), { front: "mesa", back: "table", lang_pair: ES_EN }, n.id)).toEqual({ exact: undefined, sameWord: [] });
    col.apply(f.make("note_deleted", { note_id: n.id }));
    expect(duplicates(col.liveNotes(), { front: "mesa", back: "table", lang_pair: ES_EN }).exact).toBeUndefined();
  });

  it("finds nothing for an empty word", () => {
    expect(duplicates(notes(), { front: "  ", back: "bench", lang_pair: ES_EN })).toEqual({ exact: undefined, sameWord: [] });
  });
});

describe("addEvents", () => {
  it("writes the card and its two faces, trimmed, without empty places", () => {
    const { events, noteId } = addEvents(f, 7, draft({ front: " banco ", back: "bench", example: "  " }));
    expect(types(events)).toEqual(["note_created", "card_created", "card_created"]);
    const col = new Collection();
    events.forEach((e) => col.apply(e));
    const n = col.liveNote(noteId)!;
    expect(n.fields).toEqual({ front: "banco", back: "bench" });
    expect(n.deck_id).toBe(7);
    expect(n.lang_pair).toEqual(ES_EN);
  });

  it("keeps the example and both own notes", () => {
    const { events, noteId } = addEvents(f, 7, draft({ front: "banco", back: "bench", example: "Me siento en el banco.", memo_target: "also: bank!", memo_known: "park" }));
    const col = new Collection();
    events.forEach((e) => col.apply(e));
    expect(col.liveNote(noteId)!.fields).toEqual({ front: "banco", back: "bench", example: "Me siento en el banco.", memo_target: "also: bank!", memo_known: "park" });
  });

  it("sticks its stickers and attaches its picture in the same batch", () => {
    const { events, noteId } = addEvents(f, 7, draft({ front: "banco", back: "bench" }, { labels: [11, 12, 11], picture: { key: "pics/a.jpg", sense: "bench", scene: "a bench", details: "in a park" } }));
    expect(types(events)).toEqual(["note_created", "card_created", "card_created", "notes_labeled", "notes_labeled", "asset_attached"]);
    const col = new Collection();
    events.forEach((e) => col.apply(e));
    expect(col.labelsOf(noteId)).toEqual([]); // stickers that don't exist aren't worn
    expect(col.liveNote(noteId)!.picture).toEqual({ key: "pics/a.jpg", sense: "bench", scene: "a bench", details: "in a park" });
  });

  it("records 'no picture' so none is drawn later", () => {
    const { events, noteId } = addEvents(f, 7, draft({ front: "banco", back: "bench" }, { picture: null }));
    const col = new Collection();
    events.forEach((e) => col.apply(e));
    expect(col.liveNote(noteId)!.noPicture).toBe(true);
  });
});

describe("saveEvents", () => {
  function card(): { col: Collection; n: Note } {
    const col = collection(["banco", "bench"]);
    const n = col.liveNotes()[0];
    col.apply(f.make("asset_attached", { note_id: n.id, kind: "image", r2_key: "pics/old.jpg" }));
    return { col, n: col.liveNote(n.id)! };
  }

  it("writes nothing when nothing changed", () => {
    const { n } = card();
    expect(saveEvents(f, n, [], draftOf(ES_EN, n))).toEqual([]);
  });

  it("writes only the changed places, own notes included", () => {
    const { col, n } = card();
    const d = draftOf(ES_EN, n);
    d.text.back = " bench ";
    d.text.example = "Me siento.";
    d.text.memo_known = "park";
    const evs = saveEvents(f, n, [], d) as NoteEdited[];
    expect(evs.map((e) => [e.payload.field, e.payload.value])).toEqual([
      ["example", "Me siento."],
      ["memo_known", "park"],
    ]);
    evs.forEach((e) => col.apply(e));
    expect(col.liveNote(n.id)!.fields).toMatchObject({ example: "Me siento.", memo_known: "park" });
  });

  it("clears a place emptied by the user, but never the word or translation", () => {
    const col = new Collection();
    for (const e of f.note(1, { front: "banco", back: "bench", example: "x" }, ES_EN)) col.apply(e);
    const n = col.liveNotes()[0];
    const d = draftOf(ES_EN, n);
    d.text.example = "";
    d.text.front = " ";
    expect((saveEvents(f, n, [], d) as NoteEdited[]).map((e) => [e.payload.field, e.payload.value])).toEqual([["example", ""]]);
  });

  it("sticks on and peels off only the stickers that changed", () => {
    const { n } = card();
    const d = draftOf(ES_EN, n, [1, 2]);
    d.labels = [2, 3];
    const evs = saveEvents(f, n, [1, 2], d) as NotesLabeled[];
    expect(evs.map((e) => [e.payload.label_id, e.payload.on])).toEqual([
      [3, true],
      [1, false],
    ]);
  });

  it("attaches a redrawn picture, and nothing for the same one", () => {
    const { n } = card();
    expect(saveEvents(f, n, [], { ...draftOf(ES_EN, n), picture: { key: "pics/old.jpg" } })).toEqual([]);
    expect(types(saveEvents(f, n, [], { ...draftOf(ES_EN, n), picture: { key: "pics/new.jpg" } }))).toEqual(["asset_attached"]);
  });

  it("removes the picture once", () => {
    const { col, n } = card();
    const evs = saveEvents(f, n, [], { ...draftOf(ES_EN, n), picture: null });
    expect(types(evs)).toEqual(["asset_attached"]);
    evs.forEach((e) => col.apply(e));
    expect(saveEvents(f, col.liveNote(n.id)!, [], { ...draftOf(ES_EN, n), picture: null })).toEqual([]);
  });

  it("keeps the card's languages", () => {
    const { n } = card();
    expect(draftOf(ES_RU, n).lang_pair).toEqual(ES_EN);
  });
});

describe("undo", () => {
  it("puts an edited card back as it was: text, stickers and picture", () => {
    const col = collection(["banco", "bench"]);
    const id = col.liveNotes()[0].id;
    col.apply(f.make("asset_attached", { note_id: id, kind: "image", r2_key: "pics/old.jpg" }));
    const was = structuredClone(col.liveNote(id)!);
    const d = { ...draftOf(ES_EN, was, [1]), picture: { key: "pics/new.jpg" } };
    d.text.back = "bank";
    d.labels = [2];
    for (const e of saveEvents(f, was, [1], d)) col.apply(e);
    expect(col.liveNote(id)!.fields.back).toBe("bank");
    const undo = undoEvents(f, col.liveNote(id)!, [2], was, [1]);
    for (const e of undo) col.apply(e);
    const n = col.liveNote(id)!;
    expect([n.fields.back, n.picture?.key]).toEqual(["bench", "pics/old.jpg"]);
    expect((undo.filter((e) => e.type === "notes_labeled") as NotesLabeled[]).map((e) => [e.payload.label_id, e.payload.on])).toEqual([
      [1, true],
      [2, false],
    ]);
  });

  it("brings a deleted card back; the later of delete and restore wins in any order", () => {
    const col = collection(["banco", "bench"]);
    const id = col.liveNotes()[0].id;
    const del = f.make("note_deleted", { note_id: id });
    const back = f.make("note_restored", { note_id: id });
    col.apply(back); // arrives first (another device), but is the later one
    col.apply(del);
    expect(col.liveNote(id)).toBeDefined();
    col.apply(f.make("note_deleted", { note_id: id }));
    expect(col.liveNote(id)).toBeUndefined();
  });
});
