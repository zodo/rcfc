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
- Describe one concrete, instantly readable scene: one clear main subject, simple background. 1-2 sentences, English, no style words (the style is added later).
- Abstract words, verbs and idioms: show a person or animal visibly doing or feeling it, in a situation where the meaning is obvious.
- Idioms whose literal words make a vivid picture: merge the literal image with the meaning, as a memory hook (e.g. "estar en las nubes": a daydreaming woman whose head floats among clouds above her desk).
- People are always adults.
- Make the meaning unmistakable: include the one detail that tells this meaning apart from similar ideas (e.g. for getting up early: a person already dressed, drinking coffee, dark sky, clock showing 5:30).
- If "Details" are given, include them.
- Never include text, letters, signs, labels or speech bubbles.
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
  const scene = typeof o.scene === "string" && o.scene.trim() ? o.scene.trim() : `${r.translation}: ${r.word}`;
  // A sense we asked for wins over the LLM's own label (it mislabels).
  const sense = senseFor(r) ?? (typeof o.sense === "string" && o.sense.trim() ? o.sense.trim() : meanings(r.translation)[0] ?? r.translation);
  return { sense, scene };
}

// Medium first: scene-first prompts sometimes come out as photos.
const STYLE_LEAD = "Cut-paper illustration: a layered diorama made entirely of matte card stock, filling the whole frame. It shows:";
const STYLE =
  "Paper colors: mustard yellow, terracotta, sage green, dusty blue and white. Crisp scissor-cut edges, soft drop shadows between the layers, plain white paper background, photographed straight on in soft daylight. No text, no letters, no words.";

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
