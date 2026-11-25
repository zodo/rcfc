// Writing on a card in pencil. While the card waits for something to be
// filled in, a pencil lies on the empty place and taps it, like someone
// thinking; when the answer comes it writes it in letter by letter, its tip
// moving along the line, then lifts off. The input holds the whole text at
// once (everything reads it); only a layer over it shows the letters arriving.
// Per frame only the pencil's translate and the letters' opacity/transform change.

const PENCIL = `<svg viewBox="0 0 64 12" aria-hidden="true">
<path d="M0 6 13 1v10z" fill="#ecc99a"/>
<path d="M0 6 4.6 4.2v3.6z" fill="#3f443f"/>
<rect x="13" y="1" width="41" height="10" fill="#e2a93a"/>
<rect x="13" y="1" width="41" height="3.3" fill="#efc463"/>
<rect x="13" y="7.7" width="41" height="3.3" fill="#c9922c"/>
<rect x="54" y="0.6" width="4" height="10.8" fill="#b7b2a6"/>
<path d="M58 0.6h4a2 2 0 0 1 2 2v6.8a2 2 0 0 1-2 2h-4z" fill="#d0603f"/>
</svg>`;

/** Time to travel from where the pencil lies to the first letter. */
const TRAVEL_MS = 180;
const LETTER_MS = { min: 16, max: 55 };
/** A whole text is written within this, however long. */
const WRITE_MS = 950;

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

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

interface Pen {
  el: HTMLElement;
  hand: HTMLElement;
  side: HTMLElement;
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
  private pens = new Map<HTMLElement, Pen>();
  private writings = new Map<HTMLInputElement, Writing>();
  private queue: Writing[] = [];
  private current: Writing | undefined;
  private waiting: HTMLInputElement | null = null;

  /** `sideOf`: the positioned piece of paper a place lies on (the pencil and the letters are drawn on it). */
  constructor(private sideOf: (input: HTMLInputElement) => HTMLElement) {}

  /** The pencil waits on this empty place, tapping; null: nothing is awaited. */
  waitAt(input: HTMLInputElement | null): void {
    if (input === this.waiting) return;
    const was = this.waiting;
    this.waiting = input;
    if (was) {
      was.removeAttribute("aria-busy");
      const pen = this.pens.get(this.sideOf(was));
      if (pen && !this.busyOn(pen.side) && (!input || this.sideOf(input) !== pen.side)) this.lift(pen);
    }
    if (!input || !input.isConnected) return;
    input.setAttribute("aria-busy", "true");
    if (this.busyOn(this.sideOf(input))) return; // it is writing there; it waits once done
    const at = this.restingSpot(input);
    const pen = this.pen(this.sideOf(input), at);
    this.moveTo(pen, at, TRAVEL_MS);
    pen.hand.className = "ink-hand tapping";
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
    let end = () => {};
    const w: Writing = { input, layer, anims: [], over: false, end: () => end(), after };
    const done = new Promise<void>((r) => (end = r));
    this.writings.set(input, w);
    this.queue.push(w);
    void done.then(() => this.cleanup(w));
    if (!this.current) void this.next();
  }

  /** Every place written in at once, the pencil gone (the user reached for the card). */
  finishAll(): void {
    for (const w of this.writings.values()) w.over = true;
    for (const input of [...this.writings.keys()]) this.finish(input);
  }

  /** Nothing written, nothing awaited: the pencil leaves the card. */
  clear(): void {
    this.finishAll();
    this.waitAt(null);
    for (const pen of [...this.pens.values()]) this.lift(pen);
  }

  isWriting(input: HTMLInputElement): boolean {
    return this.writings.has(input);
  }

  private finish(input: HTMLInputElement): void {
    const w = this.writings.get(input);
    if (!w) return;
    w.over = true;
    for (const a of w.anims) a.cancel();
    w.end();
  }

  private busyOn(side: HTMLElement): boolean {
    return [...this.writings.values()].some((w) => this.sideOf(w.input) === side);
  }

  private cleanup(w: Writing): void {
    if (this.writings.get(w.input) !== w) return;
    this.writings.delete(w.input);
    this.queue = this.queue.filter((q) => q !== w);
    w.layer.remove();
    w.input.classList.remove("inked");
    w.after?.();
    if (this.current === w) this.current = undefined;
    const side = this.sideOf(w.input);
    const pen = this.pens.get(side);
    if (pen && !this.busyOn(side)) {
      // Done here: wait at the place still awaited on this side, else lift off.
      if (this.waiting && this.sideOf(this.waiting) === side) {
        const w0 = this.waiting;
        this.waiting = null;
        this.waitAt(w0);
      } else this.lift(pen);
    }
    if (!this.current) void this.next();
  }

