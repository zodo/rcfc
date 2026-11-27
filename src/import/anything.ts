// Your AI's data side: words an AI chat (or a person) wrote as a table, pasted
// or picked as a file. The prompt the app copies (`importPrompt`) asks for one
// exact CSV header; the reader takes much more than it asks for, without saying
// so: the whole chat reply around the code block, several blocks, tab or
// semicolon separators, markdown tables, other column names, language names
// instead of codes, other words for progress, dates in other formats.
//
// Pure: text in, rows and a plan out. The Store applies a plan (`importWords`).

import { parseCsv, CsvError } from "./csv";
import type { AppEvent, LangPair, NoteCreated, NoteEdited, NoteFields } from "../domain/events";
import type { Collection, EventFactory } from "../domain/collection";
import type { EntityId } from "../domain/ids";

export type WordStatus = "new" | "learning" | "known";

/** One word as read from the table, before languages are settled. */
export interface ImportRow {
  /** 1-based line in the pasted text, for messages. */
  line: number;
  word: string;
  translation: string;
  example: string;
  note: string;
  translationNote: string;
  /** What the picture should show; drawn when the word comes up. */
  picture: string;
  stickers: string[];
  status: WordStatus;
  /** Language codes from the row, when it names them. */
  lang?: string;
  to?: string;
  /** When the source app made it, ms since epoch: only orders the new words. */
  created?: number;
}

export interface RowError {
  line: number;
  message: string;
}

export interface ReadResult {
  rows: ImportRow[];
  /** Rows naming a word by its id: changes to words already there (`planChanges`). */
  changes: ChangeRow[];
  errors: RowError[];
  /** Nothing in the text looked like a table of words. */
  noTable: boolean;
}

/** The studied languages the app knows (src/ui/h.ts LANGS), kept here so this module stays DOM-free. */
export const IMPORT_LANGS = ["es", "en", "ru", "uk", "de", "fr", "it", "pt", "pl", "nl", "tr", "ja", "zh", "ko", "ar", "he", "sv", "cs"];

// ---------------------------------------------------------------- columns

type Col = "id" | "word" | "translation" | "example" | "lang" | "to" | "note" | "translationNote" | "picture" | "stickers" | "status" | "interval" | "created";

/** Header names, squashed (`squash`): lower case, letters and digits only. */
const COLUMN_NAMES: Record<Col, string[]> = {
  id: ["id", "wordid", "noteid"],
  word: ["word", "words", "front", "frontside", "term", "phrase", "expression", "vocab", "vocabulary", "lemma", "sortfield", "question", "foreign", "original", "слово", "palabra", "wort", "mot", "parola", "palavra", "słowo", "woord", "kelime", "単語", "词", "단어"],
  translation: ["translation", "translations", "back", "backside", "meaning", "definition", "answer", "gloss", "перевод", "переклад", "traducción", "traduccion", "übersetzung", "traduction", "traduzione", "tradução", "traducao", "tłumaczenie", "vertaling", "çeviri", "翻訳", "翻译", "번역", "translationen"],
  example: ["example", "examples", "examplesentence", "sentence", "hint", "usage", "context", "sample", "пример", "приклад", "ejemplo", "beispiel", "exemple", "esempio", "exemplo", "przykład", "voorbeeld", "örnek"],
  lang: ["lang", "language", "wordlang", "wordlanguage", "fromlang", "from", "langfrom", "sourcelang", "sourcelanguage", "язык", "idioma", "sprache", "langue", "lingua"],
  to: ["to", "tolang", "langto", "translationlang", "translationlanguage", "targetlang", "targetlanguage", "meaninglang"],
  note: ["note", "notes", "wordnote", "frontnote", "memo", "tip", "comment", "comments", "remark", "заметка", "примечание", "nota", "notiz", "anmerkung"],
  translationNote: ["translationnote", "translationnotes", "backnote", "meaningnote", "notetranslation"],
  picture: ["picture", "image", "illustration", "imageprompt", "pictureprompt", "picturedetails", "draw", "howitlooks", "картинка", "imagen", "bild"],
  stickers: ["stickers", "sticker", "tags", "tag", "labels", "label", "deck", "decks", "lesson", "lessons", "group", "topic", "topics", "category", "categories", "list", "set", "unit", "стикеры", "теги", "тег", "урок", "etiquetas", "lección", "leccion", "lektion", "thema"],
  status: ["status", "progress", "known", "learned", "learnt", "mastered", "state", "strength", "familiarity", "статус", "выучено", "estado", "gelernt", "état", "etat", "stato"],
  interval: ["interval", "ivl", "intervaldays", "интервал", "intervalo", "intervall"],
  created: ["created", "createdat", "publishedat", "published", "added", "addedat", "dateadded", "date", "timestamp", "дата", "fecha", "datum"],
};

