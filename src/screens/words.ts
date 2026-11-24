// Words tab: every word with its progress (new, learning, known). Above the
// list, chips open one language (with two or more) or one sticker; tap again
// for all. Search, add (+), select words to stick stickers on, mark them known
// / not known or delete them, tap one to edit. With a sticker open, Edit lists
// every word and each tap sticks it on or peels it off. The whole list is
// there, rendered in chunks while scrolling.
import { app, errorText, go, hold, page, subPage } from "../app";
import type { Note } from "../domain/collection";
import type { AppEvent } from "../domain/events";
import type { EntityId } from "../domain/ids";
import { labelPile, pileLabel } from "../domain/labels";
import { KNOWN_HORIZON_MS, wordStatus } from "../domain/scheduler";
import { append, clear, h, langName, toast } from "../ui/h";
import { pictureEditor } from "../ui/picture";
import { editSticker, languageForm, languages, openChip, rememberLanguage, setOpenChip, takeEditNext } from "./languages";
import { newStickerSheet, pencilSheet, stickersSheet, stickerTag } from "./stickers";

/** Rows added at a time as the list scrolls into view. */
const CHUNK = 150;
/** P(recall) a week ahead per studied card, kept between visits so the list shows at once. */
const weekAhead = new Map<EntityId, number>();

const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

const ICON_PEN = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 2.5l2.5 2.5L6 12.5 2.5 13.5 3.5 10z"/></svg>';
/** A pencil arrow from the note on an empty sticker up to Edit. */
const ICON_ARROW = '<svg class="pencil-arrow" viewBox="0 0 78 72" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 66 C 30 64, 52 50, 57 10"/><path d="M50 19 L57 8 L63 19"/></svg>';

interface Row {
  el: HTMLButtonElement;
  st: HTMLElement;
}

/** The list as it is used: looked through, words selected, or a sticker stuck on and peeled off (Edit). */
type Mode = "list" | "select" | "edit";

