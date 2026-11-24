import { describe, expect, it } from "bun:test";
import type { Screens } from "../src/app";
import { router, type HistoryLike, type PopTarget, type Route } from "../src/router";

/** Session history as browsers keep it: push drops forward entries, go() lands later with popstate. */
class FakeHistory implements HistoryLike, PopTarget {
  entries: unknown[] = [null];
  i = 0;
  private listeners: ((e: { state: unknown }) => void)[] = [];
  get state() {
    return this.entries[this.i];
  }
  pushState(s: unknown) {
    this.entries = [...this.entries.slice(0, this.i + 1), structuredClone(s)];
    this.i++;
  }
  replaceState(s: unknown) {
    this.entries[this.i] = structuredClone(s);
  }
  go(d: number) {
    queueMicrotask(() => this.move(d));
  }
  /** The user's back gesture. */
  back() {
    this.move(-1);
  }
  private move(d: number) {
    const to = Math.max(0, Math.min(this.entries.length - 1, this.i + d));
    if (to === this.i) return;
    this.i = to;
    for (const f of this.listeners) f({ state: this.state });
  }
  addEventListener(_: "popstate", f: (e: { state: unknown }) => void) {
    this.listeners.push(f);
  }
  names() {
    return this.entries.slice(0, this.i + 1).map((e) => (e as Route).name);
  }
}

function setup(h = new FakeHistory()) {
  const shown: string[] = [];
  const screen = (name: string) => (...args: unknown[]) => void shown.push(args.length ? `${name}(${args.join(",")})` : name);
  const screens = { home: screen("home"), study: screen("study"), words: screen("words"), add: screen("add"), import: screen("import"), edit: screen("edit"), addLanguage: screen("addLanguage"), settings: screen("settings") } as Screens;
  const go = router(screens, h, h);
  return { h, go, shown, last: () => shown[shown.length - 1] };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("router", () => {
  it("starts at home, at the bottom of history", () => {
    const { h, shown } = setup();
    expect(shown).toEqual(["home"]);
    expect(h.names()).toEqual(["home"]);
  });

  it("back from a tab goes to Study; tabs replace each other instead of piling up", () => {
    const { h, go, last } = setup();
    go.words();
    go.settings();
    go.words();
    expect(h.names()).toEqual(["home", "words"]);
    h.back();
    expect(last()).toBe("home");
  });

  it("back from a sub-page goes to Words, then to Study", () => {
    const { h, go, last } = setup();
    go.words();
    go.edit(42);
    expect(last()).toBe("edit(42)");
    h.back();
    expect(last()).toBe("words");
    h.back();
    expect(last()).toBe("home");
  });

  it("on-screen back buttons move through history, so a later gesture doesn't land on the old screen", async () => {
    const { h, go, last } = setup();
    go.words();
    go.add();
    go.words(); // the Back button
    await tick();
    expect(last()).toBe("words");
    expect(h.names()).toEqual(["home", "words"]);
    go.study(7);
    go.home(); // the study screen's close button
    await tick();
    expect(last()).toBe("home");
    expect(h.names()).toEqual(["home"]);
  });

  it("from a sub-page straight to another tab: up one level, then sideways", async () => {
    const { h, go, last } = setup();
    go.words();
    go.import();
    go.settings();
    await tick();
    expect(last()).toBe("settings");
    expect(h.names()).toEqual(["home", "settings"]);
    h.back();
    expect(last()).toBe("home");
  });

  it("a sub-page opened from Study sits on Words", () => {
    const { h, go } = setup();
    go.add();
    expect(h.names()).toEqual(["home", "words", "add"]);
  });

  it("a reload shows the screen history was on", () => {
    const h = new FakeHistory();
    h.entries = [{ name: "home", args: [] }, { name: "words", args: [] }, { name: "edit", args: [5] }];
    h.i = 2;
    const { shown, last } = setup(h);
    expect(shown).toEqual(["edit(5)"]);
    h.back();
    expect(last()).toBe("words");
  });
});
