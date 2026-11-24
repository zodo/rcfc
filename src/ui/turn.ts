// Turning a card over, by hand or by itself. The card turns around its
// centre line but rises as it turns, so the edge it turns away from stays on
// the table, like lifting one side of a real card. Its shadow is what a light
// a little above the top of the screen casts on the table: as wide as the
// card seen from above, and slanted, because the raised edge throws its
// shadow further down than the edge on the table.

/** Shadow offset per px of height (how far above the screen's top the light is). */
const K = 0.2;
/** While dragged, the card turns towards its edge but never past this: the other side stays hidden. */
export const EDGE = 88;

export class Turn {
  /** Degrees: 0 front up, ±180 back up. */
  a = 0;
  private v = 0;
  private raf = 0;

  constructor(
    private flipper: HTMLElement,
    /** Holds the card's shadows (their own opacity is the card's lift). */
    private shadow: HTMLElement,
    private shades: HTMLElement[],
    private width: number,
  ) {}

  render(): void {
    const rad = (this.a * Math.PI) / 180, up = Math.abs(Math.sin(rad)), wide = Math.abs(Math.cos(rad));
    this.flipper.style.transform = `translateZ(${((this.width / 2) * up).toFixed(1)}px) rotateY(${this.a.toFixed(2)}deg)`;
    const skew = (Math.atan(-K * Math.tan(rad)) * 180) / Math.PI;
    this.shadow.style.transform = `translateY(${((K * this.width) / 2 * up).toFixed(1)}px) skewY(${skew.toFixed(2)}deg) scaleX(${wide.toFixed(3)})`;
    this.shadow.style.opacity = (1 - 0.45 * up).toFixed(3); // raised higher, the shadow is lighter
    const shade = (0.28 * up).toFixed(3); // the side turning away from the light darkens
    for (const s of this.shades) s.style.opacity = shade;
  }

  /** Follows a sideways drag of `dx` px: towards the edge, stiffer the closer it gets. */
  drag(dx: number): void {
    this.stop();
    this.a = Math.sign(dx) * EDGE * (1 - Math.exp(-Math.abs(dx) / 110));
    this.render();
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  /** Spring to `to` degrees; a soft spring wobbles a little. */
  to(to: number, { k = 200, c = 24, done }: { k?: number; c?: number; done?: () => void } = {}): void {
    this.stop();
    let last = performance.now();
    const step = (now: number) => {
      const dt = Math.min(0.032, (now - last) / 1000);
      last = now;
      const d = this.a - to;
      this.v += (-k * d - c * this.v) * dt;
      this.a += this.v * dt;
      if (Math.abs(this.v) > 0.05 || Math.abs(d) > 0.05) {
        this.render();
        this.raf = requestAnimationFrame(step);
      } else {
        this.a = to;
        this.v = 0;
        this.render();
        this.raf = 0;
        done?.();
      }
    };
    this.raf = requestAnimationFrame(step);
  }
}
