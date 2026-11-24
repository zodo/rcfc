// Make a picture's paper background pure white, so the card shows through.
//
// Pictures are cut-paper scenes photographed on white paper. The photo's paper
// is grey (190-250) with a vignette, JPEG grain, the edges of backing sheets
// and stray shadows. On a light card (multiply blending) all of that would
// show. Steps:
//
// 1. Fit a smooth surface (quadratic, per channel) to the border, divide it out
//    (flat-field), find the background: light, unsaturated pixels connected to
//    the border. Refit (cubic) on all background outside the scene, redo.
// 2. Scene outline: the row and column spans of coloured pixels, grown by
//    HULL_PAD. Inside it nothing changes but near-white lifting to white,
//    because white paper in the scene (walls, clouds) and pale grey-green
//    pieces are part of the picture. Pale pieces look like shadows to any
//    pixel rule; v3 tried to trace shadows and damaged them, so we don't.
// 3. Outside the outline: background keeps only its low-frequency darkness
//    (the soft shadows the model drew), fading out away from visible pieces;
//    thin light lines between background (sheet edges) and the outer frame
//    edge become white.
//
// Pure, on RGBA pixels: runs on a canvas in the browser and in tests. Tuned on
// 15 real pictures (scratch eval set), ~60-150 ms at 768×512 on a laptop.

const STEP = 8;
const MARGIN = 6;
/** Background: light and unsaturated after flattening, connected to the border. */
const BG_MIN = 196;
const BG_SAT = 22;
/** Masked blur radius: keeps soft shadows, drops thin lines and grain. */
const BLUR = 6;
/** Darkness (below white) that counts as white: JPEG noise and paper texture. */
const KNEE = 5;
/** Outside the scene, this many px at the image edge become white. */
const EDGE = 12;
/** Thin light unsaturated lines (sheet edges) up to this half-width between background. */
const LINE_R = 4;
const LINE_MIN = 140;
const LINE_SAT = 30;
/** Shadows are cast by pieces: background darkness fades out between these distances from them. */
const SHADOW_NEAR = 22;
const SHADOW_FAR = 44;
/** White paper is invisible on the card, so it casts no visible shadow. */
const WHITE_MIN = 232;
/** Coloured or dark pixels are certainly scene. */
const SCENE_SAT = 28;
const SCENE_DARK = 80;
const SCENE_RUN = 4;
/** The scene outline is grown by this much, so pale pieces at its edge are protected. */
const HULL_PAD = 20;

type Coef = number[][];

function terms(x: number, y: number, order: number): number[] {
  const t = [1, x, y, x * x, x * y, y * y];
  if (order === 3) t.push(x * x * x, x * x * y, x * y * y, y * y * y);
  return t;
}

