// App shell shared by the screens (src/screens/): the open store and sync,
// which screen is showing, page chrome, keyboard handling and navigation.
import type { EntityId } from "./domain/ids";
import type { Pictures } from "./pictures";
import type { Store } from "./store";
import type { Sync } from "./sync";
import { append, clear, h } from "./ui/h";

export type Tab = "home" | "words" | "settings";
/** "study" covers every full-screen flow without the tab bar (study, sorting). */
export type ScreenName = Tab | "study";

export interface Screens {
  home(): void | Promise<void>;
  study(deckId?: EntityId): void | Promise<void>;
  sortWords(deckId: EntityId): void;
  /** The Words tab, for the current language (decks.ts `currentDeck`). */
  words(): void;
  add(): void;
  import(): void;
  edit(noteId: EntityId): void;
  addLanguage(): void;
  settings(): void;
}

/** Navigation. Filled in by main.ts, so screens never import each other. */
export const go = {} as Screens;

export const app = {
  root: document.getElementById("app")!,
  /** Set once at boot, before any screen renders. */
  store: undefined as unknown as Store,
  sync: undefined as unknown as Sync,
  pictures: undefined as unknown as Pictures,
  /** What is on screen, so sync knows when it may re-render or reload. */
  current: "home" as ScreenName,
  /** The model needs a full replay; reload at the next safe moment (home). */
  reloadPending: false,
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

function nav(active: Tab) {
  const item = (s: Tab, label: string, icon: string) =>
    h("button", { class: `nav-item${active === s ? " active" : ""}`, onclick: () => go[s](), "aria-label": label }, h("span", { class: "nav-icon", "aria-hidden": "true" }, icon), h("span", {}, label));
  return h("nav", { class: "nav" }, item("home", "Study", "◎"), item("words", "Words", "≡"), item("settings", "Settings", "⚙"));
}

type Body = (Node | string | null | false)[];

/** A tab screen: title (text, or a node such as the language picker), content and the tab bar. */
export function page(active: Tab, title: string | Node, ...body: Body): void {
  show(active, h("header", { class: "top" }, typeof title === "string" ? h("h1", {}, title) : title), body);
}

/** A screen reached from a tab (add, edit, import): a back button instead of a title row of its own. */
export function subPage(active: Tab, title: string, back: () => void, ...body: Body): void {
  show(active, h("header", { class: "top sub" }, h("button", { class: "icon back", onclick: back, "aria-label": "Back" }, "‹"), h("h1", {}, title)), body);
}

function show(active: Tab, header: Node, body: Body): void {
  app.current = active;
  setKeys(null);
  clear(app.root);
  append(app.root, [header, h("section", { class: "content" }, ...body), nav(active)]);
}

/** A full-screen view without the tab bar (study, sorting, their summaries). */
export function fullScreen(...children: Node[]): void {
  app.current = "study";
  setKeys(null);
  clear(app.root);
  append(app.root, children);
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
