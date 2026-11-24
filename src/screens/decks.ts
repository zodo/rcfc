// Languages, shared by several screens. A deck is one language pair (e.g.
// Spanish → English, English → Russian); the UI calls it a language and names
// it after the language studied. Words, adding and importing work on the
// current language, which the Words header switches.
import { app, go } from "../app";
import type { Deck } from "../domain/collection";
import type { DeckCreatedPayload, LangPair } from "../domain/events";
import type { EntityId } from "../domain/ids";
import { h, LANGS, langName, langSelect } from "../ui/h";

const LAST_DECK_KEY = "rcfc:lastDeck";

export function decks(): Deck[] {
  return [...app.store.col.decks.values()];
}

/** "Spanish"; "Spanish → English" when another deck studies the same language. */
export function deckLabel(d: Deck): string {
  const twin = decks().some((o) => o.id !== d.id && (o.name === d.name || o.lang_pair.from === d.lang_pair.from));
  return twin ? `${d.name} → ${langName(d.lang_pair.to)}` : d.name;
}

/** The language last studied, added to or picked in Words. */
export function currentDeck(): Deck | undefined {
  const { decks: all } = app.store.col;
  try {
    const d = all.get(Number(localStorage.getItem(LAST_DECK_KEY)));
    if (d) return d;
  } catch {
    /* storage unavailable */
  }
  return decks()[0];
}

export function rememberDeck(id: EntityId): void {
  try {
    localStorage.setItem(LAST_DECK_KEY, String(id));
  } catch {
    /* ignore */
  }
}

/** The deck for a language pair: the existing one, else a new one named after the language. */
export async function deckFor(lang_pair: LangPair): Promise<EntityId> {
  const { store } = app;
  const same = decks().find((d) => d.lang_pair.from === lang_pair.from && d.lang_pair.to === lang_pair.to);
  if (same) return same.id;
  const ev = store.factory.deck(langName(lang_pair.from), store.preset().preset_id, lang_pair);
  await store.append([ev]);
  return (ev.payload as DeckCreatedPayload).deck_id;
}

/** "I'm learning … / I speak …": picks or creates that language and makes it current. */
export function languageForm(onDone: (id: EntityId) => void, submitLabel: string): HTMLFormElement {
  // Suggest a language not studied yet, translated into the language used so far.
  const to = currentDeck()?.lang_pair.to ?? "en";
  const used = new Set(decks().map((d) => d.lang_pair.from));
  const learning = langSelect("from", LANGS.find((c) => !used.has(c) && c !== to) ?? "es");
  const speak = langSelect("to", to);
  return h(
    "form",
    {
      class: "card-box",
      onsubmit: async (e: Event) => {
        e.preventDefault();
        const id = await deckFor({ from: learning.value, to: speak.value });
        rememberDeck(id);
        onDone(id);
      },
    },
    h("div", { class: "row2" }, h("label", {}, "I'm learning", learning), h("label", {}, "I speak", speak)),
    h("button", { class: "primary", type: "submit" }, submitLabel),
  );
}

const ADD = "add";

/** The Words title: the current language, switchable, with "Add a language" at the end. */
export function languagePicker(current: Deck, onChange: () => void): HTMLElement {
  const s = h("select", { class: "lang-picker", "aria-label": "Language" });
  for (const d of decks()) s.appendChild(h("option", { value: String(d.id), selected: d.id === current.id }, deckLabel(d)));
  s.appendChild(h("option", { value: ADD }, "+ Add a language"));
  s.addEventListener("change", () => {
    if (s.value === ADD) return go.addLanguage();
    rememberDeck(Number(s.value));
    onChange();
  });
  // The visible title is plain text; the native select sits invisibly on top, so it opens the system picker.
  return h("h1", { class: "picker" }, h("span", {}, deckLabel(current)), h("span", { class: "chev", "aria-hidden": "true" }, "▾"), s);
}