const dot = (c: number[], t: number[]) => {
  let s = 0;
  for (let i = 0; i < t.length; i++) s += c[i] * t[i];
  return s;
};

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Least squares via normal equations (Gauss-Jordan with pivoting). */
function solve(rows: number[][], values: number[]): number[] | null {
  const n = rows[0].length;
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

/** Robust per-channel surface fit to sample points (drops outliers over 4 rounds). */
function fitSurface(px: Uint8ClampedArray, w: number, h: number, pts: [number, number][], order: number): Coef | null {
  const T = pts.map(([x, y]) => terms(x / w, y / h, order));
  const C = pts.map(([x, y]) => {
    const i = (y * w + x) * 4;
    return [px[i], px[i + 1], px[i + 2]];
  });
  let keep = pts.map(() => true);
  let coef: Coef = [];
  for (let round = 0; round < 4; round++) {
    const idx = keep.flatMap((k, i) => (k ? [i] : []));
    if (idx.length < T[0].length * 4) return null;
    const cs = [0, 1, 2].map((ch) =>
      solve(
        idx.map((i) => T[i]),
        idx.map((i) => C[i][ch]),
      ),
    );
    if (cs.some((c) => !c)) return null;
    coef = cs as Coef;
    const res = T.map((t, i) => Math.max(...[0, 1, 2].map((ch) => Math.abs(dot(coef[ch], t) - C[i][ch]))));
    const kept = res.filter((_, i) => keep[i]).sort((a, b) => a - b);
    const cut = Math.max(10, kept[Math.floor(kept.length * 0.75)]);
    keep = res.map((r) => r < cut);
  }
  if (keep.filter(Boolean).length < pts.length * 0.5) return null;
  return coef;
}

/** Divide out the paper surface (evaluated on a 16 px grid, interpolated: it is smooth). */
function flatten(src: Uint8ClampedArray, w: number, h: number, coef: Coef, order: number): Float32Array {
  const out = new Float32Array(w * h * 3);
  const G = 16;
  const gw = Math.ceil(w / G) + 1;
  const gh = Math.ceil(h / G) + 1;
  const grid = new Float32Array(gw * gh * 3);
  for (let gy = 0; gy < gh; gy++)
    for (let gx = 0; gx < gw; gx++) {
      const t = terms((gx * G) / w, (gy * G) / h, order);
      for (let ch = 0; ch < 3; ch++) grid[(gy * gw + gx) * 3 + ch] = Math.max(1, dot(coef[ch], t));
    }
  for (let y = 0; y < h; y++) {
    const gy = Math.floor(y / G);
    const fy = (y - gy * G) / G;
    for (let x = 0; x < w; x++) {
      const gx = Math.floor(x / G);
      const fx = (x - gx * G) / G;
      const i = y * w + x;
      for (let ch = 0; ch < 3; ch++) {
        const a = grid[(gy * gw + gx) * 3 + ch];
        const b = grid[(gy * gw + gx + 1) * 3 + ch];
        const c = grid[((gy + 1) * gw + gx) * 3 + ch];
        const d = grid[((gy + 1) * gw + gx + 1) * 3 + ch];
        const bg = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
        out[i * 3 + ch] = Math.min(255, (src[i * 4 + ch] / bg) * 255);
      }
    }
  }
  return out;
}

function minc(f: Float32Array, i: number): number {
  return Math.min(f[i * 3], f[i * 3 + 1], f[i * 3 + 2]);
}
function satc(f: Float32Array, i: number): number {
  return Math.max(f[i * 3], f[i * 3 + 1], f[i * 3 + 2]) - minc(f, i);
}

/** Background: flood fill from the border through light, unsaturated pixels. */
function background(f: Float32Array, w: number, h: number): Uint8Array {
  const n = w * h;
  const mask = new Uint8Array(n);
  const q = new Int32Array(n);
  let head = 0;
  let tail = 0;
  const push = (i: number) => {
    if (!mask[i] && minc(f, i) >= BG_MIN && satc(f, i) <= BG_SAT) {
      mask[i] = 1;
      q[tail++] = i;
    }
  };
  for (let x = 0; x < w; x++) push(x), push((h - 1) * w + x);
  for (let y = 0; y < h; y++) push(y * w), push(y * w + w - 1);
  while (head < tail) {
    const i = q[head++];
    const x = i % w;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (i >= w) push(i - w);
    if (i < n - w) push(i + w);
  }
  return mask;
}

/** Chamfer (3-4) distance to the nearest pixel in `set`, in px. */
function distanceTo(set: Uint8Array, w: number, h: number): Float32Array {
  const INF = 1e9;
  const d = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) d[i] = set[i] ? 0 : INF;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!d[i]) continue;
      let v = d[i];
      if (x > 0) v = Math.min(v, d[i - 1] + 3);
      if (y > 0) {
        v = Math.min(v, d[i - w] + 3);
        if (x > 0) v = Math.min(v, d[i - w - 1] + 4);
        if (x < w - 1) v = Math.min(v, d[i - w + 1] + 4);
      }
      d[i] = v;
    }
  for (let y = h - 1; y >= 0; y--)
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (!d[i]) continue;
      let v = d[i];
      if (x < w - 1) v = Math.min(v, d[i + 1] + 3);
      if (y < h - 1) {
        v = Math.min(v, d[i + w] + 3);
        if (x < w - 1) v = Math.min(v, d[i + w + 1] + 4);
        if (x > 0) v = Math.min(v, d[i + w - 1] + 4);
      }
      d[i] = v;
    }
  for (let i = 0; i < w * h; i++) d[i] /= 3;
  return d;
}

