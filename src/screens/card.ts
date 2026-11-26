// The card editor: Add and Edit as one card, both sides at once
// (docs/plans/20261125-card-editor.md). A blank card has pencil notes with
// arrows pointing at its places; the languages are words in those notes.
// When typing pauses, the AI fills in what is missing (the other word, an
// example; src/domain/fill.ts), and the picture draws itself once both words
// are in.
// A new card is written when Add is pressed (in the bar, or Enter on its last
// places); leaving one not added yet asks first. An edited card is saved when
// it is left, with Undo on a slip. src/domain/cards.ts turns the draft into
// events; a picture still drawing then follows the card.
import { app, back as goBack, go, guardLeaving, hold, keepHoldsNext, sheet, sheetOr, subPage } from "../app";
import { addEvents, draftOf, duplicates, MEMO_KNOWN, MEMO_TARGET, PICTURE_DETAILS, saveEvents, undoEvents, type CardDraft, type DraftPicture } from "../domain/cards";
import type { Note } from "../domain/collection";
import { applyOption, askKey, clean as cleanFill, clearAuto, fillAsk, filledPlace, type FillOption, type FillPlace, type FillRequest, type FillText } from "../domain/fill";
import type { NoteDeleted, NoteRestored } from "../domain/events";
import type { EntityId } from "../domain/ids";
import type { PicState, SketchResult } from "../pictures";
import { foldWhenTight } from "../ui/fold";
import { h, ICON_PEN, ICON_SPEAK, langName, langSelect, slip } from "../ui/h";
import { Ink } from "../ui/ink";
import { arrowNote, pickWord } from "../ui/pencil";
import { cutout, cutoutReady } from "../ui/picture";
import { SketchNote } from "../ui/sketch";
import { languageOfText } from "../domain/script";
import { deckFor, languageForm, languages, lastLanguage, openLabel, rememberLanguage, rememberTranslation, translationFor } from "./languages";
import { stickersSheet, stickerTag, type StickerTarget } from "./stickers";

