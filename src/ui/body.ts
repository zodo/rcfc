// A card you can hold: position, turn, scale and lift, moved by springs or
// thrown. It turns around the point you hold (px, py from its centre), like
// paper does, without moving its transform origin.

export interface Pose {
  x: number;
  y: number;
  r: number;
}

type Key = "x" | "y" | "r" | "s" | "lift";

export class Body {
  x = 0;
  y = 0;
  /** Turn, degrees. */
  r = 0;
  s = 1;
  /** 0 resting on the table, 1 picked up (the shadow grows). */
  lift = 0;
  /** Grab point relative to the centre, in the card's own frame. */
  px = 0;
  py = 0;
  /** Where it rests: its own spot in the pile. */
  home: Pose = { x: 0, y: 0, r: 0 };
  private v: Partial<Record<Key, number>> = {};
  private raf = 0;
  private lastLift = -1;

  constructor(
    readonly el: HTMLElement,
    readonly w: number,
    readonly h: number,
    private shRest: HTMLElement,
    private shLift: HTMLElement,
  ) {}

  get moving(): boolean {
    return this.raf !== 0;
  }

  render(): void {
    const a = (this.r * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    const tx = this.x + this.px - (this.px * c - this.py * s), ty = this.y + this.py - (this.px * s + this.py * c);
    this.el.style.transform = `translate(${tx.toFixed(2)}px,${ty.toFixed(2)}px) rotate(${this.r.toFixed(3)}deg) scale(${this.s.toFixed(4)})`;
    const l = Math.max(0, Math.min(1, this.lift));
    if (l !== this.lastLift) {
      this.lastLift = l;
      this.shLift.style.opacity = String(l);
      this.shRest.style.opacity = String(1 - l);
    }
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  /** Hold it at (clientX, clientY) without moving it. */
  grab(clientX: number, clientY: number): void {
    this.stop();
    const rect = this.el.getBoundingClientRect();
    const a = (this.r * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    const tx = this.x + this.px - (this.px * c - this.py * s), ty = this.y + this.py - (this.px * s + this.py * c);
    const gx = clientX - (rect.left + rect.width / 2), gy = clientY - (rect.top + rect.height / 2);
    this.px = gx * c + gy * s;
    this.py = -gx * s + gy * c;
    this.x = tx - this.px + (this.px * c - this.py * s);
    this.y = ty - this.py + (this.px * s + this.py * c);
  }

  /** Let go of the grab point without moving it, so springing home lands exactly home. */
  unpivot(): void {
    const a = (this.r * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    this.x += this.px - (this.px * c - this.py * s);
    this.y += this.py - (this.px * s + this.py * c);
    this.px = this.py = 0;
  }

  spring(target: Partial<Record<Key, number>>, { k = 420, c = 28, done, onFrame }: { k?: number; c?: number; done?: () => void; onFrame?: () => void } = {}): void {
    this.stop();
    let last = performance.now();
    const keys = Object.keys(target) as Key[];
    const step = (now: number) => {
      const dt = Math.min(0.032, (now - last) / 1000);
      last = now;
      let moving = false;
      for (const key of keys) {
        const v = this.v[key] ?? 0, d = this[key] - target[key]!;
        const nv = v + (-k * d - c * v) * dt;
        this.v[key] = nv;
        this[key] += nv * dt;
        if (Math.abs(nv) > 0.02 || Math.abs(d) > 0.02) moving = true;
      }
      onFrame?.();
      if (moving) {
        this.render();
        this.raf = requestAnimationFrame(step);
      } else {
        for (const key of keys) {
          this[key] = target[key]!;
          this.v[key] = 0;
        }
        this.render();
        this.raf = 0;
        done?.();
      }
    };
    this.raf = requestAnimationFrame(step);
  }

  /** Thrown: keeps going (px/ms, deg/ms) until it is `bound` px away. */
  fly(vx: number, vy: number, vr: number, bound: number, done: () => void, gravity = 0.0016): void {
    this.stop();
    let last = performance.now();
    const step = (now: number) => {
      const dt = Math.min(32, now - last);
      last = now;
      this.x += vx * dt;
      this.y += vy * dt;
      this.r += vr * dt;
      vy += gravity * dt;
      this.render();
      if (Math.abs(this.x) < bound && Math.abs(this.y) < bound * 1.6) this.raf = requestAnimationFrame(step);
      else {
        this.raf = 0;
        done();
      }
    };
    this.raf = requestAnimationFrame(step);
  }
}
