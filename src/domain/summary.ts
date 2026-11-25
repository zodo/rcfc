// A word's notes: what a good learner's dictionary says about it (forms,
// how it's used, what not to mix it up with), written by an LLM for the
// card's answer side, where they are tiny print to zoom into
// (src/ui/fineprint.ts). No example sentences: the card has one. Pure, so the
// Worker (worker/summary.ts), the client and tests share it.
import { clean, languageName, MAX_FILL_TEXT } from "./fill";

/**
 * DeepSeek V4.1 Flash, thinking off. Compared on 10 Spanish words written in
 * Spanish: Gemma 4 26B (5x cheaper) wrote things a learner would believe and
 * shouldn't ("coger una decisión", contradicting itself on tener for age);
 * gpt-oss-120b was slow and often empty; Mistral Small 3.1 repeated lines and
 * slipped into English.
 */
export const SUMMARY_MODEL = "@cf/deepseek-ai/deepseek-v4.1-flash-1017";
/** Bump when the prompt or the reply's shape changes: kept replies (server and devices) are keyed by it. */
export const SUMMARY_VERSION = 1;
/** Estimated neurons per summary (~700 tokens in, ~650 out on DeepSeek V4.1 Flash), rounded up. Kept ones cost nothing. */
export const NEURONS_PER_SUMMARY = 100;

const MAX_FORMS = 8;
const MAX_NOTES = 4;
const MAX_LINES = 5;
const MAX_LINE = 200;

export interface SummaryRequest {
  /** Studied language (the white side). */
  from: string;
  /** Known language (the cream side). */
  to: string;
  /** The language the notes are written in: the studied one by default, or the known one. */
  in: string;
  word: string;
  /** Which meaning the card is about. */
  translation: string;
}

export interface Summary {
  /** Part of speech and the key grammar fact, then the meaning: "verb, irregular · to have". */
  gist: string;
  /** Label (known language) → forms (studied language): "present" → "tengo, tienes…". */
  forms: [string, string][];
  /** A few short sections: how it's used, don't mix up, register… */
  notes: { title: string; lines: string[] }[];
}

export function summaryRequestOk(r: SummaryRequest): boolean {
  const w = clean(r.word), t = clean(r.translation);
  return !!w && !!t && w.length <= MAX_FILL_TEXT && t.length <= MAX_FILL_TEXT && (r.in === r.from || r.in === r.to);
}

/** The messages for one summary. */
export function summaryMessages(r: SummaryRequest): { role: "system" | "user"; content: string }[] {
  const from = languageName(r.from), to = languageName(r.to), lang = languageName(r.in);
  const own = r.in === r.from;
  const system = [
    `You write the notes on the back of a flashcard for someone learning ${from} who knows ${to}. The card already shows the word, its ${to} translation and an example sentence. Your notes add what a good learner's dictionary says about this word in this meaning: its grammar and how it is used.`,
    own
      ? `Write everything in ${from}, in simple ${from} a learner at B1 level reads easily: short plain lines, everyday words, the usual ${from} grammar terms.`
      : `Write in ${to}; ${from} words, forms and phrases stay in ${from}.`,
    `- "gist": a few words: the part of speech and the one grammar fact that matters most (irregular, reflexive, gender…), then " · " and the meaning in a few words.`,
    `- "forms": the forms a learner needs, at most ${MAX_FORMS} rows, each {"label": a short grammar term in ${lang}, "value": the ${from} forms}. A verb: the present (all persons), other tenses only where they are irregular, plus the participle. A noun: singular and plural, with articles where ${from} has them. An adjective: its gender and number forms. Only forms that exist for this meaning. Words that don't change: [].`,
    `- "notes": 1 to 3 sections, each {"title": 1 to 3 plain words in ${lang}, "lines": 1 to 4 short lines}. Pick only what really helps with this word: how it is used (prepositions or cases it takes, set constructions, common collocations), what not to mix it up with (near-synonyms, false friends) and the difference, register or region when notable, other common meanings.`,
    `No sentences used as examples: collocations and constructions as bare phrases only (e.g. "tener hambre", not "Tengo hambre."). Nothing obvious or generic. Every line under 15 words. No markdown, no exclamation marks.`,
    `Return JSON: {"gist": "...", "forms": [{"label": "...", "value": "..."}], "notes": [{"title": "...", "lines": ["..."]}]}`,
  ].join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: `${from} word: ${clean(r.word)}\n${to} translation: ${clean(r.translation)}` },
  ];
}

