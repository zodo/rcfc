// Swipe a card left/right (pointer events: touch, pen and mouse). A short tap
// calls onTap. The element follows the finger and flies out on commit.

export interface SwipeOptions {
  onLeft?: () => void;
  onRight?: () => void;
  onTap?: () => void;
  /** Whether a swipe may commit right now (otherwise it snaps back). */
  canSwipe?: () => boolean;
  threshold?: number;
}

export function swipeable(el: HTMLElement, o: SwipeOptions) {
  const threshold = o.threshold ?? 80;
  let x0 = 0;
  let y0 = 0;
  let dx = 0;
  let active = false;
  let moved = false;
  el.style.touchAction = "pan-y";

  const setHint = (d: number) => {
    el.classList.toggle("hint-right", d > threshold / 2);
    el.classList.toggle("hint-left", d < -threshold / 2);
  };
  const reset = () => {
    el.style.transition = "transform 0.18s ease";
    el.style.transform = "";
    setHint(0);
  };

  el.addEventListener("pointerdown", (e) => {
    if ((e.target as HTMLElement).closest("button")) return;
    active = true;
    moved = false;
    x0 = e.clientX;
    y0 = e.clientY;
    dx = 0;
    el.style.transition = "none";
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic or already-released pointer */
    }
  });
  el.addEventListener("pointermove", (e) => {
    if (!active) return;
    dx = e.clientX - x0;
    if (Math.abs(dx) > 6 || Math.abs(e.clientY - y0) > 6) moved = true;
    if (!o.canSwipe || o.canSwipe()) {
      el.style.transform = `translateX(${dx}px) rotate(${dx / 25}deg)`;
      setHint(dx);
    }
  });
  const end = () => {
    if (!active) return;
    active = false;
    if (!moved) {
      reset();
      o.onTap?.();
      return;
    }
    const allowed = !o.canSwipe || o.canSwipe();
    const go = allowed && Math.abs(dx) >= threshold ? (dx > 0 ? o.onRight : o.onLeft) : undefined;
    if (!go) {
      reset();
      if (!allowed) o.onTap?.();
      return;
    }
    el.style.transition = "transform 0.2s ease-in";
    el.style.transform = `translateX(${dx > 0 ? 130 : -130}vw) rotate(${dx > 0 ? 20 : -20}deg)`;
    setTimeout(go, 160);
  };
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", () => {
    active = false;
    reset();
  });
}