const squash = (s: string) => s.normalize("NFC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

const BY_NAME = new Map<string, Col>();
for (const [col, names] of Object.entries(COLUMN_NAMES) as [Col, string[]][]) for (const n of names) BY_NAME.set(squash(n), col);

interface Header {
  cols: Map<Col, number>;
  /** Languages the header names its columns by ("Spanish,English"). */
  lang?: string;
  to?: string;
}

/**
 * Which column each header cell is (first one wins), or undefined when the row is
 * no header of ours. Columns named by language ("Japanese,Kana,English") are the
 * word (the first) and the translation (the last).
 */
function mapHeader(cells: string[]): Header | undefined {
  const cols = new Map<Col, number>();
  const langCols: [number, string][] = [];
  cells.forEach((c, i) => {
    const col = BY_NAME.get(squash(c));
    if (col && !cols.has(col)) cols.set(col, i);
    else if (!col) {
      const code = languageNames().get(squash(c));
      if (code) langCols.push([i, code]);
    }
  });
  const h: Header = { cols };
  if (langCols.length >= 2 && !cols.has("word") && !cols.has("translation")) {
    const [w, t] = [langCols[0], langCols.at(-1)!];
    cols.set("word", w[0]).set("translation", t[0]);
    h.lang = w[1];
    h.to = t[1];
  } else if (langCols.length === 1 && cols.has("word") !== cols.has("translation")) {
    // "Spanish,Translation" / "Word,English"
    cols.set(cols.has("word") ? "translation" : "word", langCols[0][0]);
    h[cols.get("word") === langCols[0][0] ? "lang" : "to"] = langCols[0][1];
  }
  return cols.has("word") && cols.has("translation") ? h : undefined;
}

// ---------------------------------------------------------------- languages

/** ISO 639-2 and common country-style codes people write instead. */
const CODE_ALIASES: Record<string, string> = {
  spa: "es", eng: "en", rus: "ru", ukr: "uk", ua: "uk", deu: "de", ger: "de", fra: "fr", fre: "fr", ita: "it", por: "pt", pol: "pl",
  nld: "nl", dut: "nl", tur: "tr", jpn: "ja", jp: "ja", zho: "zh", chi: "zh", cn: "zh", kor: "ko", kr: "ko", ara: "ar", heb: "he", iw: "he",
  swe: "sv", se: "sv", ces: "cs", cze: "cs", cz: "cs",
};

let names: Map<string, string> | undefined;
/** Language names in every language the app has ("Spanish", "español", "испанский" → es). */
function languageNames(): Map<string, string> {
  if (names) return names;
  names = new Map();
  for (const display of IMPORT_LANGS) {
    let dn: Intl.DisplayNames;
    try {
      dn = new Intl.DisplayNames([display], { type: "language" });
    } catch {
      continue;
    }
    for (const code of IMPORT_LANGS) {
      const n = dn.of(code);
      if (n) names.set(squash(n), code);
    }
  }
  return names;
}

/** A language as the app's code: "es", "ES", "es-MX", "spa", "Spanish", "español". Undefined when unknown. */
export function langCode(raw: string): string | undefined {
  const s = raw.trim();
  if (!s) return undefined;
  const base = s.toLowerCase().split(/[-_\s(]/)[0];
  if (IMPORT_LANGS.includes(base)) return base;
  if (CODE_ALIASES[base]) return CODE_ALIASES[base];
  return languageNames().get(squash(s)) ?? languageNames().get(squash(s.replace(/\(.*\)/, "")));
}

/**
 * The studied language a file's name gives: Duocards names its export
 * `duo_cards_es_export.csv`; others may say "spanish_words.csv".
 */
export function fileLang(name: string): string | undefined {
  const duo = /duo_?cards_([a-z]{2,3}(?:-[a-z]{2,4})?)_export/i.exec(name)?.[1];
  if (duo) return langCode(duo);
  for (const part of name.replace(/\.[^.]*$/, "").split(/[^\p{L}]+/u)) if (part.length >= 4 && languageNames().has(squash(part))) return languageNames().get(squash(part));
  return undefined;
}

// ---------------------------------------------------------------- status and dates

const KNOWN_WORDS = new Set(["known", "know", "mastered", "learned", "learnt", "done", "yes", "y", "true", "1", "x", "✓", "✔", "fullygrown", "ja", "да", "sí", "si", "oui", "sì", "sim", "tak", "evet", "gelernt", "выучено", "выучил", "знаю", "conocida", "conocido", "sabida", "bekannt", "connu", "mature", "strong"]);
const LEARNING_WORDS = new Set(["learning", "started", "inprogress", "progress", "seen", "review", "reviewing", "young", "watering", "growing", "practicing", "practising", "weak", "familiar", "partial", "half", "учу", "изучаю", "aprendiendo", "lernend", "enapprentissage"]);

/** Progress as one of three levels; anything not recognised is new. */
export function readStatus(raw: string): WordStatus {
  const s = raw.trim().toLocaleLowerCase();
  if (!s) return "new";
  // "4/4", "Strength: 2/4", "75%"
  const frac = /(\d+(?:[.,]\d+)?)\s*\/\s*(\d+(?:[.,]\d+)?)/.exec(s);
  if (frac) {
    const r = parseFloat(frac[1].replace(",", ".")) / parseFloat(frac[2].replace(",", "."));
    return r >= 1 ? "known" : r > 0 ? "learning" : "new";
  }
  const pct = /^(\d+(?:[.,]\d+)?)\s*%$/.exec(s);
  if (pct) {
    const p = parseFloat(pct[1].replace(",", "."));
    return p >= 90 ? "known" : p > 0 ? "learning" : "new";
  }
  const k = squash(s) || s;
  if (KNOWN_WORDS.has(k) || KNOWN_WORDS.has(s)) return "known";
  if (LEARNING_WORDS.has(k)) return "learning";
  return "new";
}

/** An interval from a scheduler ("142d", "3 weeks", "2mo") as a level: three weeks or more is known. */
export function intervalStatus(raw: string): WordStatus {
  const m = /(\d+(?:[.,]\d+)?)\s*([a-zа-я]*)/i.exec(raw.trim());
  if (!m) return "new";
  const n = parseFloat(m[1].replace(",", "."));
  const u = m[2].toLowerCase();
  const days = /^(w|н)/.test(u) ? n * 7 : /^(mo|m$|мес)/.test(u) ? n * 30 : /^(y|г|л)/.test(u) ? n * 365 : /^(h|ч)/.test(u) ? n / 24 : /^(min|мин)/.test(u) ? n / 1440 : n;
  return days >= 21 ? "known" : days > 0 ? "learning" : "new";
}

/** A date in the usual shapes (ISO, epoch, 31.12.2026, 12/31/2026, 2026/12/31); undefined when it isn't one. */
export function readDate(raw: string): number | undefined {
  const s = raw.trim();
  if (!s) return undefined;
  if (/^\d{9,13}$/.test(s)) {
    const n = Number(s);
    return s.length <= 10 ? n * 1000 : n;
  }
  let m = /^(\d{4})[./-](\d{1,2})[./-](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (m && !/^\d{4}-\d{2}-\d{2}T/.test(s)) return utc(+m[1], +m[2], +m[3], m[4], m[5], m[6]);
  m = /^(\d{1,2})([./-])(\d{1,2})\2(\d{2,4})(?:[ ,T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (m) {
    let [a, b] = [+m[1], +m[3]];
    const y = m[4].length === 2 ? 2000 + +m[4] : +m[4];
    // Day first, except a slash date that can only be month first (12/31/2026).
    let day = a, month = b;
    if (m[2] === "/" && b > 12 && a <= 12) [day, month] = [b, a];
    if (month > 12 && day <= 12) [day, month] = [month, day];
    return utc(y, month, day, m[5], m[6], m[7]);
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : undefined;
}

function utc(y: number, mo: number, d: number, h?: string, mi?: string, s?: string): number | undefined {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return undefined;
  return Date.UTC(y, mo - 1, d, +(h ?? 0), +(mi ?? 0), +(s ?? 0));
}

// ---------------------------------------------------------------- finding the table

interface Chunk {
  text: string;
  /** Line in the pasted text where the chunk starts (1-based). */
  line: number;
  fenced: boolean;
}

/** The code blocks in a chat reply (``` or ~~~, the last one may be cut off), else the whole text. */
function chunks(text: string): Chunk[] {
  // The prompt pasted back (with an export under it): its header line is no table.
  // `#` lines are comments: the prompt at the top of a words file (`exportWords`), a chat's markdown headings.
  const lines = text
    .replace(/\r\n?/g, "\n")
    .replace(`Header exactly:\n${IMPORT_HEADER}\n`, "Header exactly:\n\n")
    .split("\n")
    .map((l) => (/^\s*#/.test(l) ? "" : l));
  const out: Chunk[] = [];
  let open: { fence: string; start: number; body: string[] } | null = null;
  lines.forEach((l, i) => {
    const f = /^\s*(```+|~~~+)/.exec(l);
    if (open) {
      if (f && f[1][0] === open.fence[0] && f[1].length >= open.fence.length && !l.trim().slice(f[1].length).trim()) {
        out.push({ text: open.body.join("\n"), line: open.start + 1, fenced: true });
        open = null;
      } else open.body.push(l);
    } else if (f) open = { fence: f[1], start: i + 1, body: [] };
  });
  if (open) out.push({ text: (open as { body: string[] }).body.join("\n"), line: (open as { start: number }).start + 1, fenced: true });
  return out.length ? out : [{ text: lines.join("\n"), line: 1, fenced: false }];
}

const SEPARATORS = [",", "\t", ";", "|"];

/** A markdown table row: "| a | b |" → ["a", "b"]; its "|---|" line → []. */
function pipeCells(line: string): string[] | undefined {
  const t = line.trim();
  if (!t.startsWith("|") && !t.endsWith("|")) return undefined;
  const cells = t.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
  return cells.every((c) => /^:?-{2,}:?$/.test(c)) ? [] : cells;
}

/** Splits a line without quote rules: the fallback when quotes don't add up. */
const loose = (line: string, sep: string) => line.split(sep).map((c) => c.trim().replace(/^"(.*)"$/s, "$1").replace(/""/g, '"'));

interface Table {
  header: Header;
  records: { line: number; values: string[] }[];
}

/** The first header of ours in a chunk and the rows under it. */
function tableIn(c: Chunk): Table | undefined {
  const lines = c.text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) continue;
    const pipes = pipeCells(l);
    if (pipes) {
      const header = mapHeader(pipes);
      if (!header) continue;
      const records: Table["records"] = [];
      for (let j = i + 1; j < lines.length; j++) {
        const cells = pipeCells(lines[j]);
        if (!cells) break;
        if (cells.length) records.push({ line: c.line + j, values: cells });
      }
      return { header, records };
    }
    for (const sep of SEPARATORS.slice(0, 3)) {
      if (!l.includes(sep)) continue;
      const header = mapHeader(loose(l, sep));
      if (!header) continue;
      // Outside a code block the table ends at the first blank line: chat text follows it.
      let end = lines.length;
      if (!c.fenced) for (let j = i + 1; j < lines.length; j++) if (!lines[j].trim()) { end = j; break; }
      const body = lines.slice(i, end).join("\n");
      let records: Table["records"];
      try {
        records = parseCsv(body, sep).map((r) => ({ line: c.line + i + r.line - 1, values: r.values }));
      } catch (e) {
        if (!(e instanceof CsvError)) throw e;
        records = lines.slice(i, end).flatMap((x, k) => (x.trim() ? [{ line: c.line + i + k, values: loose(x, sep) }] : []));
      }
      return { header, records: records.slice(1) };
    }
  }
  return undefined;
}

// ---------------------------------------------------------------- reading

const clean = (s: string | undefined) => (s ?? "").normalize("NFC").replace(/\r\n?/g, "\n").trim();

/** Every table of words in the text, read into rows. */
export function readImport(text: string): ReadResult {
  const rows: ImportRow[] = [];
  const changes: ChangeRow[] = [];
  const errors: RowError[] = [];
  let tables = 0;
  for (const c of chunks(text)) {
    const t = tableIn(c);
    if (!t) continue;
    tables++;
    const at = (v: string[], col: Col) => {
      const i = t.header.cols.get(col);
      return i === undefined ? "" : clean(v[i]);
    };
    for (const r of t.records) {
      const v = r.values;
      if (v.every((x) => !x.trim())) continue;
      // A row that repeats the header (blocks glued together) is not a word.
      if (mapHeader(v)) continue;
      const id = at(v, "id").replace(/^#/, "");
      if (/^\d{1,16}$/.test(id) && Number(id) > 0) {
        const c: ChangeRow = { line: r.line, id: Number(id), word: at(v, "word"), translation: at(v, "translation"), example: at(v, "example"), note: at(v, "note"), translationNote: at(v, "translationNote"), stickers: at(v, "stickers"), status: at(v, "status") };
        for (const k of ["lang", "to"] as const) {
          const raw = at(v, k);
          if (!raw) continue;
          const code = langCode(raw);
          if (code) c[k] = code;
          else errors.push({ line: r.line, message: `unknown language "${raw}"` });
        }
        if (errors.at(-1)?.line !== r.line) changes.push(c);
        continue;
      }
      const word = at(v, "word");
      const translation = at(v, "translation");
      if (!word || !translation) {
        errors.push({ line: r.line, message: !word ? "no word" : "no translation" });
        continue;
      }
      const row: ImportRow = {
        line: r.line,
        word,
        translation,
        example: at(v, "example"),
        note: at(v, "note"),
        translationNote: at(v, "translationNote"),
        picture: at(v, "picture"),
        stickers: [...new Set(at(v, "stickers").split(/[;,|\n]/).map((s) => s.trim().replace(/\s+/g, " ")).filter(Boolean))],
        status: t.header.cols.has("status") ? readStatus(at(v, "status")) : intervalStatus(at(v, "interval")),
      };
      if (t.header.lang) row.lang = t.header.lang;
      if (t.header.to) row.to = t.header.to;
      for (const k of ["lang", "to"] as const) {
        const raw = at(v, k);
        if (!raw) continue;
        const code = langCode(raw);
        if (code) row[k] = code;
        else errors.push({ line: r.line, message: `unknown language "${raw}"` });
      }
      if (errors.at(-1)?.line === r.line) continue;
      const created = readDate(at(v, "created"));
      if (created !== undefined) row.created = created;
      rows.push(row);
    }
  }
  return { rows, changes, errors, noTable: tables === 0 };
}

// ---------------------------------------------------------------- planning

/** A row whose languages are settled. */
export interface ReadyRow extends ImportRow {
  pair: LangPair;
}

export interface SkippedRow {
  line: number;
  word: string;
  reason: "repeated" | "exists";
}

/** A row whose word is already there (same word, translation and languages): `merge` brings what it adds. */
export interface ExistingRow {
  row: ReadyRow;
  noteId: EntityId;
}

export interface ImportPlan {
  ready: ReadyRow[];
  skipped: SkippedRow[];
  /** The rows skipped as "exists", with the word each one is. */
  existing: ExistingRow[];
  errors: RowError[];
  /** Rows that name no language (or only one side): the screen asks, and `fallback` fills them in. */
  unnamed: number;
}

/** Dedup key: NFC, trimmed, inner whitespace collapsed, case-folded. */
export function noteKey(front: string, back: string): string {
  const norm = (s: string) => s.normalize("NFC").trim().replace(/\s+/g, " ").toLocaleLowerCase();
  return `${norm(front)}\u0000${norm(back)}`;
}

const pairKey = (front: string, back: string, p: LangPair) => `${p.from}>${p.to}\u0000${noteKey(front, back)}`;

/**
 * Settles each row's languages (its own, else `fallback`), drops words that are
 * already there or repeated, and orders them: dated rows oldest first, so new
 * words come up in the order they were met; undated keep their order after them.
 */
export function planImport(
  read: ReadResult,
  existing: Iterable<{ id: EntityId; fields: { front: string; back: string }; lang_pair: LangPair; deleted?: boolean; former?: { front: string; back: string; to: string }[] }>,
  fallback: LangPair,
): ImportPlan {
  const seen = new Map<string, EntityId | undefined>();
  const live = [...existing].filter((n) => !n.deleted);
  for (const n of live) seen.set(pairKey(n.fields.front, n.fields.back, n.lang_pair), n.id);
  // What a word was before it was edited (another translation, another translation language) still names it, unless a word is that now.
  for (const n of live)
    for (const f of n.former ?? []) {
      const k = pairKey(f.front, f.back, { from: n.lang_pair.from, to: f.to });
      if (!seen.has(k)) seen.set(k, n.id);
    }
  const fromFile = new Set<string>();
  const ready: ReadyRow[] = [];
  const skipped: SkippedRow[] = [];
  const there: ExistingRow[] = [];
  const errors = [...read.errors];
  let unnamed = 0;
  for (const r of read.rows) {
    if (!r.lang || !r.to) unnamed++;
    const pair = { from: r.lang ?? (r.to === fallback.from ? fallback.to : fallback.from), to: r.to ?? (r.lang === fallback.to ? fallback.from : fallback.to) };
    if (pair.from === pair.to) {
      errors.push({ line: r.line, message: "word and translation in the same language" });
      continue;
    }
    const key = pairKey(r.word, r.translation, pair);
    if (seen.has(key)) {
      const id = seen.get(key);
      skipped.push({ line: r.line, word: r.word, reason: id === undefined ? "repeated" : "exists" });
      if (id !== undefined) there.push({ row: { ...r, pair }, noteId: id });
      continue;
    }
    seen.set(key, undefined);
    fromFile.add(key);
    ready.push({ ...r, pair });
  }
  ready.sort((a, b) => (a.created ?? Infinity) - (b.created ?? Infinity));
  errors.sort((a, b) => a.line - b.line);
  return { ready, skipped, existing: there, errors, unnamed };
}

/** The note fields a row fills in, by its column. */
type MergedField = "example" | "memo_target" | "memo_known";
const MERGED: ["example" | "note" | "translationNote", MergedField][] = [
  ["example", "example"],
  ["note", "memo_target"],
  ["translationNote", "memo_known"],
];

/**
 * What a word added again brings to the one already there: the stickers it
 * doesn't wear yet (by name; new ones are made by the caller), and the example
 * and notes where it has none. Nothing it has is written over; progress stays.
 */
export function mergeOf(col: Collection, e: ExistingRow): { edits: { field: MergedField; value: string }[]; stickers: string[] } {
  const n = col.notes.get(e.noteId);
  if (!n) return { edits: [], stickers: [] };
  // A row naming the word as it was in another translation language: its translation-side note is in that language, not the card's.
  const otherTo = e.row.pair.to !== n.lang_pair.to;
  const edits = MERGED.filter(([k, f]) => e.row[k] && !n.fields[f]?.trim() && !(otherTo && f === "memo_known")).map(([k, f]) => ({ field: f, value: e.row[k] }));
  const stickers = [...new Set(e.row.stickers)].filter((name) => {
    const l = col.labelByName(name);
    return !l || !col.wears(n.id, l.id);
  });
  return { edits, stickers };
}

/** The edits of `mergeOf` as events. */
export const mergeEdits = (f: EventFactory, noteId: EntityId, edits: { field: string; value: string }[]): AppEvent[] =>
  edits.map((x) => f.make<NoteEdited>("note_edited", { note_id: noteId, field: x.field, value: x.value }));

/**
 * The words' creation events (a note and its two cards each), in the plan's
 * order. `decks`: the hidden deck of each studied language. Stickers and
 * progress are the Store's (`importWords`): they need the collection.
 */
export function importEvents(f: EventFactory, rows: ReadyRow[], decks: Map<string, EntityId>): { events: AppEvent[]; noteIds: EntityId[] } {
  const events: AppEvent[] = [];
  const noteIds: EntityId[] = [];
  for (const r of rows) {
    const deck = decks.get(r.pair.from);
    if (deck === undefined) throw new Error(`no deck for ${r.pair.from}`);
    const fields: NoteFields = { front: r.word, back: r.translation };
    if (r.example) fields.example = r.example;
    if (r.note) fields.memo_target = r.note;
    if (r.translationNote) fields.memo_known = r.translationNote;
    if (r.picture) fields.picture_details = r.picture;
    const evs = f.note(deck, fields, r.pair);
    const created = evs[0] as NoteCreated;
    created.payload.source = { kind: "import", ...(r.created !== undefined && { created_at: new Date(r.created).toISOString() }) };
    noteIds.push(created.payload.note_id);
    events.push(...evs);
  }
  return { events, noteIds };
}

/** The language a set of texts is written in, when its script says so (Cyrillic, kana, Hangul…). */
export function scriptLang(texts: string[]): string | undefined {
  const s = texts.join(" ");
  const count = (re: RegExp) => (s.match(re) ?? []).length;
  const letters = count(/\p{L}/gu);
  if (!letters) return undefined;
  const share = (re: RegExp) => count(re) / letters > 0.5;
  if (share(/\p{Script=Cyrillic}/gu)) return /[іїєґІЇЄҐ]/.test(s) ? "uk" : "ru";
  if (count(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu) > 0 && share(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu)) return "ja";
  if (share(/\p{Script=Hangul}/gu)) return "ko";
  if (share(/\p{Script=Han}/gu)) return "zh";
  if (share(/\p{Script=Arabic}/gu)) return "ar";
  if (share(/\p{Script=Hebrew}/gu)) return "he";
  return undefined;
}

// ---------------------------------------------------------------- the prompt

/** The prompt's last line, in the language the user's translations are in: the reply's language follows it. */
const LAST_LINE: Record<string, string> = {
  en: "Here's my export, or what I'd like to learn:",
  es: "Aquí está mi exportación, o lo que quiero aprender:",
  ru: "Вот мой экспорт или то, что я хочу выучить:",
  uk: "Ось мій експорт або те, що я хочу вивчити:",
  de: "Hier ist mein Export oder was ich lernen möchte:",
  fr: "Voici mon export, ou ce que je veux apprendre :",
  it: "Ecco il mio export, o quello che voglio imparare:",
  pt: "Aqui está a minha exportação, ou o que quero aprender:",
  pl: "Oto mój eksport albo to, czego chcę się nauczyć:",
  nl: "Hier is mijn export, of wat ik wil leren:",
  tr: "İşte dışa aktarımım ya da öğrenmek istediklerim:",
  ja: "これが私のエクスポート、または覚えたいことです：",
  zh: "这是我的导出文件，或者我想学的内容：",
  ko: "제 내보내기 파일 또는 배우고 싶은 내용입니다:",
  ar: "هذا ملف التصدير الخاص بي، أو ما أريد تعلّمه:",
  he: "הנה הייצוא שלי, או מה שאני רוצה ללמוד:",
  sv: "Här är min export, eller det jag vill lära mig:",
  cs: "Tady je můj export, nebo co se chci naučit:",
};

export const IMPORT_HEADER = "id,word,translation,example,lang,to,note,translation_note,picture,stickers,status";
/** Read-only columns the words file adds after those: how each word has gone (`Collection.practice`). Replies' copies are ignored. */
export const PRACTICE_COLUMNS = "reviews,again,last_seen";
/** A timestamp as the day it fell on, YYYY-MM-DD (UTC). */
const day = (ts: number) => new Date(ts).toISOString().slice(0, 10);

/** What the user's own AI is given besides the languages. */
export interface PromptOptions {
  /** The user's sticker names, for the AI to reuse. */
  stickers?: string[];
  /** The prompt sits on top of the user's words (`exportWords`): it changes them, and the user asks in the chat. */
  words?: boolean;
}

/**
 * The prompt "Your AI" copies, or puts on top of the words file. `pairs`: the
 * languages studied and what their translations are in (empty for a new
 * user); `known`: the language the last line is written in; `name(code)` →
 * "Spanish".
 */
export function importPrompt(pairs: LangPair[], known: string, name: (code: string) => string, o: PromptOptions = {}): string {
  const lang = (c: string) => `${name(c)} (${c})`;
  let usual = "";
  if (pairs.length) {
    const tos = [...new Set(pairs.map((p) => p.to))];
    const list = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} or ${xs.at(-1)}`);
    usual =
      tos.length === 1
        ? ` If my request doesn't say, I'm usually\nlearning ${list(pairs.map((p) => lang(p.from)))}, with translations in ${lang(tos[0])}.`
        : ` If my request doesn't say, I'm usually\nlearning ${list(pairs.map((p) => `${lang(p.from)} with translations in ${lang(p.to)}`))}.`;
  }
  const stickers = o.stickers?.length ? `\nMy stickers so far: ${o.stickers.join("; ")}. Reuse these names when they fit.` : "";
  const ways = o.words
    ? `Below are all my cards, one per row, with their ids. Help me with them as I ask in the chat:
translate, fix, add examples, sort them into stickers, delete, find what's missing, add
new ones, find my hardest words, anything. If I haven't said what I'd like, ask me first,
in one short question.

The last columns show how each card has gone, for you to read: ${PRACTICE_COLUMNS}.
reviews = times I've answered it (both directions), again = times I didn't remember it,
last_seen = the day I last answered it (empty if never). Many agains, most of all for
the reviews, mean a hard word. Never put these columns in your reply.`
    : `Please help me make cards. Either:
- I give you an export or list from another app or source, and you convert it, keeping
  everything in it (tags, lessons, progress); or
- we talk about what I want to learn (a topic, a trip, a book, my level) and you suggest
  the words. If my request is vague (no topic or no amount), first ask me one or two
  short questions, then make the cards.`;
  const reply = o.words
    ? `Reply with only the rows you change or add, as CSV in one markdown code block (for a
long reply, a .csv file to download is fine too). Same header:`
    : `Give the cards as CSV in one markdown code block. No file needed, the block is enough.
Header exactly:`;
  const changes = o.words
    ? `
- id: keep a card's id to change it; leave it empty for a new card
- a cell left empty keeps what the card has; "-" clears an example or a note
- stickers on a changed card are its whole list: leave one out to take it off
- status delete removes a card; known / learning mark what I know or don't
- a card's word language (lang) can't change; its translation language (to) can`
    : `
- id: leave empty`;
  const paste = "Words → Your AI → Its reply";
  return `I use Really Cool Flashcards, a language-learning app. Each card has a word in the
language I'm learning, its translation, an example sentence, and a picture the app
draws by itself. ${ways}

Languages: every row says its own, so one reply can mix pairs. Use what the words
actually are, e.g. what an export contains.${usual}${stickers}

${reply}
${IMPORT_HEADER}${changes}
- word: dictionary form, with the article for nouns where the language has one
- translation: short
- example: one short natural sentence that holds the word, in the word's language. The app also shows it with the word blanked out, to recall the word from its translation, so make it a sentence where only this word fits (most of all for small grammar words)
- lang, to: ISO 639-1 codes of this row's word and translation
- note, translation_note: optional tip of a few words shown on the word / translation side, written in that side's language (irregular form, false friend, reading), else empty
- picture: usually empty. Only when the word has another meaning that could be drawn instead, say which to draw ("money bank, not a bench")
- stickers: free-text tags that group words; the app makes a study pile for each. Fill them from the tags, decks or lessons of an export, or when I ask; else empty. Separate several with ";"
- status: new, learning or known. known = I said I know it, or my source shows it's mastered (e.g. an interval over a month); learning = started but not mastered; else new
Quote fields that contain commas. Nothing but CSV inside the block. For a long list, give every row; if needed, split it into several blocks with the same header.

After the block, tell me in my language, in one line, to copy the block and paste it in the app under ${paste} (keep those names in English, as the app shows them).${o.words ? "" : " If there are no stickers, also offer to add some to group the words."}

The app wrote this message in English, but I may not speak it: reply in the language
we usually talk in, unless I write below in another one.
${o.words ? "" : `\n${LAST_LINE[known] ?? LAST_LINE.en}\n`}`;
}

// ---------------------------------------------------------------- changes: rows with an id

/** A row naming a word by its id, its cells as written: "" = not given (left as it is), "-" = cleared. */
export interface ChangeRow {
  line: number;
  id: EntityId;
  word: string;
  translation: string;
  example: string;
  note: string;
  translationNote: string;
  stickers: string;
  status: string;
  lang?: string;
  to?: string;
}

/** The note fields a change row can set, by its column. */
const CHANGED: [keyof Pick<ChangeRow, "word" | "translation" | "example" | "note" | "translationNote">, string][] = [
  ["word", "front"],
  ["translation", "back"],
  ["example", "example"],
  ["note", "memo_target"],
  ["translationNote", "memo_known"],
];

/** What one row changes on its word. Nothing in it is unchanged. */
export interface WordChange {
  line: number;
  noteId: EntityId;
  fields: { field: string; from: string; to: string }[];
  /** The translation's language, from → to. */
  lang?: { from: string; to: string };
  /** Sticker names to stick on (made when new) and stickers to peel off. */
  stickOn: string[];
  peelOff: EntityId[];
  /** "I know" / "Don't know". */
  status?: "known" | "unknown";
  /** Deleted (restorable). */
  remove?: true;
}

export interface RefusedChange {
  line: number;
  noteId: EntityId;
  word: string;
  reason: string;
}

export interface ChangePlan {
  changes: WordChange[];
  refused: RefusedChange[];
}

const DELETE_WORDS = new Set(["delete", "deleted", "remove", "removed", "del", "удалить", "удалено", "видалити", "borrar", "eliminar", "löschen", "supprimer", "eliminare", "excluir", "usuń"]);
const isClear = (s: string) => /^[-–—]$/.test(s);
const same = (a: string, b: string) => a.normalize("NFC").trim().replace(/\s+/g, " ") === b.normalize("NFC").trim().replace(/\s+/g, " ");

/**
 * What change rows do to the words they name, against the words as they are
 * now. A row echoed unchanged changes nothing and is left out; a row that
 * can't be applied is refused whole, with the reason. `statusOf` is the
 * word's status as the app shows it (it needs the model's predictions).
 */
export function planChanges(rows: ChangeRow[], col: Collection, statusOf: (noteId: EntityId) => WordStatus): ChangePlan {
  const changes: WordChange[] = [];
  const refused: RefusedChange[] = [];
  const done = new Set<EntityId>();
  for (const r of rows) {
    const n = col.notes.get(r.id);
    const refuse = (reason: string) => refused.push({ line: r.line, noteId: r.id, word: n?.fields.front ?? r.word, reason });
    if (!n) { refuse("no word with this id"); continue; }
    if (n.deleted) { refuse("deleted"); continue; }
    if (done.has(n.id)) { refuse("this word is in the reply twice"); continue; }
    done.add(n.id);
    const status = squash(r.status);
    if (DELETE_WORDS.has(status)) {
      changes.push({ line: r.line, noteId: n.id, fields: [], stickOn: [], peelOff: [], remove: true });
      continue;
    }
    if (r.lang && r.lang !== n.lang_pair.from) { refuse("its language can't change: add it again instead"); continue; }
    if ((r.word && isClear(r.word)) || (r.translation && isClear(r.translation))) { refuse("a word and its translation can't be emptied"); continue; }
    const to = r.to ?? n.lang_pair.to;
    if (to === n.lang_pair.from) { refuse("the translation can't be in the word's language"); continue; }
    const c: WordChange = { line: r.line, noteId: n.id, fields: [], stickOn: [], peelOff: [] };
    for (const [k, field] of CHANGED) {
      const cell = r[k];
      if (!cell) continue;
      const now = n.fields[field] ?? "";
      const next = isClear(cell) ? "" : cell;
      if (!same(now, next)) c.fields.push({ field, from: now, to: next });
    }
    if (to !== n.lang_pair.to) c.lang = { from: n.lang_pair.to, to };
    if (r.stickers) {
      const want = isClear(r.stickers) ? [] : [...new Set(r.stickers.split(/[;,|\n]/).map((s) => s.trim().replace(/\s+/g, " ")).filter(Boolean))];
      const wears = col.labelsOf(n.id);
      const wanted = new Set(want.map((w) => col.labelByName(w)?.id).filter((x) => x !== undefined));
      c.stickOn = want.filter((w) => { const l = col.labelByName(w); return !l || !col.wears(n.id, l.id); });
      c.peelOff = wears.filter((l) => !wanted.has(l.id)).map((l) => l.id);
    }
    if (status) {
      const s = readStatus(r.status), now = statusOf(n.id);
      if (s === "known" && now !== "known") c.status = "known";
      else if (s !== "known" && now === "known") c.status = "unknown";
    }
    if (c.fields.length || c.lang || c.stickOn.length || c.peelOff.length || c.status) changes.push(c);
  }
  return { changes, refused };
}

const csvCell = (s: string) => (/[",\n\r]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/**
 * The words file "Share my words" sends: the prompt as `#` lines on top (the
 * reader skips them), then every word with its id. `statusOf` as in `planChanges`.
 */
export function exportWords(col: Collection, statusOf: (noteId: EntityId) => WordStatus, prompt: string): string {
  const lines = prompt.trimEnd().split("\n").map((l) => (l ? `# ${l}` : "#"));
  lines.push(`${IMPORT_HEADER},${PRACTICE_COLUMNS}`);
  for (const n of col.liveNotes()) {
    const f = n.fields;
    const stickers = col.labelsOf(n.id).map((l) => l.name).join("; ");
    const p = col.practice(n.id);
    lines.push(
      [String(n.id), f.front, f.back, f.example ?? "", n.lang_pair.from, n.lang_pair.to, f.memo_target ?? "", f.memo_known ?? "", f.picture_details ?? "", stickers, statusOf(n.id), String(p.reviews), String(p.again), p.last_seen === undefined ? "" : day(p.last_seen)]
        .map(csvCell)
        .join(","),
    );
  }
  return lines.join("\n") + "\n";
}
