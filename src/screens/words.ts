// Words tab: the current language's words with their progress (new, learning,
// known). Search, add (+), select several to mark known or delete, tap one to edit.
import { app, errorText, go, page, subPage } from "../app";
import type { Note } from "../domain/collection";
import type { AppEvent } from "../domain/events";
import type { EntityId } from "../domain/ids";
import { KNOWN_HORIZON_MS, wordStatus } from "../domain/scheduler";
import { append, clear, h, langName, toast } from "../ui/h";
import { pictureEditor } from "../ui/picture";
import { currentDeck, languageForm, languagePicker } from "./decks";

const LIST_MAX = 300;
/** P(recall) a week ahead per studied card, kept between visits so the list shows at once. */
const weekAhead = new Map<EntityId, number>();

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function words(): void {
  const { store } = app;
  const deck = currentDeck();
  if (!deck) return void go.home();
  const all = () => store.col.liveNotes(deck.id).reverse();
  let selecting = false;
  const selected = new Set<EntityId>();

  const q = h("input", { type: "search", placeholder: `Search ${plural(all().length, "word")}`, autocomplete: "off", "aria-label": "Search" });
  const tools = h("div", { class: "word-tools" });
  const selInfo = h("div", { class: "select-info" });
  const list = h("div", { class: "list" });
  const knowBtn = h("button", { class: "secondary", onclick: () => void markKnown() }, "I know these");
  const delBtn = h("button", { class: "danger", onclick: () => void remove() }, "Delete");
  const actions = h("div", { class: "nav select-actions hidden" }, knowBtn, delBtn);

  const hits = (): Note[] => {
    const term = q.value.trim().toLocaleLowerCase();
    return term ? all().filter((n) => `${n.fields.front}\n${n.fields.back}\n${n.fields.example ?? ""}`.toLocaleLowerCase().includes(term)) : all();
  };

  const status = (n: Note) => wordStatus((store.col.cardsByNote.get(n.id) ?? []).map((id) => store.col.cards.get(id)!), weekAhead);

  /** Re-predict a week ahead for this language, then redraw. */
  const refresh = async () => {
    const cards = store.col.liveCards(deck!.id);
    for (const [id, p] of await store.predictAt(cards, Date.now() + KNOWN_HORIZON_MS)) weekAhead.set(id, p);
    if (list.isConnected) render();
  };

  const setSelecting = (on: boolean) => {
    selecting = on;
    selected.clear();
    document.querySelector("nav.nav:not(.select-actions)")?.classList.toggle("hidden", on);
    actions.classList.toggle("hidden", !on);
    render();
  };

  function render() {
    clear(tools);
    append(tools, [
      q,
      selecting
        ? h("button", { class: "secondary", onclick: () => setSelecting(false) }, "Done")
        : [h("button", { class: "secondary", onclick: () => setSelecting(true), disabled: all().length === 0 }, "Select"), h("button", { class: "primary add-btn", onclick: () => go.add(), "aria-label": "Add a word" }, "+")],
    ].flat());

    const found = hits();
    clear(selInfo);
    if (selecting) {
      const allOn = found.length > 0 && found.every((n) => selected.has(n.id));
      append(selInfo, [
        h("span", { class: "muted small" }, selected.size ? `${selected.size} selected` : "Tap words to select them"),
        h("button", { class: "link small", onclick: () => (found.forEach((n) => (allOn ? selected.delete(n.id) : selected.add(n.id))), render()) }, allOn ? "Select none" : `Select all ${found.length}`),
      ]);
    }
    knowBtn.disabled = delBtn.disabled = selected.size === 0;

    clear(list);
    list.classList.toggle("selecting", selecting);
    for (const n of found.slice(0, LIST_MAX)) {
      const row = h(
        "button",
        {
          class: `word${selected.has(n.id) ? " selected" : ""}`,
          onclick: () => {
            if (!selecting) return go.edit(n.id);
            if (!selected.delete(n.id)) selected.add(n.id);
            render();
          },
        },
        selecting ? h("span", { class: "check", "aria-hidden": "true" }, selected.has(n.id) ? "✓" : "") : null,
        h("span", { class: "w-front" }, n.fields.front),
        h("span", { class: "w-back muted" }, n.fields.back),
        h("span", { class: `w-p small st-${status(n) ?? "pending"}` }, status(n) ?? ""),
      );
      list.appendChild(row);
    }
    if (found.length > LIST_MAX) list.appendChild(h("p", { class: "muted small center" }, `${found.length - LIST_MAX} more; refine the search.`));
    if (!found.length && q.value) list.appendChild(h("p", { class: "muted center" }, "No matches."));
    list.classList.toggle("hidden", !found.length && !q.value);
  }

  async function markKnown() {
    knowBtn.disabled = delBtn.disabled = true;
    knowBtn.textContent = "Saving…";
    try {
      const n = await store.markKnown([...selected]);
      toast(`${plural(n, "word")} marked as known`);
    } catch (e) {
      toast(`Could not save: ${errorText(e)}`);
    }
    knowBtn.textContent = "I know these";
    if (list.isConnected) setSelecting(false);
    await refresh();
  }

  async function remove() {
    const ids = [...selected];
    if (!confirm(`Delete ${plural(ids.length, "word")}? Their review history is kept for the model.`)) return;
    await store.append(ids.map((note_id) => store.factory.make("note_deleted", { note_id })));
    toast(`Deleted ${plural(ids.length, "word")}`);
    q.placeholder = `Search ${plural(all().length, "word")}`;
    if (list.isConnected) setSelecting(false);
  }

  q.addEventListener("input", render);
  const empty = all().length
    ? null
    : h(
        "div",
        { class: "card-box center" },
        h("p", {}, `No ${langName(deck.lang_pair.from)} words yet.`),
        h("button", { class: "primary", onclick: () => go.add() }, "Add a word"),
        h("button", { class: "secondary", onclick: () => go.import() }, "Import from Duocards"),
      );
  page("words", languagePicker(deck, () => go.words()), empty ?? tools, empty ? null : selInfo, list);
  app.root.appendChild(actions);
  render();
  void refresh();
}

