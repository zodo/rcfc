// Words: search the list, edit or delete a word.
import { app, go, page } from "../app";
import type { AppEvent } from "../domain/events";
import type { EntityId } from "../domain/ids";
import { clear, h } from "../ui/h";
import { pictureEditor } from "../ui/picture";

const LIST_MAX = 300;

export function browse(): void {
  const { store } = app;
  const q = h("input", { type: "search", placeholder: "Search", autocomplete: "off" });
  const list = h("div", { class: "list" });
  const render = () => {
    clear(list);
    const term = q.value.trim().toLocaleLowerCase();
    const notes = store.col.liveNotes().reverse();
    const hits = term ? notes.filter((n) => `${n.fields.front}\n${n.fields.back}\n${n.fields.example ?? ""}`.toLocaleLowerCase().includes(term)) : notes;
    for (const n of hits.slice(0, LIST_MAX)) {
      const cards = (store.col.cardsByNote.get(n.id) ?? []).map((id) => store.col.cards.get(id)!);
      const ps = cards.map((c) => store.preds.get(c.id)).filter((p): p is number => p !== undefined);
      const recall = ps.length ? `${Math.round(Math.min(...ps) * 100)}%` : "new";
      list.appendChild(
        h("button", { class: "word", onclick: () => go.edit(n.id) }, h("span", { class: "w-front" }, n.fields.front), h("span", { class: "w-back muted" }, n.fields.back), h("span", { class: "w-p muted small" }, recall)),
      );
    }
    if (hits.length > LIST_MAX) list.appendChild(h("p", { class: "muted small center" }, `${hits.length - LIST_MAX} more; refine the search.`));
    if (!hits.length) list.appendChild(h("p", { class: "muted center" }, term ? "No matches." : "No words yet."));
  };
  q.addEventListener("input", render);
  page("browse", `Words · ${store.col.liveNotes().length}`, q, list);
  render();
}

export function edit(noteId: EntityId): void {
  const { store } = app;
  const n = store.col.liveNote(noteId);
  if (!n) return browse();
  const front = h("input", { value: n.fields.front });
  const back = h("input", { value: n.fields.back });
  const example = h("textarea", { rows: 2, value: n.fields.example ?? "" });
  page(
    "browse",
    "Edit word",
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
          browse();
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
            browse();
          },
        },
        "Delete",
      ),
      h("button", { class: "secondary", type: "button", onclick: () => browse() }, "Cancel"),
    ),
    h("div", { class: "card-box" }, h("h2", {}, "Picture"), pictureEditor(n.id)),
  );
}
