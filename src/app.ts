// App shell shared by the screens (src/screens/): the open store and sync,
// which screen is showing, page chrome, keyboard handling and navigation.
import { launchAway } from "./ui/launch";
import type { EntityId } from "./domain/ids";
import type { Filler } from "./fill";
import type { Pictures } from "./pictures";
import type { Speech } from "./speech";
import type { Summaries } from "./summaries";
import type { Hold } from "./router";
import type { Store } from "./store";
import type { Sync } from "./sync";
import { append, clear, h } from "./ui/h";

export type Tab = "home" | "words" | "settings";
/** "study" covers the full-screen study flow (no tab bar). */
export type ScreenName = Tab | "study";

export interface Screens {
  home(): void | Promise<void>;
  /** A pile: a studied language's ("es"; default: the last one studied) or a sticker's ("label:7"). */
  study(pile?: string): void | Promise<void>;
  /** The Words tab: every word, or the language open there (languages.ts `openLanguage`). */
  words(): void;
  /** Add a word to the last language used (languages.ts `lastLanguage`). */
  add(): void;
  import(): void;
  edit(noteId: EntityId): void;
  addLanguage(): void;
  settings(): void;
}

/** Navigation. Filled in by main.ts, so screens never import each other. */
export const go = {} as Screens;

let holdBack: Hold = () => () => {};
/** Holds of the screen showing, released when another one renders. */
const held = new Set<() => void>();
/**
 * Hold the phone's back gesture while something is open on the screen (a
 * sheet, Select, Edit): back runs `onBack` instead of leaving (src/router.ts).
 * Returns release, for when it is closed by other means.
 */
export const hold: Hold = (onBack) => {
  const release = holdBack(() => {
    held.delete(release);
    onBack();
  });
  held.add(release);
  return () => {
    held.delete(release);
    release();
  };
};
export function setHold(h: Hold): void {
  holdBack = h;
}

let backOne: () => void = () => {};
/** Leave this screen for the one under it in history: Edit opened in study goes back to study, from Words to Words. */
export function back(): void {
  backOne();
}
export function setBack(f: () => void): void {
  backOne = f;
}

export const app = {
  root: document.getElementById("app")!,
  /** Set once at boot, before any screen renders. */
  store: undefined as unknown as Store,
  sync: undefined as unknown as Sync,
  pictures: undefined as unknown as Pictures,
  filler: undefined as unknown as Filler,
  speech: undefined as unknown as Speech,
  summaries: undefined as unknown as Summaries,
  /** What is on screen, so sync knows when it may re-render or reload. */
  current: "home" as ScreenName,
  /** The model needs a full replay; reload at the next safe moment (home). */
  reloadPending: false,
  /** The pile just finished in study: its spot on the table draws its check. */
  cleared: null as string | null,
  /** The pile just dealt more or gathered again from the table: its cards land on its spot. */
  refilled: null as string | null,
  /** A pile tapped on the table, where it lay and a copy of it: study lifts the copy away, then drops its own pile in. */
  opening: null as { pile: string; rect: DOMRect; copy: HTMLElement } | null,
};

/** Reload now if nothing is in progress on screen, else on the next visit home. */
export function reloadWhenSafe(): void {
  if (app.current === "home") location.reload();
  else app.reloadPending = true;
}

/** One keyboard handler for the current screen. */
let keyHandler: ((e: KeyboardEvent) => void) | null = null;
export function setKeys(f: ((e: KeyboardEvent) => void) | null): void {
  if (keyHandler) document.removeEventListener("keydown", keyHandler);
  keyHandler = f;
  if (f) document.addEventListener("keydown", f);
}

const ICONS = {
  home: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="3" width="13" height="17" rx="1.5" transform="rotate(8 12 12)" opacity=".45"/><rect x="5" y="4" width="13" height="17" rx="1.5"/></svg>',
  words: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M5 7h14M5 12h14M5 17h9"/></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M10.3 2h3.4l.5 2.6 1.6.7 2.2-1.5 2.4 2.4-1.5 2.2.7 1.6 2.6.5v3.4l-2.6.5-.7 1.6 1.5 2.2-2.4 2.4-2.2-1.5-1.6.7-.5 2.6h-3.4l-.5-2.6-1.6-.7-2.2 1.5-2.4-2.4 1.5-2.2-.7-1.6L2 13.7v-3.4l2.6-.5.7-1.6-1.5-2.2 2.4-2.4 2.2 1.5 1.6-.7zM12 8.5a3.5 3.5 0 100 7 3.5 3.5 0 000-7z"/></svg>',
};

