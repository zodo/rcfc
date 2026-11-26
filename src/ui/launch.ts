// The launch screen: the pile of cards from the iOS splash screen, laid in the
// same place by index.html before any of the app's code runs (src/ui/launch.json,
// scripts/build-icons.ts), so the splash gives way to it unseen. While the app
// opens, it lies still; after 0.6 s someone idly shuffles it; a long model
// update writes a pencil note with a line that grows. Then it leaves:
//   - onto the table (launchToTable): the pile flies into the first pile's spot,
//     its RCFC card turning over into that pile's top card while the pile's
//     other cards land under it, then the other piles are dealt one by one;
//   - into the welcome card (launchToWelcome): the RCFC card lifts and turns
//     over, its back is the welcome card; the cards under it slide off;
//   - anywhere else (launchAway): a short fade.
// Nothing waits for it: it leaves as soon as the screen is ready, and the
// screen under it can be tapped meanwhile. Moving things change only
// transform-like properties and opacity.
// `?splash`: the splash picture laid over the pile at half opacity, to check on
// a phone that they match; a tap anywhere lets the app go on.
import G from "./launch.json";
import { haptic } from "./paper";

const SHUFFLE_AFTER = 600;
const FLY_MS = 520;
const EASE = "cubic-bezier(0.35, 0.1, 0.25, 1)";

let el: HTMLElement | null = null;
let gone = false;
let held = false;
let pendingExit: (() => void) | null = null;
let shuffleTimer = 0;
let order: HTMLElement[] = [];

const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const unit = () => parseFloat(el!.style.getPropertyValue("--u")) || 1;
const pose = (slot: number) => {
  const [, dx, dy, deg] = G.under[slot] as [string, number, number, number];
  const u = unit();
  return { translate: `${dx * u}px ${dy * u}px`, rotate: `${deg}deg` };
};

/** Takes over the pile index.html laid out. */
export function startLaunch(): void {
  el = document.getElementById("launch");
  if (!el) return;
  order = [...el.querySelectorAll<HTMLElement>(".launch-card:not(.launch-top)")];
  order.forEach((c, i) => (c.style.zIndex = String(i)));
  if (new URLSearchParams(location.search).has("splash")) overlaySplash(el);
  if (!reduced()) shuffleTimer = window.setTimeout(shuffle, Math.max(0, SHUFFLE_AFTER - performance.now()));
}

/** Whether the launch screen still covers the app. */
export function launching(): boolean {
  return !!el && !gone;
}

/** Every 1.5 s a card from the middle slides out, lifts, and is tucked back under the pile. */
function shuffle(side = 1): void {
  if (!launching()) return;
  el!.classList.add("launch-shuffling"); // the cards' slide between slots; never at the first paint
  const card = order[2];
  const from = pose(2), to = pose(0), u = unit();
  const out = { translate: `${side * 280 * u}px ${-26 * u}px`, rotate: `${side * 9}deg` };
  card.animate([from, { ...out, offset: 0.48 }, { ...out, offset: 0.52 }, to], { duration: 1050, easing: "cubic-bezier(0.45, 0, 0.35, 1)" });
  window.setTimeout(() => {
    if (!launching()) return;
    // under the pile now: the others move up a slot
    order = [card, ...order.filter((c) => c !== card)];
    order.forEach((c, i) => {
      c.style.zIndex = String(i);
      Object.assign(c.style, pose(i));
    });
  }, 520);
  shuffleTimer = window.setTimeout(() => shuffle(-side), 1500);
}

let note: HTMLElement | null = null;
let line: SVGPathElement | null = null;

/** A long model update: the pencil writes on the top card, and draws a line as it goes. */
export function launchProgress(done: number, total: number): void {
  if (!launching()) return;
  if (!note) {
    const front = el!.querySelector(".launch-front")!;
    note = document.createElement("div");
    note.className = "launch-note";
    const words = document.createElement("span");
    note.append(words);
    note.insertAdjacentHTML("beforeend", '<svg viewBox="0 0 150 10" preserveAspectRatio="none" aria-hidden="true"><path pathLength="1" d="M2 6 C 30 3, 50 8, 75 5 S 120 3, 148 6"/></svg>');
    line = note.querySelector("path");
    front.append(note);
    const text = "Getting to know your words";
    [...text].forEach((ch, i) => window.setTimeout(() => (words.textContent += ch), i * 45));
  }
  line!.style.strokeDashoffset = String(1 - Math.min(1, done / Math.max(1, total)));
}

