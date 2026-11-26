// Card pictures: which meaning to draw and the prompts that draw it. Pure, so
// the Worker (worker/pictures.ts) and tests share it.
//
// Pipeline: the meaning is decided first (user's choice, else the only listed
// meaning, else a small LLM picks one of the listed meanings from the example),
// then the LLM picks the kind of picture and turns word + meaning into one
// concrete scene, and FLUX.2 klein 4B draws it in the house cut-paper style.
// Numbers, times and years are drawn as numerals instead (FLUX miscounts
// "thirteen apples"), and words no picture can show (of, however) get none. The scene writer never sees the
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
  /** The user asked for a picture: never answered with none. */
  always?: boolean;
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

const KINDS = `First decide which kind of picture fits the meaning:
- "scene": things, people, animals, plain actions (to eat, to put, to write), feelings, qualities you can see or feel (heavy, red, noisy), places, weather, seasons, jobs, swear words and insults (what they literally say, or the behaviour: shit: a pile of manure; idiot: a man trying to fit a round peg into a square hole), greetings and polite words (please, yes: a nod), common adjectives and comparatives (good, better, alive, free, safe), God, wishing and hoping, skills shown in action, and ideas a person visibly acts out. Nouns for things you can hold, see or point at (a weapon, a message, a detail, a country), plain action verbs and concrete adjectives always get a scene. Units of time (hour, year, century), "number", midnight and noon get a scene too, never digits. First, second and third: a person on that step of a winners' podium.
- "digits": only a number itself, a clock time or a year: drawn as big numerals cut from paper, because counted things come out miscounted. Write only the digits, at most 4 (thirteen: "13", a hundred: "100", half past seven: "7:30", 1999: "1999", percent: "%"). Never for bigger numbers, fractions or other ordinals.
- "none": words whose meaning no picture can show, or none tells apart from its neighbours: articles, prepositions, conjunctions, pronouns, possessives, particles, auxiliary and modal verbs (can, must, need, may), aspect verbs (to usually do, to have just done, to do again), connecting words (however, therefore, actually, although), adverbs of time, frequency, degree and likelihood (still, already, yet, just, always, often, never, again, recently, later, today, tomorrow, the day after tomorrow, very, quite, too, only, probably, maybe, totally), quantity words (all, every, some, in total), numbers past 9999, fractions and ordinals past third, weekdays and months (no picture tells Tuesday from Wednesday), words for a group of people by ethnicity, nationality, religion, sexual orientation or gender identity (a Jew, a Korean, a Muslim, gay, transgender; their places, holidays and things still get a scene: a church, a mosque, Christmas, a flag), political movements and ideologies (feminism, socialism), and words about suicide, sex or nudity (the image model's safety filter refuses them). For any other word, abstract nouns too (quality, importance, system): "none" unless one clear, everyday scene shows exactly this meaning; a gesture, a handshake or a near miss counts. A banned symbol is no reason for "none": find another picture.`;

