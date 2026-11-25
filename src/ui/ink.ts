// Writing on a card in pencil. While the card waits for something to be
// filled in, a short worn pencil doodles little curls on the line of the first
// place being filled in, like someone thinking; when the answer comes the curls
// rub away and the same pencil writes each place in turn, letter by letter, its
// tip moving along the line, travelling from one place to the next (across the
// card's sides), then lifts off. The input holds the whole text at once
// (everything reads it); only a layer over it shows the letters arriving.
// Per frame only the pencil's translate, the letters' opacity/transform and the
// doodle's stroke change.

export const PENCIL = `<svg viewBox="0 0 36 12" aria-hidden="true">
<path d="M0.5 6.3 11 1.5v9z" fill="#ecc99a"/>
<path d="M0.5 6.3 3.6 5.2v2.4z" fill="#4a4f4a"/>
<rect x="11" y="1.3" width="16" height="9.4" fill="#7c9a77"/>
<rect x="11" y="1.3" width="16" height="3" fill="#97b292"/>
<path d="M27 1.1h3v9.8h-3z" fill="#b7b2a6"/>
<path d="M30 1.4h2.6q2 0 2.2 2.2l-.2 4.6q-.4 2.4-2 2.4H30z" fill="#c98a7c"/>
<path d="M14 3.2l2 1.4M19 7.5l2.4.8M23.5 3.6l1.4 1.8" stroke="#5e7a59" stroke-width="0.7"/>
</svg>`;
const SVG_NS = "http://www.w3.org/2000/svg";

/** Time to travel from where the pencil is to where it writes next. */
const TRAVEL_MS = 220;
const LETTER_MS = { min: 16, max: 55 };
/** A whole text is written within this, however long. */
const WRITE_MS = 950;
/** One round of curls, then a pause, then they are rubbed away and it starts again. */
const DOODLE_MS = 2000;
const DOODLE_REST_MS = 450;

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const settled = (a: Animation) =>
  a.finished.then(
    () => true,
    () => false,
  );

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

function letters(text: string): string[] {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map((s) => s.segment);
  return Array.from(text);
}

/** Four little curls along a line, starting at (x, y). */
function curls(x: number, y: number): string {
  let d = `M${x} ${y}`;
  for (let i = 0; i < 4; i++) {
    const cx = x + i * 9;
    d += ` C${cx + 8} ${y - 2}, ${cx + 9} ${y - 13}, ${cx + 5} ${y - 12} S${cx + 3} ${y - 2}, ${cx + 9} ${y}`;
  }
  return d;
}

interface Pen {
  el: HTMLElement;
  hand: HTMLElement;
  x: number;
  y: number;
  move?: Animation;
}

interface Writing {
  input: HTMLInputElement;
  layer: HTMLElement;
  anims: Animation[];
  over: boolean;
  end: () => void;
  after?: () => void;
}

export class Ink {
  private pen: Pen | undefined;
  private writings = new Map<HTMLInputElement, Writing>();
  private queue: Writing[] = [];
  private current: Writing | undefined;
  private waiting: HTMLInputElement | null = null;
  private doodling: { stop: () => void } | undefined;

  /**
   * `desk`: the positioned element holding every side of the card (the one pencil moves over it).
   * `sideOf`: the positioned piece of paper a place lies on (its letters are drawn on it).
   */
  constructor(
    private desk: () => HTMLElement,
    private sideOf: (input: HTMLInputElement) => HTMLElement,
  ) {}

  /** The pencil doodles on this empty place while it waits; null: nothing is awaited. */
  waitAt(input: HTMLInputElement | null): void {
    if (input === this.waiting) return;
    this.waiting?.removeAttribute("aria-busy");
    this.waiting = input;
    input?.setAttribute("aria-busy", "true");
    this.idle();
  }

  /**
   * Write text into a place: the input holds it at once, the letters show as
   * the pencil passes. Places queued write one after another. `after` runs
   * once the text shows (written, or finished early).
   */
  write(input: HTMLInputElement, text: string, after?: () => void): void {
    this.finish(input);
    input.value = text;
    if (!text || !input.isConnected || reducedMotion()) return after?.();
    const side = this.sideOf(input);
    const layer = document.createElement("div");
    layer.className = "ink-layer";
    layer.setAttribute("aria-hidden", "true");
    const cs = getComputedStyle(input);
    Object.assign(layer.style, {
      fontFamily: cs.fontFamily,
      fontSize: cs.fontSize,
      fontStyle: cs.fontStyle,
      fontWeight: cs.fontWeight,
      color: cs.color,
      letterSpacing: cs.letterSpacing,
      padding: cs.padding,
      justifyContent: cs.textAlign === "center" ? "center" : cs.textAlign === "right" || cs.textAlign === "end" ? "flex-end" : "flex-start",
    });
    for (const l of letters(text)) {
      const s = document.createElement("span");
      s.textContent = l;
      layer.append(s);
    }
    side.append(layer);
    this.place(layer, input, side);
    input.classList.add("inked");
    // Typed into (or pasted into) while being written: it is the user's text now, shown at once.
    input.addEventListener("input", () => this.finish(input), { once: true });
    let end = () => {};
    const w: Writing = { input, layer, anims: [], over: false, end: () => end(), after };
    const done = new Promise<void>((r) => (end = r));
    this.writings.set(input, w);
    this.queue.push(w);
    void done.then(() => this.cleanup(w));
    if (!this.current) void this.next();
  }

