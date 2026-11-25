// The card editor: Add and Edit as one card, both sides at once
// (docs/plans/20261125-card-editor.md). A blank card has pencil notes with
// arrows pointing at its places; the languages are words in those notes.
// The picture draws itself once both words are in and typing pauses.
// Nothing is written until Add or Save (src/domain/cards.ts turns the draft
// into events); a picture still drawing then follows the card.
import { app, go, sheet, subPage } from "../app";
import { addEvents, draftOf, duplicates, MEMO_KNOWN, MEMO_TARGET, saveEvents, type CardDraft, type DraftPicture } from "../domain/cards";
import type { Note } from "../domain/collection";
import type { NoteDeleted } from "../domain/events";
import type { EntityId } from "../domain/ids";
import type { PicState, SketchResult } from "../pictures";
import { h, ICON_SPEAK, langName, langSelect } from "../ui/h";
import { arrowNote, pickWord } from "../ui/pencil";
import { cutout } from "../ui/picture";
import { deckFor, languageForm, languages, lastLanguage, openLabel, rememberLanguage, rememberTranslation, translationFor } from "./languages";
import { stickersSheet, stickerTag, type StickerTarget } from "./stickers";

/** How long typing must pause before the picture is drawn. */
export const PAUSE_MS = 1500;
const NEW_LANG = "new";

/** Cards added since the Add screen was opened, newest first. */
let added: EntityId[] = [];

/** The Add screen: a blank card. */
export function addCard(): void {
  added = [];
  open();
}

/** The Edit screen: the card filled in. */
export function editCard(noteId: EntityId): void {
  const n = app.store.col.liveNote(noteId);
  if (!n) return go.words();
  open(n);
}

const clean = (s: string) => s.normalize("NFC").trim();
const picKey = (front: string, back: string, details: string) => [clean(front), clean(back), clean(details)].join("\u0000");

const QUEUE_TEXT: Record<PicState, string> = {
  queued: "the picture is on its way",
  drawing: "drawing…",
  waiting: "today's free pictures are used up; it comes tomorrow",
  failed: "the picture couldn't be drawn",
};

