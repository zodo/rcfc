// Add a word: a note with forward and reverse cards, in the last language used
// (switchable here; "Add a language…" picks a new one, made with its first word).
// The translation's language is picked per word, above its field. With a
// sticker open in Words, the word gets it (× skips it for this word).
import { app, go, subPage } from "../app";
import type { NoteFields } from "../domain/events";
import { noteKey } from "../import/duocards";
import type { NoteCreatedPayload, NotesLabeled } from "../domain/events";
import { clear, h, langName, langSelect, toast } from "../ui/h";
import { pictureEditor } from "../ui/picture";
import { deckFor, languages, lastLanguage, openLabel, rememberLanguage, rememberTranslation, translationFor } from "./languages";
import { stickerTag } from "./stickers";

const NEW = "new";

export function add(): void {
  const lang = lastLanguage();
  if (!lang) return void go.addLanguage();
  const { store } = app;
  // Which language: a native picker, the languages with words plus this one if it has none yet.
  const langs = languages();
  const all = langs.includes(lang) ? langs : [...langs, lang];
  const picker = h("select", { name: "language" });
  for (const l of all) picker.appendChild(h("option", { value: l, selected: l === lang }, langName(l)));
  picker.appendChild(h("option", { value: NEW }, "Add a language…"));
  picker.addEventListener("change", () => {
    if (picker.value === NEW) return go.addLanguage();
    rememberLanguage(picker.value);
    go.add();
  });
  // The translation's language, as the label of its field: this word only, remembered for the next one.
  const to = langSelect("to", translationFor(lang));
  to.setAttribute("aria-label", "Translation in");
  const toName = h("span", {}, langName(to.value));
  to.addEventListener("change", () => {
    toName.textContent = langName(to.value);
    rememberTranslation(lang, to.value);
  });
  const front = h("input", { name: "front", required: true, autocomplete: "off", autocapitalize: "off", spellcheck: false });
  const back = h("input", { name: "back", required: true, autocomplete: "off", "aria-label": "Translation" });
  const example = h("textarea", { name: "example", rows: 2 });
  const hint = h("p", { class: "muted small" });
  const label = store.col.liveLabel(openLabel() ?? 0);
  const sticks = label
    ? h("p", { class: "sticks small" }, "Sticks: ", stickerTag(label, h("button", { class: "x", type: "button", "aria-label": `Don't stick ${label.name} on this word`, onclick: () => (sticks!.hidden = true) }, "×")))
    : null;
  // The word just added, with its picture arriving; adjustable right here.
  const last = h("div", { class: "last-added" });
  subPage(
    "words",
    "Add a word",
    () => go.words(),
    h(
      "form",
      {
        class: "card-box",
        onsubmit: async (e: Event) => {
          e.preventDefault();
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
          const evs = store.factory.note(await deckFor(lang), fields, { from: lang, to: to.value });
          const noteId = (evs[0].payload as NoteCreatedPayload).note_id;
          if (label && sticks && !sticks.hidden) evs.push(store.factory.make<NotesLabeled>("notes_labeled", { label_id: label.id, note_ids: [noteId], on: true }));
          await store.append(evs);
          if (sticks) sticks.hidden = false;
          void app.pictures.ensure(noteId);
          clear(last);
          last.append(h("div", { class: "card-box" }, h("h2", {}, f, h("span", { class: "muted" }, ` · ${b}`)), pictureEditor(noteId)));
          toast(`Added "${f}"`);
          front.value = back.value = example.value = "";
          hint.textContent = "";
          front.focus();
        },
      },
      h("label", {}, "Language", picker),
      h("label", {}, langName(lang), front),
      h("div", { class: "field" }, h("span", { class: "field-lang" }, toName, h("span", { class: "chev", "aria-hidden": "true" }, "▾"), to), back),
      h("label", {}, "Example (optional)", example),
      hint,
      sticks,
      h("button", { class: "primary", type: "submit" }, "Add"),
    ),
    last,
    h("p", { class: "muted small center" }, "Have a Duocards export? ", h("button", { class: "link", type: "button", onclick: () => go.import() }, "Import it")),
  );
  front.focus();
}
