// The picture's place while it draws: the pencil writes down what the picture
// will show, the meaning first and then the scene as the server streams it in,
// at a steady handwriting pace. Written out, it rests, strikes the scene
// through (a quick, untidy line through each line; the meaning stays) and,
// thinking better of it, writes the scene once more right after it, again and
// again, until the picture comes; a full box is rubbed out down to the meaning
// and the next go starts under it. Waiting for the
// scene after the meaning, it doodles curls. Then the
// picture is brought in from past the top of the screen and laid down over
// the note (`bringIn`); the note under it goes once it lies flat.
//
// Too small a place for words (the card editor's cream side folded small above
// the keyboard): the pencil draws three dots in it instead, rubs them out with
// its eraser and draws them again, as on a place a fill is awaited for; given
// room again, it writes on.
//
// One pencil on a card: given `yieldTo`, the note pauses while that other
// pencil (the card editor's fills) is busy, with no pencil of its own, and
// goes on where it stopped.
//
// Per frame only the pencil's translate, the letters' opacity and the doodle's
// and strikes' strokes change; the glued picture moves by transform only.
import type { SceneText } from "../pictures";
import { dot, PENCIL } from "./ink";

const SVG_NS = "http://www.w3.org/2000/svg";
/** Narrower than this, the place shows dots, not words. */
const SMALL_PX = 160;
/** Steady handwriting: ~2.5 s for a two-line scene. */
const LETTER_MS = 26;
/** The meaning is written a little slower than the scene: it's the heading. */
const SENSE_LETTER_MS = 70;
/**
 * The picture is brought in from past the top of the screen and laid down, as
 * a camera over the card would see it: close to the lens it is bigger and its
 * shadow falls far off and soft; it slows over its place, hovers, and comes
 * down, the shadow sliding under it and sharpening. Transform and opacity
 * only: a soft and a sharp shadow cross-fade.
 */
async function bringIn(layer: HTMLElement, pic: HTMLElement, box: DOMRect): Promise<void> {
  // A sheet casts a sheet's shadow; a picture melted into the card (study) only its own drawn ones.
  const sheet = pic.classList.contains("cut");
  const shadow = (cls: string) => {
    const el = document.createElement("div");
    if (!sheet) return el;
    el.className = `sk-shadow ${cls}`;
    el.style.transform = getComputedStyle(pic).transform; // the picture's own tilt
    layer.prepend(el);
    return el;
  };
  const far = shadow("far");
  const near = shadow("near");
  layer.classList.add("moving");
  const x = box.width * 0.25;
  const y = -(box.bottom + box.height * 0.4 + 60);
  const ms = 1000;
  const T = 0.45; // share of the time spent travelling
  const done = [
    layer.animate(
      [
        { transform: `translate(${x}px, ${y}px) rotate(12deg) scale(1.4)` },
        { transform: "translate(6px, -14px) rotate(-2deg) scale(1.07)", offset: T, easing: "cubic-bezier(.2,.6,.35,1)" },
        { transform: "translate(2px, -4.7px) rotate(-0.7deg) scale(1.03)", offset: T + (0.8 - T) * 0.55, easing: "ease-in" },
        { transform: "none", offset: 0.8, easing: "ease-out" },
        { transform: "scale(0.994)", offset: 0.88 },
        { transform: "none" },
      ],
      { duration: ms, easing: "cubic-bezier(.45,.05,.55,.95)" },
    ),
    far.animate(
      [
        { translate: "46px 70px", scale: "1.12", opacity: 0.55 },
        { translate: "18px 26px", scale: "1.04", opacity: 0.7, offset: T },
        { translate: "4px 6px", scale: "1", opacity: 0.25, offset: 0.74 },
        { translate: "0 0", scale: "1", opacity: 0, offset: 0.8 },
        { translate: "0 0", scale: "1", opacity: 0 },
      ],
      { duration: ms, fill: "forwards" },
    ),
    near.animate([{ opacity: 0 }, { opacity: 0, offset: T + 0.1 }, { opacity: 1, offset: 0.8 }, { opacity: 1 }], { duration: ms, fill: "forwards" }),
  ];
  await Promise.all(done.map((a) => a.finished.catch(() => {})));
  layer.classList.remove("moving");
  far.remove();
  near.remove();
}

