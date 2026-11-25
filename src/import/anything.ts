// Import from anything: words an AI chat (or a person) wrote as a table, pasted
// or picked as a file. The prompt the app copies (`importPrompt`) asks for one
// exact CSV header; the reader takes much more than it asks for, without saying
// so: the whole chat reply around the code block, several blocks, tab or
// semicolon separators, markdown tables, other column names, language names
// instead of codes, other words for progress, dates in other formats.
//
// Pure: text in, rows and a plan out. The Store applies a plan (`importWords`).

import { parseCsv, CsvError } from "./csv";
import type { AppEvent, LangPair, NoteCreated, NoteFields } from "../domain/events";
import type { EventFactory } from "../domain/collection";
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
  errors: RowError[];
  /** Nothing in the text looked like a table of words. */
  noTable: boolean;
}

/** The studied languages the app knows (src/ui/h.ts LANGS), kept here so this module stays DOM-free. */
export const IMPORT_LANGS = ["es", "en", "ru", "uk", "de", "fr", "it", "pt", "pl", "nl", "tr", "ja", "zh", "ko", "ar", "he", "sv", "cs"];

// ---------------------------------------------------------------- columns

type Col = "word" | "translation" | "example" | "lang" | "to" | "note" | "translationNote" | "picture" | "stickers" | "status" | "interval" | "created";

/** Header names, squashed (`squash`): lower case, letters and digits only. */
const COLUMN_NAMES: Record<Col, string[]> = {
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
  const lines = text.replace(/\r\n?/g, "\n").replace(`Header exactly:\n${IMPORT_HEADER}\n`, "Header exactly:\n\n").split("\n");
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
  return { rows, errors, noTable: tables === 0 };
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

export interface ImportPlan {
  ready: ReadyRow[];
  skipped: SkippedRow[];
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
export function planImport(read: ReadResult, existing: Iterable<{ fields: { front: string; back: string }; lang_pair: LangPair; deleted?: boolean }>, fallback: LangPair): ImportPlan {
  const seen = new Set<string>();
  for (const n of existing) if (!n.deleted) seen.add(pairKey(n.fields.front, n.fields.back, n.lang_pair));
  const fromFile = new Set<string>();
  const ready: ReadyRow[] = [];
  const skipped: SkippedRow[] = [];
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
      skipped.push({ line: r.line, word: r.word, reason: fromFile.has(key) ? "repeated" : "exists" });
      continue;
    }
    seen.add(key);
    fromFile.add(key);
    ready.push({ ...r, pair });
  }
  ready.sort((a, b) => (a.created ?? Infinity) - (b.created ?? Infinity));
  errors.sort((a, b) => a.line - b.line);
  return { ready, skipped, errors, unnamed };
}

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

export const IMPORT_HEADER = "word,translation,example,lang,to,note,translation_note,picture,stickers,status";

/**
 * The prompt the Import screen copies. `pairs`: the languages studied and what
 * their translations are in (empty for a new user); `known`: the language the
 * last line is written in; `name(code)` → "Spanish".
 */
export function importPrompt(pairs: LangPair[], known: string, name: (code: string) => string): string {
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
  return `I use Really Cool Flashcards, a language-learning app. Each card has a word in the
language I'm learning, its translation, an example sentence, and a picture the app
draws by itself. Please help me make cards. Either:
- I give you an export or list from another app or source, and you convert it, keeping
  everything in it (tags, lessons, progress); or
- we talk about what I want to learn (a topic, a trip, a book, my level) and you suggest
  the words. If my request is vague (no topic or no amount), first ask me one or two
  short questions, then make the cards.

Languages: every row says its own, so one reply can mix pairs. Use what the words
actually are, e.g. what an export contains.${usual}

Give the cards as CSV in one markdown code block. No file needed, the block is enough.
Header exactly:
${IMPORT_HEADER}
- word: dictionary form, with the article for nouns where the language has one
- translation: short
- example: one short natural sentence using the word, in the word's language
- lang, to: ISO 639-1 codes of this row's word and translation
- note, translation_note: optional tip of a few words shown on the word / translation side, written in that side's language (irregular form, false friend, reading), else empty
- picture: usually empty. Only when the word has another meaning that could be drawn instead, say which to draw ("money bank, not a bench")
- stickers: free-text tags that group words; the app makes a study pile for each. Fill them from the tags, decks or lessons of an export, or when I ask; else empty. Separate several with ";"
- status: new, learning or known. known = I said I know it, or my source shows it's mastered (e.g. an interval over a month); learning = started but not mastered; else new
Quote fields that contain commas. Nothing but CSV inside the block. For a long list, give every row; if needed, split it into several blocks with the same header.

After the block, tell me in my language, in one line, to copy the block and paste it in the app under Words → Add → Import from anything (keep those three names in English, as the app shows them). If there are no stickers, also offer to add some to group the words.

The app wrote this message in English, but I may not speak it: reply in the language
we usually talk in, unless I write below in another one.

${LAST_LINE[known] ?? LAST_LINE.en}
`;
}
