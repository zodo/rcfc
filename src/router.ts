// Screens as browser history, so the phone's back gesture (Android back,
// iPhone swipe from the edge) walks back through the app the way the on-screen
// back buttons do. History mirrors a fixed tree instead of growing with every
// tap:
//
//   home (Study tab)                      depth 0: back leaves the app
//   ├─ words, settings, study             depth 1: back goes to Study
//   │  └─ add, edit, addLanguage          depth 2: back goes to Words
//
// Going deeper pushes an entry, sideways (tab to tab) replaces it, going up
// goes back in history (so the gesture and the buttons stay in step), and a
// history move made by the user renders whatever its entry names.
//
// A screen can also hold the back gesture for something open on it (a sheet,
// Select, Edit): `hold` pushes an entry for the same screen, and back then
// closes that thing instead of leaving the screen.
import type { Screens } from "./app";

export type RouteName = keyof Screens;
export interface Route {
  name: RouteName;
  args: unknown[];
}

const DEPTH: Record<RouteName, number> = { home: 0, words: 1, settings: 1, study: 1, add: 2, edit: 2, addLanguage: 2 };

/** The slice of `window.history` and `window` the router uses (tests pass a fake). */
export interface HistoryLike {
  readonly state: unknown;
  pushState(state: unknown, unused: string): void;
  replaceState(state: unknown, unused: string): void;
  go(delta: number): void;
}
export interface PopTarget {
  addEventListener(type: "popstate", f: (e: { state: unknown }) => void): void;
}

function isRoute(s: unknown): s is Route {
  return !!s && typeof s === "object" && typeof (s as Route).name === "string" && (s as Route).name in DEPTH && Array.isArray((s as Route).args);
}

/** Hold the back gesture: `onBack` runs on back instead of leaving the screen. Returns release, for closing it by other means. */
export type Hold = (onBack: () => void) => () => void;

/** One step back, to whatever is under this screen (also after a reload), as the back gesture does. */
export type Back = () => void;

/**
 * Wraps the screens into navigation that keeps history in step. Renders the
 * current entry's screen at start: home, or what a reload left in history.
 */
export function router(screens: Screens, hist: HistoryLike = history, win: PopTarget = window): { go: Screens; hold: Hold; back: Back } {
  let current: Route = { name: "home", args: [] };
  /** Where to land once a history move we started arrives. */
  let pending: Route | null = null;
  /** Open holds, innermost last; each has an entry on top of the screen's. */
  let holds: (() => void)[] = [];
  /** Our own steps back over held entries still to arrive, and where to go after them. */
  let releasing = 0;
  let queued: Route | null = null;
  /** A step back asked for while held entries were being stepped over. */
  let backQueued = false;

  const render = (r: Route) => {
    current = r;
    void (screens[r.name] as (...a: unknown[]) => unknown)(...r.args);
  };

  win.addEventListener("popstate", (e) => {
    if (releasing > 0) {
      if (--releasing === 0 && backQueued) {
        backQueued = false;
        back();
      } else if (releasing === 0 && queued) {
        const to = queued;
        queued = null;
        navigate(to);
      }
      return;
    }
    if (holds.length) {
      holds.pop()!(); // the user's back: close what was open
      return;
    }
    const landed = isRoute(e.state) ? e.state : { name: "home" as const, args: [] };
    const target = pending;
    pending = null;
    if (target && (target.name !== landed.name || JSON.stringify(target.args) !== JSON.stringify(landed.args))) {
      hist.replaceState(target, "");
      render(target);
    } else render(landed);
  });

  const navigate = (to: Route) => {
    if (releasing > 0) {
      queued = to;
      return;
    }
    if (holds.length) {
      // Off the held entries first, then on as usual.
      const n = holds.length;
      holds = [];
      releasing = 1;
      queued = to;
      hist.go(-n);
      return;
    }
    const from = DEPTH[current.name];
    const depth = DEPTH[to.name];
    if (depth > from) {
      // A screen two levels up (e.g. add) sits on its parent (words).
      if (depth - from > 1) hist.pushState({ name: "words", args: [] }, "");
      hist.pushState(to, "");
      render(to);
    } else if (depth === from) {
      hist.replaceState(to, "");
      render(to);
    } else {
      pending = to;
      hist.go(depth - from);
    }
  };

  const go = {} as Screens;
  for (const name of Object.keys(DEPTH) as RouteName[]) {
    (go as unknown as Record<string, (...a: unknown[]) => void>)[name] = (...args: unknown[]) => navigate({ name, args });
  }

  const hold: Hold = (onBack) => {
    hist.pushState({ ...current, held: holds.length + 1 }, "");
    holds.push(onBack);
    return () => {
      const k = holds.indexOf(onBack);
      if (k < 0) return; // already closed by back
      const n = holds.length - k;
      holds = holds.slice(0, k);
      releasing++;
      hist.go(-n);
    };
  };

  // Off the held entries too: what is open on the screen closes with it.
  const back: Back = () => {
    if (releasing > 0) {
      queued = null;
      backQueued = true;
      return;
    }
    const n = holds.length;
    holds = [];
    pending = null;
    hist.go(-(n + 1));
  };

  // Start: the current entry if a reload left one, else home at the bottom.
  if (!isRoute(hist.state)) hist.replaceState({ name: "home", args: [] }, "");
  render(isRoute(hist.state) ? (hist.state as Route) : { name: "home", args: [] });
  return { go, hold, back };
}
