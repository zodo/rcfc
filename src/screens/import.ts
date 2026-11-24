// Import a Duocards CSV export: preview, pick the language, import.
import { app, go, requestPersistence, subPage } from "../app";
import type { AppEvent } from "../domain/events";
import { DuocardsFormatError, guessSourceLang, importDuocardsCsv } from "../import/duocards";
import { append, clear, h, langSelect, toast } from "../ui/h";
import { deckFor, languageLabel, languages, lastLanguage, rememberLanguage } from "./languages";

export function importScreen(): void {
  const { store } = app;
  const file = h("input", { type: "file", accept: ".csv,text/csv" });
  const box = h("div", {});
  file.addEventListener("change", async () => {
    const f = file.files?.[0];
    if (!f) return;
    const text = await f.text();
    const cur = lastLanguage();
    const from = guessSourceLang(f.name) ?? cur?.from ?? "es";
    clear(box);
    let preview;
    try {
      preview = importDuocardsCsv(text, { deckId: 0, langPair: { from, to: "en" }, deviceId: store.deviceId, existing: store.col.liveNotes().map((n) => n.fields) });
    } catch (e) {
      box.appendChild(h("p", { class: "error" }, e instanceof DuocardsFormatError ? e.message : `Could not read the file: ${e}`));
      return;
    }
    // Default: the current language if the file looks like it, else another with that language, else a new one.
    const known = languages();
    const match = cur?.from === from ? cur : known.find((p) => p.from === from);
    const target = h("select", { name: "target" });
    known.forEach((p, i) => target.appendChild(h("option", { value: String(i), selected: p.from === match?.from && p.to === match.to }, languageLabel(p, known))));
    target.appendChild(h("option", { value: "new", selected: !match }, "A new language…"));
    const fromSel = langSelect("from", from);
    const toSel = langSelect("to", cur?.to ?? "en");
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
              const langPair = target.value === "new" ? { from: fromSel.value, to: toSel.value } : known[Number(target.value)];
              const deckId = await deckFor(langPair);
              const res = importDuocardsCsv(text, { deckId, langPair, deviceId: store.deviceId, existing: store.col.liveNotes().map((n) => n.fields) });
              await store.append(res.events as AppEvent[]);
              await requestPersistence();
              rememberLanguage(langPair);
              toast(`Imported ${res.notes} words`);
              go.words();
            },
          },
          `Import ${preview.notes} words`,
        ),
      ),
    ]);
    syncLangs();
  });
  subPage(
    "words",
    "Import from Duocards",
    () => go.words(),
    h(
      "div",
      { class: "card-box" },
      h("p", { class: "muted" }, "In Duocards, export your cards as CSV, then pick the file here. Importing the same file again only adds what's missing."),
      file,
    ),
    box,
  );
}