/** How long typing must pause before the card is filled in and its picture drawn. */
export const PAUSE_MS = 1500;
/** Filling in starts sooner than the picture: it costs little, and the pencil covers the wait. */
const FILL_PAUSE_MS = 700;
/** Add waits this long at most for a fill still on its way. */
const FILL_WAIT_MS = 8000;
const NEW_LANG = "new";
const ICON_BIN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>';

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
  let details = note?.picture?.details ?? note?.fields[PICTURE_DETAILS] ?? "";
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
  /** Why the words drawn for have no picture; `none`: no picture can show them (of, however), so the card gets none. */
  let problem: "offline" | "limit" | "failed" | "none" | undefined;
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
  /** The next fill leaves the example alone (the translation's language was switched; the example is the word's). */
  let keepExample = false;

  // ---- the places ----
  const input = (name: string, attrs: Record<string, unknown> = {}) => h("input", { name, autocomplete: "off", enterkeyhint: "done", ...attrs });
  /** The card as it was opened: what Undo puts back after leaving saved it. */
  const was = note ? structuredClone(note) : undefined;
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
  /** What a fill wrote on a side whose language changed is in the old one: it goes at once, and the pencil waits there for the new. */
  const rubOut = (ps: FillPlace[]) => {
    const gone = ps.filter((p) => auto.has(p) && places[p].value);
    if (!gone.length) return;
    for (const p of gone) auto.delete(p);
    const t = textNow();
    for (const p of gone) t[p] = "";
    setText(t);
    shown = undefined;
    options = [];
    suggestion = "";
  };
  const has = (p: FillPlace) => !!cleanFill(places[p].value);
  /**
   * A side's language picked: its text is translated into it from the other
   * side's word, which becomes what the card is filled in from (typed or not);
   * with nothing on the other side, the text is just said to be in it.
   * `typing`: told by the letters being typed, so the text is in it already.
   */
  const setTo = (l: string, typing = false) => {
    if (l === to) return;
    to = l;
    if (![...toSel.options].some((o) => o.value === to)) toSel.prepend(h("option", { value: to }, langName(to)));
    toSel.value = to;
    if (!typing && has("front") && has("back")) {
      auto.delete("front");
      auto.add("back");
      keepExample = has("example"); // in the studied language: it still fits the word
      rubOut(["back"]);
    } else rubOut(["back"]);
    update();
    renderFill();
    if (!typing) pause();
  };
  const setFrom = (l: string) => {
    from = l;
    // A translation on the card stays in its language, and the word is translated from it.
    const keep = has("back") && to !== l;
    const next = keep ? to : translationFor(l);
    if (![...toSel.options].some((o) => o.value === next)) toSel.prepend(h("option", { value: next }, langName(next)));
    toSel.value = to = next;
    fillFrom();
    if (keep && has("front")) {
      auto.delete("back");
      auto.add("front");
      if (has("example")) auto.add("example"); // in the old language
    }
    rubOut(["front", "example", ...(keep ? [] : (["back"] as const))]);
    update();
    renderFill();
    pause();
  };
  /** The languages the user's translations are in, most used first: what a translation typed in other letters is taken to be. */
  const known = (): string[] => {
    const n = new Map<string, number>();
    for (const x of store.col.liveNotes()) n.set(x.lang_pair.to, (n.get(x.lang_pair.to) ?? 0) + 1);
    return [...n].sort((a, b) => b[1] - a[1]).map(([l]) => l);
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
  toSel.addEventListener("change", () => setTo(toSel.value));

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

  /** `always`: the user asked for a picture ("draw one"), so the answer is never none. */
  const draw = (force: boolean, via = sketcher, always = false) => {
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
    const p = via.draw({ word: f, translation: b, example: clean(example.value), details, always, onText: sk && ((t) => sk.text(t)) });
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
      else if (r.reason !== "stale") {
        problem = r.reason;
        if (r.reason === "none") drawn = undefined;
      }
      renderPic();
    });
  };

  /** The picture whose pencil has shown. */
  let pencilFor: string | undefined;
  const renderPic = () => {
    const b = clean(back.value);
    const both = !!clean(front.value) && !!b;
    const box = (...c: (Node | string | null)[]) => h("div", { class: "ed-pic-box" }, ...c);
    // The translation shows here once the pencil has written it, not before.
    const mirror = () => h("span", { class: "ed-mirror", lang: to }, ink.isWriting(back) ? "" : b);
    /** The drawn picture with a pencil on its corner (how it looks: details, Redraw, No picture), laid over it so nothing moves when it comes. */
    const framed = (el: HTMLElement, fresh: boolean) => {
      const edit = h("button", {
        type: "button",
        class: `ed-pic-edit${fresh ? " fresh" : ""}`,
        "aria-label": details ? `How it looks: ${details}` : "How it looks",
        title: "How it looks",
        onclick: () => {
          detailsOpen = !detailsOpen;
          renderPic();
          if (!detailsOpen) return;
          detailsInput.focus();
          // Folded above the keyboard: its Redraw and No picture in view too.
          const vv = window.visualViewport;
          if (vv && pic.closest(".folded"))
            requestAnimationFrame(() => {
              const over = pic.getBoundingClientRect().bottom + 8 - (vv.offsetTop + vv.height);
              if (over > 0) window.scrollBy({ top: over });
            });
        },
      });
      edit.innerHTML = ICON_PEN;
      return h("div", { class: "ed-pic-frame" }, el, edit);
    };
    const queued = note && !drawn && !pending && !removed ? pictures.state(note.id) : undefined;
    /** Keeps the caption's line while there is no picture yet, so nothing under it moves when one comes. */
    const room = () => h("span", { class: "ed-caption room", "aria-hidden": "true" }, "+ how it looks");
    let body: (Node | string | null)[];
    if (removed) {
      body = [box(h("span", {}, "no picture")), h("button", { type: "button", class: "ed-caption", onclick: () => ((removed = false), draw(true, sketcher, true)) }, "draw one")];
    } else if (pending && sketch) {
      body = [sketch.el, room()];
    } else if (drawn) {
      // On its piece of paper, glued on: the card being made.
      // Just brought in, the pencil comes once it lies flat; drawn again (details opened) it is there at once.
      const fresh = glued?.key === drawn.key && pencilFor !== drawn.key;
      pencilFor = drawn.key;
      body = [glued?.key === drawn.key ? framed(glued.el, fresh) : framed(cutout(drawn.key, "l", true), false), room()];
    } else if (pending) {
      body = [box(mirror(), h("span", { class: "ed-pic-says" }, "drawing…")), room()];
    } else if (queued) {
      body = [box(h("span", { class: "ed-pic-says" }, QUEUE_TEXT[queued])), queued === "failed" ? h("button", { type: "button", class: "ed-caption", onclick: () => void pictures.retry(note!.id) }, "try again") : null];
    } else if (problem === "none") {
      body = [box(mirror()), h("button", { type: "button", class: "ed-caption", onclick: () => draw(true, sketcher, true) }, "draw one anyway")];
    } else if (problem) {
      const says = problem === "offline" ? "it draws itself once you're online" : problem === "limit" ? "today's free pictures are used up; it comes tomorrow" : "it couldn't be drawn";
      body = [box(mirror(), h("span", { class: "ed-pic-says" }, says)), problem === "failed" ? h("button", { type: "button", class: "ed-caption", onclick: () => draw(true) }, "try again") : room()];
    } else if (both) {
      body = [box(mirror()), room()];
    } else {
      body = [box(h("span", { class: "ed-pic-says" }, "its picture goes here")), room()];
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
    const keep = (): Set<FillPlace> | undefined => (keepExample ? new Set(["example"]) : undefined);
    /** Streamed: the first option's places as they are written out, the filled place first. */
    const onFirst = (first: Partial<FillOption>) => {
      if (mine !== fillGen || askKey(askNow()) !== k) return;
      const place = filledPlace(r);
      if (place && !(place === "back" ? first.translation : first.word)) return;
      const a = applyOption(textNow(), auto, r, { word: first.word ?? "", translation: first.translation ?? "", example: first.example ?? "" }, keep());
      auto = a.auto;
      setText(a.text, place ?? "example");
      update();
      checkDup();
      draw(false); // the words are in: the picture needn't wait for the example
    };
    const p = app.filler.fill(r, onFirst).then((res) => {
      if (mine !== fillGen) return;
      filling = asking = undefined;
      // The card changed meanwhile (the user typed what was asked for): this answer is for another question.
      if (askKey(askNow()) !== k) return renderFill();
      if (res.ok && res.fill.options.length) {
        const a = applyOption(textNow(), auto, r, res.fill.options[0], keep());
        keepExample = false;
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
    keepExample = false;
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
    clearTimeout(fillTimer);
    checkDup();
    if (!fill()) draw(false);
  };
  let fillTimer: ReturnType<typeof setTimeout> | undefined;
  for (const el of [front, back]) {
    el.addEventListener("input", () => {
      typed(el === front ? "front" : "back");
      // A translation typed in other letters (Cyrillic on an English side) is in another language: the side says so.
      if (el === back && !editing) {
        const l = languageOfText(back.value, to, known());
        if (l !== to) setTo(l, true);
      }
      update();
      clearTimeout(timer);
      clearTimeout(fillTimer);
      renderPic();
      fillTimer = setTimeout(() => {
        checkDup();
        fill();
      }, FILL_PAUSE_MS);
      timer = setTimeout(pause, PAUSE_MS);
    });
    el.addEventListener("blur", pause);
  }
  example.addEventListener("input", () => {
    typed("example");
    update();
  });
  front.addEventListener("keydown", (e) => e.key === "Enter" && (e.preventDefault(), back.focus()));
  // Enter on the other places: done. On a new card that means Add, so a row of cards goes without leaving the keyboard.
  for (const el of [back, example, memoTarget, memoKnown])
    el.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || e.isComposing) return;
      e.preventDefault();
      if (editing) el.blur();
      else void addIt();
    });
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
    d.picture = removed || (problem === "none" && !pending && drawnFor === current) ? null : !pending && drawn && drawnFor === current ? drawn : undefined;
    return d;
  };
  /** Why the card can't be added (or saved) as it is. */
  const whyNot = (): "word" | "translation" | "repeat" | undefined => (!clean(front.value) ? "word" : !clean(back.value) ? "translation" : checkDup().exact ? "repeat" : undefined);
  const ready = (): boolean => {
    const why = whyNot();
    hint.textContent = why === "word" ? "The word is missing." : why === "translation" ? "The translation is missing." : why === "repeat" ? "This card is already in your words." : "";
    if (why === "word") front.focus();
    if (why === "translation") back.focus();
    return !why;
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

  /** Add the card as it is: its id, or undefined when it can't be added yet (the hint says why). */
  const addNow = async (): Promise<EntityId | undefined> => {
    await settle();
    if (!ready()) return undefined;
    const d = draft();
    const wait = d.picture === undefined ? pending : undefined;
    const { events, noteId } = addEvents(store.factory, await deckFor(from!), d);
    await store.append(events);
    rememberLanguage(from!);
    rememberTranslation(from!, to);
    if (wait) void pictures.adopt(noteId, wait);
    else if (d.picture === undefined) void pictures.ensure(noteId);
    added.unshift(noteId);
    return noteId;
  };

  /** A fresh blank card, same languages and open sticker. */
  const fresh = () => {
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
  };

  const addIt = once(async () => {
    if (await addNow()) fresh();
  });

  /** The screen under this one shows what Undo changed. */
  const refresh = () => {
    if (app.current === "words") go.words();
    else if (app.current === "home") go.home();
  };
  const unDelete = (id: EntityId) => void store.append([store.factory.make<NoteRestored>("note_restored", { note_id: id })]).then(refresh);

  const deleteIt = once(async () => {
    if (!note) return;
    sketcher.cancel();
    await store.append([store.factory.make<NoteDeleted>("note_deleted", { note_id: note.id })]);
    away();
    slip(`Deleted ${note.fields.front}`, "Undo", () => unDelete(note.id));
  });

  // ---- leaving: a new card not added yet asks first; an edit is saved, with Undo ----
  /** Holds the back gesture, so leaving goes through `leave` too. */
  let guard: (() => void) | undefined;
  const arm = () => {
    if (!guard && !parked) guard = hold(() => ((guard = undefined), leave()));
  };
  const typedAnything = () => [front, back, example, memoTarget, memoKnown].some((el) => !!clean(el.value));

  /** Off this screen: back to the one under it, the card this one lies on, or `then` (a tab). */
  const away = (then?: () => void) => {
    ink.clear();
    sketcher.cancel();
    dropSketch();
    fillGen++; // a fill still on its way writes nothing, and draws nothing
    guard?.();
    guard = undefined;
    if (then) then();
    else if (over) over.leave();
    else goBack();
  };

  const leave = (then?: () => void) => {
    if (busy) return;
    clearTimeout(timer);
    ink.finishAll();
    if (editing) return void saveAndLeave(then);
    if (!typedAnything()) return away(then);
    notAdded(then);
  };

  /** Back on a card not added yet: add it, keep editing, or (back again) throw it away. */
  const notAdded = (then?: () => void) => {
    arm(); // back on the sheet throws the card away, so the gesture stays held under it
    const word = clean(front.value) || clean(back.value);
    const why = whyNot();
    const title = why === "repeat" ? "This card is already in your words" : why ? `${word} has no ${why} yet` : `${word} isn't added yet`;
    const close = sheetOr(
      () => away(then),
      "Not added yet",
      title,
      why
        ? null
        : h(
            "button",
            {
              type: "button",
              class: "primary",
              onclick: async () => {
                close();
                const id = await addNow();
                if (!id) return;
                away(then);
                slip(`Added ${word}`, "Undo", () => void store.append([store.factory.make<NoteDeleted>("note_deleted", { note_id: id })]).then(refresh));
              },
            },
            `Add ${word}`,
          ),
      h("button", { type: "button", class: "secondary", onclick: () => close() }, "Keep editing"),
      h("p", { class: "sheet-pencil" }, "back again throws it away"),
    );
  };

  /** Leaving an edited card saves it; a slip offers to put it back as it was. */
  const saveAndLeave = async (then?: () => void) => {
    if (!note) return away(then);
    if (whyNot() === "repeat") {
      arm();
      const close = sheetOr(
        () => away(then),
        "Not saved",
        "This card is already in your words",
        h("button", { type: "button", class: "secondary", onclick: () => close() }, "Keep editing"),
        h("button", { type: "button", class: "link", onclick: () => (close(), away(then)) }, "Leave it as it was"),
      );
      return;
    }
    const now = store.col.liveNote(note.id);
    if (!now) return away(then);
    const d = draft();
    const wait = d.picture === undefined ? pending : undefined;
    const events = saveEvents(store.factory, now, wears, d);
    busy = true;
    try {
      if (events.length) await store.append(events);
    } finally {
      busy = false;
    }
    if (d.picture !== undefined || wait) pictures.cancel(note.id);
    if (wait) void pictures.adopt(note.id, wait, was?.picture?.key);
    away(then);
    if (events.length && was)
      slip(`Saved ${clean(front.value) || note.fields.front}`, "Undo", () => {
        const cur = store.col.liveNote(note.id);
        if (!cur) return;
        const undo = undoEvents(store.factory, cur, store.col.labelsOf(note.id).map((l) => l.id), was, wears);
        if (undo.length) void store.append(undo).then(refresh);
      });
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
      guardLeaving(tabGuard); // the tabs ask this card again; its hold on the gesture stayed under the other one's
      window.scrollTo(0, scroll);
      update();
      checkDup();
      renderStickers();
      renderPic();
      renderAdded();
    };
    keepHoldsNext();
    open(n, { leave: putBack }); // its back gesture goes through its own leave, which ends here
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
  const foldHint = h("p", { class: "ed-fold-hint", hidden: true }, "the other side, tap to turn it up");
  cream.append(foldHint);
  subPage("words", editing ? "Edit card" : "Add a card", () => leave(), root, hint, editing ? null : addedList,
    editing ? null : h("p", { class: "small center" }, h("button", { class: "link", type: "button", onclick: () => go.import() }, "Import from anything")),
  );

  // The bar stays at the top: Add on a new card, the bin on a saved one.
  const bar = app.root.querySelector<HTMLElement>("header.top")!;
  bar.classList.add("ed-bar");
  if (editing) {
    const bin = h("button", { type: "button", class: "icon ed-bin", "aria-label": "Delete card", onclick: deleteIt });
    bin.innerHTML = ICON_BIN;
    bar.append(bin);
  } else bar.append(h("button", { type: "button", class: "primary ed-add", onclick: addIt }, "Add"));
  const tabGuard = (to: () => void) => {
    if (!editing && !typedAnything()) return false;
    leave(to);
    return true;
  };
  guardLeaving(tabGuard);
  if (editing) arm();
  else root.addEventListener("input", arm);
  foldWhenTight(root, [white, cream], [front, back], bar, foldHint);
  // Folded, a tap on the small picture closes the keyboard: the card lies whole, the picture full size.
  pic.addEventListener("click", (e) => {
    if (!root.classList.contains("folded") || (e.target as Element).closest("button, input, textarea")) return;
    (document.activeElement as HTMLElement | null)?.blur();
    window.visualViewport?.addEventListener("resize", () => requestAnimationFrame(() => pic.scrollIntoView({ block: "center", behavior: "smooth" })), { once: true });
  });

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
  // A card without a picture (an imported word, say) draws one as soon as it is opened.
  if (note && !note.picture && !note.noPicture) {
    if (pictures.state(note.id)) void pictures.ensure(note.id); // the queue has it: needed now
    else {
      // Its own drawer, so typing here can't make it stale; it becomes the card's however the card is left.
      draw(true, pictures.sketcher());
      if (pending) void pictures.adopt(note.id, pending);
    }
  }
}