/** JSON schema for models that take one (response_format json_schema). */
export const SUMMARY_SCHEMA = {
  type: "object",
  properties: {
    gist: { type: "string" },
    forms: { type: "array", items: { type: "object", properties: { label: { type: "string" }, value: { type: "string" } }, required: ["label", "value"] } },
    notes: { type: "array", items: { type: "object", properties: { title: { type: "string" }, lines: { type: "array", items: { type: "string" } } }, required: ["title", "lines"] } },
  },
  required: ["gist", "forms", "notes"],
};

/** One line of text: no markdown emphasis or list marks, within `max`. */
function line(v: unknown, max = MAX_LINE): string {
  if (typeof v !== "string") return "";
  const s = clean(v)
    .replace(/\*\*|__|`/g, "")
    .replace(/^[-•*]\s+/, "")
    .trim();
  return s.length <= max ? s : "";
}

/** The LLM's reply (an object, JSON text, or JSON in a code fence) as a summary, or null when nothing usable came. */
export function parseSummary(reply: unknown): Summary | null {
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
  if (!v || typeof v !== "object") return null;
  const o = v as { gist?: unknown; forms?: unknown; notes?: unknown };
  const forms: [string, string][] = [];
  for (const f of Array.isArray(o.forms) ? o.forms : []) {
    const x = (f ?? {}) as { label?: unknown; value?: unknown };
    const label = line(x.label, 40), value = line(x.value);
    if (label && value) forms.push([label, value]);
    if (forms.length === MAX_FORMS) break;
  }
  const notes: Summary["notes"] = [];
  for (const n of Array.isArray(o.notes) ? o.notes : []) {
    const x = (n ?? {}) as { title?: unknown; lines?: unknown };
    const title = line(x.title, 60);
    const lines = (Array.isArray(x.lines) ? x.lines : []).map((l) => line(l)).filter(Boolean).slice(0, MAX_LINES);
    if (title && lines.length) notes.push({ title, lines });
    if (notes.length === MAX_NOTES) break;
  }
  const gist = line(o.gist, 120);
  return gist || forms.length || notes.length ? { gist, forms, notes } : null;
}

/** What a summary is kept under: the same words make the same key, on the server and on devices. */
export function summaryText(r: SummaryRequest, model = SUMMARY_MODEL): string {
  return [SUMMARY_VERSION, model, r.from.toLowerCase(), r.to.toLowerCase(), r.in.toLowerCase(), clean(r.word), clean(r.translation)].join("\u0000");
}

/** Where the server keeps a summary, so the same words never cost twice (for anyone). */
export async function summaryKey(r: SummaryRequest, model = SUMMARY_MODEL): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(summaryText(r, model)));
  return `summary/${[...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("")}.json`;
}

/** Local dev has no AI: notes anyone can recognise, long enough to scroll. */
export function devSummary(r: SummaryRequest): Summary {
  const w = clean(r.word);
  return {
    gist: `dev notes · ${clean(r.translation)}`,
    forms: [
      ["form one", `${w}, ${w}s, ${w}ed`],
      ["form two", `${w}ing`],
    ],
    notes: [
      { title: "How it's used", lines: [`${w} + something: a dev line.`, "Another dev line, a little longer so it wraps on a phone."] },
      { title: "Don't mix up", lines: [`${w} and its neighbour: they differ.`] },
      { title: "Register", lines: ["Neutral. Dev placeholder."] },
    ],
  };
}