export function words(): void {
  const { store } = app;
  const { col } = store;
  const langs = languages();
  const open = openChip();
  const openLang = open?.startsWith("lang:") ? open.slice("lang:".length) : null;
  const labelId = open ? pileLabel(open) : undefined;
  const inChip = () => (labelId !== undefined ? col.labelNotes(labelId) : col.liveNotes().filter((n) => !openLang || n.lang_pair.from === openLang));
  let mode: Mode = "list";
  /** Releases the back gesture held while selecting or editing. */
  let releaseMode: (() => void) | null = null;
  /** Newest first: in Edit every word, else the open chip's. */
  const all = () => (mode === "edit" ? col.liveNotes() : inChip()).reverse();
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
  const stickBtn = btn("Stickers", "sticker-btn", async () => stickersSheet([...selected], () => (labelId !== undefined ? rebuild() : undefined)));
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
  const actions = h("div", { class: "nav select-actions hidden" }, stickBtn, knowBtn, unknownBtn, delBtn);
  const busy = (on: boolean) => {
    for (const b of [stickBtn, knowBtn, unknownBtn, delBtn]) b.disabled = on || selected.size === 0;
  };

  const status = (n: Note) => wordStatus((col.cardsByNote.get(n.id) ?? []).map((id) => col.cards.get(id)!), weekAhead);
  const showStatus = (n: Note, st: HTMLElement) => {
    const s = status(n);
    st.className = `w-p small st-${s ?? "pending"}`;
    st.textContent = s ?? "";
  };

  /** Re-predict a week ahead for the words listed, then update the statuses shown. */
  const refresh = async () => {
    const cards = col.liveCards().filter((c) => !openLang || col.notes.get(c.note_id)!.lang_pair.from === openLang);
    for (const [id, p] of await store.predictAt(cards, Date.now() + KNOWN_HORIZON_MS)) weekAhead.set(id, p);
    for (const [id, r] of rows) showStatus(col.notes.get(id)!, r.st);
  };

  /** After marking: clear the selection (stay in select mode to go on), update statuses. */
  const afterAnswers = async () => {
    for (const id of selected) rows.get(id)?.el.classList.remove("selected");
    selected.clear();
    renderInfo();
    await refresh();
  };

  /** Select and Edit hold the back gesture: back goes back to the list. */
  const setMode = (m: Mode) => {
    releaseMode?.();
    releaseMode = null;
    mode = m;
    selected.clear();
    document.querySelector("nav.nav:not(.select-actions)")?.classList.toggle("hidden", m === "select");
    actions.classList.toggle("hidden", m !== "select");
    list.classList.toggle("selecting", m === "select");
    list.classList.toggle("editing", m === "edit");
    if (m !== "list")
      releaseMode = hold(() => {
        releaseMode = null;
        setMode("list");
      });
    rebuild();
  };

  const link = (label: string, f: () => void, cls = "") => h("button", { class: `link small${cls}`, onclick: f }, label);

  /** The row above the list: count, Edit and Select; or what selecting or editing offers. Same place, same height. */
  function renderInfo() {
    clear(info);
    if (mode === "edit") {
      append(info, [h("span", { class: "small" }, "Tap words to stick on or peel off"), link("Done", () => setMode("list"))]);
    } else if (mode === "list") {
      const count = q.value ? plural(found.length, "match", "matches") : plural(found.length, "word");
      append(info, [
        h("span", { class: "muted small" }, count),
        h("span", { class: "info-links" }, labelId !== undefined ? link("Edit", () => setMode("edit"), " edit-link") : null, found.length ? link("Select", () => setMode("select")) : null),
      ]);
    } else {
      const allOn = found.length > 0 && found.every((n) => selected.has(n.id));
      const toggleAll = () => {
        for (const n of found) allOn ? selected.delete(n.id) : selected.add(n.id);
        for (const [id, r] of rows) r.el.classList.toggle("selected", selected.has(id));
        renderInfo();
      };
      append(info, [h("span", { class: "muted small" }, `${selected.size} selected`), h("span", { class: "info-links" }, link(allOn ? "Select none" : `Select all ${found.length}`, toggleAll), link("Cancel", () => setMode("list")))]);
    }
    busy(false);
  }

  /** Edit: stick the open sticker on a word, or peel it off. */
  async function toggleSticker(n: Note, el: HTMLElement) {
    const on = !col.wears(n.id, labelId!);
    el.classList.toggle("stuck", on);
    el.setAttribute("aria-pressed", String(on));
    try {
      await store.stick(labelId!, [n.id], on);
    } catch (e) {
      el.classList.toggle("stuck", !on);
      el.setAttribute("aria-pressed", String(!on));
      toast(`Could not save: ${errorText(e)}`);
    }
  }

  function row(n: Note): HTMLButtonElement {
    const st = h("span", {});
    showStatus(n, st);
    const stuck = mode === "edit" && col.wears(n.id, labelId!);
    const el = h(
      "button",
      {
        class: `word${selected.has(n.id) ? " selected" : ""}${stuck ? " stuck" : ""}`,
        onclick: () => {
          if (mode === "edit") return void toggleSticker(n, el);
          if (mode === "list") return go.edit(n.id);
          if (!selected.delete(n.id)) selected.add(n.id);
          el.classList.toggle("selected", selected.has(n.id));
          renderInfo();
        },
      },
      h("span", { class: "check", "aria-hidden": "true" }),
      h("span", { class: "mark", "aria-hidden": "true" }),
      h("span", { class: "w-front" }, n.fields.front),
      h("span", { class: "w-back muted" }, n.fields.back),
      st,
    );
    if (mode === "edit") el.setAttribute("aria-pressed", String(stuck));
    rows.set(n.id, { el, st });
    return el;
  }

  /** Append the next chunk of rows. */
  function grow() {
    const end = Math.min(found.length, shown + CHUNK);
    for (; shown < end; shown++) list.insertBefore(row(found[shown]), more);
    more.classList.toggle("hidden", shown >= found.length);
  }

  /** The list from scratch: after a search, a delete or a change of mode. */
  function rebuild() {
    const term = q.value.trim().toLocaleLowerCase();
    found = term ? all().filter((n) => `${n.fields.front}\n${n.fields.back}\n${n.fields.example ?? ""}`.toLocaleLowerCase().includes(term)) : all();
    const ids = new Set(found.map((n) => n.id));
    for (const id of selected) if (!ids.has(id)) selected.delete(id);
    rows.clear();
    clear(list);
    list.appendChild(more);
    shown = 0;
    grow();
    // A sticker with no words: the sheet says so, and a pencil note points at Edit.
    const none = mode === "list" && labelId !== undefined && !found.length && !q.value;
    list.classList.toggle("none", none);
    if (none) list.prepend(h("p", { class: "none-line" }, "No words yet."), h("span", { class: "pencil-note", "aria-hidden": "true" }, "add words"), svg(ICON_ARROW));
    else if (!found.length && q.value) list.prepend(h("p", { class: "muted center" }, "No matches."));
    list.classList.toggle("hidden", !found.length && !q.value && !none);
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
  const empty = col.liveNotes().length
    ? null
    : h(
        "div",
        { class: "card-box center" },
        h("p", {}, "No words yet."),
        h("button", { class: "primary", onclick: () => go.add() }, "Add a word"),
        h("button", { class: "secondary", onclick: () => go.import() }, "Import from Duocards"),
      );
  // + adds to the open language, else to the last one used; with a sticker open, the word gets it.
  const addWord = () => (openLang && rememberLanguage(openLang), go.add());
  const tools = h("div", { class: "word-tools" }, q, h("button", { class: "primary add-btn", onclick: addWord, "aria-label": "Add a word" }, "+"));
  const chip = (key: string, label: string) => h("button", { class: "chip", "aria-pressed": "false", onclick: () => (setOpenChip(key), go.words()) }, label);
  const langRow =
    langs.length > 1
      ? h(
          "div",
          { class: "chips lang-chips" },
          ...langs.map((l) => {
            const key = `lang:${l}`;
            if (key !== open) return chip(key, langName(l));
            return h("button", { class: "chip on", "aria-pressed": "true", onclick: () => (setOpenChip(null), go.words()) }, langName(l));
          }),
        )
      : null;
  // Stickers on one line that scrolls sideways, + Sticker at its end; the open one shows a pencil.
  const stickRow = h(
    "div",
    { class: "chips sticker-chips" },
    ...col.liveLabels().map((l) => {
      const key = labelPile(l.id);
      if (key !== open) {
        const b = chip(key, "");
        b.className = "chip sticker";
        b.append(h("span", { class: "t" }, l.name));
        return b;
      }
      const pen = h("button", { class: "pen", "aria-label": `Rename or delete ${l.name}`, onclick: () => pencilSheet(l.id, (now) => (setOpenChip(now === undefined ? null : labelPile(now)), go.words())) });
      pen.innerHTML = ICON_PEN;
      return h("span", { class: "chip sticker on" }, h("button", { class: "t", "aria-pressed": "true", onclick: () => (setOpenChip(null), go.words()) }, l.name), pen);
    }),
    h("button", { class: "chip new-sticker", onclick: () => newStickerSheet(editSticker) }, "+ Sticker"),
  );
  const chips = h("div", { class: "chip-rows" }, langRow, stickRow);
  page("words", "Words", empty ? null : chips, empty ?? tools, empty ? null : info, list);
  app.root.appendChild(actions);
  if (labelId !== undefined && takeEditNext()) setMode("edit");
  else {
    takeEditNext();
    rebuild();
  }
  const on = stickRow.querySelector<HTMLElement>(".on");
  if (on) stickRow.scrollLeft = on.offsetLeft - 40;
  void refresh();
}

function svg(markup: string): Element {
  const t = document.createElement("template");
  t.innerHTML = markup;
  return t.content.firstElementChild!;
}

export function edit(noteId: EntityId): void {
  const { store } = app;
  const n = store.col.liveNote(noteId);
  if (!n) return words();
  const front = h("input", { value: n.fields.front });
  const back = h("input", { value: n.fields.back });
  const example = h("textarea", { rows: 2, value: n.fields.example ?? "" });
  // Its stickers: × peels one off, + Sticker sticks one on; both at once.
  const tags = h("div", { class: "edit-stickers" });
  const renderTags = () =>
    tags.replaceChildren(
      ...store.col.labelsOf(n.id).map((l) =>
        stickerTag(
          l.name,
          h(
            "button",
            {
              class: "x",
              type: "button",
              "aria-label": `Peel off ${l.name}`,
              onclick: async () => {
                await store.stick(l.id, [n.id], false);
                renderTags();
              },
            },
            "×",
          ),
        ),
      ),
      h("button", { class: "chip new-sticker small", type: "button", onclick: () => stickersSheet([n.id], renderTags) }, "+ Sticker"),
    );
  renderTags();
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
      h("div", { class: "stickers-field" }, h("span", {}, "Stickers"), tags),
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
