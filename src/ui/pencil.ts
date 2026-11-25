// Pencil marks on paper: a note with a hand-drawn arrow pointing up at the
// place it is about, and a word in it that opens a picker.
import { h } from "./h";

const ARROW = '<svg viewBox="0 0 40 34" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M36 30C24 28 14 20 12 4"/><path d="M7 9l5-6 4 6"/></svg>';

/** A pencil note under a place, its arrow pointing up at it. */
export function arrowNote(cls = ""): { el: HTMLElement; text: HTMLElement } {
  const text = h("span", { class: "arrow-text" });
  const el = h("div", { class: `arrow-note ${cls}`.trim() }, h("span", { class: "arrow" }), text);
  el.firstElementChild!.innerHTML = ARROW;
  return { el, text };
}

/**
 * A word in pencil that opens a native picker: blue with a dotted underline,
 * the select lying invisibly on top so a tap opens the system's list.
 */
export function pickWord(select: HTMLSelectElement, label: string): { el: HTMLElement; text: HTMLElement } {
  const text = h("span", {});
  select.setAttribute("aria-label", label);
  return { el: h("span", { class: "pick-word" }, text, select), text };
}
