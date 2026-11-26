// A word's notes (src/summaries.ts) as tiny print on the card's answer side,
// whichever side that is (on the question side they would give the answer
// away). A tap on it (card turned) zooms the camera in until it reads, then
// shows the same text at reading size on the card's paper, scrollable; back,
// or a tap on the paper away from the text, zooms out again. A word on the
// page switches the notes between the studied and the known language.
//
// The tiny print is the zoomed page itself, laid out at reading width and
// scaled down by K, so zooming by 1/K lands exactly on the page and the swap
// to real text is invisible. It is faint, and inks in while zooming; the rest
// of the page, below what the tiny print shows, fades in with it, so the
// whole page is there when the zoom ends.
import { app, hold } from "../app";
import type { Note } from "../domain/collection";
import type { Summary } from "../domain/summary";
import { h, toast } from "./h";

/** The page's text width at reading size: the zoomed view's column. */
const pageWidth = () => Math.min(window.innerWidth, 560) - 48;
/** Where the page starts in the zoomed view, under the back button. */
const PAGE_TOP = 72;
/** How small the tiny print is, and how much of the page's top it shows (px at reading size). */
const K = 0.16;
const SHOWN = 300;
/** How faint the tiny print is until zoomed into. */
const FAINT = 0.42;
const ZOOM = { duration: 280, easing: "cubic-bezier(.2,.7,.3,1)" };
const ZOOM_OUT = { duration: 300, easing: "cubic-bezier(.25,.6,.3,1)" };

/** A word's notes laid out at reading size. */
function page(note: Note, s: Summary, lang: string): HTMLElement {
  const el = h(
    "div",
    { class: "sum-page", lang },
    h("div", { class: "sum-head" }, h("span", { class: "sum-word", lang: note.lang_pair.from }, note.fields.front), " ", h("span", { class: "sum-gist" }, s.gist)),
    s.forms.length ? h("div", { class: "sum-sec sum-rows" }, ...s.forms.flatMap(([a, b]) => [h("span", { class: "sum-label" }, a), h("span", { lang: note.lang_pair.from }, b)])) : null,
    ...s.notes.map((n) => h("div", { class: "sum-sec" }, h("div", { class: "sum-title" }, n.title), ...n.lines.map((l) => h("p", {}, l)))),
  );
  el.style.width = `${pageWidth()}px`;
  return el;
}

/** What a tiny print shows, for zooming into it. */
const shown = new WeakMap<HTMLElement, { note: Note; summary: Summary; lang: string }>();

/** Put the notes on the tiny print, scaled down. */
function print(fine: HTMLElement, note: Note, summary: Summary, lang: string): void {
  const inner = page(note, summary, lang);
  inner.style.transform = `scale(${K})`;
  fine.firstElementChild!.replaceChildren(inner);
  fine.classList.remove("empty");
  shown.set(fine, { note, summary, lang });
}

/**
 * A word's notes as tiny print, for a card's answer side. Its room is kept
 * from the start (nothing moves when they arrive); it stays blank and can't be
 * tapped while there are none.
 */
export function finePrint(note: Note): HTMLElement {
  const w = pageWidth();
  const clip = h("div", { class: "fine-clip" });
  clip.style.width = `${Math.ceil(w * K) + 1}px`; // never narrower than the page: a full line keeps its last letter
  clip.style.height = `${(SHOWN * K).toFixed(1)}px`;
  clip.style.opacity = String(FAINT);
  const fine = h("div", { class: "fine empty", "aria-label": "Word notes" }, clip);
  const lang = app.summaries.langFor(note);
  void app.summaries.get(note, lang).then((s) => {
    if (!s) return;
    print(fine, note, s, lang);
    if (fine.isConnected) clip.animate([{ opacity: 0 }, { opacity: FAINT }], { duration: 400 }); // came while the card was out
  });
  return fine;
}