  /** Every place written in at once (the user reached for the card). */
  finishAll(): void {
    for (const w of this.writings.values()) w.over = true;
    for (const input of [...this.writings.keys()]) this.finish(input);
  }

  /** Nothing written, nothing awaited: the pencil leaves the card. */
  clear(): void {
    this.finishAll();
    this.waitAt(null);
  }

  isWriting(input: HTMLInputElement): boolean {
    return this.writings.has(input);
  }

  /** The pencil is on the card: writing, or waiting on a place. */
  busy(): boolean {
    return this.writings.size > 0 || this.waiting !== null;
  }

  private finish(input: HTMLInputElement): void {
    const w = this.writings.get(input);
    if (!w) return;
    w.over = true;
    for (const a of w.anims) a.cancel();
    w.end();
  }

  private cleanup(w: Writing): void {
    if (this.writings.get(w.input) !== w) return;
    this.writings.delete(w.input);
    this.queue = this.queue.filter((q) => q !== w);
    w.layer.remove();
    w.input.classList.remove("inked");
    w.after?.();
    if (this.current === w) this.current = undefined;
    if (!this.current) {
      if (this.queue.length) void this.next();
      else this.idle();
    }
  }

  /** Not writing: doodle on the place awaited, else lift off the card. */
  private idle(): void {
    if (this.current || this.queue.length) return; // writing; it comes back here after
    this.stopDoodle();
    const input = this.waiting;
    if (!input || !input.isConnected) return this.lift();
    const at = offsetIn(input, this.desk());
    const start = { x: at.x + 10, y: at.y + input.offsetHeight - 3 };
    const pen = this.getPen(start);
    pen.hand.className = "ink-hand";
    this.moveTo(start, TRAVEL_MS);
    if (!reducedMotion()) this.doodle(start);
  }