/** The tab bar: paper tabs, the current one lifted. */
function nav(active: Tab) {
  const item = (s: Tab, label: string) => {
    const icon = h("span", { class: "nav-icon", "aria-hidden": "true" });
    icon.innerHTML = ICONS[s];
    return h("button", { class: `nav-item${active === s ? " active" : ""}`, onclick: () => go[s](), "aria-label": label }, icon, h("span", {}, label));
  };
  return h("nav", { class: "nav" }, item("home", "Study"), item("words", "Words"), item("settings", "Settings"));
}

type Body = (Node | string | null | false)[];

/** A tab screen: title, content and the tab bar. */
export function page(active: Tab, title: string | Node, ...body: Body): void {
  show(active, h("header", { class: "top" }, typeof title === "string" ? h("h1", {}, title) : title), body);
}

/** A screen reached from a tab (add, edit, import): a back button instead of a title row of its own. */
export function subPage(active: Tab, title: string, back: () => void, ...body: Body): void {
  const b = h("button", { class: "icon back", onclick: back, "aria-label": "Back" });
  b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>';
  show(active, h("header", { class: "top sub" }, b, h("h1", {}, title)), body);
}

function releaseHolds(): void {
  for (const r of [...held].reverse()) r();
  held.clear();
}

function show(active: Tab, header: Node, body: Body): void {
  releaseHolds();
  if (active !== "home") launchAway(); // the table and the welcome card send it off themselves
  app.current = active;
  setKeys(null);
  clear(app.root);
  append(app.root, [header, h("section", { class: "content" }, ...body), nav(active)]);
}

/** A full-screen view without the tab bar (study and its summary). */
export function fullScreen(...children: Node[]): void {
  releaseHolds();
  launchAway();
  app.current = "study";
  setKeys(null);
  clear(app.root);
  append(app.root, children);
}

/**
 * Keeps a bottom sheet above the on-screen keyboard and within what shows.
 * iOS (and Android Chrome by default) doesn't shrink the page for the
 * keyboard, it covers it: a sheet fixed to the page's bottom lies under it.
 * The visual viewport is what shows. Returns the stop.
 */
function aboveKeyboard(el: HTMLElement): () => void {
  const vv = window.visualViewport;
  if (!vv) return () => {};
  const fit = () => {
    const covered = Math.max(0, window.innerHeight - vv.offsetTop - vv.height);
    el.style.bottom = covered > 1 ? `${covered + 12}px` : "";
    el.style.maxHeight = `${vv.height - 24}px`;
  };
  fit();
  vv.addEventListener("resize", fit);
  vv.addEventListener("scroll", fit);
  return () => {
    vv.removeEventListener("resize", fit);
    vv.removeEventListener("scroll", fit);
  };
}

/**
 * A sheet of paper over the screen, with what can be done next. A tap
 * outside, Escape or the back gesture closes it. Returns close.
 */
export function sheet(label: string, title: string | Node, ...body: Body): () => void {
  const backdrop = h("div", { class: "sheet-backdrop" });
  const el = h("div", { class: "pile-sheet", role: "dialog", "aria-label": label }, h("h2", {}, title), ...body);
  const remove = () => {
    backdrop.remove();
    el.remove();
    unfit();
    document.removeEventListener("keydown", onKey);
  };
  const close = () => {
    remove();
    release();
  };
  const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
  backdrop.addEventListener("click", close);
  document.addEventListener("keydown", onKey);
  app.root.append(backdrop, el);
  const unfit = aboveKeyboard(el);
  const release = hold(remove);
  (el.querySelector("input, button") as HTMLElement | null)?.focus();
  return close;
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Ask the browser not to evict our IndexedDB once there is data worth keeping. */
export async function requestPersistence(): Promise<void> {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch {
    /* not supported */
  }
}
