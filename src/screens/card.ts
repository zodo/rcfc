// The card editor: Add and Edit as one card, both sides at once
// (docs/plans/20261125-card-editor.md). A blank card has pencil notes with
// arrows pointing at its places; the languages are words in those notes.
// When typing pauses, the AI fills in what is missing (the other word, an
// example; src/domain/fill.ts), and the picture draws itself once both words
// are in.
// Nothing is written until Add or Save (src/domain/cards.ts turns the draft
// into events); a picture still drawing then follows the card.
import { app, back as goBack, go, hold, sheet, subPage } from "../app";
import { addEvents, draftOf, duplicates, MEMO_KNOWN, MEMO_TARGET, saveEvents, type CardDraft, type DraftPicture } from "../domain/cards";
import type { Note } from "../domain/collection";
import { applyOption, askKey, clean as cleanFill, clearAuto, fillAsk, filledPlace, type FillOption, type FillPlace, type FillRequest, type FillText } from "../domain/fill";
import type { NoteDeleted } from "../domain/events";
import type { EntityId } from "../domain/ids";
import type { PicState, SketchResult } from "../pictures";
import { h, ICON_SPEAK, langName, langSelect } from "../ui/h";
import { Ink } from "../ui/ink";
import { arrowNote, pickWord } from "../ui/pencil";
import { cutout, cutoutReady } from "../ui/picture";
import { SketchNote } from "../ui/sketch";
import { deckFor, languageForm, languages, lastLanguage, openLabel, rememberLanguage, rememberTranslation, translationFor } from "./languages";
import { stickersSheet, stickerTag, type StickerTarget } from "./stickers";

/** How long typing must pause before the card is filled in and its picture drawn. */
export const PAUSE_MS = 1500;
/** Add / Save wait this long at most for a fill still on its way. */
const FILL_WAIT_MS = 8000;
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

/**
 * `over`: this editor lies on top of another card being filled in (opened
 * from its "you already have" note or its added list); leaving it puts that
 * card back as it was left, instead of going back in history.
 */