/** Before the scene has come, the pencil rests this long after the meaning before it doodles (the scene is usually on its way). */
const SCENE_GRACE_MS = 450;
/** Written out, the pencil rests this long before striking it through. */
const STRIKE_REST_MS = 600;
/** Striking through: ms per px of line, and the move from one line to the next. */
const STRIKE_MS_PER_PX = 1.5;
const STRIKE_MOVE_MS = 120;
/** One run of three curls. */
const CURLS_MS = 1140;
const LINE = 23;

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

function letters(text: string): string[] {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map((s) => s.segment);
  return Array.from(text);
}

/** An element's layout position inside an ancestor (transforms such as a card's tilt don't count). */
function offsetIn(el: HTMLElement, ancestor: HTMLElement): { x: number; y: number } {
  let x = 0, y = 0;
  let e: HTMLElement | null = el;
  while (e && e !== ancestor) {
    x += e.offsetLeft;
    y += e.offsetTop;
    e = e.offsetParent as HTMLElement | null;
  }
  return { x, y };
}

interface Strike {
  p: SVGPathElement;
  len: number;
  start: number;
  dur: number;
}

export class SketchNote {
  readonly el: HTMLElement;
  private note: HTMLElement;
  private senseEl: HTMLElement;
  private sceneEl: HTMLElement;
  private svg: SVGSVGElement;
  private pen: HTMLElement | undefined;
  private hand: HTMLElement | undefined;
  private sense: HTMLElement[] = [];
  private scene: HTMLElement[] = [];
  private written = 0;
  private started = 0;
  /** When the scene's first letters could be written (the sense done, the scene there). */
  private sceneFrom = 0;
  private frame = 0;
  /** When everything that had arrived was written. */
  private caughtUp = 0;
  private doodling: { stopped: boolean; anims: Animation[] } | undefined;
  /** Too small for words: the dots, drawn and rubbed out round after round. */
  private dotting: { stopped: boolean; anims: Animation[] } | undefined;
  /** The lines struck through so far, drawn by the frame clock. */
  private strikes: SVGSVGElement;
  private strike: { from: number; total: number; penFrom: { x: number; y: number }; items: Strike[] } | undefined;
  /** The block holding the meaning and the goes at the scene; the goes still showing. */
  private block: HTMLElement;
  private goes: HTMLElement[] = [];
  /** Letters of the goes after the first. */
  private again: HTMLElement[] = [];
  /** Where the go being written starts in `all()`, and when its letters may come (clock). */
  private blockStart = 0;
  private againFrom = 0;
  private closed = false;
  private hurry = false;

  /** Its own clock: runs only while it has the pencil. */
  private clock = 0;
  private lastFrame = 0;
  /** After the other pencil leaves: not before it has lifted off (real time). */
  private resumeAt = 0;

  constructor(private yieldTo?: () => boolean) {
    this.senseEl = document.createElement("span");
    this.senseEl.className = "sk-sense";
    this.sceneEl = document.createElement("span");
    this.sceneEl.className = "sk-scene";
    this.note = document.createElement("div");
    this.note.className = "sk-note";
    this.block = document.createElement("div");
    this.block.append(this.senseEl, this.sceneEl);
    this.goes.push(this.sceneEl);
    this.note.append(this.block);
    this.svg = document.createElementNS(SVG_NS, "svg");
    this.svg.setAttribute("class", "ink-doodle");
    this.svg.setAttribute("aria-hidden", "true");
    this.strikes = document.createElementNS(SVG_NS, "svg");
    this.strikes.setAttribute("class", "ink-doodle sk-strikes");
    this.strikes.setAttribute("aria-hidden", "true");
    this.el = document.createElement("div");
    this.el.className = "sketch";
    this.el.setAttribute("role", "status");
    this.el.setAttribute("aria-label", "drawing the picture");
    this.el.append(this.note, this.strikes, this.svg);
  }

  /** What the picture will show, so far. Text already written stays; new text is written on. */
  text(t: SceneText): void {
    if (this.closed) return;
    if (t.sense !== undefined && this.sense.length === 0) this.sense = this.fill(this.senseEl, t.sense, 0);
    // Once it's being struck through, the text is what was written (the stream is long done by then).
    const settled = !!this.strike || this.again.length > 0;
    if (!settled && t.scene !== undefined && t.scene !== this.sceneText()) this.scene = this.fill(this.sceneEl, t.scene, this.sense.length);
    if (reducedMotion()) {
      for (const s of this.all()) s.classList.add("on");
      this.written = this.all().length;
      return;
    }
    this.run();
  }

