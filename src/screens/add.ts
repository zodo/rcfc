// Add a word: a note with forward and reverse cards, in the last language used
// (switchable here; "Add a language…" picks a new one, made with its first word).
import { app, go, subPage } from "../app";
import type { NoteFields } from "../domain/events";
import { noteKey } from "../import/duocards";
import type { NoteCreatedPayload } from "../domain/events";
import { clear, h, langName, toast } from "../ui/h";
import { pictureEditor } from "../ui/picture";
import { deckFor, languageLabel, languages, lastLanguage, rememberLanguage, samePair } from "./languages";

const NEW = "new";

export function add(): void {
  const pair = lastLanguage();
  if (!pair) return void go.addLanguage();
  const { store } = app;
  // Which language: a native picker, the languages with words plus this one if it has none yet.
  const langs = languages();
  const all = langs.some((p) => samePair(p, pair)) ? langs : [...langs, pair];
  const picker = h("select", { name: "language" });
  all.forEach((p, i) => picker.appendChild(h("option", { value: String(i), selected: samePair(p, pair) }, languageLabel(p, all))));
  picker.appendChild(h("option", { value: NEW }, "Add a language…"));
  picker.addEventListener("change", () => {
    if (picker.value === NEW) return go.addLanguage();
    rememberLanguage(all[Number(picker.value)]);
    go.add();
  });
  const front = h("input", { name: "front", required: true, autocomplete: "off", autocapitalize: "off", spellcheck: false });
  const back = h("input", { name: "back", required: true, autocomplete: "off" });
  const example = h("textarea", { name: "example", rows: 2 });
  const hint = h("p", { class: "muted small" });
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
          const evs = store.factory.note(await deckFor(pair), fields, pair);
          await store.append(evs);
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
      h("label", {}, "Language", picker),
      h("label", {}, langName(pair.from), front),
      h("label", {}, langName(pair.to), back),
      h("label", {}, "Example (optional)", example),
      hint,
      h("button", { class: "primary", type: "submit" }, "Add"),
    ),
    last,
    h("p", { class: "muted small center" }, "Have a Duocards export? ", h("button", { class: "link", type: "button", onclick: () => go.import() }, "Import it")),
  );
  front.focus();
}
