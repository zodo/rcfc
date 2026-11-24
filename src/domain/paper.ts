// Make a picture's paper background pure white, so the card shows through.
//
// Pictures are drawn as cut-paper scenes photographed on white paper. The
// photo's paper is not white: lighting leaves it 190-250 grey with a vignette.
// We fit a smooth surface (quadratic per channel) to the border pixels, divide
// it out (flat-field), clip near-white to white and fade the outer edge, so on
// a light card (with multiply blending) only the paper cut-outs and the shadows
// the model drew remain. Pure, on RGBA pixels, so it runs in the browser on a
// canvas and in tests on synthetic images.

const MARGIN = 6;
const STEP = 8;
/** Edge fade width, px: hides the photographed sheet's own edges. */
const FADE = 14;

function basis(x: number, y: number): number[] {
  return [1, x, y, x * x, x * y, y * y];
}

/** Least squares via normal equations (6×6, Gaussian elimination). */
function fit(rows: number[][], values: number[]): number[] | null {
  const n = 6;
  const a = Array.from({ length: n }, () => new Array<number>(n + 1).fill(0));
  rows.forEach((r, k) => {
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) a[i][j] += r[i] * r[j];
      a[i][n] += r[i] * values[k];
    }
  });
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    if (Math.abs(a[p][c]) < 1e-9) return null;
    [a[c], a[p]] = [a[p], a[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = a[r][c] / a[c][c];
      for (let k = c; k <= n; k++) a[r][k] -= f * a[c][k];
    }
  }
  return a.map((row, i) => row[n] / row[i]);
}

const evalAt = (coef: number[], b: number[]) => b.reduce((s, v, i) => s + v * coef[i], 0);

/**
 * Flatten the paper background in place. Returns false (pixels untouched) when
 * the border is not light, even paper, i.e. the scene fills the whole frame.
 */
export function flattenPaper(px: Uint8ClampedArray, w: number, h: number): boolean {
  const pts: [number, number][] = [];
  for (let x = 0; x < w; x += STEP) pts.push([x, MARGIN], [x, h - 1 - MARGIN]);
  for (let y = 0; y < h; y += STEP) pts.push([MARGIN, y], [w - 1 - MARGIN, y]);
  const bases = pts.map(([x, y]) => basis(x / w, y / h));
  const colors = pts.map(([x, y]) => {
    const i = (y * w + x) * 4;
    return [px[i], px[i + 1], px[i + 2]];
  });
  let keep = pts.map(() => true);
  let coefs: number[][] = [];
  for (let iter = 0; iter < 4; iter++) {
    const idx = keep.flatMap((k, i) => (k ? [i] : []));
    if (idx.length < 24) return false;
    const cs = [0, 1, 2].map((ch) =>
      fit(
        idx.map((i) => bases[i]),
        idx.map((i) => colors[i][ch]),
      ),
    );
    if (cs.some((c) => !c)) return false;
    coefs = cs as number[][];
    const res = bases.map((b, i) => Math.max(...[0, 1, 2].map((ch) => Math.abs(evalAt(coefs[ch], b) - colors[i][ch]))));
    const kept = res.filter((_, i) => keep[i]).sort((a, b) => a - b);
    const cut = Math.max(12, kept[Math.floor(kept.length * 0.7)]);
    keep = res.map((r) => r < cut);
  }
  // Must be mostly light, grey (unsaturated) paper.
  if (keep.filter(Boolean).length < pts.length * 0.6) return false;
  for (const b of bases) {
    const c = coefs.map((k) => evalAt(k, b));
    if (Math.min(...c) < 160 || Math.max(...c) - Math.min(...c) > 25) return false;
  }

  for (let y = 0; y < h; y++) {
    const edgeY = Math.min(y, h - 1 - y);
    for (let x = 0; x < w; x++) {
      const b = basis(x / w, y / h);
      const i = (y * w + x) * 4;
      const out = [0, 0, 0];
      for (let ch = 0; ch < 3; ch++) out[ch] = Math.min(255, (px[i + ch] / Math.max(1, evalAt(coefs[ch], b))) * 255);
      const white = Math.min(out[0], out[1], out[2]) > 246;
      const edge = Math.min(edgeY, x, w - 1 - x);
      const t = white ? 1 : edge < FADE ? 1 - edge / FADE : 0;
      for (let ch = 0; ch < 3; ch++) px[i + ch] = out[ch] + (255 - out[ch]) * t;
    }
  }
  return true;
}