  /** Curls on the line, round after round, until stopped. */
  private doodle(start: { x: number; y: number }): void {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "ink-doodle");
    svg.setAttribute("aria-hidden", "true");
    this.desk().append(svg);
    let stopped = false;
    let running: Animation[] = [];
    const stop = () => {
      if (stopped) return;
      stopped = true;
      const pen = this.pen;
      if (pen) {
        // Wherever the tip got to is where it goes on from.
        const [x, y] = getComputedStyle(pen.el).translate.split(" ").map(parseFloat);
        if (Number.isFinite(x) && Number.isFinite(y)) {
          pen.x = x;
          pen.y = y;
          pen.el.style.translate = `${x}px ${y}px`;
        }
      }
      for (const a of running) a.cancel();
      void settled(svg.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300, fill: "forwards" })).then(() => svg.remove());
    };
    this.doodling = { stop };
    void (async () => {
      await sleep(TRAVEL_MS);
      while (!stopped && this.pen) {
        const pen = this.pen;
        const path = document.createElementNS(SVG_NS, "path");
        path.setAttribute("d", curls(start.x, start.y));
        svg.replaceChildren(path);
        const len = path.getTotalLength();
        path.style.strokeDasharray = `${len}px`;
        path.style.strokeDashoffset = `${len}px`;
        const frames: Keyframe[] = [];
        for (let i = 0; i <= 40; i++) {
          const p = path.getPointAtLength((i / 40) * len);
          frames.push({ translate: `${p.x}px ${p.y}px` });
        }
        const draw = path.animate([{ strokeDashoffset: `${len}px` }, { strokeDashoffset: "0px" }], { duration: DOODLE_MS, easing: "linear", fill: "forwards" });
        const move = pen.el.animate(frames, { duration: DOODLE_MS, easing: "linear", fill: "forwards" });
        running = [draw, move];
        if (!(await settled(move)) || stopped) return;
        const end = path.getPointAtLength(len);
        pen.x = end.x;
        pen.y = end.y;
        pen.el.style.translate = `${end.x}px ${end.y}px`;
        move.cancel();
        await sleep(DOODLE_REST_MS);
        if (stopped) return;
        // Rubbed away, and back to the start of the line for another round.
        const rub = path.animate([{ opacity: 0.75 }, { opacity: 0 }], { duration: 300, fill: "forwards" });
        running = [rub];
        this.moveTo(start, 300);
        if (!(await settled(rub)) || stopped) return;
      }
    })();
  }

  private stopDoodle(): void {
    this.doodling?.stop();
    this.doodling = undefined;
  }

  private async next(): Promise<void> {
    const w = this.queue.shift();
    if (!w) return;
    this.current = w;
    if (w.over || !w.input.isConnected) return w.end();
    this.stopDoodle();
    const side = this.sideOf(w.input);
    this.place(w.layer, w.input, side); // the card may have moved since it was queued
    const spans = [...w.layer.children] as HTMLElement[];
    const box = offsetIn(w.layer, this.desk());
    const right = box.x + w.layer.clientWidth - 4;
    const y = box.y + w.layer.offsetHeight * 0.74;
    const tips = spans.map((s) => ({ x: Math.min(box.x + s.offsetLeft + s.offsetWidth, right), y }));
    const start = { x: Math.min(box.x + (spans[0]?.offsetLeft ?? 0), right), y };
    const per = Math.max(LETTER_MS.min, Math.min(LETTER_MS.max, WRITE_MS / Math.max(1, spans.length)));
    const total = TRAVEL_MS + per * spans.length;

    const pen = this.getPen(start);
    pen.hand.className = "ink-hand writing";
    // The tip goes to the first letter, then along the line, a letter at a time.
    const frames: Keyframe[] = [{ translate: `${pen.x}px ${pen.y}px`, offset: 0 }, { translate: `${start.x}px ${start.y}px`, offset: TRAVEL_MS / total }];
    tips.forEach((t, i) => frames.push({ translate: `${t.x}px ${t.y + (i % 2 ? -1 : 0.5)}px`, offset: (TRAVEL_MS + per * (i + 1)) / total }));
    pen.move?.cancel();
    pen.move = pen.el.animate(frames, { duration: total, easing: "linear" });
    const last = tips.at(-1) ?? start;
    pen.x = last.x;
    pen.y = last.y;
    pen.el.style.translate = `${pen.x}px ${pen.y}px`;
    w.anims.push(pen.move);
    spans.forEach((s, i) =>
      w.anims.push(
        s.animate([{ opacity: 0, transform: "translateY(2px) scale(0.85)" }, { opacity: 1, transform: "none" }], {
          duration: 160,
          delay: TRAVEL_MS + per * i,
          easing: "ease-out",
          fill: "both",
        }),
      ),
    );
    await settled(pen.move);
    pen.hand.className = "ink-hand";
    if (!w.over) {
      // Let the last letter settle before the input shows the text.
      await sleep(140);
      w.end();
    }
  }

  private place(layer: HTMLElement, input: HTMLInputElement, side: HTMLElement): void {
    const at = offsetIn(input, side);
    Object.assign(layer.style, { left: `${at.x}px`, top: `${at.y}px`, width: `${input.offsetWidth}px`, height: `${input.offsetHeight}px` });
  }

  /** The pencil; one that isn't there yet comes down onto the paper at `at`. */
  private getPen(at: { x: number; y: number }): Pen {
    if (this.pen?.el.isConnected) return this.pen;
    const el = document.createElement("div");
    el.className = "ink-pen";
    el.setAttribute("aria-hidden", "true");
    const hand = document.createElement("div");
    hand.className = "ink-hand";
    hand.innerHTML = PENCIL;
    el.append(hand);
    el.style.translate = `${at.x}px ${at.y}px`;
    this.desk().append(el);
    const pen: Pen = { el, hand, x: at.x, y: at.y };
    this.pen = pen;
    if (!reducedMotion())
      el.animate([{ opacity: 0, translate: `${at.x + 14}px ${at.y - 18}px` }, { opacity: 1, translate: `${at.x}px ${at.y}px` }], { duration: 200, easing: "ease-out" });
    return pen;
  }

  private moveTo(at: { x: number; y: number }, ms: number): void {
    const pen = this.pen;
    if (!pen || (pen.x === at.x && pen.y === at.y)) return;
    pen.move?.cancel();
    if (!reducedMotion()) pen.move = pen.el.animate([{ translate: `${pen.x}px ${pen.y}px` }, { translate: `${at.x}px ${at.y}px` }], { duration: ms, easing: "ease-in-out" });
    pen.x = at.x;
    pen.y = at.y;
    pen.el.style.translate = `${at.x}px ${at.y}px`;
  }

  /** The pencil lifts off the paper and is gone. */
  private lift(): void {
    const pen = this.pen;
    if (!pen) return;
    this.pen = undefined;
    pen.move?.cancel();
    if (reducedMotion() || !pen.el.isConnected) return pen.el.remove();
    const a = pen.el.animate([{ opacity: 1, translate: `${pen.x}px ${pen.y}px` }, { opacity: 0, translate: `${pen.x + 16}px ${pen.y - 22}px` }], { duration: 220, easing: "ease-in", fill: "forwards" });
    void settled(a).then(() => pen.el.remove());
  }
}
