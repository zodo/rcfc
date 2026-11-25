// Card pictures: which meaning to draw and the prompts that draw it. Pure, so
// the Worker (worker/pictures.ts) and tests share it.
//
// Pipeline: the meaning is decided first (user's choice, else the only listed
// meaning, else a small LLM picks one of the listed meanings from the example),
// then the LLM turns word + meaning into one concrete scene, and FLUX.2 klein 4B
// draws it in the house cut-paper style. The scene writer never sees the
// example: given one, it drew the sentence's situation instead of the word.

export const PICTURE_W = 768;
export const PICTURE_H = 512;

export const SCENE_MODEL = "@cf/google/gemma-4-26b-a4b-it";
export const IMAGE_MODEL = "@cf/black-forest-labs/flux-2-klein-4b";

/** Estimated neurons per picture: klein 4B at 768×512 is 2 tiles (~52), the scene ~1.3. Rounded up. */
export const NEURONS_PER_PICTURE = 60;
/** Workers AI gives 10,000 free neurons a day (UTC); stay under it. */
export const DEFAULT_DAILY_NEURONS = 9000;

export const MAX_DETAILS = 300;

export interface PictureRequest {
  word: string;
  translation: string;
  example?: string;
  /** Meaning to draw, chosen by the user. */
  sense?: string;
  /** Extra details the user wants in the picture. */
  details?: string;
}

