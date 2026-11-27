// The marks of the chats people use (ChatGPT's knot, Claude's spark, Gemini's
// star), cut from coloured paper and glued on a white backing cut roughly
// round each one with straight scissor cuts, like the card pictures. Drawn on
// a canvas (a bitmap, as the app's textures are), all the same size.

export type Mark = "chatgpt" | "claude" | "gemini";
export const MARKS: Mark[] = ["chatgpt", "claude", "gemini"];

type Pt = [number, number];

/** One mark, `size` CSS px square; `seed` fixes its cuts. */
export function paperMark(kind: Mark, size: number, seed = 7): HTMLCanvasElement {
  let s = seed >>> 0;
  const rnd = () => ((s = (s + 0x6d2b79f5) >>> 0), (((s ^ (s >>> 15)) * (1 | s)) >>> 0) / 4294967296);
  const dpr = Math.min(3, Math.max(2, Math.ceil(window.devicePixelRatio || 1)));
  const W = Math.round(size * dpr), R = W * 0.36, c = W / 2;
  const cv = document.createElement("canvas");
  cv.width = cv.height = W;
  cv.style.width = cv.style.height = `${size}px`;
  cv.setAttribute("aria-hidden", "true");
  const x = cv.getContext("2d");
  if (!x) return cv;

  /** A closed outline resampled every `step` px, each point nudged a little: scissor cuts. */
  const cut = (pts: Pt[], step: number, amp: number): Pt[] => {
    const out: Pt[] = [];
    for (let i = 0; i < pts.length; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % pts.length];
      const n = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay) / step));
      for (let k = 0; k < n; k++) out.push([ax + ((bx - ax) * k) / n + (rnd() - 0.5) * amp, ay + ((by - ay) * k) / n + (rnd() - 0.5) * amp]);
    }
    return out;
  };
  const path = (polys: Pt[][]) => {
    x.beginPath();
    for (const p of polys) {
      x.moveTo(p[0][0], p[0][1]);
      for (const q of p.slice(1)) x.lineTo(q[0], q[1]);
      x.closePath();
    }
  };
  const rot = (px: number, py: number, a: number): Pt => [c + px * Math.cos(a) - py * Math.sin(a), c + px * Math.sin(a) + py * Math.cos(a)];

  let shapes: Pt[][] = [];
  let color: string;
  /** The knot is cut as strips of paper (an outline); the others are filled. */
  const strips = kind === "chatgpt";
  if (kind === "claude") {
    // the spark: rays of uneven length round a small middle
    color = "#d97757";
    const n = 12;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + (rnd() - 0.5) * 0.12;
      const len = R * (0.72 + rnd() * 0.3), w0 = R * 0.2, w1 = R * 0.17;
      shapes.push([rot(0, -w0 / 2, a), rot(len, -w1 / 2, a), rot(len + w1 * 0.4, 0, a), rot(len, w1 / 2, a), rot(0, w0 / 2, a)]);
    }
  } else if (kind === "gemini") {
    // the four-point star with curved sides
    color = "#5a7cf0";
    const pts: Pt[] = [];
    for (let i = 0; i < 160; i++) {
      const t = (i / 160) * Math.PI * 2, co = Math.cos(t), si = Math.sin(t);
      pts.push([c + Math.sign(co) * Math.abs(co) ** 3.4 * R * 1.12, c + Math.sign(si) * Math.abs(si) ** 3.4 * R * 1.12]);
    }
    shapes.push(pts);
  } else {
    // the knot: six rounded links, each turned 60° and slid along itself, so they twist like a pinwheel
    color = "#1d1f1e";
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2, L = R * 0.62, H = R * 0.21, off = R * 0.4, sh = R * 0.2, pts: Pt[] = [];
      for (let i = 0; i <= 20; i++) {
        const t = -Math.PI / 2 + (i / 20) * Math.PI;
        pts.push(rot(sh + L / 2 + Math.cos(t) * H, off + Math.sin(t) * H, a));
      }
      for (let i = 0; i <= 20; i++) {
        const t = Math.PI / 2 + (i / 20) * Math.PI;
        pts.push(rot(sh - L / 2 + Math.cos(t) * H, off + Math.sin(t) * H, a));
      }
      shapes.push(pts);
    }
  }
  // Every mark the same size: its farthest point (a strip's edge included) at R.
  const half = strips ? R * 0.055 : 0;
  const reach = Math.max(...shapes.flat().map(([px, py]) => Math.hypot(px - c, py - c))) + half;
  const k = R / reach;
  shapes = shapes.map((p) => p.map(([px, py]): Pt => [c + (px - c) * k, c + (py - c) * k]));
  const cutShapes = shapes.map((p) => cut(p, W * 0.035, W * 0.006));

  // The white backing: a rough polygon round everything, 13-16 straight cuts.
  const all = shapes.flat();
  const nb = 13 + Math.floor(rnd() * 4), back: Pt[] = [];
  const a0 = rnd();
  for (let i = 0; i < nb; i++) {
    const a = ((i + a0 + (rnd() - 0.5) * 0.5) / nb) * Math.PI * 2;
    let m = 0;
    for (const [px, py] of all) m = Math.max(m, (px - c) * Math.cos(a) + (py - c) * Math.sin(a));
    const r = m + W * 0.05 + half;
    back.push([c + Math.cos(a) * r, c + Math.sin(a) * r]);
  }
  x.save();
  x.shadowColor = "rgba(20,30,20,.28)";
  x.shadowBlur = W * 0.025;
  x.shadowOffsetY = W * 0.012;
  path([back]);
  x.fillStyle = "#fbfaf6";
  x.fill();
  x.restore();

  path(cutShapes);
  if (strips) {
    x.lineJoin = "round";
    x.lineWidth = R * 0.11;
    x.strokeStyle = color;
    x.stroke();
  } else {
    x.fillStyle = color;
    x.fill();
  }

  // Grain over the paper drawn.
  const g = document.createElement("canvas");
  g.width = g.height = 64;
  const gx = g.getContext("2d");
  if (gx) {
    const id = gx.createImageData(64, 64);
    for (let i = 0; i < id.data.length; i += 4) {
      const v = 128 + (rnd() - 0.5) * 255;
      id.data[i] = id.data[i + 1] = id.data[i + 2] = v;
      id.data[i + 3] = 26;
    }
    gx.putImageData(id, 0, 0);
    const pattern = x.createPattern(g, "repeat");
    if (pattern) {
      x.globalCompositeOperation = "source-atop";
      x.fillStyle = pattern;
      x.fillRect(0, 0, W, W);
    }
  }
  return cv;
}

/** The three marks overlapping, each turned a little. */
export function marks(size: number): HTMLElement {
  const row = document.createElement("span");
  row.className = "marks";
  MARKS.forEach((m, i) => {
    const c = paperMark(m, size, 11 + i);
    c.style.rotate = `${[-6, 4, -3][i]}deg`;
    row.append(c);
  });
  return row;
}