/** Scene outline: inside the row span and column span of coloured pixels, grown by HULL_PAD. */
function sceneHull(f: Float32Array, w: number, h: number): Uint8Array {
  const scene = new Uint8Array(w * h);
  // The outer frame band is never scene: slivers of a photographed sheet edge live there.
  for (let y = EDGE; y < h - EDGE; y++)
    for (let x = EDGE; x < w - EDGE; x++) {
      const i = y * w + x;
      scene[i] = satc(f, i) >= SCENE_SAT || minc(f, i) < SCENE_DARK ? 1 : 0;
    }
  const span = (len: number, at: (k: number) => number): [number, number] => {
    let first = -1;
    let last = -2;
    let run = 0;
    for (let k = 0; k < len; k++) {
      run = at(k) ? run + 1 : 0;
      if (run === SCENE_RUN) {
        if (first < 0) first = k - SCENE_RUN + 1;
        last = k;
      } else if (run > SCENE_RUN) last = k;
    }
    return [first, last];
  };
  const rows = Array.from({ length: h }, (_, y) => span(w, (x) => scene[y * w + x]));
  const cols = Array.from({ length: w }, (_, x) => span(h, (y) => scene[y * w + x]));
  const hull = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (x >= rows[y][0] && x <= rows[y][1] && y >= cols[x][0] && y <= cols[x][1]) hull[y * w + x] = 1;
  const d = distanceTo(hull, w, h);
  for (let i = 0; i < w * h; i++) hull[i] = d[i] <= HULL_PAD ? 1 : 0;
  return hull;
}

/** Thin light unsaturated lines with background on both sides (photographed sheet edges). */
function thinLines(f: Float32Array, mask: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  const near = (x: number, y: number, dx: number, dy: number) => {
    for (let k = 1; k <= LINE_R; k++) {
      const xx = x + dx * k;
      const yy = y + dy * k;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h || mask[yy * w + xx]) return true;
    }
    return false;
  };
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (mask[i] || minc(f, i) < LINE_MIN || satc(f, i) > LINE_SAT) continue;
      if ((near(x, y, -1, 0) && near(x, y, 1, 0)) || (near(x, y, 0, -1) && near(x, y, 0, 1))) out[i] = 1;
    }
  return out;
}

/** Box blur of `v` over `mask` pixels only (normalized convolution), output where `want`. */
function maskedBlur(v: Float32Array, mask: Uint8Array, want: Uint8Array, w: number, h: number, r: number): Float32Array {
  const W = w + 1;
  const sv = new Float64Array(W * (h + 1));
  const sm = new Float64Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    let rv = 0;
    let rm = 0;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (mask[i]) (rv += v[i]), (rm += 1);
      sv[(y + 1) * W + x + 1] = sv[y * W + x + 1] + rv;
      sm[(y + 1) * W + x + 1] = sm[y * W + x + 1] + rm;
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!want[i]) continue;
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w, x + r + 1);
      const a = y1 * W + x1;
      const b = y0 * W + x1;
      const c = y1 * W + x0;
      const d = y0 * W + x0;
      const cnt = sm[a] - sm[b] - sm[c] + sm[d];
      out[i] = cnt > 0 ? (sv[a] - sv[b] - sv[c] + sv[d]) / cnt : 0;
    }
  }
  return out;
}

