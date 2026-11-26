// Filling in a card: the card editor sends what the user typed (the studied
// word, its translation, or both) and an LLM fills in the rest: the other word,
// an example in the studied language, the word's other meanings (the user taps
// one to swap it in) and a better form of the typed word ("did you mean
// el banco?"). Pure, so the Worker (worker/fill.ts), the editor and tests share it.
//
// The side typed into says which side the text is on, so nothing is detected.

export const FILL_MODEL = "@cf/google/gemma-4-26b-a4b-it";
/** Bump when the prompt or the reply's shape changes: cached replies are keyed by it. */
export const FILL_VERSION = 2;
/** Estimated neurons per fill (~700 tokens in, ~250 out on Gemma 4 26B), rounded up. Cached fills cost nothing. */
export const NEURONS_PER_FILL = 15;
export const MAX_FILL_TEXT = 120;
/** Meanings offered at most: the one filled in and two to swap in. */
export const MAX_OPTIONS = 3;

export interface FillRequest {
  /** Studied language (the white side). */
  from: string;
  /** Known language (the cream side). */
  to: string;
  /** The studied word as typed. */
  word?: string;
  /** Its translation as typed. */
  translation?: string;
}

/** One meaning: the studied word, its translation and an example of it in the studied language. */
export interface FillOption {
  word: string;
  translation: string;
  example: string;
}

export interface Fill {
  /** Most common first. Typed word: its meanings; typed translation: the studied words for it; both: one, for the example. */
  options: FillOption[];
  /** A better form of the typed word: dictionary form, spelling, article. Only when it differs. */
  suggest?: string;
}

const NAMES: Record<string, string> = {
  es: "Spanish",
  en: "English",
  ru: "Russian",
  uk: "Ukrainian",
  de: "German",
  fr: "French",
  it: "Italian",
  pt: "Portuguese",
  pl: "Polish",
  nl: "Dutch",
  tr: "Turkish",
  ja: "Japanese",
  zh: "Chinese",
  ko: "Korean",
  ar: "Arabic",
  he: "Hebrew",
  sv: "Swedish",
  cs: "Czech",
};

