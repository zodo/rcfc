// Add a word: a note with forward and reverse cards.
import { app, go, page } from "../app";
import type { NoteFields } from "../domain/events";
import { noteKey } from "../import/duocards";
import type { NoteCreatedPayload } from "../domain/events";
import { clear, h, langName, toast } from "../ui/h";
import { pictureEditor } from "../ui/picture";
import { deckSelect, decks, lastDeck, rememberDeck } from "./decks";

export function add(): void {
  if (decks().length === 0) return void go.home();
  const { store } = app;
  const deck = deckSelect("deck", lastDeck());
  const front = h("input", { name: "front", required: true, autocomplete: "off", autocapitalize: "off", spellcheck: false });
  const back = h("input", { name: "back", required: true, autocomplete: "off" });
  const example = h("textarea", { name: "example", rows: 2 });
  const hint = h("p", { class: "muted small" });
  // The word just added, with its picture arriving; adjustable right here.
  const last = h("div", { class: "last-added" });
  const updateLabels = () => {
    const d = store.col.decks.get(Number(deck.value))!;
    front.placeholder = `Word in ${langName(d.lang_pair.from)}`;
    back.placeholder = `Translation in ${langName(d.lang_pair.to)}`;
  };
  deck.addEventListener("change", updateLabels);
  page(
    "add",
    "Add a word",
    h(
      "form",
      {
        class: "card-box",
        onsubmit: async (e: Event) => {
          e.preventDefault();
          const d = store.col.decks.get(Number(deck.value))!;
          const f = front.value.trim().normalize("NFC");
          const b = back.value.trim().normalize("NFC");
          if (!f || !b) return;
          if (store.col.liveNotes().some((n) => noteKey(n.fields.front, n.fields.back) === noteKey(f, b))) {
            hint.textContent = `"${f}" is already in your words.`;
            return;
          }
          const fields: NoteFields = { front: f, back: b };
          const ex = example.value.trim();
          if (ex) fields.example = ex;
          const evs = store.factory.note(d.id, fields, d.lang_pair);
          await store.append(evs);
          rememberDeck(d.id);
          const noteId = (evs[0].payload as NoteCreatedPayload).note_id;
          void app.pictures.ensure(noteId);
          clear(last);
          last.append(h("div", { class: "card-box" }, h("h2", {}, f, h("span", { class: "muted" }, ` · ${b}`)), pictureEditor(noteId)));
          toast(`Added "${f}"`);
          front.value = back.value = example.value = "";
          hint.textContent = "";
          front.focus();
        },
      },
      decks().length > 1 ? h("label", {}, "Deck", deck) : null,
      h("label", {}, "Word", front),
      h("label", {}, "Translation", back),
      h("label", {}, "Example (optional)", example),
      hint,
      h("button", { class: "primary", type: "submit" }, "Add"),
      h("p", { class: "muted small" }, "Each word gets two cards: word → translation, and later translation → word."),
    ),
    last,
  );
  updateLabels();
  front.focus();
}
