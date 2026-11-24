// Languages, shared by several screens. The UI shows only the language
// studied (Spanish): it exists while it has words and has one pile. Each word
// also records the language its translation is in (`note.lang_pair.to`), picked
// per word on the Add screen, defaulting to the last one used for that
// language. Under each studied language sits one hidden deck, because the
// model takes a deck id (src/domain/rows.ts): made with its first word, its id
// derived from the language so devices adding offline agree.
import { app } from "../app";
import { derivedEntityId, type EntityId } from "../domain/ids";
import { languagePile } from "../domain/piles";
import { h, LANGS, langName, langSelect } from "../ui/h";

const LAST_KEY = "rcfc:lastLanguage";
const OPEN_KEY = "rcfc:wordsLanguage";
const TRANSLATION_KEY = "rcfc:translation:";

/** Every studied language with words, in the order its first word was added. */
export function languages(): string[] {
  const out: string[] = [];
  for (const n of app.store.col.liveNotes()) if (!out.includes(n.lang_pair.from)) out.push(n.lang_pair.from);
  return out;
}

function read(k: string): string | null {
  try {
    return localStorage.getItem(k)?.split(">")[0] || null; // older values were pairs, "es>en"
  } catch {
    return null; // storage unavailable
  }
}
function write(k: string, v: string | null): void {
  try {
    if (v) localStorage.setItem(k, v);
    else localStorage.removeItem(k);
  } catch {
    /* ignore */
  }
}

/** The language last studied, added to or picked (maybe one with no words yet: just picked to add the first). */
export function lastLanguage(): string | undefined {
  return read(LAST_KEY) ?? languages()[0];
}
export function rememberLanguage(lang: string): void {
  write(LAST_KEY, lang);
}

/** The language open in Words; null = all words. */
export function openLanguage(): string | null {
  const l = read(OPEN_KEY);
  return l && languages().includes(l) ? l : null;
}
export function setOpenLanguage(lang: string | null): void {
  write(OPEN_KEY, lang);
  if (lang) rememberLanguage(lang);
}

/** The language a new word's translation is in: the last one picked for this language, else its latest word's, else any word's. */
export function translationFor(lang: string): string {
  let pick: string | null = null;
  try {
    pick = localStorage.getItem(TRANSLATION_KEY + lang);
  } catch {
    /* storage unavailable */
  }
  if (pick) return pick;
  const notes = app.store.col.liveNotes();
  return (notes.findLast((n) => n.lang_pair.from === lang) ?? notes.at(-1))?.lang_pair.to ?? (lang === "en" ? "es" : "en");
}
export function rememberTranslation(lang: string, to: string): void {
  write(TRANSLATION_KEY + lang, to);
}

/** The hidden deck new words of this language go into: the existing one, else one made now. */
export async function deckFor(lang: string): Promise<EntityId> {
  const { store } = app;
  const same = [...store.col.decks.values()].filter((d) => d.lang_pair.from === lang).sort((a, b) => a.id - b.id)[0];
  if (same) return same.id;
  const id = derivedEntityId(`deck:${languagePile(lang)}`);
  await store.append([store.factory.deck(langName(lang), store.preset().preset_id, { from: lang, to: translationFor(lang) }, id)]);
  return id;
}

/** "I'm learning … / I speak …": picks a language (made once its first word is added) and its translations' language. */
export function languageForm(onDone: (lang: string) => void, submitLabel: string): HTMLFormElement {
  // Suggest a language not studied yet, translated into the language used so far.
  const last = lastLanguage();
  const to = last ? translationFor(last) : "en";
  const used = new Set(languages());
  const learning = langSelect("from", LANGS.find((c) => !used.has(c) && c !== to) ?? "es");
  const speak = langSelect("to", to);
  return h(
    "form",
    {
      class: "card-box",
      onsubmit: (e: Event) => {
        e.preventDefault();
        rememberLanguage(learning.value);
        rememberTranslation(learning.value, speak.value);
        onDone(learning.value);
      },
    },
    h("div", { class: "row2" }, h("label", {}, "I'm learning", learning), h("label", {}, "I speak", speak)),
    h("button", { class: "primary", type: "submit" }, submitLabel),
  );
}
