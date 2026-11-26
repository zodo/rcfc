// Study: one card at a time, on a pile of paper cards. Tap the card, drag it
// sideways (it turns under your finger) or press Show answer to turn it over,
// then throw it: right = Got it, left = Again (it goes back under the pile),
// up = Easy. Buttons and arrow keys do the same. Once turned, a tap (or Space)
// turns it over again, to look at the other side; the answer stays given.
//
// The pile is real: every card has its own spot (a little off, a little
// turned), so taking the top one moves nothing else. Its height is the number
// of cards dealt and left (src/domain/piles.ts); the card under the top one is
// the next card, fixed once shown (StudySession.peek). A finished pile goes
// back to the table (src/screens/home.ts), where its spot shows the check.
import { app, errorText, fullScreen, go, setKeys } from "../app";
import type { Card, Note } from "../domain/collection";
import type { ReviewPayload } from "../domain/events";
import type { EntityId } from "../domain/ids";
import { pileLabel } from "../domain/labels";
import type { Draw } from "../domain/piles";
import { AHEAD } from "../pictures";
import { StudySession } from "../session";
import { Body, type Pose } from "../ui/body";
import { h, ICON_PEN, ICON_SPEAK, toast } from "../ui/h";
import { relight, startTilt, tiltNeedsTap } from "../ui/light";
import { haptic, seeded } from "../ui/paper";
import { cutout, livePicture } from "../ui/picture";
import { finePrint, zoomed, zoomInto } from "../ui/fineprint";
import { EDGE, Turn } from "../ui/turn";
import { languages, lastLanguage, rememberLanguage } from "./languages";

/** Cards drawn under the top one; the pile's shadow stands in for the rest. */
const SHOWN = 6;

type Rating = ReviewPayload["rating"];
/** Where a card goes: -1 Again (left), 1 Got it (right), 2 Easy (up). */
type Dir = -1 | 1 | 2;
const RATING: Record<Dir, Rating> = { [-1]: 1, 1: 3, 2: 4 };

/**
 * Pencil notes on the back of a card teach the throws: each one is gone for
 * good on this device once a card was thrown that way LEARN times.
 */