/** The meanings a translation lists ("bank, bench" → ["bank", "bench"]). */
export function meanings(translation: string): string[] {
  return translation
    .split(/[,;/]|\s+\|\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * The meaning to draw when code can decide it: the user's choice, else the only
 * listed meaning, else (no example to decide) the first. Undefined = several
 * meanings and an example: the LLM picks one (`senseMessages`).
 */
export function senseFor(r: PictureRequest): string | undefined {
  const s = r.sense?.trim();
  if (s) return s;
  const m = meanings(r.translation);
  if (m.length > 1 && r.example?.trim()) return undefined;
  return m[0] ?? r.translation;
}

export const SENSE_SYSTEM = `A word has several meanings. Which one does the example sentence use? Return JSON: {"meaning": <its number>}`;

/** Asks which listed meaning the example uses (only when `senseFor` can't decide). */
export function senseMessages(r: PictureRequest): { role: "system" | "user"; content: string }[] {
  const list = meanings(r.translation).map((m, i) => `${i + 1}. ${m}`);
  return [
    { role: "system", content: SENSE_SYSTEM },
    { role: "user", content: [`Word: ${r.word}`, `Example: ${r.example?.trim() ?? ""}`, "Meanings:", ...list].join("\n") },
  ];
}

/** The meaning the LLM picked: one of the listed ones, else the first. */
export function parseSense(reply: unknown, r: PictureRequest): string {
  const m = meanings(r.translation);
  const o = reply && typeof reply === "object" ? (reply as { meaning?: unknown }).meaning : reply;
  // `{"meaning": 2}`, a bare 2, or JSON in a code fence: the first number in it.
  const n = Number(/\d+/.exec(typeof o === "string" ? o : JSON.stringify(o ?? ""))?.[0]);
  return m[n - 1] ?? m[0] ?? r.translation;
}

export const SCENE_SYSTEM = `You write the subject for a flashcard illustration that helps a language learner remember one word.
Rules:
- Show exactly the given "Meaning" of the word, nothing else.
- Describe one concrete, instantly readable scene: one or two main figures or objects. Never describe a place behind them (no street, city, room, park, wall, doorway or landscape): it becomes a cut-out on blank paper, so at most one or two small props hint at the setting, like a sun, a lamp or a bush. 1-2 sentences, English, no style words (the style is added later).
- Abstract words, verbs and idioms: show a person or animal visibly doing or feeling it, in a situation where the meaning is obvious.
- Idioms whose literal words make a vivid picture: merge the literal image with the meaning, as a memory hook (e.g. "estar en las nubes": a daydreaming woman whose head floats among clouds).
- People are always adults.
- Make the meaning unmistakable: include the one detail that tells this meaning apart from similar ideas (e.g. for getting up early: a person already dressed, drinking coffee, a small sun just rising, a rooster crowing).
- If "Details" are given, include them.
- The picture is a test: the learner must guess the word from it. So nothing in it may carry writing: no quoted words, dialogue or names, no speech or thought bubbles, no calendars, signs, books, screens, chalkboards, labels, letters or digits. Show talking with gestures and open mouths; show days, numbers and times with things you can count or see (e.g. Monday: a sleepy office worker with a briefcase hurrying to work at dawn; thirteen: thirteen apples in a row).
Return JSON: {"scene": "<the scene>"}`;

/** Word and the meaning decided before (never the example), plus the user's details. */
export function sceneMessages(r: PictureRequest, sense: string): { role: "system" | "user"; content: string }[] {
  const lines = [`Word: ${r.word}`, `Meaning: ${sense}`];
  if (r.details?.trim()) lines.push(`Details: ${r.details.trim()}`);
  return [
    { role: "system", content: SCENE_SYSTEM },
    { role: "user", content: lines.join("\n") },
  ];
}

/** The scene LLM's reply (a JSON string, an object, or JSON in a code fence). */
export function parseScene(reply: unknown, sense: string): string {
  let v: unknown = reply;
  if (typeof v === "string") {
    const text = v.replace(/^\s*```(?:json)?/, "").replace(/```\s*$/, "").trim();
    try {
      v = JSON.parse(text);
    } catch {
      v = { scene: text };
    }
  }
  const o = (v ?? {}) as { scene?: unknown };
  const text = typeof o.scene === "string" ? withoutQuotes(o.scene) : "";
  return text || `A simple everyday scene that shows ${sense}.`;
}

const SPEECH_VERB = String.raw`(?:(?:and|while|as)\s+)?(?:says?|said|saying|asks?|asking|shouts?|shouting|reads?|reading|writes?|writing|showing|displaying|labell?ed|with the words?|the words?)(?:\s+(?:each other|him|her|them|out|loud))*,?\s*`;
const QUOTED = new RegExp(String.raw`[\s,]*(?:${SPEECH_VERB})?(?:"[^"]*"|“[^”]*”|«[^»]*»|(?<![\p{L}\p{N}])['‘](?:[^'’]|(?<=\p{L})['’](?=\p{L})){1,120}['’](?![\p{L}\p{N}]))`, "giu");

/**
 * The scene minus quoted words and dialogue. The scene LLM writes them despite
 * its rules ("a calendar highlighting the word 'Monday'"), and FLUX then draws
 * them as text: a giveaway on a card that should make you recall the word.
 */
export function withoutQuotes(scene: string): string {
  return scene
    .replace(QUOTED, "")
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// Medium first: scene-first prompts sometimes come out as photos. A loose
// cut-out, not a full-frame diorama: its hand-cut outline shows on the card
// (the client flattens the white paper away), a framed panel looks like a photo.
const STYLE_LEAD = "Cut-paper illustration: one large free-standing cut-out of layered matte card stock, centered on a plain white background and filling most of the frame. It shows:";
const STYLE =
  "Its outline is irregular and hand-cut, following the figures and props: no rectangular backdrop, no panel, no frame, plain white background showing around it. Paper colors: mustard yellow, terracotta, sage green, dusty blue and white. Crisp scissor-cut edges, soft drop shadows between the layers, photographed straight on in soft daylight. The paper is blank, with no writing anywhere and no speech or thought bubbles.";

export function imagePrompt(scene: string): string {
  return `${STYLE_LEAD} ${scene} ${STYLE}`;
}

/** UTC day for the daily neuron budget (Workers AI resets at 00:00 UTC). */
export function budgetDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** Seconds until the budget resets. */
export function secondsToReset(now: number): number {
  const d = new Date(now);
  return Math.ceil((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - now) / 1000);
}

// ---- the scene as it streams in ----
//
// POST /api/pictures with `stream: true` answers NDJSON, one object per line:
// `{"sense"}` once the meaning is decided, `{"scene"}` (all of it so far) as
// the scene LLM writes it, then `{"key","sense","scene"}` with the picture,
// or `{"error"}`. The card shows the scene in pencil while the picture draws.

export type PictureLine = { sense: string } | { scene: string } | { key: string; sense: string; scene: string } | { error: string };

/**
 * The scene so far from a reply still arriving (`{"scene": "a person stand`).
 * It stops before any quote mark: quoted words are stripped from the final
 * scene (`withoutQuotes`), so they never show, not even for a moment.
 */
export function sceneSoFar(reply: string): string {
  const m = /"scene"\s*:\s*"/.exec(reply);
  if (!m) return "";
  let out = "";
  for (let i = m.index + m[0].length; i < reply.length; i++) {
    const c = reply[i];
    if (c === '"') break; // its end, or a quote in it
    if (c === "\\") {
      const n = reply[i + 1];
      if (n === undefined || n === '"' || n === "u") break; // cut mid-escape, or a quote / unicode escape: wait for the end
      out += n === "n" ? " " : n === "t" ? " " : n;
      i++;
      continue;
    }
    if ("“”«»".includes(c)) break;
    out += c;
  }
  // Single quotes are quotes too, unless inside a word (don't, l'eau).
  const q = /(^|[^\p{L}\p{N}])['‘]/u.exec(out);
  if (q) out = out.slice(0, q.index + q[1].length);
  return out.replace(/\s+/g, " ").trimStart();
}

/** Splits streamed text into complete lines; returns them and what is left over. */
export function takeLines(buf: string): { lines: string[]; rest: string } {
  const parts = buf.split("\n");
  const rest = parts.pop() ?? "";
  return { lines: parts.map((l) => l.trim()).filter(Boolean), rest };
}
