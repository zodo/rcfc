// A word's notes (src/summaries.ts) as tiny print on the card's answer side,
// whichever side that is (on the question side they would give the answer
// away). A tap on it (card turned) zooms the camera in until it reads, then
// shows the same text at reading size on the card's paper, scrollable; back,
// or a tap on the paper away from the text, zooms out again. A word on the
// page switches the notes between the studied and the known language.
//
// The tiny print is the zoomed page itself, laid out at reading width and
// scaled down by K, so zooming by 1/K lands exactly on the page and the swap
// to real text is invisible. It is faint, and inks in while zooming.
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
  clip.style.width = `${(w * K).toFixed(1)}px`;
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

/** Lines of the page the tiny print showed clearly (px at reading size): already on the paper when zoomed in. */
const SEEN = SHOWN * 0.7;
const LINE_MS = 55;

/**
 * What the tiny print didn't show comes onto the page line by line, top to
 * bottom, as if written out now; what it showed is there at once.
 */
function reveal(pg: HTMLElement, seen = SEEN): void {
  const top = pg.getBoundingClientRect().top;
  const lines = new Map<number, HTMLElement[]>();
  for (const el of pg.querySelectorAll<HTMLElement>(".sum-title, .sum-rows > span, p")) {
    const y = Math.round(el.getBoundingClientRect().top - top);
    if (y < seen) continue;
    lines.set(y, [...(lines.get(y) ?? []), el]); // a row's label and forms come together
  }
  [...lines.keys()].sort((a, b) => a - b).forEach((y, i) => {
    for (const el of lines.get(y)!) el.animate([{ opacity: 0, translate: "0 3px" }, { opacity: 1, translate: "0 0" }], { duration: 200, delay: i * LINE_MS, easing: "ease-out", fill: "backwards" });
  });
}

/**
 * Zoom into `fine` until it reads, then show the page. `screen` is the whole
 * study screen (the camera moves over it), `cardTilt` the card's rotation in
 * degrees (the camera turns with it, so the page comes out straight).
 */
export function zoomInto(fine: HTMLElement, screen: HTMLElement, cardTilt: number): void {
  const what = shown.get(fine);
  if (open || !what) return;
  open = true;
  const clip = fine.querySelector<HTMLElement>(".fine-clip")!;
  const S = 1 / K;
  const r = clip.getBoundingClientRect();
  const c = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  // The tiny print's centre lands where the page's top shows in the view.
  const t = { x: window.innerWidth / 2, y: PAGE_TOP + (SHOWN * K) / K / 2 };
  // Around the screen's own transform origin: its centre.
  const box = screen.getBoundingClientRect();
  const cx = c.x - (box.left + box.width / 2), cy = c.y - (box.top + box.height / 2);
  const step = (dx: number, dy: number, a: number, s: number) => `translate(${dx}px,${dy}px) translate(${cx}px,${cy}px) rotate(${a}deg) scale(${s}) translate(${-cx}px,${-cy}px)`;
  document.documentElement.classList.add("sum-zoom"); // the zoomed screen must not make the page scroll
  const zoomedIn = step(t.x - c.x, t.y - c.y, -cardTilt, S);
  const anim = screen.animate([{ transform: step(0, 0, 0, 1) }, { transform: zoomedIn }], { ...ZOOM, fill: "forwards" });
  const ink = clip.animate([{ opacity: FAINT }, { opacity: 1 }], { ...ZOOM, fill: "forwards" });

  const scroller = h("div", { class: "sum-scroll" });
  const view = h("div", { class: "sum-view", role: "dialog", "aria-label": "Word notes" }, scroller);
  const backBtn = h("button", { class: "icon sum-back", "aria-label": "Back" });
  backBtn.innerHTML = ICON_BACK;
  let pg = page(what.note, what.summary, what.lang);
  const sheet = h("div", { class: "sum-sheet" }, pg);
  sheet.style.backgroundSize = `${192 * S}px`; // the grain as big as on the zoomed card
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
      print(fine, what.note, s, want); // the card's tiny print too, for zooming out onto it
      Object.assign(what, { summary: s, lang: want });
      const fresh = page(what.note, s, want);
      pg.replaceWith(fresh);
      pg = fresh;
      scroller.scrollTop = 0;
      reveal(pg, 0);
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
      open = false;
    };
    if (anim.playState === "running") {
      // Closed while still zooming in: back the way it came.
      view.remove();
      anim.reverse();
      ink.reverse();
      anim.onfinish = () => (anim.cancel(), ink.cancel(), done());
      return;
    }
    // Unscrolled, the page lies exactly on the zoomed card: swap back at once. Scrolled, fade it.
    if (scroller.scrollTop > 4) view.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, fill: "forwards" }).onfinish = () => view.remove();
    else view.remove();
    // Its own curve, not the zoom-in played backwards (that starts slow and stops hard):
    // off at once, settling softly onto the table.
    const back = screen.animate([{ transform: zoomedIn }, { transform: step(0, 0, 0, 1) }], ZOOM_OUT);
    clip.animate([{ opacity: 1 }, { opacity: FAINT }], ZOOM_OUT);
    anim.cancel();
    ink.cancel();
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
    // No fade: the page lies exactly where the zoomed tiny print was, so the swap doesn't show,
    // and the lines below start coming at once.
    document.body.append(view);
    reveal(pg);
    for (const b of view.querySelectorAll("button")) b.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 240, delay: 60, fill: "backwards" });
    document.addEventListener("keydown", onKey);
  };
}
