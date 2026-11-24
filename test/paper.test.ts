import { describe, expect, it } from "bun:test";
import { flattenPaper } from "../src/domain/paper";

const W = 192;
const H = 128;

/** Grey photographed paper with a vignette, and a coloured paper piece in the middle. */
function photo(fill?: (x: number, y: number) => [number, number, number]): Uint8ClampedArray {
  const px = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const v = 245 - 40 * ((x / W - 0.3) ** 2 + (y / H - 0.3) ** 2); // ~245 to ~225
      const inside = x > 50 && x < 140 && y > 35 && y < 95;
      const c: [number, number, number] = fill ? fill(x, y) : inside ? [0.85 * v, 0.4 * v, 0.3 * v] : [v, v, v * 1.01];
      px.set([...c, 255], (y * W + x) * 4);
    }
  return px;
}
const at = (px: Uint8ClampedArray, x: number, y: number) => Array.from(px.slice((y * W + x) * 4, (y * W + x) * 4 + 3));

describe("flattenPaper", () => {
  it("turns the vignetted paper pure white and keeps the paper piece's colour", () => {
    const px = photo();
    expect(flattenPaper(px, W, H)).toBe(true);
    for (const [x, y] of [[2, 2], [W - 3, H - 3], [30, 64], [170, 20], [96, 110]]) expect(at(px, x, y)).toEqual([255, 255, 255]);
    const [r, g, b] = at(px, 96, 64);
    // The piece was 0.85 / 0.4 / 0.3 of the paper's brightness: same after flattening.
    expect(r).toBeGreaterThan(205);
    expect(r).toBeLessThan(225);
    expect(Math.abs(g - 102)).toBeLessThan(8);
    expect(Math.abs(b - 77)).toBeLessThan(8);
  });

  it("leaves a picture alone when the scene fills the whole frame", () => {
    const px = photo((x, y) => [(x * 7) % 255, (y * 5) % 255, 90]);
    const before = px.slice();
    expect(flattenPaper(px, W, H)).toBe(false);
    expect(px).toEqual(before);
  });

  it("leaves dark or coloured backgrounds alone", () => {
    expect(flattenPaper(photo(() => [60, 70, 80]), W, H)).toBe(false);
    expect(flattenPaper(photo(() => [240, 180, 120]), W, H)).toBe(false);
  });
});
