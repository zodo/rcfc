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
  const { go, hold, back } = router(screens, h, h);
  return { h, go, hold, back, shown, last: () => shown[shown.length - 1] };
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
    go.study("es");
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

  it("Edit opened in study sits on study, and leaving it goes back there", async () => {
    const { h, go, back, last } = setup();
    go.study("es");
    go.edit(5);
    expect(h.names()).toEqual(["home", "study", "edit"]);
    back();
    await tick();
    expect(last()).toBe("study(es)");
    expect(h.names()).toEqual(["home", "study"]);
  });

  it("leaving Edit opened in Words goes back to Words; after a reload too", async () => {
    const { go, back, last } = setup();
    go.words();
    go.edit(5);
    back();
    await tick();
    expect(last()).toBe("words");
    const h = new FakeHistory();
    h.entries = [{ name: "home", args: [] }, { name: "study", args: ["es"] }, { name: "edit", args: [5] }];
    h.i = 2;
    const again = setup(h);
    again.back();
    await tick();
    expect(again.last()).toBe("study(es)");
  });

  it("leaving a screen with something held open steps over it too", async () => {
    const { h, go, hold, back, last } = setup();
    go.study("es");
    go.edit(5);
    hold(() => {});
    back();
    await tick();
    expect(last()).toBe("study(es)");
    expect(h.names()).toEqual(["home", "study"]);
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

  it("back closes what a screen holds open, innermost first, and stays on the screen", () => {
    const { h, go, hold, shown } = setup();
    go.words();
    const closed: string[] = [];
    hold(() => closed.push("select"));
    hold(() => closed.push("sheet"));
    h.back();
    expect(closed).toEqual(["sheet"]);
    h.back();
    expect(closed).toEqual(["sheet", "select"]);
    expect(shown.at(-1)).toBe("words");
    h.back();
    expect(shown.at(-1)).toBe("home");
  });

  it("closing a hold by other means steps back over its entry without re-rendering", async () => {
    const { h, go, hold, shown } = setup();
    go.words();
    const release = hold(() => {
      throw new Error("not by back");
    });
    release();
    await tick();
    expect(h.names()).toEqual(["home", "words"]);
    expect(shown).toEqual(["home", "words"]);
    h.back();
    expect(shown.at(-1)).toBe("home");
  });

  it("going on from inside a hold drops it first", async () => {
    const { h, go, hold, last } = setup();
    hold(() => {});
    go.add();
    await tick();
    await tick();
    expect(last()).toBe("add");
    expect(h.names()).toEqual(["home", "words", "add"]);
    const release = hold(() => {});
    release();
    go.words();
    await tick();
    await tick();
    expect(last()).toBe("words");
    expect(h.names()).toEqual(["home", "words"]);
  });
});
