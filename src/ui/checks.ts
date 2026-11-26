// The pencil checks a finished pile gets: one for the day's pile, and a second,
// blue one once more was dealt and finished, with ×N beside it from the second
// time on. Never more than two checks, however many handfuls. Drawn on the
// study table when a pile is finished (fresh: in one pencil stroke, with bits
// of coloured paper jumping off it) and on the pile's spot on the table.
import { h } from "./h";
import { seeded } from "./paper";

const CHECK = "M5 12.5l4.5 4.5L19 7";
const BONUS = "M15 16.5l4.5 4.5L29 11";

/** When a fresh check is drawn (ms after it appears; style.css .checks.fresh). */
export const CHECK_DRAWN = 780;

/** The checks for a pile finished after `rounds` deals of more today; `fresh`: the last one draws itself in. */
export function checks(rounds: number, fresh = false, seed = 0): HTMLElement {
  const bonus = rounds > 0;
  const path = (d: string, cls: string) => `<path class="${cls}" pathLength="1" d="${d}"/>`;
  const svg = `<svg viewBox="0 0 ${bonus ? 34 : 24} 24" fill="none" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path(CHECK, "check")}${bonus ? path(BONUS, "check bonus") : ""}</svg>`;
  const el = h("span", { class: `checks${bonus ? " two" : ""}${fresh ? " fresh" : ""}`, "aria-hidden": "true" });
  el.innerHTML = svg;
  if (rounds > 1) el.append(h("span", { class: "times" }, `×${rounds}`));
  if (fresh) el.append(...flecks(seed));
  return el;
}

/** Bits of coloured paper that jump off a check as it is drawn. */
function flecks(seed: number): HTMLElement[] {
  const r = seeded(seed + 7);
  const colours = ["--again", "--good", "--easy", "--new", "--highlight"];
  return Array.from({ length: 9 }, (_, i) => {
    const a = -Math.PI / 2 + (i - 4) * 0.36 + (r() - 0.5) * 0.3; // a fan, upwards
    const dist = 46 + r() * 34;
    const f = h("span", { class: "fleck", "aria-hidden": "true" });
    f.style.setProperty("--x", `${(Math.cos(a) * dist).toFixed(0)}px`);
    f.style.setProperty("--y", `${(Math.sin(a) * dist).toFixed(0)}px`);
    f.style.setProperty("--r", `${((r() - 0.5) * 540).toFixed(0)}deg`);
    f.style.setProperty("--c", `var(${colours[i % colours.length]})`);
    f.style.setProperty("--cut", `var(--cut-${1 + (i % 4)})`);
    return f;
  });
}
