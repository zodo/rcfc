// Which language a typed word is in, from its letters alone (no AI, no wait):
// a word in Cyrillic isn't English. Only the script is told apart, so this
// picks among the languages written in it: the one the card has, else the one
// the user uses most, else the usual one. Ukrainian is told from Russian by its
// own letters (і ї є ґ). Within one script (English or Spanish) it never guesses.

type Script = "Latn" | "Cyrl" | "Grek" | "Arab" | "Hebr" | "Hang" | "Kana" | "Hani";

const SCRIPT_OF: Record<string, Script> = {
  ru: "Cyrl", uk: "Cyrl", bg: "Cyrl", sr: "Cyrl", be: "Cyrl", kk: "Cyrl", mk: "Cyrl",
  el: "Grek", ar: "Arab", fa: "Arab", he: "Hebr", ko: "Hang", ja: "Kana", zh: "Hani",
};
/** The usual language of a script, when the user uses none written in it. */
const USUAL: Record<Script, string> = { Latn: "en", Cyrl: "ru", Grek: "el", Arab: "ar", Hebr: "he", Hang: "ko", Kana: "ja", Hani: "zh" };

const TESTS: [Script, RegExp][] = [
  ["Kana", /[\p{Script=Hiragana}\p{Script=Katakana}]/u], // before Han: Japanese mixes kanji in
  ["Hang", /\p{Script=Hangul}/u],
  ["Hani", /\p{Script=Han}/u],
  ["Cyrl", /\p{Script=Cyrillic}/u],
  ["Grek", /\p{Script=Greek}/u],
  ["Arab", /\p{Script=Arabic}/u],
  ["Hebr", /\p{Script=Hebrew}/u],
  ["Latn", /\p{Script=Latin}/u],
];

const scriptOfLang = (lang: string): Script => SCRIPT_OF[lang.toLowerCase().split("-")[0]] ?? "Latn";

/** The script most of the text's letters are in; undefined with no letters. */
export function scriptOf(text: string): Script | undefined {
  const count = new Map<Script, number>();
  for (const ch of text) {
    const s = TESTS.find(([, re]) => re.test(ch))?.[0];
    if (s) count.set(s, (count.get(s) ?? 0) + 1);
  }
  // Any kana makes it Japanese, even with more kanji.
  if (count.has("Kana")) return "Kana";
  return [...count].sort((a, b) => b[1] - a[1])[0]?.[0];
}

/**
 * The language `text` is in, given the card says `current`: `current` when its
 * letters could be that, else the first of `preferred` written in those
 * letters, else the usual one. Too little to go by (under 2 letters): `current`.
 */
export function languageOfText(text: string, current: string, preferred: readonly string[]): string {
  const letters = [...text].filter((c) => /\p{L}/u.test(c)).length;
  const s = letters >= 2 ? scriptOf(text) : undefined;
  if (!s) return current;
  const ukr = s === "Cyrl" && /[іїєґІЇЄҐ]/u.test(text);
  const fits = (l: string) => {
    const ls = scriptOfLang(l);
    if (s === "Hani") return ls === "Hani" || ls === "Kana"; // all kanji: Japanese can be that too
    if (ukr) return l.split("-")[0] === "uk";
    return ls === s;
  };
  if (fits(current)) return current;
  return preferred.find(fits) ?? (ukr ? "uk" : USUAL[s]);
}