const SCENE_RULES = `Rules for a scene:
- Show exactly the given "Meaning" of the word, nothing else. A thing is shown itself (a bed: an empty bed, not a sleeper).
- Describe one concrete, instantly readable scene: one or two main figures or objects. Never describe a place behind them (no street, city, room, park, wall, doorway or landscape): it becomes a cut-out on blank paper, so at most one or two small props hint at the setting, like a sun, a lamp or a bush. 1-2 sentences, English, no style words (the style is added later).
- Abstract words, verbs and idioms: show a person or animal visibly doing or feeling it, in a situation where the meaning is obvious.
- Idioms whose literal words make a vivid picture: merge the literal image with the meaning, as a memory hook (e.g. "estar en las nubes": a daydreaming woman whose head floats among clouds).
- The picture must point to this word, not to a near neighbour: include the one detail that tells this meaning apart from similar words (think, know, understand; look, see; can, strong; buy, customer). E.g. for getting up early: a person already dressed, drinking coffee, a small sun just rising, a rooster crowing.
- No stock symbols standing for the meaning: no lightbulbs, question marks, exclamation marks, hearts, check marks, thumbs up, magnifying glasses, keys, mirrors, forking paths, glows or sparkles, and no apple as a stand-in object, unless the word is that very thing.
- The image model can't draw these, so never ask for them: more than three people or a crowd, something missing or absent ("without", "no", "not", "used to be"), time passing or before/after, a figure repeated, distance or "far away", split panels, arrows.
- Never "a person", "someone" or "they": pick a man or a woman. If the word itself is masculine or feminine (la enfermera, der Arzt), match it; otherwise a woman as often as a man, and against the cliché as often as with it (a doctor, an engineer, a boss, a nurse may be either).
- Political and social words (immigrant, border, homeland, slave, poor, rich, police, soldier) are shown plainly: what the word names, with no feelings, hopes, pride or judgement added (an immigrant: a man with a suitcase at a train station). A country: one landmark of it, never people in costume.
- Family words show the role by what the person does, not a hug (a father: a man teaching his son to ride a bike; a mother: a woman walking her little son to school by the hand).
- Never a body, a wound, a pool of blood or a weapon aimed at a person. Violent and sad words get a picture of their own, not a shared symbol: war: a soldier beside a tank; to kill: a knight striking a dragon; death: a gravestone; to die: a wilting flower; blood: a red drop on a fingertip. Murder: "none".
- If "Details" are given, include them.
- The picture is a test: the learner must guess the word from it. So nothing in it may carry writing: no quoted words, dialogue or names, no speech or thought bubbles, no calendars, newspapers, signs, price tags, lists, screens, maps, chalkboards, labels, letters of the alphabet, digits or numbered things; clocks have hands only; paper things (a cheque, a letter, a book) are shown closed or blank. Show talking with gestures and open mouths, and jobs by their tools (a teacher: holding up a globe in front of a pupil). Never show a number by counting things.
- Don't reuse these examples: write a scene of your own.`;

const INTRO = "You write the subject for a flashcard illustration that helps a language learner remember one word.";

/**
 * The scene LLM's system prompt. It also decides the kind of picture (a scene,
 * digits cut from paper, or none), "kind" first so it is known before the
 * scene streams. `always`: the user asked for a picture, so "none" is no option.
 */
export function sceneSystem(always = false): string {
  if (always) return `${INTRO}\n${KINDS.replace(/\n- "none":[^\n]*/, "").replace("which kind", "which of two kinds")}\n${SCENE_RULES.replace(' Murder: "none".', "")}\nReturn JSON: {"kind": "scene", "scene": "<the scene>"} or {"kind": "digits", "digits": "<the digits>"}`;
  return `${INTRO}\n${KINDS}\n${SCENE_RULES}\nReturn JSON: {"kind": "scene", "scene": "<the scene>"}, {"kind": "digits", "digits": "<the digits>"} or {"kind": "none"}`;
}

/** Word and the meaning decided before (never the example), plus the user's details. With details the user wants a picture. */
export function sceneMessages(r: PictureRequest, sense: string): { role: "system" | "user"; content: string }[] {
  const lines = [`Word: ${r.word}`, `Meaning: ${sense}`];
  if (r.details?.trim()) lines.push(`Details: ${r.details.trim()}`);
  // Last, and only about who: as "Person: a woman" it read as a call for a person, and "that", "only" and "still" got scenes again.
  lines.push(`(Only if you choose a scene with a person in it: make them a ${womanOrMan(r.word, sense)}, unless the word itself is masculine or feminine, like la secretaria or der Lehrer: then match the word. This never changes the kind.)`);
  return [
    { role: "system", content: sceneSystem(r.always || !!r.details?.trim()) },
    { role: "user", content: lines.join("\n") },
  ];
}

/**
 * Who a scene shows when the word doesn't say: each request is on its own, so
 * "a woman as often as a man" in the prompt alone gave a man for doctor,
 * engineer, teacher, cook and pilot. Fixed per word, so a redraw keeps it.
 */
