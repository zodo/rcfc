// Whether cards read their word aloud by themselves: a scrap of card stock lying
// on the table (the Study tab's title line, and study's top corner). Its white
// side has a speaker drawn in pencil; tapped, it turns over to its cream side,
// "shh". It only switches (Speech.auto); the speakers on a card say the word.
import { app } from "../app";
import { h, toast } from "./h";
import { haptic } from "./paper";

const SPEAKER =
  '<svg viewBox="0 0 32 24" aria-hidden="true"><path d="M5.2 9.1 L9.6 9 L15.1 4.6 L15.4 19.2 L9.8 15.1 L5.1 15.3 Z" /><path d="M19.4 8.6 C21 10.4 21.1 13.5 19.5 15.4" /><path d="M23.1 5.6 C26.3 8.9 26.4 15.2 23.3 18.5" /></svg>';

/** The scrap; `onChange(on)` after a tap (study says the word on top when switched on). */
export function autoReadScrap(onChange?: (on: boolean) => void): HTMLElement {
  const b = h("button", { class: "auto-read", type: "button", "aria-label": "Read words aloud by themselves" });
  const on = h("span", { class: "ar-side on" });
  on.innerHTML = SPEAKER;
  const off = h("span", { class: "ar-side off", lang: "en" }, "shh");
  b.append(on, off);
  const draw = () => {
    const v = app.speech.auto;
    b.classList.toggle("quiet", !v);
    b.setAttribute("aria-pressed", String(v));
  };
  b.addEventListener("click", () => {
    const v = !app.speech.auto;
    app.speech.auto = v;
    if (!v) app.speech.hush();
    haptic("tap");
    // Turned over like a card: narrowed to its edge, the other side up, widened again.
    b.classList.add("turning");
    setTimeout(() => {
      draw();
      b.classList.remove("turning");
    }, 120);
    toast(v ? "Cards read aloud by themselves" : "Cards stay quiet until you tap a speaker");
    onChange?.(v);
  });
  draw();
  return b;
}