function borderPoints(w: number, h: number): [number, number][] {
  const pts: [number, number][] = [];
  for (let x = 0; x < w; x += STEP) pts.push([x, MARGIN], [x, h - 1 - MARGIN]);
  for (let y = 0; y < h; y += STEP) pts.push([MARGIN, y], [w - 1 - MARGIN, y]);
  return pts;
}

/**
 * Make the paper background pure white in place, keeping the scene and the
 * soft shadows the model drew. Returns false (pixels untouched) when the
 * picture has no light paper background (the scene fills the frame).
 */
export function flattenPaper(px: Uint8ClampedArray, w: number, h: number): boolean {
  const border = borderPoints(w, h);
  const c1 = fitSurface(px, w, h, border, 2);
  if (!c1) return false;
  for (const [x, y] of border) {
    const v = c1.map((c) => dot(c, terms(x / w, y / h, 2)));
    if (Math.min(...v) < 150 || Math.max(...v) - Math.min(...v) > 28) return false;
  }
  let f = flatten(px, w, h, c1, 2);
  let mask = background(f, w, h);
  let hull = sceneHull(f, w, h);
  const pts: [number, number][] = [];
  for (let y = 2; y < h; y += STEP) for (let x = 2; x < w; x += STEP) if (mask[y * w + x] && !hull[y * w + x]) pts.push([x, y]);
  const c2 = pts.length > 200 ? fitSurface(px, w, h, pts, 3) : null;
  if (c2) {
    f = flatten(px, w, h, c2, 3);
    mask = background(f, w, h);
    hull = sceneHull(f, w, h);
  }
  // Most of the border must be paper, or the scene fills the frame.
  let ring = 0;
  let ringBg = 0;
  for (let x = 0; x < w; x++) for (const y of [2, h - 3]) ring++, (ringBg += mask[y * w + x]);
  for (let y = 0; y < h; y++) for (const x of [2, w - 3]) ring++, (ringBg += mask[y * w + x]);
  if (ringBg < ring * 0.5) return false;

  const n = w * h;
  const dark = new Float32Array(n);
  for (let i = 0; i < n; i++) if (mask[i]) dark[i] = 255 - minc(f, i);
  const lines = thinLines(f, mask, w, h);
  const bg = new Uint8Array(n);
  for (let i = 0; i < n; i++) bg[i] = mask[i] | lines[i];
  const soft = maskedBlur(dark, mask, bg, w, h, BLUR);
  const visible = new Uint8Array(n);
  for (let i = 0; i < n; i++) visible[i] = !bg[i] && !(minc(f, i) >= WHITE_MIN && satc(f, i) <= BG_SAT) ? 1 : 0;
  const dist = distanceTo(visible, w, h);

  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const o = i * 4;
      const edge = Math.min(x, y, w - 1 - x, h - 1 - y);
      if (hull[i]) {
        // Scene: unchanged, except near-white lifts smoothly to white.
        const t = 1 - smoothstep(KNEE, 2 * KNEE + 4, 255 - minc(f, i));
        for (let ch = 0; ch < 3; ch++) px[o + ch] = Math.round(f[i * 3 + ch] + (255 - f[i * 3 + ch]) * t);
      } else if (bg[i]) {
        // Paper: only soft shadows near visible pieces, neutral grey.
        let d = Math.max(0, soft[i] - KNEE) * (255 / (255 - KNEE));
        d *= 1 - smoothstep(SHADOW_NEAR, SHADOW_FAR, dist[i]);
        if (edge < EDGE) d *= edge / EDGE;
        for (let ch = 0; ch < 3; ch++) px[o + ch] = Math.round(255 - d);
      } else {
        const t = edge < EDGE ? 1 - edge / EDGE : 0;
        for (let ch = 0; ch < 3; ch++) px[o + ch] = Math.round(f[i * 3 + ch] + (255 - f[i * 3 + ch]) * t);
      }
    }
  return true;
}