  /**
   * The picture is here: what's left of the note is written at once, the pencil
   * lifts off and the picture is brought in and laid down over the note. Resolves once it lies flat.
   */
  async glue(pic: HTMLElement): Promise<void> {
    if (this.closed) return;
    this.hurry = true;
    this.stopDoodle();
    this.stopDots();
    this.strike = undefined;
    for (const s of this.all()) s.classList.add("on");
    this.written = this.all().length;
    this.closed = true;
    cancelAnimationFrame(this.frame);
    this.lift();
    const layer = document.createElement("div");
    layer.className = "sk-glued";
    layer.append(pic);
    this.el.append(layer);
    if (!reducedMotion()) await bringIn(layer, pic, this.el.getBoundingClientRect());
    // Only now, under the picture lying flat, the note and the outline go.
    this.el.classList.add("glued");
  }

  /** Stop everything (the note is taken off the card). */
  close(): void {
    this.closed = true;
    cancelAnimationFrame(this.frame);
    this.stopDoodle();
    this.stopDots();
    this.pen?.remove();
    this.pen = undefined;
  }

  private sceneText(): string {
    return this.scene.map((s) => s.textContent).join("");
  }

  private all(): HTMLElement[] {
    return [...this.sense, ...this.scene, ...this.again];
  }

  /** Letters for a place; the ones written already (`before` + `written`) show at once. */
  private fill(el: HTMLElement, text: string, before: number): HTMLElement[] {
    const shown = Math.max(0, this.written - before);
    const spans = letters(text).map((l, i) => {
      const s = document.createElement("span");
      s.textContent = l;
      if (i < shown) s.classList.add("on");
      return s;
    });
    el.replaceChildren(...spans);
    return spans;
  }