function open(note?: Note, over?: { leave: () => void }): void {
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
  /** The words alone that the picture on the card shows: a redraw of the same words keeps it while drawing. */
  let drawnWords = note ? picKey(note.fields.front, note.fields.back, "") : "";
  let pending: Promise<SketchResult> | undefined;
  /** While it draws: the pencil writing down what it will show. */
  let sketch: SketchNote | undefined;
  /** The picture just glued on over the note: shown as it lies, not drawn again. */
  let glued: { key: string; el: HTMLElement } | undefined;
  const dropSketch = () => {
    sketch?.close();
    sketch = undefined;
  };
  let problem: "offline" | "limit" | "failed" | undefined;
  let removed = !!note?.noPicture;
  let detailsOpen = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  // ---- filling in: what the AI wrote, and the meanings it offers ----
  /** Places a fill wrote that the user hasn't typed in since. */
  let auto = new Set<FillPlace>();
  /** The question last asked (askKey): a pause with the same one asks nothing. */
  let asked = "";
  let filling: Promise<void> | undefined;
  let fillGen = 0;
  /** The question the offered meanings answer, the meanings, and a better form of the typed word. */
  let shown: FillRequest | undefined;
  let options: FillOption[] = [];
  let chosen = 0;
  let suggestion = "";

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
    pause();
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
    pause();
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
    if (!force && k === drawnFor) return; // nothing new: leave the picture space as it is, a tap on it may be under way
    drawnFor = k;
    problem = undefined;
    dropSketch();
    const words = picKey(f, b, "");
    // New words: the pencil notes what the picture will show. A redraw of the same words: the old picture stays until the new one comes.
    const sk = drawn && drawnWords === words ? undefined : (sketch = new SketchNote(() => ink.busy()));
    const p = sketcher.draw({ word: f, translation: b, example: clean(example.value), details, onText: sk && ((t) => sk.text(t)) });
    pending = p;
    renderPic();
    void p.then(async (r) => {
      if (pending !== p) return;
      if (r.ok && sk?.el.isConnected) {
        // Glued on over the note before the card takes it as its picture.
        const el = await cutoutReady(r.picture.key, "l", true);
        if (pending !== p) return;
        if (el) {
          await sk.glue(el);
          if (pending !== p) return;
          glued = { key: r.picture.key, el };
        }
      }
      pending = undefined;
      if (sk && sketch === sk) dropSketch();
      if (r.ok) {
        drawn = r.picture;
        drawnWords = words;
      }
      else if (r.reason !== "stale") problem = r.reason;
      renderPic();
    });
  };

  const renderPic = () => {
    const b = clean(back.value);
    const both = !!clean(front.value) && !!b;
    const box = (...c: (Node | string | null)[]) => h("div", { class: "ed-pic-box" }, ...c);
    // The translation shows here once the pencil has written it, not before.
    const mirror = () => h("span", { class: "ed-mirror", lang: to }, ink.isWriting(back) ? "" : b);
    const caption = () =>
      h("button", { type: "button", class: "ed-caption", onclick: () => ((detailsOpen = true), renderPic(), detailsInput.focus()) }, details ? `how it looks: ${details}` : "+ how it looks");
    const queued = note && !drawn && !pending && !removed ? pictures.state(note.id) : undefined;
    /** Keeps the caption's line while there is no picture yet, so nothing under it moves when one comes. */
    const room = () => h("span", { class: "ed-caption room", "aria-hidden": "true" }, "+ how it looks");
    let body: (Node | string | null)[];
    if (removed) {
      body = [box(h("span", {}, "no picture")), h("button", { type: "button", class: "ed-caption", onclick: () => ((removed = false), draw(true)) }, "draw one")];
    } else if (pending && sketch) {
      body = [sketch.el, room()];
    } else if (drawn) {
      // On its piece of paper, glued on: the card being made.
      body = [glued?.key === drawn.key ? glued.el : cutout(drawn.key, "l", true), caption()];
    } else if (pending) {
      body = [box(mirror(), h("span", { class: "ed-pic-says" }, "drawing…")), room()];
    } else if (queued) {
      body = [box(h("span", { class: "ed-pic-says" }, QUEUE_TEXT[queued])), queued === "failed" ? h("button", { type: "button", class: "ed-caption", onclick: () => void pictures.retry(note!.id) }, "try again") : null];
    } else if (problem) {
      const says = problem === "offline" ? "it draws itself once you're online" : problem === "limit" ? "today's free pictures are used up; it comes tomorrow" : "it couldn't be drawn";
      body = [box(mirror(), h("span", { class: "ed-pic-says" }, says)), problem === "failed" ? h("button", { type: "button", class: "ed-caption", onclick: () => draw(true) }, "try again") : room()];
    } else if (both) {
      body = [box(mirror(), h("span", { class: "ed-pic-says" }, "draws when you stop typing")), room()];
    } else {
      body = [box(h("span", { class: "ed-pic-says" }, "the picture draws itself from the two words")), room()];
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
                dropSketch();
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

  // ---- filling in ----
  const places: Record<FillPlace, HTMLInputElement> = { front, back, example };
  const textNow = (): FillText => ({ front: front.value, back: back.value, example: example.value });
  /** Writes on the card in pencil: doodles on the first place while it waits, then writes each fill in turn. */
  const ink = new Ink(
    () => root,
    (el) => el.closest<HTMLElement>(".ed-side")!,
  );
  /**
   * The card with this text. Places a fill wrote are written in by the pencil,
   * `first` first, one after another; `then` runs once all of them show.
   * Emptied places empty at once.
   */
  const setText = (t: FillText, first?: FillPlace, then?: () => void) => {
    const order: FillPlace[] = first ? [first, ...(["front", "back", "example"] as const).filter((p) => p !== first)] : ["front", "back", "example"];
    const changed = order.filter((p) => places[p].value !== t[p]);
    const written = changed.filter((p) => t[p] && auto.has(p));
    for (const p of changed) {
      if (written.includes(p)) continue;
      ink.write(places[p], t[p]);
    }
    let left = written.length;
    if (!left) return then?.();
    for (const p of written)
      ink.write(places[p], t[p], () => {
        if (p === "back" && !drawn) renderPic(); // its mirror in the picture space
        if (--left === 0) then?.();
      });
  };
  const askNow = () => fillAsk(textNow(), auto, { from: from!, to });
  const wordFill = h("p", { class: "ed-fill", role: "status" });
  const transFill = h("p", { class: "ed-fill", role: "status" });

  /** The question on its way. */
  let asking: FillRequest | undefined;

  /** Ask for what is missing, unless that was asked already. True while a fill on its way may change the words (the picture waits for it). */
  const fill = (): boolean => {
    const r = askNow();
    const k = askKey(r);
    if (k === asked) return !!filling && !!r && !!filledPlace(r);
    asked = k;
    const mine = ++fillGen;
    filling = asking = undefined;
    if (!r) return renderFill(), false;
    const p = app.filler.fill(r).then((res) => {
      if (mine !== fillGen) return;
      filling = asking = undefined;
      // The card changed meanwhile (the user typed what was asked for): this answer is for another question.
      if (askKey(askNow()) !== k) return renderFill();
      if (res.ok && res.fill.options.length) {
        const a = applyOption(textNow(), auto, r, res.fill.options[0]);
        auto = a.auto;
        // What else it offers shows once the pencil has written the answer in.
        shown = undefined;
        setText(a.text, filledPlace(r) ?? "example", () => {
          if (askKey(askNow()) !== k) return;
          shown = r;
          options = res.fill.options;
          chosen = 0;
          suggestion = res.fill.suggest ?? "";
          renderFill();
        });
      }
      update();
      renderFill();
      checkDup();
      draw(false);
    });
    filling = p;
    asking = r;
    renderFill();
    return !!filledPlace(r);
  };

  /** Swap in another meaning the fill offered; the picture follows it. */
  const choose = (i: number) => {
    if (!shown || busy) return;
    chosen = i;
    const a = applyOption(textNow(), auto, shown, options[i]);
    auto = a.auto;
    setText(a.text, filledPlace(shown));
    asked = askKey(askNow());
    update();
    renderFill();
    checkDup();
    draw(false);
  };

  /** Take the suggested form of the word ("el banco" for "banco"); the translation and picture stay. */
  const takeSuggestion = () => {
    if (!suggestion || busy) return;
    const was = picKey(front.value, back.value, details);
    ink.write(front, suggestion);
    suggestion = "";
    if (shown) shown = { ...shown, word: front.value };
    asked = askKey(askNow());
    // Same meaning: the picture drawn (or drawing) for the old form is this word's picture.
    if (drawnFor === was) drawnFor = picKey(front.value, back.value, details);
    update();
    renderFill();
    checkDup();
  };

  /** The user typed in a place: it is theirs now. Emptying every word typed takes back what the fill wrote. */
  const typed = (p: FillPlace) => {
    auto.delete(p);
    const mine = (q: FillPlace) => !auto.has(q) && !!cleanFill(places[q].value);
    if (!mine("front") && !mine("back") && auto.size) {
      setText(clearAuto(textNow(), auto));
      auto.clear();
    }
    // Meanings offered for another word than the one there now are put away.
    if (shown && askKey(askNow()) !== askKey(shown)) {
      shown = undefined;
      options = [];
      suggestion = "";
    }
    renderFill();
  };

  const renderFill = () => {
    const place = shown && filledPlace(shown);
    const others = (field: "word" | "translation", lang: string) =>
      options.flatMap((o, i) => (i === chosen ? [] : [" · ", h("button", { type: "button", class: "link", lang, onclick: () => choose(i) }, o[field])])).slice(1);
    const or = (field: "word" | "translation", lang: string): (Node | string)[] => (options.length > 1 ? ["or: ", ...others(field, lang)] : []);
    const typedWord = !auto.has("front") && suggestion && cleanFill(front.value) !== cleanFill(suggestion);
    wordFill.replaceChildren(
      ...(typedWord ? ["did you mean ", h("button", { type: "button", class: "link", lang: from!, onclick: takeSuggestion }, suggestion), "?"] : place === "front" && auto.has("front") ? or("word", from!) : []),
    );
    transFill.replaceChildren(...(place === "back" && auto.has("back") ? or("translation", to) : []));
    // Looking it up: the pencil waits on the place being filled in.
    const waitOn = asking ? places[filledPlace(asking) ?? "example"] : null;
    ink.waitAt(filling && waitOn && !cleanFill(waitOn.value) ? waitOn : null);
  };

  // ---- duplicates: told as soon as typing pauses ----
  const checkDup = () => {
    const d = duplicates(store.col.liveNotes(), { front: front.value, back: back.value, lang_pair: { from: from!, to } }, note?.id);
    const link = (n: Note) => h("button", { type: "button", class: "link", onclick: () => openOver(n.id) }, `${n.fields.front} · ${n.fields.back}`);
    const said = d.exact ? `=${d.exact.id}:${d.exact.fields.back}` : d.sameWord.map((n) => `${n.id}:${n.fields.back}`).join();
    if (said === dupSaid) return d; // the same note: left as it is, a tap on its link may be under way
    dupSaid = said;
    if (d.exact) dupNote.replaceChildren("this card is already in your words: ", link(d.exact));
    else if (d.sameWord.length) dupNote.replaceChildren("you already have ", link(d.sameWord[0]), d.sameWord.length > 1 ? ` and ${d.sameWord.length - 1} more` : "");
    else dupNote.replaceChildren();
    return d;
  };
  let dupSaid = "";

  // ---- the arrow notes follow what is filled in ----
  const update = () => {
    const word = editing ? plain(from!) : fromWord.el;
    const trans = editing ? plain(to) : toWord.el;
    fromWord.text.textContent = langName(from!);
    toWord.text.textContent = langName(to);
    wordNote.text.replaceChildren(...(clean(front.value) ? [word] : ["the ", word, " word goes here"]));
    transNote.text.replaceChildren(...(clean(back.value) ? [trans] : ["its ", trans, " translation goes here"]));
    exampleNote.el.classList.toggle("gone", !!clean(example.value));
    front.lang = from!;
    example.lang = from!;
    back.lang = to;
    speak.hidden = !app.speech.canSay(from!) || !clean(front.value);
  };

  const speak = h("button", { type: "button", class: "speak inline", "aria-label": "Say it", onclick: () => void app.speech.say(clean(front.value), from!) });
  speak.innerHTML = ICON_SPEAK;

  // Typing restarts the pause; Enter or leaving the field ends it at once.
  // At the pause what is missing is filled in, and the picture draws (after the fill, when one may change the words).
  const pause = () => {
    clearTimeout(timer);
    checkDup();
    if (!fill()) draw(false);
  };
  for (const el of [front, back]) {
    el.addEventListener("input", () => {
      typed(el === front ? "front" : "back");
      update();
      clearTimeout(timer);
      renderPic();
      timer = setTimeout(pause, PAUSE_MS);
    });
    el.addEventListener("blur", pause);
  }
  example.addEventListener("input", () => {
    typed("example");
    update();
  });
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

  /** The words just typed: what is missing is filled in (waited for, a while) and drawing starts now if it hadn't. */
  const settle = async () => {
    clearTimeout(timer);
    fill();
    if (filling) await Promise.race([filling, new Promise((r) => setTimeout(r, FILL_WAIT_MS))]);
    draw(false);
  };

  const addIt = once(async () => {
    await settle();
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
    ink.clear();
    for (const el of [front, back, example, memoTarget, memoKnown]) el.value = "";
    labels = openSticker();
    sketcher = pictures.sketcher();
    dropSketch();
    drawn = pending = problem = glued = undefined;
    drawnFor = drawnWords = details = "";
    removed = detailsOpen = false;
    auto = new Set();
    asked = "";
    fillGen++;
    filling = shown = undefined;
    options = [];
    suggestion = "";
    renderFill();
    dupNote.replaceChildren();
    dupSaid = "";
    update();
    renderPic();
    renderStickers();
    renderAdded();
    front.focus();
  });

  const saveIt = once(async () => {
    await settle();
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
    ink.clear();
    sketcher.cancel();
    dropSketch();
    fillGen++; // a fill still on its way writes nothing, and draws nothing
    if (over) over.leave();
    else goBack();
  };

  /** While another card is open on top of this one: kept whole, put back when that one is left. */
  let parked = false;
  /** Open a saved card on top of this one; back (button, gesture, Save, Delete) returns here, nothing lost. */
  const openOver = (id: EntityId) => {
    const n = store.col.liveNote(id);
    if (!n || busy) return;
    clearTimeout(timer);
    ink.finishAll();
    const saved = [...app.root.childNodes];
    const scroll = window.scrollY;
    parked = true;
    const putBack = () => {
      parked = false;
      app.root.replaceChildren(...saved);
      window.scrollTo(0, scroll);
      update();
      checkDup();
      renderStickers();
      renderPic();
      renderAdded();
    };
    let release = () => {};
    open(n, {
      leave: () => {
        release();
        putBack();
      },
    });
    release = hold(putBack); // the back gesture
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
          { type: "button", class: "ed-added-row", onclick: () => openOver(id) },
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
    h("div", { class: "ed-note-row" }, wordNote.el, wordFill),
    dupNote,
    example,
    exampleNote.el,
    h("label", { class: "ed-memo-line" }, h("span", { "aria-hidden": "true" }, "✎"), memoTarget),
  );
  const cream = h("section", { class: "ed-side known", "aria-label": "Cream side" }, back, h("div", { class: "ed-note-row" }, transNote.el, transFill), pic, h("label", { class: "ed-memo-line" }, h("span", { "aria-hidden": "true" }, "✎"), memoKnown));
  const root = h("div", { class: "editor" }, white, cream);
  // Reaching for the card while the pencil writes: everything shows written at once.
  for (const type of ["pointerdown", "keydown"]) root.addEventListener(type, () => ink.finishAll(), true);
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
    if (parked) return;
    if (!root.isConnected) return off();
    if (note && id === note.id) {
      // The queue's picture arrived while the card is open: show it, unless one was drawn here.
      const now = store.col.liveNote(note.id)?.picture;
      if (now && !drawn && !pending && !removed) {
        drawn = { ...now };
        drawnFor = picKey(front.value, back.value, details);
        drawnWords = picKey(front.value, back.value, "");
      }
      renderPic();
    }
    if (added.includes(id)) renderAdded();
  });
  update();
  renderStickers();
  renderPic();
  renderAdded();
  if (!editing) front.focus();
}
