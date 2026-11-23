// Deck helpers shared by several screens.
import { app } from "../app";
import type { Deck } from "../domain/collection";
import type { DeckCreatedPayload, LangPair } from "../domain/events";
import type { EntityId } from "../domain/ids";
import { h, langName, langSelect } from "../ui/h";

const LAST_DECK_KEY = "rcfc:lastDeck";

export function decks(): Deck[] {
  return [...app.store.col.decks.values()];
}

export function deckSelect(name: string, selected?: EntityId): HTMLSelectElement {
  const s = h("select", { name });
  for (const d of decks()) s.appendChild(h("option", { value: String(d.id), selected: d.id === selected }, d.name));
  return s;
}

/** The deck words were last added or imported to. */
export function lastDeck(): EntityId | undefined {
  try {
    const v = Number(localStorage.getItem(LAST_DECK_KEY));
    if (app.store.col.decks.has(v)) return v;
  } catch {
    /* storage unavailable */
  }
  return decks()[0]?.id;
}

export function rememberDeck(id: EntityId): void {
  try {
    localStorage.setItem(LAST_DECK_KEY, String(id));
  } catch {
    /* ignore */
  }
}

export async function createDeck(name: string, lang_pair: LangPair): Promise<EntityId> {
  const { store } = app;
  const ev = store.factory.deck(name.trim() || langName(lang_pair.from), store.preset().preset_id, lang_pair);
  await store.append([ev]);
  return (ev.payload as DeckCreatedPayload).deck_id;
}

export function newDeckForm(onDone: (id: EntityId) => void, from = "es"): HTMLFormElement {
  const name = h("input", { name: "name", placeholder: `e.g. ${langName(from)}`, autocomplete: "off" });
  const fromSel = langSelect("from", from);
  const toSel = langSelect("to", "en");
  return h(
    "form",
    {
      class: "card-box",
      onsubmit: async (e: Event) => {
        e.preventDefault();
        const id = await createDeck(name.value || langName(fromSel.value), { from: fromSel.value, to: toSel.value });
        onDone(id);
      },
    },
    h("h2", {}, "New deck"),
    h("label", {}, "Name", name),
    h("div", { class: "row2" }, h("label", {}, "I'm learning", fromSel), h("label", {}, "I speak", toSel)),
    h("button", { class: "primary", type: "submit" }, "Create deck"),
  );
}