export function womanOrMan(word: string, sense: string): "woman" | "man" {
  let h = 0x811c9dc5; // FNV-1a: a plain sum's low bit is just the letters' parity
  for (const c of `${word}\n${sense}`) h = Math.imul(h ^ c.codePointAt(0)!, 0x01000193);
  return (h >>> 16) & 1 ? "woman" : "man";
}

/** What to draw: a scene, numerals cut from paper (`scene` describes them for the pencil), or nothing. */
export type Plan = { kind: "scene"; scene: string } | { kind: "digits"; digits: string; scene: string } | { kind: "none" };

/** A number, a time or a year: what may be drawn as numerals. "3." (FLUX drew "33.") and the like are left out. */
const DIGITS_RE = /^(?:\d{1,4}(?::\d{2})?|%)$/;

/** Modal and aspect verbs (English meanings): the scene model is told they get none but drew "can" as a weightlifter anyway. */
const NO_PICTURE = /^(?:to )?(?:be able to|can|could|must|should|ought to|may|might|have to|need(?: to)?|usually(?: do)?|have just(?: done)?|do again)$/i;

/**
 * Groups of people by religion, ethnicity, orientation or identity, and
 * ideologies (English meanings): told to answer none, the scene model still
 * drew a kippah for "Jew" and a rainbow flag for "gay". A costume for a people
 * is a stereotype, so none, in code.
 */
const GROUPS = /\b(?:jews?|jewish|muslims?|christians?|catholics?|protestants?|hindus?|buddhists?|sikhs?|atheists?|arabs?|gays?|lesbians?|bisexual|homosexuals?|heterosexual|transgender|trans|queer|non-binary|black (?:man|woman|person|people)|white (?:man|woman|person|people)|(?:femin|social|commun|capital|fasc|naz|liberal|conservat|national|anarch|zion|islam|racism)ism|feminists?|socialists?|communists?|fascists?|nazis?)\b/i;

/** The scene LLM's reply (a JSON string, an object, or JSON in a code fence). `always`: never "none". */
export function parsePlan(reply: unknown, sense: string, always = false): Plan {
  let v: unknown = reply;
  if (typeof v === "string") {
    const text = v.replace(/^\s*```(?:json)?/, "").replace(/```\s*$/, "").trim();
    try {
      v = JSON.parse(text);
    } catch {
      v = { scene: text };
    }
  }
  const o = (v ?? {}) as { kind?: unknown; scene?: unknown; digits?: unknown };
  if (!always && (NO_PICTURE.test(sense.trim()) || GROUPS.test(sense))) return { kind: "none" };
  const digits = typeof o.digits === "string" || typeof o.digits === "number" ? String(o.digits).replace(/\s+/g, "") : "";
  if (o.kind === "digits" && DIGITS_RE.test(digits)) return { kind: "digits", digits, scene: `the number ${digits}, cut from paper` };
  const text = typeof o.scene === "string" ? withoutQuotes(o.scene) : "";
  // Nothing usable (bad digits, an empty scene): none, unless the user asked for a picture.
  if ((o.kind === "none" || !text) && !always) return { kind: "none" };
  return { kind: "scene", scene: text || `A simple everyday scene that shows ${sense}.` };
}

/** Units of time and the like, which the scene model sometimes gives digits ("year": 1, "century": 100). */
const NOT_A_NUMBER = /\b(?:years?|hours?|days?|weeks?|months?|century|centuries|decades?|minutes?|time|number|noon|midday|midnight|age|dozen|first|second|third|\w+th)\b/i;

/**
 * Things the scene model is told never to draw and still sometimes writes
 * (a focus group of 1,122 words found each of these): a match asks it once
 * more. A term the meaning itself names is fine (a mirror for "mirror").
 */