/** Leave for any screen but the table and the welcome card. */
export function launchAway(): void {
  exit(() => fadeOut(200));
}

/** The table is drawn (under the launch screen): deal the pile onto it. */
export function launchToTable(root: HTMLElement): void {
  exit(() => (reduced() ? fadeOut(220) : deal(root)));
}

/** The welcome card is drawn: the RCFC card turns over into it. */
export function launchToWelcome(root: HTMLElement, card: HTMLElement): void {
  exit(() => (reduced() ? fadeOut(220) : welcome(root, card)));
}

function exit(f: () => void): void {
  if (!launching()) return;
  if (held) {
    pendingExit = f;
    return;
  }
  gone = true;
  clearTimeout(shuffleTimer);
  note?.remove();
  // cards caught mid-shuffle stop where they are
  for (const c of order) for (const a of c.getAnimations()) {
    try {
      a.commitStyles();
    } catch {
      /* not rendered */
    }
    a.cancel();
  }
  f();
}

function fadeOut(ms: number): void {
  const l = el!;
  l.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ms, fill: "forwards" }).onfinish = () => l.remove();
}

/** The table's own things come up with the deal: names, outlines, the tab bar. */
function showScreen(root: HTMLElement): void {
  const fade = (e: Element, delay = 0, pseudoElement?: string) =>
    e.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 280, delay, fill: "backwards", ...(pseudoElement ? { pseudoElement } : {}) });
  root.querySelectorAll("header.top, .pile-name, .pile-count, .content > :not(.table, .welcome-card)").forEach((e) => fade(e));
  root.querySelectorAll(".spot").forEach((s) => (s.querySelector(".pile-stack") ? fade(s, 0, "::before") : fade(s)));
  const nav = root.querySelector(".nav");
  nav?.animate([{ translate: "0 100%" }, { translate: "0 0" }], { duration: 380, delay: 160, easing: "cubic-bezier(0.2, 0.8, 0.3, 1)", fill: "backwards" });
}

/** A card dropped onto its spot (style.css .spot.dealt): from a little above, a touch big, fading in. */
function land(c: Element, delay: number): Animation {
  return c.animate([{ opacity: 0, translate: "0 -46px", scale: 1.1 }, { opacity: 1, offset: 0.7 }, { opacity: 1, translate: "0 0", scale: 1 }], {
    duration: 300,
    delay,
    easing: "cubic-bezier(0.25, 0.8, 0.35, 1)",
    fill: "backwards",
  });
}

/** Moves the pile onto `target` (a card-sized box): FLIP from where it lies, with a little lift on the way. */
function fly(target: DOMRect, lift: number, ms: number): { animation: Animation; scale: number } {
  const pile = el!.querySelector<HTMLElement>(".launch-pile")!;
  const b = pile.getBoundingClientRect();
  const s = target.width / b.width;
  const dx = target.left + target.width / 2 - (b.left + b.width / 2);
  const dy = target.top + target.height / 2 - (b.top + b.height / 2);
  const animation = pile.animate(
    [
      { transform: "none" },
      { transform: `translate(${dx * 0.45}px, ${dy * 0.45 - 18}px) scale(${(1 - (1 - s) * 0.4) * lift})`, offset: 0.45 },
      { transform: `translate(${dx}px, ${dy}px) scale(${s})` },
    ],
    { duration: ms, easing: EASE, fill: "forwards" },
  );
  return { animation, scale: s };
}

/**
 * The back of the RCFC card: a copy of what it turns into, at its own size,
 * scaled to the big card. Copied again when a picture in it loads (pictures
 * come a moment after the table is drawn); returns the stop to that.
 */
function backFace(of: HTMLElement, scale: number): () => void {
  const r = of.getBoundingClientRect();
  const holder = document.createElement("div");
  holder.className = "launch-back";
  const copy = () => {
    const c = of.cloneNode(true) as HTMLElement;
    c.removeAttribute("id");
    const from = of.querySelectorAll("select"), to = c.querySelectorAll("select");
    from.forEach((s, i) => (to[i].value = s.value));
    c.style.cssText += `;position:absolute;left:0;top:0;width:${r.width}px;height:${r.height}px;margin:0;opacity:1;transform-origin:0 0;scale:${1 / scale}`;
    holder.replaceChildren(c);
  };
  copy();
  el!.querySelector(".launch-flip")!.append(holder);
  of.addEventListener("load", copy, true); // load doesn't bubble, but is seen on the way down
  return () => of.removeEventListener("load", copy, true);
}

