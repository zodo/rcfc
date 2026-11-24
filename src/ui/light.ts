// Tilt light: the light stays put in the room while the phone tilts, so
// shadows shift a little and the pile of cards moves against them.
//
// Elements that move carry `data-light` (how many px per unit of tilt). Their
// `translate` is set directly: a custom property on the screen would restyle
// everything under it on every frame (that dropped a Pixel below 120 fps).

const MAX = 7;
const tilt = { tx: 0, ty: 0, x: 0, y: 0, base: null as { g: number; b: number } | null, listening: false };
let lit: HTMLElement[] = [];
let running = false;
let last = 0;

const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

function onOrient(e: DeviceOrientationEvent): void {
  if (e.beta == null || e.gamma == null) return;
  const g = e.gamma, b = e.beta;
  if (!tilt.base) tilt.base = { g, b };
  // The neutral pose slowly follows the hand (~2 s), so only changes in tilt move the light.
  tilt.base.g += (g - tilt.base.g) * 0.01;
  tilt.base.b += (b - tilt.base.b) * 0.01;
  const tx = clamp((g - tilt.base.g) * 0.4, -MAX, MAX), ty = clamp((b - tilt.base.b) * 0.4, -MAX, MAX);
  // Ignore sensor jitter (~0.3°): a still phone means no work at all.
  if (Math.abs(tx - tilt.tx) > 0.12 || Math.abs(ty - tilt.ty) > 0.12) {
    tilt.tx = tx;
    tilt.ty = ty;
    if (lit[0]?.isConnected) run(); // nothing lit off the study screen
  }
}

/** Start listening. On iPhone this asks for motion access, so call it from a tap. */
export function startTilt(): void {
  if (tilt.listening || reduced()) return;
  const D = window.DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> } | undefined;
  if (!D) return;
  tilt.listening = true;
  if (typeof D.requestPermission === "function") {
    D.requestPermission()
      .then((r) => r === "granted" && addEventListener("deviceorientation", onOrient))
      .catch(() => (tilt.listening = false));
  } else addEventListener("deviceorientation", onOrient);
}

/** Whether starting needs a tap first (iPhone's permission prompt). */
export const tiltNeedsTap = () => typeof (window.DeviceOrientationEvent as unknown as { requestPermission?: unknown } | undefined)?.requestPermission === "function";

/** Pick up the lit elements under `root` (after rendering or changing them). */
export function relight(root: ParentNode): void {
  lit = [...root.querySelectorAll<HTMLElement>("[data-light]")];
  paint();
}

function paint(): void {
  for (const el of lit) {
    const f = Number(el.dataset.light);
    el.style.translate = `${(tilt.x * f).toFixed(1)}px ${(tilt.y * f).toFixed(1)}px`;
  }
}

function run(): void {
  if (running) return;
  running = true;
  last = performance.now();
  requestAnimationFrame(frame);
}

function frame(now: number): void {
  const a = 1 - Math.exp(-(now - last) / 55); // same smoothing at 60 or 120 Hz
  last = now;
  tilt.x += (tilt.tx - tilt.x) * a;
  tilt.y += (tilt.ty - tilt.y) * a;
  paint();
  if (Math.abs(tilt.tx - tilt.x) > 0.03 || Math.abs(tilt.ty - tilt.y) > 0.03) requestAnimationFrame(frame);
  else running = false;
}