export function languageName(code: string): string {
  const base = code.toLowerCase().split("-")[0];
  if (NAMES[base]) return NAMES[base];
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** Definite articles of languages whose nouns are learned with one. */
const ARTICLES: Record<string, string> = {
  es: "el, la, los, las",
  fr: "le, la, l', les",
  it: "il, lo, la, l', i, gli, le",
  pt: "o, a, os, as",
  de: "der, die, das",
  nl: "de, het",
};

export const clean = (s: string | undefined): string => (s ?? "").normalize("NFC").replace(/\s+/g, " ").trim();

/** What the request asks for, or null when it is malformed. */
export function fillKind(r: FillRequest): "word" | "translation" | "example" | null {
  const w = clean(r.word), t = clean(r.translation);
  if (w.length > MAX_FILL_TEXT || t.length > MAX_FILL_TEXT) return null;
  if (w && t) return "example";
  if (w) return "word";
  if (t) return "translation";
  return null;
}

function rules(r: FillRequest): string {
  const from = languageName(r.from), to = languageName(r.to);
  const art = ARTICLES[r.from.toLowerCase().split("-")[0]];
  const form = art
    ? `the ${from} word in dictionary form, spelled correctly; a noun with its definite article (${art}), e.g. a noun learned as "el banco", not "banco"`
    : `the ${from} word in dictionary form, spelled correctly`;
  return [
    `You fill in a flashcard for someone learning ${from} who knows ${to}.`,
    `- "word": ${form}. Keep a phrase or idiom as a phrase.`,
    `- "translation": ONE ${to} translation of that meaning, the one a good dictionary gives first: a word or a short phrase, never a list (no commas, slashes or "or"), no article before a ${to} noun, no explanations or brackets.`,
    `- "example": one short, natural ${from} sentence (4-10 words) in which the word clearly has exactly that meaning; everyday language a learner understands. Only ${from}, no translation.`,
  ].join("\n");
}

/** The messages for one fill. */
export function fillMessages(r: FillRequest): { role: "system" | "user"; content: string }[] {
  const from = languageName(r.from), to = languageName(r.to);
  const w = clean(r.word), t = clean(r.translation);
  const kind = fillKind(r);
  let task: string;
  let user: string;
  if (kind === "word") {
    task = [
      `The learner typed a ${from} word. Return its meanings, most common first: 1 to ${MAX_OPTIONS} options, one per clearly different meaning, each meaning its own option (e.g. Spanish "banco": "bank" and "bench" are two options); never two options for synonyms of one meaning; a word with one meaning gets one option.`,
      `"suggest": the word in the form above if what was typed differs from it (another form of the word, a misspelling, a missing article); else null.`,
      `If what was typed is not ${from}, or not a word at all, return the closest ${from} word in "suggest" and options for it.`,
    ].join("\n");
    user = `${from} word: ${w}`;
  } else if (kind === "translation") {
    task = [
      `The learner typed a ${to} word and wants the ${from} word for it. Return 1 to ${MAX_OPTIONS} options, most common first: the usual ${from} word first, then a different ${from} word only if it is also common for this ${to} word (for another meaning, or another usual way to say it).`,
      `In each option "translation" is the typed ${to} word (narrowed to that meaning if needed). "suggest" is null.`,
    ].join("\n");
    user = `${to} word: ${t}`;
  } else {
    task = [
      `The learner typed a ${from} word and its ${to} translation. Return exactly one option for that meaning: "word" and "translation" as typed (fix only spelling), and an example.`,
      `"suggest": the ${from} word in the form above if what was typed differs from it (another form of the word, a misspelling, a missing article); else null.`,
    ].join("\n");
    user = `${from} word: ${w}\n${to} translation: ${t}`;
  }
  return [
    { role: "system", content: `${rules(r)}\n\n${task}\n\nReturn JSON: {"suggest": string or null, "options": [{"word": "...", "translation": "...", "example": "..."}]}` },
    { role: "user", content: user },
  ];
}

/** JSON schema for models that take one (response_format json_schema). */
export const FILL_SCHEMA = {
  type: "object",
  properties: {
    suggest: { type: ["string", "null"] },
    options: {
      type: "array",
      items: {
        type: "object",
        properties: { word: { type: "string" }, translation: { type: "string" }, example: { type: "string" } },
        required: ["word", "translation", "example"],
      },
    },
  },
  required: ["suggest", "options"],
};

const same = (a: string, b: string) => clean(a).toLocaleLowerCase() === clean(b).toLocaleLowerCase();

/** Text an option may hold: one line, no quotes or brackets around it. */
function tidy(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  const s = clean(v).replace(/^["'“«]+|["'”»]+$/g, "").trim();
  return s.length <= max ? s : "";
}

/**
 * The LLM's reply (an object, JSON text, or JSON in a code fence) as a fill for
 * the request: what was typed stays as typed, empty or repeated options are
 * dropped, and a suggestion equal to the typed word is no suggestion.
 */
export function parseFill(reply: unknown, r: FillRequest): Fill {
  let v: unknown = reply;
  if (typeof v === "string") {
    const text = v.replace(/^\s*```(?:json)?/, "").replace(/```\s*$/, "").trim();
    try {
      v = JSON.parse(text);
    } catch {
      const m = /\{[\s\S]*\}/.exec(text);
      try {
        v = m ? JSON.parse(m[0]) : null;
      } catch {
        v = null;
      }
    }
  }
  const o = (v && typeof v === "object" ? v : {}) as { suggest?: unknown; options?: unknown };
  const kind = fillKind(r);
  const w = clean(r.word), t = clean(r.translation);
  const options: FillOption[] = [];
  /** The first option's word as the LLM wrote it: the typed word's better form when "suggest" is left out. */
  let lemma = "";
  for (const raw of Array.isArray(o.options) ? o.options : []) {
    if (!raw || typeof raw !== "object") continue;
    const x = raw as Record<string, unknown>;
    const opt = { word: tidy(x.word, MAX_FILL_TEXT), translation: tidy(x.translation, MAX_FILL_TEXT), example: tidy(x.example, 300) };
    lemma ||= opt.word;
    if (kind === "example") {
      opt.word = w;
      opt.translation = t;
    } else if (kind === "translation") opt.translation ||= t;
    else if (kind === "word") opt.word ||= w;
    // The side to fill must be there, and a meaning offered twice is one.
    const filled = kind === "translation" ? opt.word : opt.translation;
    if (!filled || options.some((p) => same(kind === "translation" ? p.word : p.translation, filled))) continue;
    options.push(opt);
    if (options.length === (kind === "example" ? 1 : MAX_OPTIONS)) break;
  }
  const said = tidy(o.suggest, MAX_FILL_TEXT);
  const suggest = kind === "translation" ? "" : said && said.toLowerCase() !== "null" ? said : lemma;
  return suggest && !same(suggest, w) ? { options, suggest } : { options };
}

/** Where a fill is kept, so the same words never cost twice (for anyone). */
export async function fillKey(r: FillRequest, model = FILL_MODEL): Promise<string> {
  const text = [FILL_VERSION, model, r.from.toLowerCase(), r.to.toLowerCase(), clean(r.word), clean(r.translation)].join("\u0000");
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return `fill/${[...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("")}.json`;
}

/** Local dev has no AI: a fill anyone can recognise, so the editor can be tried for free. */
export function devFill(r: FillRequest): Fill {
  const w = clean(r.word), t = clean(r.translation);
  const kind = fillKind(r);
  const ex = (word: string) => `${word}, ${word}: dev example.`;
  if (kind === "example") return { options: [{ word: w, translation: t, example: ex(w) }] };
  if (kind === "word")
    return {
      options: [
        { word: w, translation: `${w} (${r.to})`, example: ex(w) },
        { word: w, translation: `${w} (${r.to}) 2`, example: `${ex(w)} 2` },
      ],
    };
  return { options: [{ word: `${t} (${r.from})`, translation: t, example: ex(`${t} (${r.from})`) }] };
}

// ---- the card editor's side: what to ask, and what a fill writes ----

/** The places a fill writes. */
export type FillPlace = "front" | "back" | "example";
export type FillText = Record<FillPlace, string>;

/**
 * What to ask for the card as it stands, or nothing. `auto`: the places a fill
 * wrote and the user hasn't typed in since; they are asked for again, never
 * asked from. Typed word → its translation; typed translation → the word;
 * both typed → an example, if the user hasn't typed one.
 */
export function fillAsk(text: FillText, auto: ReadonlySet<FillPlace>, pair: { from: string; to: string }): FillRequest | undefined {
  const word = auto.has("front") ? "" : clean(text.front);
  const translation = auto.has("back") ? "" : clean(text.back);
  const r: FillRequest = { from: pair.from, to: pair.to, word: word || undefined, translation: translation || undefined };
  const kind = fillKind(r);
  if (!kind) return undefined;
  if (kind === "example" && clean(text.example) && !auto.has("example")) return undefined;
  return r;
}

/** Two asks are the same question. */
export const askKey = (r: FillRequest | undefined): string => (r ? [r.from, r.to, clean(r.word), clean(r.translation)].join("\u0000") : "");

/** The place a fill fills in from its options: the translation for a typed word, the word for a typed translation. */
export function filledPlace(r: FillRequest): "front" | "back" | undefined {
  const kind = fillKind(r);
  return kind === "word" ? "back" : kind === "translation" ? "front" : undefined;
}

/**
 * The card with option `i` of a fill written in: the filled place and the
 * example, each only where it is empty or was written by a fill (never over
 * what the user typed, nor over `keep`). Returns the new text and auto places.
 */
export function applyOption(text: FillText, auto: ReadonlySet<FillPlace>, r: FillRequest, o: FillOption, keep: ReadonlySet<FillPlace> = new Set()): { text: FillText; auto: Set<FillPlace> } {
  const t = { ...text };
  const a = new Set(auto);
  const free = (p: FillPlace) => !keep.has(p) && (!clean(t[p]) || a.has(p));
  const place = filledPlace(r);
  if (place && free(place)) {
    t[place] = place === "back" ? o.translation : o.word;
    a.add(place);
  }
  if (o.example && free("example")) {
    t.example = o.example;
    a.add("example");
  }
  return { text: t, auto: a };
}

/** The user emptied what the fill was asked from: what it wrote goes too. */
export function clearAuto(text: FillText, auto: ReadonlySet<FillPlace>): FillText {
  const t = { ...text };
  for (const p of auto) t[p] = "";
  return t;
}