const BANNED: [RegExp, string][] = [
  [/\blight ?bulbs?\b/i, "a lightbulb"],
  [/\bthumbs?[ -]up\b/i, "a thumbs up"],
  [/\bmagnifying glass/i, "a magnifying glass"],
  [/\bmirrors?\b|\breflection/i, "a mirror"],
  [/\bcalendars?\b/i, "a calendar"],
  [/\bnewspapers?\b/i, "a newspaper"],
  [/\b(?:chalk|black|white)boards?\b/i, "a board"],
  [/\bsign(?:post|board)?s?\b(?! language)/i, "a sign"],
  [/\bprice tags?\b|\blabels?\b/i, "a label"],
  [/\b(?:check)?lists?\b/i, "a list"],
  [/\bdocuments?\b|\bpages? (?:of|with)\b|\bopen book\b|\bnumbered\b/i, "a document or numbered things"],
  [/\bmaps?\b/i, "a map"],
  [/\b(?:speech|thought) bubbles?\b|\balphabet\b/i, "a speech bubble or letters"],
  [/\bcrowds?\b|\bgroup of\b|\bqueue\b|\bline of people\b/i, "a crowd"],
  [/\bdoorways?\b|\blandscape\b|\bvalley\b|\bmountain range\b/i, "a setting behind the figures"],
  [/\bshackles?\b|\bchained\b/i, "shackles"],
  [/\burin|\bstream of liquid\b/i, "a bodily fluid"],
  [/\bin the distance\b|\bfar away\b|\bevery (?:day|morning|night|evening)\b/i, "distance or repetition"],
  [/\bwithout\b|\bmissing\b/i, "something missing"],
  [/\b(?:forking|two) paths?\b|\bcrossroads?\b/i, "forking paths"],
  [/\bglow|\bsparkl/i, "a glow"],
  [/\bcorpse|\bdead body\b|\bbody under\b|\bblood\b/i, "a body or blood"],
];

/** What breaks a rule in this plan, said to the scene model when it is asked again; undefined when nothing does. */
export function planProblem(p: Plan, sense: string): string | undefined {
  if (p.kind === "digits" && NOT_A_NUMBER.test(sense)) return `"${sense}" is not a number itself: give it a scene (or none), not digits`;
  if (p.kind !== "scene") return undefined;
  for (const [re, what] of BANNED) if (re.test(p.scene) && !re.test(sense)) return `the scene has ${what}, which the rules forbid: write another scene without it`;
  return undefined;
}

/** Asking again after a broken rule: the conversation so far plus what was wrong. */
export function retryMessages(first: { role: "system" | "user"; content: string }[], reply: string, problem: string): { role: "system" | "user" | "assistant"; content: string }[] {
  return [...first, { role: "assistant", content: reply }, { role: "user", content: `That breaks a rule: ${problem}. Answer again, in the same JSON.` }];
}

/** The scene alone (a reply without a kind is a scene). */
export function parseScene(reply: unknown, sense: string): string {
  const p = parsePlan(reply, sense, true);
  return p.kind === "none" ? "" : p.scene;
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

/** Numerals: the one thing drawn with writing, since digits read the same in every language and the translation beside them says it anyway. */
export function digitsPrompt(digits: string): string {
  // Kept plain: spelling the characters out with their count ("exactly 2 characters: 1, 3") made FLUX draw 123,
  // and "each in a different color, side by side" made one 7 into 7777.
  const what =
    digits.length === 1
      ? `one single large numeral ${digits}, only one, cut from layered matte card stock in two colors, standing alone`
      : `the numerals ${digits.split("").join(" ")} (reading ${digits}), large and bold, each cut from layered matte card stock in a different color, standing side by side`;
  return `Cut-paper illustration: ${what}, centered on a plain white background and filling most of the frame. Nothing else: no other shapes, objects or writing. Irregular hand-cut outlines, plain white background showing around them. Paper colors: mustard yellow, terracotta, sage green, dusty blue. Crisp scissor-cut edges, soft drop shadows between the layers, photographed straight on in soft daylight.`;
}

/** The image prompt for a plan that draws something. */
export function planPrompt(p: Exclude<Plan, { kind: "none" }>): string {
  return p.kind === "digits" ? digitsPrompt(p.digits) : imagePrompt(p.scene);
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
// `{"none","sense"}` when no picture can show the word, or `{"error"}`. The card shows the scene in pencil while the picture draws.

export type PictureLine = { sense: string } | { scene: string } | { key: string; sense: string; scene: string } | { none: true; sense: string } | { error: string };

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
