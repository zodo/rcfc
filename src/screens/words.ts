// Words tab: every word with its progress (new, learning, known); with two or
// more languages, chips above the list open one of them (tap again for all).
// Search, add (+), select words to mark known / not known or delete, tap one
// to edit. The whole list is there, rendered in chunks while scrolling.
import { app, errorText, go, page, subPage } from "../app";
import type { Note } from "../domain/collection";
import type { AppEvent } from "../domain/events";
import type { EntityId } from "../domain/ids";
import { KNOWN_HORIZON_MS, wordStatus } from "../domain/scheduler";
import { append, clear, h, langName, toast } from "../ui/h";
import { pictureEditor } from "../ui/picture";
import { languageForm, languages, openLanguage, rememberLanguage, setOpenLanguage } from "./languages";

/** Rows added at a time as the list scrolls into view. */
const CHUNK = 150;
/** P(recall) a week ahead per studied card, kept between visits so the list shows at once. */
const weekAhead = new Map<EntityId, number>();

const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

interface Row {
  el: HTMLButtonElement;
  st: HTMLElement;
}

export function words(): void {
  const { store } = app;
  const langs = languages();
  const open = openLanguage();
  const all = () => store.col.liveNotes().filter((n) => !open || n.lang_pair.from === open).reverse();
  let selecting = false;
  const selected = new Set<EntityId>();
  let found: Note[] = [];
  let shown = 0;
  const rows = new Map<EntityId, Row>();

  const q = h("input", { type: "search", placeholder: "Search", autocomplete: "off", "aria-label": "Search" });
  const info = h("div", { class: "select-info" });
  const list = h("div", { class: "list" });
  const more = h("div", { class: "list-more", "aria-hidden": "true" });
  const btn = (label: string, cls: string, f: () => Promise<void>) => {
    const b = h("button", { class: cls }, label);
    b.addEventListener("click", async () => {
      busy(true);
      try {
        await f();
      } catch (e) {
        toast(`Could not save: ${errorText(e)}`);
      }
      busy(false);
    });
    return b;
  };
  const knowBtn = btn("I know", "primary", async () => {
    const n = await store.markKnown([...selected]);
    toast(`${plural(n, "word")} marked as known`);
    await afterAnswers();
  });
  const unknownBtn = btn("Don't know", "secondary dunno", async () => {
    const r = await store.markUnknown([...selected]);
    toast([r.forgotten ? `${plural(r.forgotten, "word")} to review soon` : "", r.next ? `${plural(r.next, "word")} to learn next` : ""].filter(Boolean).join(", "));
    await afterAnswers();
  });
  const delBtn = btn("Delete", "danger", async () => {
    const ids = [...selected];
    if (!confirm(`Delete ${plural(ids.length, "word")}? Their review history is kept for the model.`)) return;
    await store.append(ids.map((note_id) => store.factory.make("note_deleted", { note_id })));
    toast(`Deleted ${plural(ids.length, "word")}`);
    selected.clear();
    rebuild();
  });
  const actions = h("div", { class: "nav select-actions hidden" }, knowBtn, unknownBtn, delBtn);
  const busy = (on: boolean) => {
    for (const b of [knowBtn, unknownBtn, delBtn]) b.disabled = on || selected.size === 0;
  };

  const status = (n: Note) => wordStatus((store.col.cardsByNote.get(n.id) ?? []).map((id) => store.col.cards.get(id)!), weekAhead);
  const showStatus = (n: Note, st: HTMLElement) => {
    const s = status(n);
    st.className = `w-p small st-${s ?? "pending"}`;
    st.textContent = s ?? "";
  };

  /** Re-predict a week ahead for the words listed, then update the statuses shown. */
  const refresh = async () => {
    const cards = store.col.liveCards().filter((c) => !open || store.col.notes.get(c.note_id)!.lang_pair.from === open);
    for (const [id, p] of await store.predictAt(cards, Date.now() + KNOWN_HORIZON_MS)) weekAhead.set(id, p);
    for (const [id, r] of rows) showStatus(store.col.notes.get(id)!, r.st);
  };

  /** After marking: clear the selection (stay in select mode to go on), update statuses. */
  const afterAnswers = async () => {
    for (const id of selected) rows.get(id)?.el.classList.remove("selected");
    selected.clear();
    renderInfo();
    await refresh();
  };

  const setSelecting = (on: boolean) => {
    selecting = on;
    selected.clear();
    document.querySelector("nav.nav:not(.select-actions)")?.classList.toggle("hidden", on);
    actions.classList.toggle("hidden", !on);
    list.classList.toggle("selecting", on);
    for (const r of rows.values()) r.el.classList.remove("selected");
    renderInfo();
  };

  const link = (label: string, f: () => void) => h("button", { class: "link small", onclick: f }, label);

  /** The row above the list: count and Select, or the selection and its controls. Same place, same height. */
  function renderInfo() {
    clear(info);
    if (!selecting) {
      append(info, [h("span", { class: "muted small" }, q.value ? plural(found.length, "match", "matches") : plural(found.length, "word")), link("Select", () => setSelecting(true))]);
    } else {
      const allOn = found.length > 0 && found.every((n) => selected.has(n.id));
      const toggleAll = () => {
        for (const n of found) allOn ? selected.delete(n.id) : selected.add(n.id);
        for (const [id, r] of rows) r.el.classList.toggle("selected", selected.has(id));
        renderInfo();
      };
      append(info, [h("span", { class: "muted small" }, `${selected.size} selected`), h("span", { class: "info-links" }, link(allOn ? "Select none" : `Select all ${found.length}`, toggleAll), link("Cancel", () => setSelecting(false)))]);
    }
    busy(false);
  }

  function row(n: Note): HTMLButtonElement {
    const st = h("span", {});
    showStatus(n, st);
    const el = h(
      "button",
      {
        class: `word${selected.has(n.id) ? " selected" : ""}`,
        onclick: () => {
          if (!selecting) return go.edit(n.id);
          if (!selected.delete(n.id)) selected.add(n.id);
          el.classList.toggle("selected", selected.has(n.id));
          renderInfo();
        },
      },
      h("span", { class: "check", "aria-hidden": "true" }),
      h("span", { class: "w-front" }, n.fields.front),
      h("span", { class: "w-back muted" }, n.fields.back),
      st,
    );
    rows.set(n.id, { el, st });
    return el;
  }

  /** Append the next chunk of rows. */
  function grow() {
    const end = Math.min(found.length, shown + CHUNK);
    for (; shown < end; shown++) list.insertBefore(row(found[shown]), more);
    more.classList.toggle("hidden", shown >= found.length);
  }

  /** The list from scratch: after a search or a delete. */
  function rebuild() {
    const term = q.value.trim().toLocaleLowerCase();
    found = term ? all().filter((n) => `${n.fields.front}\n${n.fields.back}\n${n.fields.example ?? ""}`.toLocaleLowerCase().includes(term)) : all();
    for (const id of selected) if (!store.col.liveNote(id)) selected.delete(id);
    rows.clear();
    clear(list);
    list.appendChild(more);
    shown = 0;
    grow();
    if (!found.length && q.value) list.prepend(h("p", { class: "muted center" }, "No matches."));
    list.classList.toggle("hidden", !found.length && !q.value);
    renderInfo();
  }

  // Load more rows well before the end comes into view.
  const io = new IntersectionObserver(
    (es) => {
      if (!more.isConnected) io.disconnect();
      else if (es.some((e) => e.isIntersecting)) grow();
    },
    { rootMargin: "800px" },
  );
  io.observe(more);

  q.addEventListener("input", rebuild);
  const empty = all().length
    ? null
    : h(
        "div",
        { class: "card-box center" },
        h("p", {}, "No words yet."),
        h("button", { class: "primary", onclick: () => go.add() }, "Add a word"),
        h("button", { class: "secondary", onclick: () => go.import() }, "Import from Duocards"),
      );
  // + adds to the open language, else to the last one used.
  const addWord = () => (open && rememberLanguage(open), go.add());
  const tools = h("div", { class: "word-tools" }, q, h("button", { class: "primary add-btn", onclick: addWord, "aria-label": "Add a word" }, "+"));
  const chips =
    langs.length > 1
      ? h(
          "div",
          { class: "chips lang-chips" },
          ...langs.map((p) => {
            const on = p === open;
            return h("button", { class: `chip${on ? " on" : ""}`, "aria-pressed": String(on), onclick: () => (setOpenLanguage(on ? null : p), go.words()) }, langName(p));
          }),
        )
      : null;
  page("words", "Words", chips, empty ?? tools, empty ? null : info, list);
  app.root.appendChild(actions);
  rebuild();
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
  subPage("words", "Add a language", () => go.words(), languageForm(() => go.add(), "Add a word"));
}