function open(note?: Note): void {
  const { store, pictures } = app;
  const editing = !!note;
  let from = note?.lang_pair.from ?? lastLanguage();
  if (!from) return go.addLanguage();
  let to = note?.lang_pair.to ?? translationFor(from);
  const openSticker = (): EntityId[] => {
    const id = openLabel();
    return id !== undefined && store.col.liveLabel(id) ? [id] : [];
  };
  const wears = note ? store.col.labelsOf(note.id).map((l) => l.id) : [];
  let labels = note ? [...wears] : openSticker();

  // ---- the picture: what it shows, what is drawing, and why there is none ----
  let sketcher = pictures.sketcher();
  let drawn: DraftPicture | undefined = note?.picture ? { ...note.picture } : undefined;
  let details = note?.picture?.details ?? "";
  /** The words (+ details) the picture shows or is drawing; a pause with the same ones draws nothing. */
  let drawnFor = note ? picKey(note.fields.front, note.fields.back, details) : "";
  let pending: Promise<SketchResult> | undefined;
  let problem: "offline" | "limit" | "failed" | undefined;
  let removed = !!note?.noPicture;
  let detailsOpen = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  // ---- the places ----
  const input = (name: string, attrs: Record<string, unknown> = {}) => h("input", { name, autocomplete: "off", enterkeyhint: "done", ...attrs });
  const front = input("front", { class: "ed-word", value: note?.fields.front ?? "", autocapitalize: "off", spellcheck: false, enterkeyhint: "next", "aria-label": "Word" });
  const back = input("back", { class: "ed-trans", value: note?.fields.back ?? "", "aria-label": "Translation" });
  const example = input("example", { class: "ed-example", value: note?.fields.example ?? "", "aria-label": "Example" });
  const memoTarget = input(MEMO_TARGET, { class: "ed-memo", value: note?.fields[MEMO_TARGET] ?? "", placeholder: "a note of your own", "aria-label": "Your note on this side" });
  const memoKnown = input(MEMO_KNOWN, { class: "ed-memo", value: note?.fields[MEMO_KNOWN] ?? "", placeholder: "a note of your own", "aria-label": "Your note on this side" });

  // The languages, as words in the arrow notes: pickers on a new card, plain pencil on a saved one.
  const fromSel = h("select", { name: "language" });
  const fillFrom = () => {
    fromSel.replaceChildren(...[...new Set([...languages(), from!])].map((l) => h("option", { value: l, selected: l === from }, langName(l))), h("option", { value: NEW_LANG }, "Add a language…"));
  };
  fillFrom();
  const toSel = langSelect("to", to);
  const fromWord = pickWord(fromSel, "Language of the word");
  const toWord = pickWord(toSel, "Language of the translation");
  const plain = (l: string) => h("span", { class: "lang-plain" }, langName(l));
  const setFrom = (l: string) => {
    from = l;
    to = translationFor(l);
    if (![...toSel.options].some((o) => o.value === to)) toSel.prepend(h("option", { value: to }, langName(to)));
    toSel.value = to;
    fillFrom();
    update();
  };
  fromSel.addEventListener("change", () => {
    if (fromSel.value !== NEW_LANG) return setFrom(fromSel.value);
    fromSel.value = from!;
    const close = sheet(
      "Add a language",
      "Add a language",
      languageForm((l) => {
        close();
        setFrom(l);
        front.focus();
      }, "Use it"),
    );
  });
  toSel.addEventListener("change", () => {
    to = toSel.value;
    update();
  });

  const wordNote = arrowNote("ed-note-word");
  const transNote = arrowNote("ed-note-trans");
  const exampleNote = arrowNote("ed-note-example");
  exampleNote.text.textContent = "an example, if you like";
  const dupNote = h("p", { class: "ed-dup", role: "status" });

  // ---- stickers, stuck on the white side's corner ----
  const stickers = h("div", { class: "ed-stickers" });
  const target: StickerTarget = {
    count: 1,
    wearing: (id) => (labels.includes(id) ? 1 : 0),
    set: (id, on) => {
      labels = on ? [...new Set([...labels, id])] : labels.filter((x) => x !== id);
    },
  };
  const renderStickers = () => {
    stickers.replaceChildren(
      ...labels.flatMap((id) => {
        const l = store.col.liveLabel(id);
        if (!l) return [];
        const tag = stickerTag(l);
        return [h("button", { type: "button", class: "ed-sticker", "aria-label": `Peel off ${l.name}`, onclick: () => ((labels = labels.filter((x) => x !== id)), renderStickers()) }, tag)];
      }),
      h("button", { class: "chip new-sticker small", type: "button", onclick: () => stickersSheet(target, renderStickers) }, "+ Sticker"),
    );
  };

  // ---- the picture space ----
  const pic = h("div", { class: "ed-pic" });
  const detailsInput = input("details", { class: "ed-details-input", placeholder: "how it looks, e.g. in a park in autumn", maxLength: 300, "aria-label": "How it looks" });

  const draw = (force: boolean) => {
    clearTimeout(timer);
    const f = clean(front.value), b = clean(back.value);
    if (!f || !b || removed) return renderPic();
    const k = picKey(f, b, details);
    if (!force && k === drawnFor) return renderPic();
    drawnFor = k;
    problem = undefined;
    const p = sketcher.draw({ word: f, translation: b, example: clean(example.value), details });
    pending = p;
    renderPic();
    void p.then((r) => {
      if (pending !== p) return;
      pending = undefined;
      if (r.ok) drawn = r.picture;
      else if (r.reason !== "stale") problem = r.reason;
      renderPic();
    });
  };

  const renderPic = () => {
    const b = clean(back.value);
    const both = !!clean(front.value) && !!b;
    const box = (...c: (Node | string | null)[]) => h("div", { class: "ed-pic-box" }, ...c);
    const mirror = () => h("span", { class: "ed-mirror", lang: to }, b);
    const caption = () =>
      h("button", { type: "button", class: "ed-caption", onclick: () => ((detailsOpen = true), renderPic(), detailsInput.focus()) }, details ? `how it looks: ${details}` : "+ how it looks");
    const queued = note && !drawn && !pending && !removed ? pictures.state(note.id) : undefined;
    let body: (Node | string | null)[];
    if (removed) {
      body = [box(h("span", {}, "no picture")), h("button", { type: "button", class: "ed-caption", onclick: () => ((removed = false), draw(true)) }, "draw one")];
    } else if (drawn) {
      body = [cutout(drawn.key), caption()];
    } else if (pending) {
      body = [box(mirror(), h("span", { class: "ed-pic-says" }, "drawing…"))];
    } else if (queued) {
      body = [box(h("span", { class: "ed-pic-says" }, QUEUE_TEXT[queued])), queued === "failed" ? h("button", { type: "button", class: "ed-caption", onclick: () => void pictures.retry(note!.id) }, "try again") : null];
    } else if (problem) {
      const says = problem === "offline" ? "it draws itself once you're online" : problem === "limit" ? "today's free pictures are used up; it comes tomorrow" : "it couldn't be drawn";
      body = [box(mirror(), h("span", { class: "ed-pic-says" }, says)), problem === "failed" ? h("button", { type: "button", class: "ed-caption", onclick: () => draw(true) }, "try again") : null];
    } else if (both) {
      body = [box(mirror(), h("span", { class: "ed-pic-says" }, "draws when you stop typing"))];
    } else {
      body = [box(h("span", { class: "ed-pic-says" }, "the picture draws itself from the two words"))];
    }
    pic.classList.toggle("busy", !!pending || queued === "drawing" || queued === "queued");
    if (detailsOpen && !removed) {
      detailsInput.value = details;
      body = [
        ...body.slice(0, 1),
        detailsInput,
        h(
          "div",
          { class: "ed-pic-actions" },
          h("button", { type: "button", class: "secondary", onclick: () => ((details = clean(detailsInput.value)), (detailsOpen = false), draw(true)) }, "Redraw"),
          h(
            "button",
            {
              type: "button",
              class: "secondary",
              onclick: () => {
                removed = true;
                drawn = undefined;
                pending = undefined;
                problem = undefined;
                sketcher.cancel();
                detailsOpen = false;
                renderPic();
              },
            },
            "No picture",
          ),
        ),
      ];
    }
    pic.replaceChildren(...body.filter((x): x is Node | string => x !== null));
  };

  // ---- duplicates: told as soon as typing pauses ----
  const checkDup = () => {
    const d = duplicates(store.col.liveNotes(), { front: front.value, back: back.value, lang_pair: { from: from!, to } }, note?.id);
    const link = (n: Note) => h("button", { type: "button", class: "link", onclick: () => go.edit(n.id) }, `${n.fields.front} · ${n.fields.back}`);
    if (d.exact) dupNote.replaceChildren("this card is already in your words: ", link(d.exact));
    else if (d.sameWord.length) dupNote.replaceChildren("you already have ", link(d.sameWord[0]), d.sameWord.length > 1 ? ` and ${d.sameWord.length - 1} more` : "");
    else dupNote.replaceChildren();
    return d;
  };

  // ---- the arrow notes follow what is filled in ----
  const update = () => {
    const word = editing ? plain(from!) : fromWord.el;
    const trans = editing ? plain(to) : toWord.el;
    fromWord.text.textContent = langName(from!);
    toWord.text.textContent = langName(to);
    wordNote.text.replaceChildren(...(clean(front.value) ? [word] : ["the ", word, " word goes here"]));
    transNote.text.replaceChildren(...(clean(back.value) ? [trans] : ["its ", trans, " translation goes here"]));
    exampleNote.el.hidden = !!clean(example.value);
    front.lang = from!;
    example.lang = from!;
    back.lang = to;
    speak.hidden = !app.speech.canSay(from!) || !clean(front.value);
  };

  const speak = h("button", { type: "button", class: "speak inline", "aria-label": "Say it", onclick: () => void app.speech.say(clean(front.value), from!) });
  speak.innerHTML = ICON_SPEAK;

  // Typing restarts the pause; Enter or leaving the field ends it at once.
  for (const el of [front, back]) {
    el.addEventListener("input", () => {
      update();
      clearTimeout(timer);
      renderPic();
      timer = setTimeout(() => {
        checkDup();
        draw(false);
      }, PAUSE_MS);
    });
    el.addEventListener("blur", () => {
      checkDup();
      draw(false);
    });
  }
  example.addEventListener("input", update);
  front.addEventListener("keydown", (e) => e.key === "Enter" && (e.preventDefault(), back.focus()));
  for (const el of [back, example, memoTarget, memoKnown]) el.addEventListener("keydown", (e) => e.key === "Enter" && (e.preventDefault(), el.blur()));
  detailsInput.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    details = clean(detailsInput.value);
    detailsOpen = false;
    draw(true);
  });

  // ---- Add / Save ----
  const hint = h("p", { class: "ed-hint", role: "alert" });
  const draft = (): CardDraft => {
    const d = draftOf({ from: from!, to }, note, labels);
    d.text = { front: front.value, back: back.value, example: example.value, memo_target: memoTarget.value, memo_known: memoKnown.value };
    d.lang_pair = note?.lang_pair ?? { from: from!, to };
    d.labels = labels;
    const current = picKey(front.value, back.value, details);
    d.picture = removed ? null : !pending && drawn && drawnFor === current ? drawn : undefined;
    return d;
  };
  const ready = (): boolean => {
    hint.textContent = "";
    if (!clean(front.value)) {
      hint.textContent = "The word is missing.";
      front.focus();
      return false;
    }
    if (!clean(back.value)) {
      hint.textContent = "The translation is missing.";
      back.focus();
      return false;
    }
    if (checkDup().exact) {
      hint.textContent = "This card is already in your words.";
      return false;
    }
    return true;
  };
  let busy = false;
  const once = (f: () => Promise<void>) => async () => {
    if (busy) return;
    busy = true;
    try {
      await f();
    } finally {
      busy = false;
    }
  };

  const addIt = once(async () => {
    draw(false); // the words just typed: drawing starts now if it hadn't
    if (!ready()) return;
    const d = draft();
    const wait = d.picture === undefined ? pending : undefined;
    const { events, noteId } = addEvents(store.factory, await deckFor(from!), d);
    await store.append(events);
    rememberLanguage(from!);
    rememberTranslation(from!, to);
    if (wait) void pictures.adopt(noteId, wait);
    else if (d.picture === undefined) void pictures.ensure(noteId);
    added.unshift(noteId);
    // A fresh blank card, same languages and open sticker.
    for (const el of [front, back, example, memoTarget, memoKnown]) el.value = "";
    labels = openSticker();
    sketcher = pictures.sketcher();
    drawn = pending = problem = undefined;
    drawnFor = details = "";
    removed = detailsOpen = false;
    dupNote.replaceChildren();
    update();
    renderPic();
    renderStickers();
    renderAdded();
    front.focus();
  });

  const saveIt = once(async () => {
    draw(false);
    if (!note || !ready()) return;
    const d = draft();
    const wait = d.picture === undefined ? pending : undefined;
    const was = note.picture?.key;
    const events = saveEvents(store.factory, note, wears, d);
    if (events.length) await store.append(events);
    if (d.picture !== undefined || wait) pictures.cancel(note.id);
    if (wait) void pictures.adopt(note.id, wait, was);
    leave();
  });

  const deleteIt = once(async () => {
    if (!note || !confirm(`Delete "${note.fields.front}"? Its review history is kept for the model.`)) return;
    sketcher.cancel();
    await store.append([store.factory.make<NoteDeleted>("note_deleted", { note_id: note.id })]);
    leave();
  });

  const leave = () => {
    sketcher.cancel();
    go.words();
  };

  // ---- cards added this sitting ----
  const addedList = h("div", { class: "ed-added" });
  const renderAdded = () => {
    const rows = added.flatMap((id) => {
      const n = store.col.liveNote(id);
      if (!n) return [];
      return [
        h(
          "button",
          { type: "button", class: "ed-added-row", onclick: () => go.edit(id) },
          n.picture ? cutout(n.picture.key) : h("span", { class: `ed-added-pic${pictures.state(id) ? " busy" : ""}` }),
          h("span", { class: "ed-added-word", lang: n.lang_pair.from }, n.fields.front),
          h("span", { class: "ed-added-trans", lang: n.lang_pair.to }, n.fields.back),
        ),
      ];
    });
    addedList.replaceChildren(...(rows.length ? [h("h2", {}, "Added just now"), ...rows] : []));
  };

  // ---- the screen ----
  const white = h(
    "section",
    { class: "ed-side target", "aria-label": "White side" },
    stickers,
    h("div", { class: "ed-word-line" }, front, speak),
    wordNote.el,
    dupNote,
    example,
    exampleNote.el,
    h("label", { class: "ed-memo-line" }, h("span", { "aria-hidden": "true" }, "✎"), memoTarget),
  );
  const cream = h("section", { class: "ed-side known", "aria-label": "Cream side" }, back, transNote.el, pic, h("label", { class: "ed-memo-line" }, h("span", { "aria-hidden": "true" }, "✎"), memoKnown));
  const root = h("div", { class: "editor" }, white, cream);
  subPage(
    "words",
    editing ? "Edit card" : "Add a card",
    () => leave(),
    root,
    hint,
    editing
      ? h("div", { class: "ed-actions" }, h("button", { class: "primary", type: "button", onclick: saveIt }, "Save"), h("button", { class: "link danger-link", type: "button", onclick: deleteIt }, "Delete card"))
      : h("div", { class: "ed-actions" }, h("button", { class: "primary ed-add", type: "button", onclick: addIt }, "Add")),
    editing ? null : addedList,
    editing ? null : h("p", { class: "muted small center" }, "Have a Duocards export? ", h("button", { class: "link", type: "button", onclick: () => go.import() }, "Import it")),
  );

  // Pictures arriving (the queue, a drawing adopted after Add) redraw what shows them.
  const off = pictures.subscribe((id) => {
    if (!root.isConnected) return off();
    if (note && id === note.id) renderPic();
    if (added.includes(id)) renderAdded();
  });
  update();
  renderStickers();
  renderPic();
  renderAdded();
  if (!editing) front.focus();
}