export function edit(noteId: EntityId): void {
  const { store } = app;
  const n = store.col.liveNote(noteId);
  if (!n) return words();
  const front = h("input", { value: n.fields.front });
  const back = h("input", { value: n.fields.back });
  const example = h("textarea", { rows: 2, value: n.fields.example ?? "" });
  subPage(
    "words",
    "Edit word",
    () => go.words(),
    h(
      "form",
      {
        class: "card-box",
        onsubmit: async (e: Event) => {
          e.preventDefault();
          const evs: AppEvent[] = [];
          const set = (field: string, value: string) => {
            if ((n.fields[field] ?? "") !== value) evs.push(store.factory.make("note_edited", { note_id: n.id, field, value }));
          };
          set("front", front.value.trim());
          set("back", back.value.trim());
          set("example", example.value.trim());
          if (evs.length) await store.append(evs);
          words();
        },
      },
      h("label", {}, "Word", front),
      h("label", {}, "Translation", back),
      h("label", {}, "Example", example),
      h("button", { class: "primary", type: "submit" }, "Save"),
      h(
        "button",
        {
          class: "danger",
          type: "button",
          onclick: async () => {
            if (!confirm(`Delete "${n.fields.front}"? Its review history is kept for the model.`)) return;
            await store.append([store.factory.make("note_deleted", { note_id: n.id })]);
            words();
          },
        },
        "Delete",
      ),
    ),
    h("div", { class: "card-box" }, h("h2", {}, "Picture"), pictureEditor(n.id)),
  );
}

export function addLanguage(): void {
  subPage("words", "Add a language", () => go.words(), languageForm(() => go.words(), "Add language"));
}