/** The language's own name for itself: "español", "English". */
function ownName(code: string): string {
  try {
    return new Intl.DisplayNames([code], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

let open = false;
/** While the page is open, the card underneath takes no keys. */
export const zoomed = () => open;

const ICON_BACK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>';

/** Whether a tap at (x, y) is on the text of `el` itself (a letter's line box), not the paper around it. */
function onText(el: Element, x: number, y: number): boolean {
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    if (!n.textContent?.trim()) continue;
    range.selectNodeContents(n);
    for (const r of range.getClientRects()) if (x >= r.left - 4 && x <= r.right + 4 && y >= r.top - 2 && y <= r.bottom + 2) return true;
  }
  return false;
}

/**
 * Zoom into `fine` until it reads, then show the page. `cardTilt` is the
 * card's rotation in degrees (the camera turns with it, so the page comes out
 * straight).
 *
 * What zooms is a copy of the card (pose, pencil notes and all) laid over
 * it; the study screen itself never moves. Scaling the screen 1/K times made Chrome on
 * Android rasterize its many layers (pile, shadows, buttons) at that scale:
 * past the GPU's tile memory, with missing tiles and flashes on the way back.
 */
export function zoomInto(fine: HTMLElement, cardTilt: number): void {
  const what = shown.get(fine);
  const card = fine.closest<HTMLElement>(".flashcard");
  const side = fine.closest<HTMLElement>(".side");
  const pile = card?.offsetParent;
  if (open || !what || !card || !side || !pile) return;
  open = true;
  // The copy: the card with its own transforms, in a box where the pile is.
  const pb = pile.getBoundingClientRect();
  const mid = { x: pb.left + pb.width / 2, y: pb.top + pb.height / 2 };
  const copy = card.cloneNode(true) as HTMLElement;
  const copyFine = [...copy.querySelectorAll<HTMLElement>(".fine")][[...card.querySelectorAll(".fine")].indexOf(fine)];
  const stand = h("div", { class: "sum-stand", "aria-hidden": "true" }, copy);
  Object.assign(stand.style, { left: `${pb.left}px`, top: `${pb.top}px`, width: `${pb.width}px`, height: `${pb.height}px` });
  const clip = copyFine.querySelector<HTMLElement>(".fine-clip")!;
  // The rest of the page, on the copy: lying exactly over the tiny print, shown only below the part it
  // shows clearly (the masks add up), fading in while the camera comes down.
  const rest = h("div", { class: "fine-rest" });
  rest.style.setProperty("--shown", `${SHOWN}px`);
  const restPage = (n: Note, sm: Summary, l: string) => {
    const p = page(n, sm, l);
    p.style.transform = `scale(${K})`;
    rest.replaceChildren(p);
  };
  restPage(what.note, what.summary, what.lang);
  copyFine.append(rest);
  const S = 1 / K;
  const r = fine.querySelector(".fine-clip")!.getBoundingClientRect();
  const c = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  // The tiny print's centre lands where the page's top shows in the view.
  const t = { x: window.innerWidth / 2, y: PAGE_TOP + (SHOWN * K) / K / 2 };
  // Around the box's own transform origin: its centre.
  const cx = c.x - mid.x, cy = c.y - mid.y;
  const step = (dx: number, dy: number, a: number, s: number) => `translate(${dx}px,${dy}px) translate(${cx}px,${cy}px) rotate(${a}deg) scale(${s}) translate(${-cx}px,${-cy}px)`;
  document.documentElement.classList.add("sum-zoom"); // the zoomed copy must not make the page scroll
  const atRest = step(0, 0, 0, 1);
  const zoomedIn = step(t.x - c.x, t.y - c.y, -cardTilt, S);
  document.body.append(stand);
  Object.assign(rest.style, { top: `${clip.offsetTop}px`, left: `${clip.offsetLeft}px` }); // laid out now
  const anim = stand.animate([{ transform: atRest }, { transform: zoomedIn }], { ...ZOOM, fill: "forwards" });
  const ink = clip.animate([{ opacity: FAINT }, { opacity: 1 }], { ...ZOOM, fill: "forwards" });
  const more = rest.animate([{ opacity: 0 }, { opacity: 1 }], { ...ZOOM, fill: "forwards" });

  const scroller = h("div", { class: "sum-scroll" });
  const view = h("div", { class: "sum-view", role: "dialog", "aria-label": "Word notes" }, scroller);
  const backBtn = h("button", { class: "icon sum-back", "aria-label": "Back" });
  backBtn.innerHTML = ICON_BACK;
  let pg = page(what.note, what.summary, what.lang);
  const sheet = h("div", { class: "sum-sheet" }, pg);
  sheet.style.backgroundSize = `${192 * S}px`; // the grain as big as on the zoomed card
  sheet.style.backgroundColor = getComputedStyle(side).backgroundColor; // its paper, white or cream
  scroller.append(sheet);
  view.append(backBtn);
  // The other language: the notes written in it, from now on for this studied language.
  const { from, to } = what.note.lang_pair;
  if (from !== to) {
    const other = () => (what.lang === from ? to : from);
    const langBtn = h("button", { class: "sum-lang" }, ownName(other()));
    langBtn.addEventListener("click", async () => {
      if (langBtn.disabled) return;
      const want = other();
      langBtn.disabled = true;
      langBtn.textContent = "…";
      const s = await app.summaries.get(what.note, want);
      langBtn.disabled = false;
      if (!s) {
        langBtn.textContent = ownName(want);
        toast("Can't get them now");
        return;
      }
      app.summaries.setLang(what.note, want);
      print(fine, what.note, s, want); // the card's tiny print too, and the copy's, for zooming out onto it
      print(copyFine, what.note, s, want);
      restPage(what.note, s, want);
      Object.assign(what, { summary: s, lang: want });
      const fresh = page(what.note, s, want);
      pg.replaceWith(fresh);
      pg = fresh;
      scroller.scrollTop = 0;
      fresh.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: "ease-out" }); // all of it at once
      langBtn.textContent = ownName(other());
    });
    view.append(langBtn);
  }

  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    document.removeEventListener("keydown", onKey);
    const done = () => {
      document.documentElement.classList.remove("sum-zoom");
      stand.remove();
      open = false;
    };
    if (anim.playState === "running") {
      // Closed while still zooming in: back the way it came.
      view.remove();
      anim.reverse();
      ink.reverse();
      more.reverse();
      anim.onfinish = () => (anim.cancel(), ink.cancel(), more.cancel(), done());
      return;
    }
    // Unscrolled, the page lies exactly on the zoomed card: swap back at once. Scrolled, fade it.
    if (scroller.scrollTop > 4) view.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, fill: "forwards" }).onfinish = () => view.remove();
    else view.remove();
    // Its own curve, not the zoom-in played backwards (that starts slow and stops hard):
    // off at once, settling softly onto the table. The copy stayed under the page, drawn.
    const back = stand.animate([{ transform: zoomedIn }, { transform: step(0, 0, 0, 1) }], ZOOM_OUT);
    clip.animate([{ opacity: 1 }, { opacity: FAINT }], ZOOM_OUT);
    rest.animate([{ opacity: 1 }, { opacity: 0 }], { ...ZOOM_OUT, fill: "forwards" });
    anim.cancel();
    ink.cancel();
    more.cancel();
    back.onfinish = done;
  };
  const leave = () => {
    release();
    close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" || e.key === "Backspace") {
      e.preventDefault();
      leave();
    }
  };
  const release = hold(close);
  backBtn.addEventListener("click", leave);
  // A tap on the paper, away from the text, puts the card down again (a scroll is no click).
  sheet.addEventListener("click", (e) => {
    if (!onText(e.target as Element, e.clientX, e.clientY)) leave();
  });
  anim.onfinish = () => {
    if (closing) return;
    // No fade: the page lies exactly where the zoomed tiny print and the rest were, so the swap doesn't show.
    document.body.append(view);
    for (const b of view.querySelectorAll("button")) b.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 240, delay: 60, fill: "backwards" });
    document.addEventListener("keydown", onKey);
  };
}