const LEARN = 3;
const THROWS_KEY = "rcfc:throws";
const NOTE: Record<Dir, { name: string; text: string; side: string }> = {
  [-1]: { name: "again", text: "again", side: "l" },
  1: { name: "good", text: "got it", side: "r" },
  2: { name: "easy", text: "easy", side: "u" },
};
function throws(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(THROWS_KEY) ?? "{}") as Record<string, number>;
  } catch {
    return {};
  }
}
function threw(dir: Dir): void {
  const t = throws();
  t[NOTE[dir].name] = (t[NOTE[dir].name] ?? 0) + 1;
  try {
    localStorage.setItem(THROWS_KEY, JSON.stringify(t));
  } catch {
    /* storage unavailable: the notes just stay */
  }
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

const ICON_CLOSE = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3l10 10M13 3L3 13" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';

/** Study a pile: a sticker's (`label:7`), or a language's ("es"; default: the last one studied). */
export async function study(want?: string): Promise<void> {
  const label = want === undefined ? undefined : pileLabel(want);
  let pile: string;
  if (label !== undefined && app.store.col.labelNotes(label).length) pile = want!;
  else {
    const langs = languages();
    const wanted = label === undefined ? (want ?? lastLanguage()) : lastLanguage();
    const lang = wanted && langs.includes(wanted) ? wanted : langs[0];
    if (!lang) return go.home();
    rememberLanguage(lang);
    pile = lang;
  }
  const s = new StudySession(app.store, pile);
  const from = app.opening?.pile === s.pile ? app.opening : null;
  app.opening = null;
  if (!(await s.startNow())) {
    fullScreen(h("p", { class: "muted center" }, "Preparing…"));
    await s.start();
  }
  const t = new Table(s);
  t.next();
  if (from) t.dropIn(from.rect, from.copy);
}

interface Faces {
  /** The side lying up, and the one underneath (its content stays hidden until turned over). */
  front: HTMLElement;
  back: HTMLElement;
  answer: HTMLElement;
  say: () => void;
  forward: boolean;
}

/**
 * One card per word, like a real one: the studied language on the white side
 * (word, pronunciation, example), the known language and the picture on the
 * cream side. A forward card lies white side up, a reverse card cream side up.
 */
function faces(card: Card, note: Note, picTilt: "l" | "r"): Faces {
  const lang = note.lang_pair;
  const forward = card.template === "forward";
  const say = () => void app.speech.say(note.fields.front, lang.from);
  const speakBtn = (label: string, onclick: () => void, cls = "speak") => {
    if (!app.speech.canSay(lang.from)) return null;
    const b = h("button", { class: cls, "aria-label": label, title: label, onclick });
    b.innerHTML = ICON_SPEAK;
    return b;
  };
  const example = note.fields.example?.trim();
  /** The user's own note on a side, in pencil. */
  const memo = (text: string | undefined, l: string) => (text?.trim() ? h("div", { class: "memo", lang: l }, text.trim()) : null);
  const target = [
    h("div", { class: "face", lang: lang.from }, note.fields.front, speakBtn("Pronounce", say, "speak inline")),
    example ? h("div", { class: "example", lang: lang.from }, example, speakBtn("Say the example", () => void app.speech.say(example, lang.from), "speak small")) : null,
    memo(note.fields.memo_target, lang.from),
  ];
  const known = [note.picture ? cutout(note.picture.key, picTilt) : note.noPicture ? null : livePicture(note.id, picTilt), h("div", { class: "face", lang: lang.to }, note.fields.back), memo(note.fields.memo_known, lang.to)];
  const up = forward ? target : known;
  up.find((e) => e?.classList.contains("face"))!.classList.add("prompt");
  // The word's notes are tiny print on the answer side, whichever side that is (not physical:
  // on the question side they could give the answer away).
  const answer = h("div", { class: "answer hidden" }, ...(forward ? known : target), finePrint(note));
  const side = (geom: "front" | "back", lng: "target" | "known") => `side ${geom} ${lng}`;
  const front = h("div", { class: side("front", forward ? "target" : "known") }, ...up, h("div", { class: "shade" }));
  const back = h("div", { class: side("back", forward ? "known" : "target") }, answer, h("div", { class: "shade" }));
  return { front, back, answer, say, forward };
}

/** The study screen: the pile, the top card and the buttons, kept while cards come and go. */
class Table {
  readonly el: HTMLElement;
  private readonly pile: HTMLElement;
  private readonly pileShadow = h("div", { class: "pile-shadow" });
  private readonly status: HTMLElement;
  private readonly recall: HTMLElement;
  private readonly controls: HTMLElement;
  /** Cards shown so far; card number i lies at pose(i). */
  private n = -1;
  private left = 1;
  private readonly seed = Math.floor(Math.random() * 1e6);
  private peekId: EntityId | null = null;
  /** The pile has been on screen: cards coming into view further down fade in from now on. */
  private shown = false;

  constructor(private s: StudySession) {
    const close = h("button", { class: "icon", "aria-label": "Close", onclick: () => go.home() });
    close.innerHTML = ICON_CLOSE;
    this.status = h("span", { class: "small" });
    this.recall = h("span", { class: "small recall" });
    this.pile = h("div", { class: "pile" }, this.pileShadow);
    this.controls = h("div", { class: "controls" });
    this.el = h("section", { class: "study" }, h("div", { class: "glow", "data-light": "-3" }), h("div", { class: "study-top" }, close, this.status, this.recall), this.pile, this.controls);
    fullScreen(this.el);
    // iPhone asks for motion access, which needs a tap; elsewhere the light can start now.
    if (tiltNeedsTap()) this.el.addEventListener("click", () => startTilt(), { once: true });
    else startTilt();
  }

  next(): void {
    if (!this.el.isConnected) return; // closed while an answer was saving
    const n = this.s.next();
    if (!n) {
      // The pile is finished: back to the table, where its spot shows it.
      if (this.s.answered) app.cleared = this.s.pile;
      void go.home();
      return;
    }
    this.n++;
    this.show(n.pick, n.left);
  }

  /**
   * Opened from the table: the tapped pile is picked up and leaves through
   * the top of the screen (`copy`, a copy of it at `from`, where it lay), then
   * the study pile is brought in and laid down like a picture on the card in
   * the editor. Never one grown into the other: that dropped frames on
   * Android (the study pile is many layers) and showed their faces differ.
   * Nothing waits for it.
   */
  dropIn(from: DOMRect, copy: HTMLElement): void {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const stand = h("div", { class: "pile-lift", "aria-hidden": "true" }, copy);
    Object.assign(stand.style, { left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, height: `${from.height}px` });
    document.body.append(stand);
    stand.animate([{ transform: "none" }, { transform: `translate(0, ${-(from.bottom + 60)}px) rotate(-4deg)` }], { duration: 230, easing: "cubic-bezier(0.5, 0, 0.75, 0)", fill: "forwards" }).onfinish = () => stand.remove();
    // Brought in and laid down along the path the card editor lays a picture on the card (src/ui/sketch.ts
    // bringIn): from past the top right, turning as it slows over its place, hovering, coming down. Only moved
    // and turned: scaled (the picture is, near the lens) or with blurred shadows, the pile's many layers lagged
    // on Android and shimmered when the scaling ended.
    const box = this.pile.getBoundingClientRect();
    const x = box.width * 0.25, y = -(box.bottom + box.height * 0.4 + 60);
    const MS = 820, T = 0.45, DELAY = 30; // it starts far above: on its way while the old pile leaves, the table never stands empty
    this.pile.animate(
      [
        { transform: `translate(${x}px, ${y}px) rotate(12deg)` },
        { transform: "translate(6px, -14px) rotate(-2deg)", offset: T, easing: "cubic-bezier(.2,.6,.35,1)" },
        { transform: "translate(2px, -4.7px) rotate(-0.7deg)", offset: T + (0.8 - T) * 0.55, easing: "ease-in" },
        { transform: "none", offset: 0.8, easing: "ease-out" },
        { transform: "translate(0, 1px)", offset: 0.88 },
        { transform: "none" },
      ],
      { duration: MS, delay: DELAY, easing: "cubic-bezier(.45,.05,.55,.95)", fill: "backwards" },
    );
    // It first touches down at keyframe 0.8, which the overall easing brings forward to 69.5% of the time.
    window.setTimeout(() => haptic("thud"), DELAY + MS * 0.695);
    for (const e of this.el.children) if (e !== this.pile) e.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260, delay: 120, fill: "backwards" });
  }

  /** Each card's own spot in the pile. */
  pose(i: number): Pose {
    const r = seeded(this.seed + i * 7919);
    return { x: (r() - 0.5) * 10, y: (r() - 0.5) * 8, r: (r() - 0.5) * 5 };
  }

  /**
   * The cards under the top one, keyed by their number; `instant` appears
   * without fading in. Each lies with its own side up: white (studied
   * language) or cream (known language), fixed once its edge shows.
   */
  private syncPile(instant?: number): void {
    const want = Math.min(SHOWN, this.left - 1);
    const faces = this.s.faces(want);
    const have = new Map([...this.pile.querySelectorAll<HTMLElement>(".under")].map((el) => [Number(el.dataset.i), el]));
    for (const [i, el] of have) if (i <= this.n || i > this.n + want) el.remove();
    for (let d = 1; d <= want; d++) {
      const i = this.n + d;
      let el = have.get(i);
      if (!el?.isConnected) {
        const p = this.pose(i);
        el = h("div", { class: "under" }, h("div", { class: "sheet" }));
        el.dataset.i = String(i);
        el.style.transform = `translate(${p.x}px,${p.y}px) rotate(${p.r}deg)`;
        this.pile.prepend(el);
        if (i !== instant && this.shown) el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300 }); // a card further down comes into view (not when the pile first appears: it comes whole)
      }
      el.firstElementChild!.classList.toggle("known", faces[d - 1] === "reverse");
      el.style.zIndex = String(10 - d);
      el.dataset.light = (d * 0.25).toFixed(2);
    }
    // The pile's own shadow: deeper while it's thick, lighter as it shrinks.
    const t = Math.min(Math.max(0, this.left - 1), 40) * 0.12;
    this.pileShadow.style.boxShadow = this.left > 1 ? `0 ${(1 + t).toFixed(1)}px ${(2 + t * 2.5).toFixed(1)}px rgb(var(--shadow) / ${(0.14 + t * 0.012).toFixed(3)})` : "none";
    relight(this.el);
    this.shown = true;
  }

  /** The card right under the top one shows the next card's front, so dragging the top away uncovers it. */
  private showPeek(): void {
    const id = this.s.peek();
    const sheet = this.pile.querySelector<HTMLElement>(`.under[data-i="${this.n + 1}"] > .sheet`);
    if (!sheet || id === this.peekId) return;
    this.peekId = id;
    sheet.replaceChildren();
    const card = id === null ? undefined : app.store.col.cards.get(id);
    const note = card && app.store.col.notes.get(card.note_id);
    if (!card || !note) return;
    const f = faces(card, note, "l").front;
    f.classList.add("peek");
    f.querySelector(".face")?.classList.remove("prompt"); // only the top card's prompt is "the prompt"
    sheet.append(f);
  }

  private show(pick: Draw, left: number): void {
    const { store } = app;
    const s = this.s;
    const card = store.col.cards.get(pick.card)!;
    const note = store.col.notes.get(card.note_id)!;
    if (!note.picture) void app.pictures.ensure(note.id); // no picture yet: draw one for next time
    const coming = s.upcoming(AHEAD);
    void app.pictures.ahead(coming); // and for the cards coming up
    void app.speech.ahead([card.id, ...coming]); // their word and example, so they speak at once
    void app.summaries.ahead([card.id, ...coming]); // and their notes
    this.left = left;
    this.status.textContent = pick.kind === "new" ? "New word" : `${left} left`;
    this.recall.textContent = pick.p !== undefined ? `recall ${(pick.p * 100).toFixed(0)}%` : "";
    // The top card was the peeked one in most cases; otherwise it takes that spot anyway.
    this.pile.querySelector(`.under[data-i="${this.n}"]`)?.remove();
    this.peekId = null;

    const f = faces(card, note, this.n % 2 ? "r" : "l");
    const t = throws();
    for (const dir of [-1, 1, 2] as Dir[]) if ((t[NOTE[dir].name] ?? 0) < LEARN) f.back.append(h("div", { class: `note ${NOTE[dir].side}`, "aria-hidden": "true" }, NOTE[dir].text));
    const shRest = h("div", { class: "sh rest", "data-light": "0.6" });
    const shLift = h("div", { class: "sh lift", "data-light": "1.7" });
    const shadow = h("div", { class: "shs" }, shRest, shLift);
    // Each face's bottom edge, shaded with it while it turns.
    const lip = (geom: "front" | "back", side: HTMLElement) => h("div", { class: `lip ${geom}${side.classList.contains("known") ? " known" : ""}` }, h("div", { class: "shade" }));
    const flipper = h("div", { class: "flipper" }, f.front, f.back, lip("front", f.front), lip("back", f.back), h("div", { class: "rim l" }), h("div", { class: "rim r" }));
    const stamps = { good: h("div", { class: "stamp good" }, "got it"), again: h("div", { class: "stamp again" }, "again"), easy: h("div", { class: "stamp easy" }, "easy") };
    const el = h("div", { class: "flashcard" }, shadow, flipper, stamps.good, stamps.again, stamps.easy);
    el.style.zIndex = "20";
    this.pile.append(el);
    const body = new Body(el, this.pile.offsetWidth, this.pile.offsetHeight, shRest, shLift);
    const turn = new Turn(flipper, shadow, [...el.querySelectorAll<HTMLElement>(".shade")], body.w);
    body.home = this.pose(this.n);
    Object.assign(body, body.home);
    body.render();
    this.syncPile();
    this.showPeek();

    // Back from the card editor: still turned over, the editing not counted.
    const spent = s.takeTurned(card.id);
    const shownAt = performance.now() - (spent ?? 0);
    let revealed = false;
    let busy = false;

    // A pencil on the turned card opens it in the card editor; back comes here again.
    const pencil = () => {
      const b = h("button", {
        class: "edit-card",
        "aria-label": "Edit card",
        title: "Edit card",
        onclick: () => {
          if (busy) return;
          s.keepTurned(card.id, performance.now() - shownAt);
          go.edit(note.id);
        },
      });
      b.innerHTML = ICON_PEN;
      return b;
    };
    f.front.append(pencil());
    f.back.append(pencil());

    const reveal = h("button", { class: "secondary wide big", onclick: () => doReveal() }, "Show answer");
    const ratings = h("div", { class: "ratings two" }, h("button", { class: "rate r1", onclick: () => answer(-1) }, "Again"), h("button", { class: "rate r3", onclick: () => answer(1) }, "Got it"));
    this.controls.replaceChildren(reveal);

    /** Where the card is turning to, in degrees: every turn adds half a turn the same way. */
    let angle = 0;
    /** Only the side lying up shows its pencil, and neither while turning: browsers draw a face-down side's pencil through the card. */
    const settled = () => {
      el.classList.remove("turning");
      el.dataset.up = Math.round(angle / 180) % 2 ? "back" : "front";
    };

    /** Turn the card over (towards `side`: 1 = to the right), from wherever a drag left it. */
    const doReveal = (side: 1 | -1 = 1) => {
      if (revealed || busy) return;
      revealed = true;
      haptic("tap");
      el.classList.add("turned");
      f.answer.classList.remove("hidden");
      angle = side * 180;
      el.classList.add("turning");
      turn.to(angle, { done: () => (el.classList.add("noted"), settled()) });
      this.controls.replaceChildren(ratings);
      if (!f.forward) f.say(); // the word side just came up
    };

    /** After the answer was shown: turn the card over again, onwards the same way. */
    const turnAgain = () => {
      if (!revealed || busy) return;
      haptic("tap");
      angle += Math.sign(angle) * 180;
      el.classList.add("turning");
      turn.to(angle, { done: settled });
    };

    // Stamps ink in while dragging; the matching button rises.
    let hot = 0;
    const ink = (x: number, y: number) => {
      if (!revealed) return;
      const up = -y > Math.abs(x);
      const p = up ? 0 : clamp((Math.abs(x) - 18) / 90, 0, 1), pu = up ? clamp((-y - 18) / 100, 0, 1) : 0;
      stamps.good.style.opacity = String(x > 0 ? p : 0);
      stamps.again.style.opacity = String(x < 0 ? p : 0);
      stamps.easy.style.opacity = String(pu);
      stamps.good.style.transform = `rotate(-12deg) scale(${1.25 - 0.25 * (x > 0 ? p : 0)})`;
      stamps.again.style.transform = `rotate(10deg) scale(${1.25 - 0.25 * (x < 0 ? p : 0)})`;
      stamps.easy.style.transform = `rotate(-4deg) scale(${1.25 - 0.25 * pu})`;
      const now = p > 0.5 ? Math.sign(x) : 0;
      if (now !== hot) {
        hot = now;
        ratings.children[0].classList.toggle("hot", hot === -1);
        ratings.children[1].classList.toggle("hot", hot === 1);
      }
    };
    // Where the card goes if let go now: 0 = back to its spot.
    const zone = (): Dir | 0 => {
      if (!revealed) return 0;
      const x = body.x - body.home.x, y = body.y - body.home.y;
      if (-y > Math.abs(x)) return -y > body.h * 0.22 ? 2 : 0;
      return Math.abs(x) > body.w * 0.33 ? (Math.sign(x) as Dir) : 0;
    };
    const settle = () => {
      const { x, y, r } = body.home;
      body.unpivot();
      body.spring({ x, y, r, lift: 0, s: 1 }, { k: 380, c: 22, onFrame: () => ink(body.x - x, body.y - y) });
    };

    const commit = async (dir: Dir, vx: number, vy: number, thrown = false) => {
      busy = true;
      if (thrown) threw(dir);
      setKeys(null);
      el.classList.add("leaving"); // no longer the card being studied, while it moves away
      haptic(dir === -1 ? "double" : "thud");
      ink(dir === 2 ? 0 : dir * 200, dir === 2 ? -400 : 0);
      const duration = Math.min(performance.now() - shownAt, 120_000);
      if (dir === -1) {
        // Back under the pile: out to the side, then tucked beneath, into the bottom spot.
        const bottom = this.n + this.left;
        const t = this.pose(bottom);
        body.spring({ x: -body.w * 0.78, y: body.y + 6, r: body.r - 7, lift: 1, s: 1.02 }, { k: 520, c: 34 });
        el.style.zIndex = "19";
        setTimeout(() => {
          el.style.zIndex = "1"; // under every sheet, over the pile's shadow
          for (const st of Object.values(stamps)) st.animate([{ opacity: st.style.opacity }, { opacity: 0 }], { duration: 250, fill: "forwards" });
          body.unpivot();
          body.spring({ x: t.x, y: t.y, r: t.r, lift: 0, s: 1 }, {
            k: 260,
            c: 26,
            done: () => {
              el.remove();
              if (this.el.isConnected) this.syncPile(bottom);
            },
          });
          setTimeout(() => haptic("tick"), 260); // it lands under the pile
        }, 230);
      } else if (dir === 2) body.fly(clamp(vx, -0.5, 0.5), Math.min(vy, -2.2), (Math.random() - 0.5) * 0.08, body.w * 2.2, () => el.remove(), 0);
      else body.fly(dir * Math.max(Math.abs(vx), 1.5), clamp(vy, -0.6, 0.6), dir * (0.12 + Math.random() * 0.1), body.w * 2.2, () => el.remove());

      try {
        await s.answer(card, RATING[dir], duration);
      } catch (e) {
        toast(`Could not save: ${errorText(e)}`);
        this.show(pick, left); // nothing was saved: the same card again
        return;
      }
      await s.refresh(card);
      this.next();
    };

    const answer = (dir: Dir) => {
      if (!revealed || busy) return;
      body.stop();
      body.unpivot();
      body.px = 0;
      body.py = body.h * 0.3;
      body.spring({ lift: 1, s: 1.025 }, { k: 900, c: 50 });
      void commit(dir, dir === 2 ? 0 : dir * 1.6, dir === 2 ? -2.2 : -0.25);
    };

    // Dragging: the card follows the finger, turning around the point held.
    let down: { x: number; y: number; bx: number; by: number; br: number; moved: boolean; queued: boolean; zone: Dir | 0; turning: boolean; target: Element | null } | null = null;
    let samples: { x: number; y: number; t: number }[] = [];
    const velocity = (e: PointerEvent) => {
      const s0 = samples[0], dt = s0 ? Math.max(1, performance.now() - s0.t) : 1;
      return s0 ? { vx: (e.clientX - s0.x) / dt, vy: (e.clientY - s0.y) / dt } : { vx: 0, vy: 0 };
    };
    el.addEventListener("pointerdown", (e) => {
      if (busy || (e.target as HTMLElement).closest("button")) return;
      body.grab(e.clientX, e.clientY);
      down = { x: e.clientX, y: e.clientY, bx: body.x, by: body.y, br: body.r, moved: false, queued: false, zone: 0, turning: false, target: e.target as Element };
      samples = [{ x: e.clientX, y: e.clientY, t: performance.now() }];
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* synthetic or already released */
      }
      body.spring({ lift: 1, s: 1.025 }, { k: 700, c: 40 });
    });
    el.addEventListener("pointermove", (e) => {
      if (!down) return;
      const now = performance.now();
      samples.push({ x: e.clientX, y: e.clientY, t: now });
      while (samples.length > 2 && now - samples[0].t > 90) samples.shift();
      let dx = e.clientX - down.x, dy = e.clientY - down.y;
      if (Math.hypot(dx, dy) > 6) down.moved = true;
      if (!revealed) {
        // The front turns with a sideways drag, up to its edge: the answer stays hidden until let go.
        turn.drag(dx);
        const turning = Math.abs(turn.a) > 45;
        if (turning !== down.turning) {
          down.turning = turning;
          if (turning) haptic("tick"); // letting go now turns it over
        }
        body.x = down.bx + dx * 0.18;
        body.y = down.by + dy * 0.1;
        if (!body.moving) body.render();
        return;
      }
      const { vx } = velocity(e);
      const gy = clamp(body.py / (body.h / 2), -1, 1);
      body.x = down.bx + dx;
      body.y = down.by + dy * 0.85;
      body.r = down.br + clamp(dx * 0.055 * -gy + vx * 2.2, -24, 24);
      if (down.queued) return;
      down.queued = true;
      requestAnimationFrame(() => {
        if (!down) return;
        down.queued = false;
        if (!body.moving) body.render(); // else the pick-up spring draws it
        ink(body.x - body.home.x, body.y - body.home.y);
        // A detent: a light tick the moment letting go would answer.
        const z = zone();
        if (z !== down.zone) {
          if (z) haptic("tick");
          down.zone = z;
        }
      });
    });
    const end = (e: PointerEvent, cancelled: boolean) => {
      if (!down) return;
      const d = down;
      down = null;
      if (!d.moved && !cancelled) {
        settle();
        // A tap on the tiny print of the side lying up zooms into it.
        const fine = revealed ? d.target?.closest<HTMLElement>(".fine:not(.empty)") : null;
        const up = Math.round(angle / 180) % 2 === 0 ? f.front : f.back;
        if (fine && up.contains(fine)) {
          // Back in its spot at once, so the zoom aims at where the print rests.
          body.stop();
          body.unpivot();
          Object.assign(body, body.home, { lift: 0, s: 1 });
          body.render();
          zoomInto(fine, body.home.r);
        }
        else if (revealed) turnAgain();
        else doReveal();
        return;
      }
      const { vx, vy } = velocity(e);
      if (!revealed) {
        settle();
        const side = Math.sign(turn.a || vx) as 1 | -1;
        if (!cancelled && (Math.abs(turn.a) > 45 || (Math.abs(vx) > 0.6 && Math.sign(vx) === Math.sign(turn.a)))) doReveal(side);
        else turn.to(0, { k: 320, c: 16 }); // back down, with a little wobble
        return;
      }
      const z = zone();
      const dx = body.x - body.home.x, dy = body.y - body.home.y;
      const fastUp = vy < -0.6 && -dy > 30 && -vy > Math.abs(vx);
      const fastSide = Math.abs(vx) > 0.55 && Math.sign(vx) === Math.sign(dx) && Math.abs(dx) > 24 && Math.abs(vx) > -vy;
      if (!cancelled && (z === 2 || (!z && fastUp))) void commit(2, vx, vy, true);
      else if (!cancelled && (z || fastSide)) void commit((z || Math.sign(dx || vx)) as Dir, vx, vy, true);
      else settle();
    };
    el.addEventListener("pointerup", (e) => end(e, false));
    el.addEventListener("pointercancel", (e) => end(e, true));

    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || zoomed()) return;
      if ((e.key === " " || e.key === "Enter") && !(e.target instanceof HTMLButtonElement)) {
        e.preventDefault();
        if (revealed) turnAgain();
        else doReveal();
      } else if (revealed && e.key === "ArrowRight") answer(1);
      else if (revealed && e.key === "ArrowLeft") answer(-1);
      else if (revealed && e.key === "ArrowUp") {
        e.preventDefault();
        answer(2);
      }
    };
    setKeys(onKey);
    if (spent !== undefined) {
      // As it was left: turned over, the notes already read.
      revealed = true;
      el.classList.add("turned", "noted");
      f.answer.classList.remove("hidden");
      angle = 180;
      turn.set(angle);
      settled();
      this.controls.replaceChildren(ratings);
      return;
    }
    if (f.forward) f.say(); // a card lying word side up says its word
  }
}