function turnOver(delay: number, ms: number): void {
  el!.querySelector(".launch-flip")!.animate([{ transform: "rotateY(0deg)" }, { transform: "rotateY(180deg)" }], { duration: ms, delay, easing: "cubic-bezier(0.4, 0, 0.3, 1)", fill: "forwards" });
}

function deal(root: HTMLElement): void {
  const l = el!;
  const stacks = [...root.querySelectorAll<HTMLElement>(".spot .pile-stack")];
  showScreen(root);
  l.style.background = "none";
  const first = stacks[0];
  if (!first) {
    // nothing to deal (every pile finished today): the pile settles into the table
    l.animate([{ opacity: 1 }, { opacity: 0, scale: 0.94 }], { duration: 300, easing: EASE, fill: "forwards" }).onfinish = () => l.remove();
    return;
  }
  const top = first.querySelector<HTMLElement>(".pile-top")!;
  const target = first.getBoundingClientRect();
  const { animation, scale } = fly(target, 1, FLY_MS);
  const stopCopying = backFace(top, scale);
  turnOver(110, 340);
  l.querySelector(".launch-top")!.animate([{}, { translate: "0 0", rotate: "-0.6deg" }], { duration: FLY_MS, easing: EASE, fill: "forwards" });
  for (const c of order) c.animate([{ opacity: 1 }, { opacity: 1, offset: 0.5 }, { opacity: 0 }], { duration: FLY_MS, fill: "forwards" });
  // the rest of the first pile lands on its spot, bottom card first; the flying card lands on top
  top.style.opacity = "0";
  const below = [...first.children].filter((c) => c !== top);
  const step = Math.min(60, 420 / (below.length + 1));
  below.forEach((c, i) => land(c, 40 + i * step));
  animation.onfinish = () => {
    stopCopying();
    top.style.opacity = "";
    l.remove();
    haptic("tap");
  };
  // then the other piles, one after another, each a beat after the one before has landed
  stacks.slice(1).forEach((stack, n) => {
    const cards = [...stack.children];
    const at = 620 + n * 280, st = Math.min(60, 420 / cards.length);
    cards.forEach((c, i) => land(c, at + i * st));
    window.setTimeout(() => haptic("thud"), at + cards.length * st + 180);
  });
}

function welcome(root: HTMLElement, card: HTMLElement): void {
  const l = el!;
  showScreen(root);
  l.style.background = "none";
  const { animation, scale } = fly(card.getBoundingClientRect(), 1.08, 640);
  const stopCopying = backFace(card, scale);
  turnOver(60, 520);
  l.querySelector(".launch-top")!.animate([{}, { translate: "0 0", rotate: "0deg" }], { duration: 640, easing: EASE, fill: "forwards" });
  // the cards under it slide off the table, the bottom one first
  order.forEach((c, i) => {
    const side = i % 2 ? 1 : -1;
    c.animate([{}, { translate: `${side * 60}px ${innerHeight}px`, rotate: `${side * 16}deg` }], { duration: 560, delay: 40 + i * 70, easing: "cubic-bezier(0.55, 0, 0.7, 0.4)", fill: "forwards" });
  });
  card.style.opacity = "0";
  animation.onfinish = () => {
    stopCopying();
    card.style.opacity = "";
    l.remove();
    haptic("tap");
  };
}

/** `?splash`: the splash picture for this screen over the pile at half opacity; a tap lets the app go on. */
function overlaySplash(l: HTMLElement): void {
  held = true;
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  const dpr = devicePixelRatio, standalone = (navigator as { standalone?: boolean }).standalone;
  const w = standalone ? screen.width : innerWidth, h = standalone ? screen.height : innerHeight;
  const img = document.createElement("img");
  img.src = `/splash/${Math.round(w * dpr)}x${Math.round(h * dpr)}-${dark ? "dark" : "light"}.jpg`;
  img.alt = "";
  img.style.cssText = `position:absolute;left:0;top:${standalone ? innerHeight - screen.height : 0}px;width:${w}px;height:${h}px;opacity:0.5;z-index:50`;
  l.append(img);
  l.style.pointerEvents = "auto";
  l.addEventListener(
    "click",
    () => {
      held = false;
      img.remove();
      l.style.pointerEvents = "";
      if (pendingExit) exit(pendingExit);
    },
    { once: true },
  );
}
