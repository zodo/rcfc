// The picture's place while it draws: the pencil writes down what the picture
// will show, the meaning first and then the scene as the server streams it in,
// at a steady handwriting pace; with nothing left to write it doodles curls
// after the last word, line after line, until the picture comes. Then the
// picture is glued on over the note: held a little above the card, brought
// down and pressed flat.
//
// Per frame only the pencil's translate, the letters' opacity and the doodle's
// stroke change; the glued picture moves by transform only.
import type { SceneText } from "../pictures";
import { PENCIL } from "./ink";

const SVG_NS = "http://www.w3.org/2000/svg";
/** Steady handwriting: ~2.5 s for a two-line scene. */
const LETTER_MS = 26;
/** The meaning is written a little slower than the scene: it's the heading. */
const SENSE_LETTER_MS = 70;
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
  private doodling: { stopped: boolean; anims: Animation[] } | undefined;
  private closed = false;
  private hurry = false;

  constructor() {
    this.senseEl = document.createElement("span");
    this.senseEl.className = "sk-sense";
    this.sceneEl = document.createElement("span");
    this.sceneEl.className = "sk-scene";
    this.note = document.createElement("div");
    this.note.className = "sk-note";
    this.note.append(this.senseEl, this.sceneEl);
    this.svg = document.createElementNS(SVG_NS, "svg");
    this.svg.setAttribute("class", "ink-doodle");
    this.svg.setAttribute("aria-hidden", "true");
    this.el = document.createElement("div");
    this.el.className = "sketch";
    this.el.setAttribute("role", "status");
    this.el.setAttribute("aria-label", "drawing the picture");
    this.el.append(this.note, this.svg);
  }

  /** What the picture will show, so far. Text already written stays; new text is written on. */
  text(t: SceneText): void {
    if (this.closed) return;
    if (t.sense !== undefined && this.sense.length === 0) this.sense = this.fill(this.senseEl, t.sense, 0);
    if (t.scene !== undefined && t.scene !== this.sceneText()) this.scene = this.fill(this.sceneEl, t.scene, this.sense.length);
    if (reducedMotion()) {
      for (const s of this.all()) s.classList.add("on");
      this.written = this.all().length;
      return;
    }
    this.run();
  }

  /**
   * The picture is here: what's left of the note is written at once, the pencil
   * lifts off and the picture is glued on over the note. Resolves once it lies flat.
   */
  async glue(pic: HTMLElement): Promise<void> {
    if (this.closed) return;
    this.hurry = true;
    this.stopDoodle();
    for (const s of this.all()) s.classList.add("on");
    this.written = this.all().length;
    this.closed = true;
    cancelAnimationFrame(this.frame);
    this.lift();
    const layer = document.createElement("div");
    layer.className = "sk-glued";
    layer.append(pic);
    this.el.append(layer);
    if (reducedMotion()) {
      this.el.classList.add("glued");
      return;
    }
    const press = layer.animate(
      [
        { opacity: 0, transform: "translate(10px, -26px) rotate(3deg) scale(1.06)", offset: 0 },
        { opacity: 1, transform: "translate(4px, -12px) rotate(1.2deg) scale(1.04)", offset: 0.25 },
        { opacity: 1, transform: "translate(0, 0) rotate(0) scale(0.985)", offset: 0.62, easing: "ease-out" },
        { opacity: 1, transform: "none", offset: 1 },
      ],
      { duration: 700, easing: "cubic-bezier(.4,0,.6,1)" },
    );
    for (const e of [this.note, this.svg]) e.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 250, delay: 350, fill: "forwards" });
    this.el.classList.add("glued");
    await press.finished.catch(() => {});
  }

  /** Stop everything (the note is taken off the card). */
  close(): void {
    this.closed = true;
    cancelAnimationFrame(this.frame);
    this.stopDoodle();
    this.pen?.remove();
    this.pen = undefined;
  }

  private sceneText(): string {
    return this.scene.map((s) => s.textContent).join("");
  }

  private all(): HTMLElement[] {
    return [...this.sense, ...this.scene];
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
    const now = performance.now();
    this.started ||= now;
    const all = this.all();
    let target = Math.min(this.sense.length, Math.floor((now - this.started) / SENSE_LETTER_MS));
    if (target >= this.sense.length && this.scene.length) {
      this.sceneFrom ||= now;
      target = this.sense.length + Math.floor((now - this.sceneFrom) / LETTER_MS);
    }
    target = Math.min(target, all.length);
    if (this.written < target) {
      this.stopDoodle();
      while (this.written < target) all[this.written++].classList.add("on");
      const tip = this.tipOf(all[this.written - 1]);
      const pen = this.getPen(tip);
      pen.style.translate = `${tip.x}px ${tip.y}px`;
      this.hand!.className = "ink-hand writing";
    } else if (this.written >= all.length) {
      // Everything that has arrived is written: doodle after it until there's more.
      this.hand && (this.hand.className = "ink-hand");
      const last = all[this.written - 1];
      this.doodle(last ? this.tipOf(last) : { x: 18, y: 30 });
    }
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
