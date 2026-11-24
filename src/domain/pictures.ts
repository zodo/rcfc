// Card pictures: which meaning to draw and the prompts that draw it. Pure, so
// the Worker (worker/pictures.ts) and tests share it.
//
// Pipeline: a small LLM turns the word into one concrete scene, then FLUX.2
// klein 4B draws it in the house cut-paper style. The meaning is decided here,
// not by the LLM: tested models ignore "use the first meaning" too often.

export const PICTURE_W = 768;
export const PICTURE_H = 512;

export const SCENE_MODEL = "@cf/ibm-granite/granite-4.0-h-micro";
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
 * The meaning to ask for: the user's choice, else (with no example to decide)
 * the first listed meaning. With an example and no choice, the LLM reads the
 * meaning from the example.
 */
export function senseFor(r: PictureRequest): string | undefined {
  const s = r.sense?.trim();
  if (s) return s;
  if (r.example?.trim()) return undefined;
  return meanings(r.translation)[0];
}

export const SCENE_SYSTEM = `You write the subject for a flashcard illustration that helps a language learner remember one word.
Rules:
- Show exactly ONE meaning. If a "Sense" is given, use it. Else use the meaning the example sentence uses.
- Describe one concrete, instantly readable scene: one or two main figures or objects. Never describe a place behind them (no street, city, room, park, wall, doorway or landscape): it becomes a cut-out on blank paper, so at most one or two small props hint at the setting, like a sun, a lamp or a bush. 1-2 sentences, English, no style words (the style is added later).
- Abstract words, verbs and idioms: show a person or animal visibly doing or feeling it, in a situation where the meaning is obvious.
- Idioms whose literal words make a vivid picture: merge the literal image with the meaning, as a memory hook (e.g. "estar en las nubes": a daydreaming woman whose head floats among clouds).
- People are always adults.
- Make the meaning unmistakable: include the one detail that tells this meaning apart from similar ideas (e.g. for getting up early: a person already dressed, drinking coffee, a small sun just rising, a rooster crowing).
- If "Details" are given, include them.
- The picture is a test: the learner must guess the word from it. So nothing in it may carry writing: no quoted words, dialogue or names, no speech or thought bubbles, no calendars, signs, books, screens, chalkboards, labels, letters or digits. Show talking with gestures and open mouths; show days, numbers and times with things you can count or see (e.g. Monday: a sleepy office worker with a briefcase hurrying to work at dawn; thirteen: thirteen apples in a row).
Return JSON: {"sense": "<the meaning you chose, 1-3 English words>", "scene": "<the scene>"}`;

export function sceneMessages(r: PictureRequest): { role: "system" | "user"; content: string }[] {
  const sense = senseFor(r);
  const lines = [`Word: ${r.word}`, `Translation: ${r.translation}`];
  if (r.example?.trim()) lines.push(`Example: ${r.example.trim()}`);
  if (sense) lines.push(`Sense: ${sense}`);
  if (r.details?.trim()) lines.push(`Details: ${r.details.trim()}`);
  return [
    { role: "system", content: SCENE_SYSTEM },
    { role: "user", content: lines.join("\n") },
  ];
}

/** The scene LLM's reply (a JSON string, an object, or JSON in a code fence). */
export function parseScene(reply: unknown, r: PictureRequest): { sense: string; scene: string } {
  let v: unknown = reply;
  if (typeof v === "string") {
    const text = v.replace(/^\s*```(?:json)?/, "").replace(/```\s*$/, "").trim();
    try {
      v = JSON.parse(text);
    } catch {
      v = { scene: text };
    }
  }
  const o = (v ?? {}) as { sense?: unknown; scene?: unknown };
  // A sense we asked for wins over the LLM's own label (it mislabels).
  const sense = senseFor(r) ?? (typeof o.sense === "string" && o.sense.trim() ? o.sense.trim() : meanings(r.translation)[0] ?? r.translation);
  const text = typeof o.scene === "string" ? withoutQuotes(o.scene) : "";
  // Never the studied word: the picture sits on the known side as a clue.
  return { sense, scene: text || `A simple everyday scene that shows ${sense}.` };
}

const SPEECH_VERB = String.raw`(?:(?:and|while|as)\s+)?(?:says?|said|saying|asks?|asking|shouts?|shouting|reads?|reading|writes?|writing|showing|displaying|labell?ed|with the words?|the words?)(?:\s+(?:each other|him|her|them|out|loud))*,?\s*`;
const QUOTED = new RegExp(String.raw`[\s,]*(?:${SPEECH_VERB})?(?:"[^"]*"|“[^”]*”|«[^»]*»|(?<![\p{L}\p{N}])['‘][^'’]{1,120}['’](?![\p{L}\p{N}]))`, "giu");

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
  "Its outline is irregular and hand-cut, following the figures and props: no rectangular backdrop, no panel, no frame, plain white background showing around it. Paper colors: mustard yellow, terracotta, sage green, dusty blue and white. Crisp scissor-cut edges, soft drop shadows between the layers, photographed straight on in soft daylight. The paper is blank, with no writing anywhere.";

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
