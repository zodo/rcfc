// Import a Duocards CSV export: preview, pick a deck, import.
import { app, go, page, requestPersistence } from "../app";
import type { AppEvent } from "../domain/events";
import { DuocardsFormatError, guessSourceLang, importDuocardsCsv } from "../import/duocards";
import { append, clear, h, langName, langSelect, toast } from "../ui/h";
import { createDeck, decks, rememberDeck } from "./decks";

export function importScreen(): void {
  const { store } = app;
  const file = h("input", { type: "file", accept: ".csv,text/csv" });
  const box = h("div", {});
  file.addEventListener("change", async () => {
    const f = file.files?.[0];
    if (!f) return;
    const text = await f.text();
    const from = guessSourceLang(f.name) ?? "es";
    clear(box);
    let preview;
    try {
      preview = importDuocardsCsv(text, { deckId: 0, langPair: { from, to: "en" }, deviceId: store.deviceId, existing: store.col.liveNotes().map((n) => n.fields) });
    } catch (e) {
      box.appendChild(h("p", { class: "error" }, e instanceof DuocardsFormatError ? e.message : `Could not read the file: ${e}`));
      return;
    }
    const target = h("select", { name: "target" });
    target.appendChild(h("option", { value: "new" }, `New deck: ${langName(from)}`));
    for (const d of decks()) target.appendChild(h("option", { value: String(d.id), selected: d.lang_pair.from === from }, d.name));
    const fromSel = langSelect("from", from);
    const toSel = langSelect("to", "en");
    const langs = h("div", { class: "row2" }, h("label", {}, "Words are in", fromSel), h("label", {}, "Translations in", toSel));
    const syncLangs = () => langs.classList.toggle("hidden", target.value !== "new");
    target.addEventListener("change", syncLangs);
    append(box, [
      h(
        "div",
        { class: "card-box" },
        h("p", {}, h("strong", {}, `${preview.notes} words`), ` found in ${f.name}.`),
        preview.skipped.length ? h("p", { class: "muted small" }, `${preview.skipped.length} skipped (already in your words or repeated in the file).`) : null,
        preview.errors.length ? h("p", { class: "muted small" }, `${preview.errors.length} rows could not be read (line ${preview.errors.map((e) => e.line).slice(0, 5).join(", ")}).`) : null,
        h("label", {}, "Import into", target),
        langs,
        h(
          "button",
          {
            class: "primary",
            disabled: preview.notes === 0,
            onclick: async (e: Event) => {
              (e.target as HTMLButtonElement).disabled = true;
              const lang_pair = { from: fromSel.value, to: toSel.value };
              const deckId = target.value === "new" ? await createDeck(langName(lang_pair.from), lang_pair) : Number(target.value);
              const deck = store.col.decks.get(deckId)!;
              const res = importDuocardsCsv(text, { deckId, langPair: deck.lang_pair, deviceId: store.deviceId, existing: store.col.liveNotes().map((n) => n.fields) });
              await store.append(res.events as AppEvent[]);
              await requestPersistence();
              rememberDeck(deckId);
              toast(`Imported ${res.notes} words`);
              go.home();
            },
          },
          `Import ${preview.notes} words`,
        ),
      ),
    ]);
    syncLangs();
  });
  page(
    "import",
    "Import",
    h(
      "div",
      { class: "card-box" },
      h("h2", {}, "From Duocards"),
      h("p", { class: "muted" }, "In Duocards, export your cards as CSV, then pick the file here. Words come in as new cards, oldest first. Importing the same file again only adds what's missing."),
      file,
    ),
    box,
  );
}
