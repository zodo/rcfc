// Today's cards from a pile, lying crosswise under it in study (src/screens/study.ts):
// a card answered Got it or Easy leaves the screen, comes back turned 90° and
// shrunk to the screen's width, and slides under the pile, so only its ends show
// on both sides. When the pile is finished they are what is left on the table,
// moved into the room between the check and the handfuls; a tap gathers them
// up into the pile again. Not physical in one way: a card lying crosswise is
// smaller than the pile's. Moved by transform only (one card at a time).
import { h } from "./h";
import { seeded } from "./paper";

/** Cards kept on the page: deeper ones are covered by the ones on top anyway. */
const KEPT = 8;

/** A card as it lies crosswise: the side that was up when it was answered. */
export interface CrossCard {
  known: boolean;
  text: string;
  lang: string;
}

export class Crossed {
  readonly el = h("div", { class: "crossed", "aria-hidden": "true" });
  /** Cards lying here, the latest last. */
  private count = 0;
  /** Where the cards lie: under the pile (0), or moved down by `dy` and to scale `s` on the finish. */
  private at = { dy: 0, s: 0 };

  constructor(
    private readonly pile: HTMLElement,
    private readonly seed: number,
  ) {}

  /**
   * The scale under the pile: nearly as wide as the screen, so the ends show
   * on both sides of the pile (its cards lie a little askew over them).
   */
  private under(): number {
    const w = this.pile.offsetWidth, ht = this.pile.offsetHeight || 1;
    const screen = document.documentElement.clientWidth;
    return Math.min(1, Math.max((w + 16) / ht, (screen - 6) / ht));
  }

  /** Under the pile again, at the scale its size asks for now (it is laid out late, and the screen turns). */
  settle(): number {
    const s = this.under();
    if (this.at.dy === 0 && Math.abs(s - this.at.s) > 0.002) {
      this.at.s = s;
      for (const el of this.el.children as HTMLCollectionOf<HTMLElement>) el.style.transform = this.pose(Number(el.dataset.k), 0, s);
    }
    return this.at.dy === 0 ? s : this.at.s;
  }

  /** Card k's own place: a little off and turned, a little higher than the one under it. */
  private pose(k: number, dy: number, s: number): string {
    const r = seeded(this.seed + k * 104_729);
    const x = (r() - 0.5) * 6, y = dy - Math.min(k, 24) * 0.9 + (r() - 0.5) * 3, deg = 90 + (r() - 0.5) * 5;
    return `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) rotate(${deg.toFixed(2)}deg) scale(${s.toFixed(3)})`;
  }

  private sheet(c: CrossCard, k: number): HTMLElement {
    const el = h("div", { class: `cross-sheet${c.known ? " known" : ""}` }, h("div", { class: "cross-face", lang: c.lang }, c.text));
    el.dataset.k = String(k);
    return el;
  }

  /** Only the top card's face is drawn: the others are covered. */
  private faces(): void {
    const sheets = [...this.el.children] as HTMLElement[];
    sheets.forEach((el, i) => el.classList.toggle("top", i === sheets.length - 1));
  }

  /** Lay these cards crosswise under the pile at once, the latest last. */
  show(cards: CrossCard[]): void {
    this.count = cards.length;
    this.at = { dy: 0, s: this.under() };
    const first = Math.max(0, cards.length - KEPT);
    this.el.replaceChildren(
      ...cards.slice(first).map((c, i) => {
        const el = this.sheet(c, first + i);
        el.style.transform = this.pose(first + i, 0, this.at.s);
        return el;
      }),
    );
    this.faces();
  }

  /** A card answered: it comes in from where it left the screen (`from`), turned, and slides under the pile. */
  land(c: CrossCard, from: "right" | "top"): void {
    const k = this.count++;
    const s = this.settle();
    const el = this.sheet(c, k);
    const end = this.pose(k, this.at.dy, s);
    el.style.transform = end;
    this.el.append(el);
    while (this.el.children.length > KEPT) this.el.firstElementChild!.remove();
    this.faces();
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const box = this.pile.getBoundingClientRect();
    const start =
      from === "right"
        ? `translate(${(innerWidth - box.left + box.width * 0.2).toFixed(0)}px, ${(-box.height * 0.08).toFixed(0)}px) rotate(128deg) scale(${s.toFixed(3)})`
        : `translate(${(box.width * 0.12).toFixed(0)}px, ${(-box.bottom - box.height * 0.2).toFixed(0)}px) rotate(62deg) scale(${s.toFixed(3)})`;
    // Thrown back in, slowing as it slides under: a little past its place, then settling.
    el.animate([{ transform: start }, { transform: end }], { duration: 560, easing: "cubic-bezier(.2,.9,.28,1.06)" });
  }

  /** Moved to the finish: down by `dy`, to fit `s`. `instant` when the pile was already finished. */
  moveTo(dy: number, s: number, instant = false): void {
    this.at = { dy, s };
    for (const el of this.el.children as HTMLCollectionOf<HTMLElement>) {
      const end = this.pose(Number(el.dataset.k), dy, s);
      const from = el.style.transform;
      el.style.transform = end;
      if (!instant && !matchMedia("(prefers-reduced-motion: reduce)").matches) el.animate([{ transform: from }, { transform: end }], { duration: 420, easing: "cubic-bezier(.3,.8,.3,1)" });
    }
  }

  /** Back under the pile (a handful was dealt onto it). */
  tuck(): void {
    this.moveTo(0, this.under());
  }

  /** The finish's room for the cards: their size there, as laid by `moveTo(dy, s)`. */
  fit(top: number, bottom: number): { dy: number; s: number; w: number; h: number } {
    const w = this.pile.offsetWidth, ht = this.pile.offsetHeight || 1;
    const room = Math.max(60, bottom - top - 20);
    const s = Math.min(this.under(), room / w);
    return { dy: (top + bottom) / 2 - ht / 2, s, w: ht * s, h: w * s };
  }

  /** Gathered up: each card stands up into the pile's place, the top one last. Resolves when they are there. */
  gather(): Promise<void> {
    const sheets = [...this.el.children] as HTMLElement[];
    this.count = 0;
    if (!sheets.length || matchMedia("(prefers-reduced-motion: reduce)").matches) {
      this.el.replaceChildren();
      return Promise.resolve();
    }
    const done = sheets.map((el, i) => {
      const from = el.style.transform;
      const a = el.animate([{ transform: from }, { transform: "translate(0, 0) rotate(0deg) scale(1)" }], { duration: 380, delay: i * 35, easing: "cubic-bezier(.3,.75,.3,1)", fill: "forwards" });
      return a.finished;
    });
    return Promise.all(done).then(() => this.el.replaceChildren());
  }
}
