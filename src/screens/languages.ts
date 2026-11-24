// Languages, shared by several screens. A language is a pair (Spanish →
// English) that lives on each word; it exists while it has words, and the UI
// names it after the language studied. Under it sits one hidden deck per pair,
// because the model takes a deck id (src/domain/rows.ts): made with the pair's
// first word, its id derived from the pair so devices adding offline agree.
import { app } from "../app";
import type { LangPair } from "../domain/events";
import { derivedEntityId, type EntityId } from "../domain/ids";
import { languagePile } from "../domain/piles";
import { h, LANGS, langName, langSelect } from "../ui/h";

const LAST_KEY = "rcfc:lastLanguage";
const OPEN_KEY = "rcfc:wordsLanguage";

export const samePair = (a: LangPair, b: LangPair) => a.from === b.from && a.to === b.to;
const key = (p: LangPair) => languagePile(p);

/** Every language with words, in the order their first word was added. */
export function languages(): LangPair[] {
  const out: LangPair[] = [];
  for (const n of app.store.col.liveNotes()) if (!out.some((p) => samePair(p, n.lang_pair))) out.push(n.lang_pair);
  return out;
}

/** "Spanish"; "Spanish → English" when another language studies Spanish too. */
export function languageLabel(p: LangPair, others: LangPair[] = languages()): string {
  const twin = others.some((o) => !samePair(o, p) && o.from === p.from);
  return twin ? `${langName(p.from)} → ${langName(p.to)}` : langName(p.from);
}

function read(k: string): LangPair | null {
  try {
    const v = localStorage.getItem(k);
    const [from, to] = v ? v.split(">") : [];
    return from && to ? { from, to } : null;
  } catch {
    return null; // storage unavailable
  }
}
function write(k: string, p: LangPair | null): void {
  try {
    if (p) localStorage.setItem(k, `${p.from}>${p.to}`);
    else localStorage.removeItem(k);
  } catch {
    /* ignore */
  }
}

/** The language last studied, added to or picked (maybe one with no words yet: just picked to add the first). */
export function lastLanguage(): LangPair | undefined {
  return read(LAST_KEY) ?? languages()[0];
}
export function rememberLanguage(p: LangPair): void {
  write(LAST_KEY, p);
}

/** The language open in Words; null = all words. */
export function openLanguage(): LangPair | null {
  const p = read(OPEN_KEY);
  return p && languages().some((o) => samePair(o, p)) ? p : null;
}
export function setOpenLanguage(p: LangPair | null): void {
  write(OPEN_KEY, p);
  if (p) rememberLanguage(p);
}

/** The hidden deck new words of this language go into: the existing one, else one made now. */
export async function deckFor(lang_pair: LangPair): Promise<EntityId> {
  const { store } = app;
  const same = [...store.col.decks.values()].filter((d) => samePair(d.lang_pair, lang_pair)).sort((a, b) => a.id - b.id)[0];
  if (same) return same.id;
  const id = derivedEntityId(`deck:${key(lang_pair)}`);
  await store.append([store.factory.deck(langName(lang_pair.from), store.preset().preset_id, lang_pair, id)]);
  return id;
}

/** "I'm learning … / I speak …": picks a language (made once its first word is added). */
export function languageForm(onDone: (p: LangPair) => void, submitLabel: string): HTMLFormElement {
  // Suggest a language not studied yet, translated into the language used so far.
  const to = lastLanguage()?.to ?? "en";
  const used = new Set(languages().map((p) => p.from));
  const learning = langSelect("from", LANGS.find((c) => !used.has(c) && c !== to) ?? "es");
  const speak = langSelect("to", to);
  return h(
    "form",
    {
      class: "card-box",
      onsubmit: (e: Event) => {
        e.preventDefault();
        const p = { from: learning.value, to: speak.value };
        rememberLanguage(p);
        onDone(p);
      },
    },
    h("div", { class: "row2" }, h("label", {}, "I'm learning", learning), h("label", {}, "I speak", speak)),
    h("button", { class: "primary", type: "submit" }, submitLabel),
  );
}
