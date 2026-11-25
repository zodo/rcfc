// The cut-paper look, set up once at boot: paper textures as small bitmap
// tiles and hand-cut edge shapes as CSS variables (style.css uses them), plus
// haptics.
//
// Textures are bitmaps drawn on a canvas, not SVG filter backgrounds: browsers
// re-render SVG filters on every paint, which made animations stutter.

/** Hand-cut edges: polygon variants in % (any size) with a few px of wobble. */
const CUTS = 4;

export function setupPaper(): void {
  const root = document.documentElement.style;
  root.setProperty("--grain", tile(192, (ctx, n) => (noise(ctx, n, 1, [97, 77, 51], 0, 0.07), noise(ctx, n, 3, [97, 77, 51], 0, 0.04))));
  root.setProperty("--fibre", tile(256, (ctx, n) => (noise(ctx, n, 1, [0, 0, 0], 0, 0.06), noise(ctx, n, 2, [0, 0, 0], 0, 0.05, 3), noise(ctx, n, 6, [0, 0, 0], 0, 0.04))));
  root.setProperty("--mottle", tile(1024, (ctx, n) => noise(ctx, n, 128, [0, 0, 0], 0, 0.09)));
  for (let i = 0; i < CUTS; i++) root.setProperty(`--cut-${i + 1}`, cutPolygon(seeded(i * 7919 + 13)));
}

function tile(size: number, draw: (ctx: CanvasRenderingContext2D, size: number) => void): string {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d");
  if (!ctx) return "none";
  draw(ctx, size);
  return `url(${c.toDataURL("image/png")})`;
}

/**
 * Value noise: random cells of `cell` px, scaled up smoothly; `stretch` makes
 * fibres. The cells get a one-cell border copied from the opposite edge, so the
 * smoothing wraps around and the tile repeats without seams.
 */
function noise(ctx: CanvasRenderingContext2D, size: number, cell: number, rgb: number[], lo: number, hi: number, stretch = 1): void {
  const w = Math.max(1, Math.round(size / cell)), h = Math.max(1, Math.round(size / cell / stretch));
  const a = Array.from({ length: w * h }, () => (lo + Math.random() * (hi - lo)) * 255);
  const c = document.createElement("canvas");
  c.width = w + 2;
  c.height = h + 2;
  const g = c.getContext("2d")!;
  const img = g.createImageData(w + 2, h + 2);
  for (let y = 0; y < h + 2; y++)
    for (let x = 0; x < w + 2; x++) {
      const i = (y * (w + 2) + x) * 4;
      img.data.set(rgb, i);
      img.data[i + 3] = a[((y + h - 1) % h) * w + ((x + w - 1) % w)];
    }
  g.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = cell > 1;
  const cw = size / w, ch = size / h;
  ctx.drawImage(c, -cw, -ch, size + 2 * cw, size + 2 * ch);
}

export function seeded(seed: number): () => number {
  let s = seed % 233280;
  return () => (s = (s * 9301 + 49297) % 233280) / 233280;
}

function cutPolygon(r: () => number): string {
  const n = 9; // points per edge
  const j = () => (r() * 1.6).toFixed(2); // inward wobble, px
  const c = (1.5 + r() * 2).toFixed(1); // snipped corner, px
  const pts: string[] = [];
  for (let i = 0; i < n; i++) pts.push(`calc(${(i * 100) / n}% + ${i ? 0 : c}px) ${i ? j() : 0}px`);
  pts.push(`100% ${c}px`);
  for (let i = 1; i < n; i++) pts.push(`calc(100% - ${j()}px) ${(i * 100) / n}%`);
  pts.push(`calc(100% - ${c}px) 100%`);
  for (let i = n - 1; i > 0; i--) pts.push(`${(i * 100) / n}% calc(100% - ${j()}px)`);
  pts.push(`0 calc(100% - ${c}px)`);
  for (let i = n - 1; i > 0; i--) pts.push(`${j()}px ${(i * 100) / n}%`);
  return `polygon(${pts.join(",")})`;
}

/**
 * Haptics through the Vibration API (Android). iPhones have none: iOS 26
 * gives a tap only when a finger flips a real switch checkbox, not when one
 * is clicked from code (`?haptics`, hapticsTest.ts, tried each way).
 */
const PATTERN = { tick: 5, tap: 9, thud: 16, double: [10, 70, 12] };
export function haptic(kind: keyof typeof PATTERN): void {
  try {
    navigator.vibrate?.(PATTERN[kind]);
  } catch {
    /* not allowed before the first tap */
  }
}
