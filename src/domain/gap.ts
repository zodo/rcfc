// The example with the word blanked out, for a reverse card's cream side: the
// translation says which word, the sentence says which form (a cloze). Found in
// code, nothing stored: the word and every other form of it (same start:
// perro → perros, ningún → ninguna; a look-alike goes too, casa → casado).
// Not found (an irregular form) = no sentence.

/** Articles a word may be typed with ("el perro"); also blanked when they stand right before the word in the example. */
const ARTICLES = new Set(
  "el la los las lo un una unos unas le les l il gli i o a os as um uma der die das den dem des ein eine einen einem einer eines de het een the an".split(" "),
);
/** Languages written without spaces between words: the word is looked for as it is. */
const NO_SPACES = new Set(["ja", "zh", "th", "lo", "km", "my"]);

const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase();

interface Tok {
  start: number;
  end: number;
  key: string;
}
const tokens = (s: string): Tok[] => [...s.matchAll(/[\p{L}\p{M}\p{N}]+/gu)].map((m) => ({ start: m.index, end: m.index + m[0].length, key: fold(m[0]) }));

/** Another form of the word: short words only as they are, longer ones by a shared start (all but the last two letters, at least three). */
function sameWord(w: string, t: string): boolean {
  if (w === t) return true;
  if (w.length < 4) return false;
  let p = 0;
  while (p < w.length && p < t.length && w[p] === t[p]) p++;
  return p >= Math.max(3, w.length - 2);
}

/** Runs of example tokens matching the word's tokens, left to right, not overlapping. */
function runs(word: string[], ex: Tok[]): [number, number][] {
  const found: [number, number][] = [];
  for (let i = 0; i + word.length <= ex.length; i++) {
    if (word.every((w, j) => sameWord(w, ex[i + j].key))) {
      found.push([i, i + word.length - 1]);
      i += word.length - 1;
    }
  }
  return found;
}

/**
 * The example split around the word: the gaps go between the parts. Null when
 * the word can't be found in it, or when nothing but the word would be left.
 */
export function gapped(word: string, example: string | undefined, lang: string): string[] | null {
  const ex = example?.trim();
  const w = word.trim();
  if (!ex || !w) return null;
  let spans: [number, number][] = [];
  const toks = tokens(ex);
  if (NO_SPACES.has(lang.split("-")[0]) && !/\s/.test(ex)) {
    for (let i = ex.indexOf(w); i >= 0; i = ex.indexOf(w, i + w.length)) spans.push([i, i + w.length]);
  } else {
    const full = tokens(w).map((t) => t.key);
    if (!full.length) return null;
    const bare = full.length > 1 && ARTICLES.has(full[0]) ? full.slice(1) : null;
    // every form of it: one left standing would give the answer away
    spans = runs(bare ?? full, toks).map(([a, b]) => {
      // an article right before a noun would give its gender away
      if (bare && a > 0 && ARTICLES.has(toks[a - 1].key) && /^\s+$/.test(ex.slice(toks[a - 1].end, toks[a].start))) a--;
      return [toks[a].start, toks[b].end];
    });
  }
  if (!spans.length) return null;
  const parts: string[] = [];
  let at = 0;
  for (const [s, e] of spans) {
    parts.push(ex.slice(at, s));
    at = e;
  }
  parts.push(ex.slice(at));
  if (!/[\p{L}\p{N}]/u.test(parts.join(""))) return null;
  return parts;
}