  private run(): void {
    if (this.frame || this.closed) return;
    const tick = () => {
      this.frame = 0;
      if (this.closed || !this.el.isConnected) return;
      this.step();
      this.frame = requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
  }

  /** One frame: write as far as the pace allows, else doodle. */
  private step(): void {
    const real = performance.now();
    const dt = this.lastFrame ? Math.min(100, real - this.lastFrame) : 0;
    this.lastFrame = real;
    if (this.yieldTo?.()) {
      // The other pencil is on the card: this one waits off it, until that one has lifted off.
      this.stopDoodle();
      if (this.pen) this.lift();
      this.resumeAt = real + 260;
      return;
    }
    if (real < this.resumeAt) return;
    const small = this.el.clientWidth < SMALL_PX;
    this.el.classList.toggle("small", small);
    if (small) {
      this.stopDoodle();
      this.strike = undefined;
      return this.dots();
    }
    this.stopDots();
    const now = (this.clock += dt) + 1;
    this.started ||= now;
    const all = this.all();
    let target = Math.min(this.sense.length, Math.floor((now - this.started) / SENSE_LETTER_MS));
    if (this.againFrom) target = this.blockStart + Math.max(0, Math.floor((now - this.againFrom) / LETTER_MS));
    else if (target >= this.sense.length && this.scene.length) {
      this.sceneFrom ||= now;
      target = this.sense.length + Math.floor((now - this.sceneFrom) / LETTER_MS);
    }
    target = Math.min(target, all.length);
    if (this.written < target) {
      this.caughtUp = 0;
      this.stopDoodle();
      while (this.written < target) all[this.written++].classList.add("on");
      const tip = this.tipOf(all[this.written - 1]);
      const pen = this.getPen(tip);
      pen.style.translate = `${tip.x}px ${tip.y}px`;
      this.hand!.className = "ink-hand writing";
    } else if (this.written >= all.length) {
      // Everything that has arrived is written: doodle after it until there's more.
      this.hand && (this.hand.className = "ink-hand");
      this.caughtUp ||= now;
      if (!this.scene.length) {
        if (now - this.caughtUp < SCENE_GRACE_MS) return;
        const last = all[this.written - 1];
        this.doodle(last ? this.tipOf(last) : { x: 18, y: 30 });
        return;
      }
      if (this.strike) return this.striking(now);
      if (now - this.caughtUp >= STRIKE_REST_MS) this.startStrike(now);
    }
  }

  /** An untidy line through each line of the go just written, one after another. */
  private startStrike(now: number): void {
    this.stopDoodle();
    const lines = new Map<number, { x0: number; x1: number; y: number; h: number }>();
    for (const sp of this.all().slice(Math.max(this.blockStart, this.sense.length), this.written)) {
      if (!sp.textContent?.trim()) continue;
      const at = offsetIn(sp, this.el);
      const key = Math.round(at.y / 6);
      const l = lines.get(key);
      if (l) {
        l.x0 = Math.min(l.x0, at.x);
        l.x1 = Math.max(l.x1, at.x + sp.offsetWidth);
      } else lines.set(key, { x0: at.x, x1: at.x + sp.offsetWidth, y: at.y, h: sp.offsetHeight });
    }
    const items: Strike[] = [];
    let t = STRIKE_MOVE_MS;
    const jitter = (n: number) => (Math.random() * 2 - 1) * n;
    [...lines.values()].forEach((l) => {
      const y = l.y + l.h * 0.58;
      const a = { x: l.x0 - 3 + jitter(2), y: y + jitter(1.5) };
      const b = { x: l.x1 + 3 + jitter(3), y: y + jitter(3) };
      // One wobbly stroke.
      let d = `M${a.x} ${a.y}`;
      const seg = (from: { x: number; y: number }, to: { x: number; y: number }) => {
        const n = Math.max(2, Math.round(Math.abs(to.x - from.x) / 40));
        for (let k = 1; k <= n; k++) {
          const x = from.x + ((to.x - from.x) * k) / n, yy = from.y + ((to.y - from.y) * k) / n;
          d += ` Q${x - (to.x - from.x) / n / 2} ${yy + jitter(2.6)}, ${x} ${yy + jitter(1)}`;
        }
      };
      seg(a, b);
      const p = document.createElementNS(SVG_NS, "path");
      p.setAttribute("d", d);
      this.strikes.append(p);
      const len = p.getTotalLength();
      p.style.strokeDasharray = `${len}px`;
      p.style.strokeDashoffset = `${len}px`;
      const dur = Math.max(160, len * STRIKE_MS_PER_PX);
      items.push({ p, len, start: t, dur });
      t += dur + STRIKE_MOVE_MS;
    });
    const at = this.pen ? this.penAt() : items.length ? this.pointOf(items[0], 0) : { x: 18, y: 30 };
    this.getPen(at);
    this.strike = { from: now, total: t - STRIKE_MOVE_MS, penFrom: at, items };
  }

  /** One frame of striking through; done, the pencil writes it all again. */
  private striking(now: number): void {
    const st = this.strike!;
    const t = now - st.from;
    let prev = st.penFrom, prevEnd = 0, tip: { x: number; y: number } | undefined;
    for (const it of st.items) {
      const k = Math.max(0, Math.min(1, (t - it.start) / it.dur));
      it.p.style.strokeDashoffset = `${it.len * (1 - k)}px`;
      if (!tip && t < it.start) {
        const q = (t - prevEnd) / Math.max(1, it.start - prevEnd);
        const to = this.pointOf(it, 0);
        tip = { x: prev.x + (to.x - prev.x) * q, y: prev.y + (to.y - prev.y) * q };
      } else if (!tip && t < it.start + it.dur) tip = this.pointOf(it, k);
      prev = this.pointOf(it, 1);
      prevEnd = it.start + it.dur;
    }
    const pen = this.getPen(tip ?? prev);
    pen.style.translate = `${(tip ?? prev).x}px ${(tip ?? prev).y}px`;
    if (t >= st.total) {
      this.strike = undefined;
      this.writeAgain(now);
    }
  }

  private pointOf(it: Strike, k: number): { x: number; y: number } {
    const q = it.p.getPointAtLength(it.len * k);
    return { x: q.x, y: q.y };
  }

  private penAt(): { x: number; y: number } {
    const [x, y] = (this.pen?.style.translate ?? "18px 30px").split(" ").map(parseFloat);
    return { x: x || 18, y: y || 30 };
  }

  /** Thinking better of it: the scene again, on from where it stopped; at the bottom of the box, the old goes are rubbed out first, down to the meaning. */
  private writeAgain(now: number): void {
    const go = (lead: string) => {
      const el = document.createElement("span");
      el.className = "sk-scene";
      const spans = this.fill(el, lead + this.sceneText(), Infinity);
      this.block.append(el);
      return { el, spans };
    };
    let next = go(" ");
    const last = next.spans.at(-1);
    let wait = 0;
    if (last && offsetIn(last, this.note).y + last.offsetHeight > this.note.clientHeight) {
      next.el.remove();
      wait = this.hurry ? 150 : 320;
      for (const el of [...this.goes, ...this.strikes.children]) {
        void el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: wait, fill: "forwards" }).finished.then(
          () => (el instanceof HTMLElement ? (el.style.display = "none") : el.remove()),
          () => {},
        );
      }
      this.goes = [];
      next = go("");
    }
    this.goes.push(next.el);
    this.blockStart = this.written;
    this.again.push(...next.spans);
    this.againFrom = now + wait;
    this.caughtUp = 0;
  }

  /** The pencil's tip at the bottom-right of a letter, in the note's coordinates. */
  private tipOf(span: HTMLElement): { x: number; y: number } {
    const at = offsetIn(span, this.el);
    return { x: at.x + span.offsetWidth, y: at.y + span.offsetHeight - 4 };
  }

  private getPen(at: { x: number; y: number }): HTMLElement {
    if (this.pen) return this.pen;
    const pen = document.createElement("div");
    pen.className = "ink-pen sk-pen";
    pen.setAttribute("aria-hidden", "true");
    const hand = document.createElement("div");
    hand.className = "ink-hand";
    hand.innerHTML = PENCIL;
    pen.append(hand);
    pen.style.translate = `${at.x}px ${at.y}px`;
    this.el.append(pen);
    pen.animate([{ opacity: 0, translate: `${at.x + 14}px ${at.y - 18}px` }, { opacity: 1, translate: `${at.x}px ${at.y}px` }], { duration: 200, easing: "ease-out" });
    this.pen = pen;
    this.hand = hand;
    return pen;
  }

  /** Curls after the text, run after run along the line, onto the next line at the edge; a full box is rubbed out. */
  private doodle(from: { x: number; y: number }): void {
    if (this.doodling) return;
    const pen = this.getPen(from);
    const d = (this.doodling = { stopped: false, anims: [] as Animation[] });
    const W = this.el.clientWidth, H = this.el.clientHeight, LEFT = this.note.offsetLeft + 2;
    const go = (frames: Keyframe[], ms: number) => {
      const a = pen.animate(frames, { duration: ms, fill: "forwards" });
      d.anims.push(a);
      return a.finished.then(
        () => {
          pen.style.translate = String(frames.at(-1)!.translate);
          a.cancel();
        },
        () => {},
      );
    };
    void (async () => {
      let x = from.x + 3, y = from.y;
      while (!d.stopped) {
        if (x + 30 > W - 14) {
          if (y + LINE > H - 8) {
            this.rubOut();
            x = from.x + 3;
            y = from.y;
          } else {
            x = LEFT;
            y += LINE;
          }
          await go([{ translate: pen.style.translate }, { translate: `${x}px ${y}px` }], 260);
          continue;
        }
        let path = `M${x} ${y}`, cx = x;
        for (let i = 0; i < 3; i++) {
          const w = 8 + Math.random() * 3, h = 10 + Math.random() * 4;
          path += ` C${cx + w * 0.9} ${y - 2}, ${cx + w} ${y - h}, ${cx + w * 0.55} ${y - h + 1} S${cx + w * 0.3} ${y - 2}, ${cx + w} ${y}`;
          cx += w;
        }
        const p = document.createElementNS(SVG_NS, "path");
        p.setAttribute("d", path);
        this.svg.append(p);
        const len = p.getTotalLength();
        p.style.strokeDasharray = `${len}px`;
        p.style.strokeDashoffset = `${len}px`;
        const frames = Array.from({ length: 31 }, (_, i) => {
          const q = p.getPointAtLength((i / 30) * len);
          return { translate: `${q.x}px ${q.y}px` };
        });
        d.anims.push(p.animate([{ strokeDashoffset: `${len}px` }, { strokeDashoffset: "0px" }], { duration: CURLS_MS, fill: "forwards" }));
        await go(frames, CURLS_MS);
        x = cx;
      }
    })();
  }

  private rubOut(): void {
    for (const p of [...this.svg.children]) void p.animate([{ opacity: 0.75 }, { opacity: 0 }], { duration: this.hurry ? 150 : 300, fill: "forwards" }).finished.then(() => p.remove(), () => {});
  }

  /** Three dots in the middle, a rest, rubbed out with the eraser (a smudge stays a moment), and again. */
  private dots(): void {
    if (this.dotting) return;
    const start = { x: this.el.clientWidth / 2 - 14, y: this.el.clientHeight / 2 + 5 };
    const pen = this.getPen(start);
    const d = (this.dotting = { stopped: false, anims: [] as Animation[] });
    const at = () => {
      const [x, y] = pen.style.translate.split(" ").map(parseFloat);
      return { x: x || start.x, y: y || start.y };
    };
    // The tip along these points over ms, inking `path` as it goes; false once stopped.
    const follow = async (pts: { x: number; y: number }[], ms: number, path?: SVGPathElement) => {
      if (d.stopped) return false;
      const from = at();
      const frames: Keyframe[] = [{ translate: `${from.x}px ${from.y}px`, offset: 0 }];
      pts.forEach((q, i) => frames.push({ translate: `${q.x}px ${q.y}px`, offset: Math.max(0.01, i / Math.max(1, pts.length - 1)) }));
      const move = pen.animate(frames, { duration: ms, easing: "linear", fill: "forwards" });
      d.anims.push(move);
      if (path) {
        const len = path.getTotalLength();
        path.style.strokeDasharray = `${len}px`;
        d.anims.push(path.animate([{ strokeDashoffset: `${len}px` }, { strokeDashoffset: "0px" }], { duration: ms, easing: "linear", fill: "forwards" }));
      }
      const ok = await move.finished.then(() => true, () => false);
      if (!ok || d.stopped) return false;
      const end = pts.at(-1)!;
      pen.style.translate = `${end.x}px ${end.y}px`;
      move.cancel();
      return true;
    };
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    void (async () => {
      while (!d.stopped) {
        this.hand && (this.hand.className = "ink-hand");
        const paths: SVGPathElement[] = [];
        for (let i = 0; i < 3; i++) {
          const pts = dot(start.x + 4 + i * 9, start.y - 5);
          const path = document.createElementNS(SVG_NS, "path");
          path.setAttribute("class", "ink-dot");
          path.setAttribute("d", "M" + pts.map((q) => `${q.x.toFixed(2)} ${q.y.toFixed(2)}`).join(" L"));
          this.svg.append(path);
          paths.push(path);
          if (!(await follow([pts[0]], 90)) || !(await follow(pts, 420, path))) return;
        }
        await wait(520);
        if (d.stopped) return;
        this.hand?.classList.add("erasing");
        const rub = Array.from({ length: 9 }, (_, i) => ({ x: start.x + (i % 2 ? 26 : 1), y: start.y - 5 + (i - 4) * 0.7 }));
        for (const p of paths) d.anims.push(p.animate([{ opacity: 0.85 }, { opacity: 0.1 }], { duration: 560, easing: "ease-in", fill: "forwards" }));
        if (!(await follow(rub, 560))) return;
        this.hand?.classList.remove("erasing");
        for (const p of paths) p.remove();
        await wait(200);
        if (!(await follow([start], 160))) return;
      }
    })();
  }

  private stopDots(): void {
    if (!this.dotting) return;
    this.dotting.stopped = true;
    for (const a of this.dotting.anims) a.cancel();
    this.dotting = undefined;
    this.hand?.classList.remove("erasing");
    for (const p of [...this.svg.querySelectorAll(".ink-dot")]) p.remove();
  }

  private stopDoodle(): void {
    if (!this.doodling) return;
    this.doodling.stopped = true;
    for (const a of this.doodling.anims) a.cancel();
    this.doodling = undefined;
    this.rubOut();
  }

  private lift(): void {
    const pen = this.pen;
    if (!pen) return;
    this.pen = undefined;
    const [x, y] = pen.style.translate.split(" ").map(parseFloat);
    void pen
      .animate([{ opacity: 1, translate: `${x}px ${y}px` }, { opacity: 0, translate: `${x + 16}px ${y - 22}px` }], { duration: 220, easing: "ease-in", fill: "forwards" })
      .finished.then(() => pen.remove(), () => pen.remove());
  }
}