  private async next(): Promise<void> {
    const w = this.queue.shift();
    if (!w) return;
    this.current = w;
    if (w.over || !w.input.isConnected) return w.end();
    const side = this.sideOf(w.input);
    this.place(w.layer, w.input, side); // the card may have moved since it was queued
    const spans = [...w.layer.children] as HTMLElement[];
    const box = offsetIn(w.layer, side);
    const right = box.x + w.layer.clientWidth - 4;
    const y = box.y + w.layer.offsetHeight * 0.74;
    const tips = spans.map((s) => ({ x: Math.min(box.x + s.offsetLeft + s.offsetWidth, right), y }));
    const start = { x: Math.min(box.x + (spans[0]?.offsetLeft ?? 0), right), y };
    const per = Math.max(LETTER_MS.min, Math.min(LETTER_MS.max, WRITE_MS / Math.max(1, spans.length)));
    const total = TRAVEL_MS + per * spans.length;

    const pen = this.pen(side, start);
    pen.hand.className = "ink-hand writing";
    // The tip goes to the first letter, then along the line, a letter at a time.
    const frames: Keyframe[] = [{ translate: `${pen.x}px ${pen.y}px`, offset: 0 }, { translate: `${start.x}px ${start.y}px`, offset: TRAVEL_MS / total }];
    tips.forEach((t, i) => frames.push({ translate: `${t.x}px ${t.y + (i % 2 ? -1 : 0.5)}px`, offset: (TRAVEL_MS + per * (i + 1)) / total }));
    pen.move?.cancel();
    pen.move = pen.el.animate(frames, { duration: total, easing: "linear", fill: "forwards" });
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
    try {
      await pen.move.finished;
    } catch {
      /* finished early */
    }
    if (!w.over) {
      // Let the last letter settle before the input shows the text.
      await new Promise((r) => setTimeout(r, 140));
      w.end();
    }
  }

  /** Where the pencil rests on an empty place: where its text will start. */
  private restingSpot(input: HTMLInputElement): { x: number; y: number } {
    const side = this.sideOf(input);
    const at = offsetIn(input, side);
    const centered = getComputedStyle(input).textAlign === "center";
    return { x: at.x + (centered ? input.offsetWidth / 2 - 14 : 8), y: at.y + input.offsetHeight * 0.74 };
  }

  private place(layer: HTMLElement, input: HTMLInputElement, side: HTMLElement): void {
    const at = offsetIn(input, side);
    Object.assign(layer.style, { left: `${at.x}px`, top: `${at.y}px`, width: `${input.offsetWidth}px`, height: `${input.offsetHeight}px` });
  }

  /** The pencil on this side; one that isn't there yet comes down onto the paper at `at`. */
  private pen(side: HTMLElement, at: { x: number; y: number }): Pen {
    const had = this.pens.get(side);
    if (had) return had;
    const el = document.createElement("div");
    el.className = "ink-pen";
    el.setAttribute("aria-hidden", "true");
    const hand = document.createElement("div");
    hand.className = "ink-hand";
    hand.innerHTML = PENCIL;
    el.append(hand);
    el.style.translate = `${at.x}px ${at.y}px`;
    side.append(el);
    const pen: Pen = { el, hand, side, x: at.x, y: at.y };
    this.pens.set(side, pen);
    if (!reducedMotion())
      el.animate([{ opacity: 0, translate: `${at.x + 14}px ${at.y - 18}px` }, { opacity: 1, translate: `${at.x}px ${at.y}px` }], { duration: 200, easing: "ease-out" });
    return pen;
  }

  private moveTo(pen: Pen, at: { x: number; y: number }, ms: number): void {
    if (pen.x === at.x && pen.y === at.y) return;
    pen.move?.cancel();
    if (!reducedMotion()) pen.move = pen.el.animate([{ translate: `${pen.x}px ${pen.y}px` }, { translate: `${at.x}px ${at.y}px` }], { duration: ms, easing: "ease-in-out" });
    pen.x = at.x;
    pen.y = at.y;
    pen.el.style.translate = `${at.x}px ${at.y}px`;
  }

  /** The pencil lifts off the paper and is gone. */
  private lift(pen: Pen): void {
    if (this.pens.get(pen.side) !== pen) return;
    this.pens.delete(pen.side);
    pen.move?.cancel();
    if (reducedMotion() || !pen.el.isConnected) return pen.el.remove();
    const a = pen.el.animate([{ opacity: 1, translate: `${pen.x}px ${pen.y}px` }, { opacity: 0, translate: `${pen.x + 16}px ${pen.y - 22}px` }], { duration: 220, easing: "ease-in", fill: "forwards" });
    void a.finished.then(
      () => pen.el.remove(),
      () => pen.el.remove(),
    );
  }
}
