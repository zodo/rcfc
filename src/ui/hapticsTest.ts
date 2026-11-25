// ?haptics: a page to feel each haptic on the phone (the iPhone path in
// paper.ts haptic() works only where WebKit allows it). In every build, so it
// runs on preview; nothing links to it.
import { haptic } from "./paper";
import { h } from "./h";

export function hapticsTest(root: HTMLElement): void {
  const kinds = ["tick", "tap", "thud", "double"] as const;
  const row = (title: string, fire: (k: (typeof kinds)[number]) => void, on: "click" | "pointerdown" = "click") =>
    h(
      "div",
      { class: "card-box" },
      h("h2", {}, title),
      h("div", { class: "chip-rows" }, ...kinds.map((k) => {
        const b = h("button", { class: "secondary", type: "button" }, k);
        b.addEventListener(on, () => fire(k));
        return b;
      })),
    );
  const pad = h("div", { class: "card-box", style: "height:160px;touch-action:none;display:grid;place-items:center" }, "Drag here: a tick every 40 px");
  let last: number | null = null;
  pad.addEventListener("pointerdown", (e) => (last = e.clientX));
  pad.addEventListener("pointermove", (e) => {
    if (last !== null && Math.abs(e.clientX - last) > 40) {
      last = e.clientX;
      haptic("tick");
    }
  });
  pad.addEventListener("pointerup", () => (last = null));
  root.replaceChildren(
    h(
      "section",
      { style: "display:flex;flex-direction:column;gap:14px;padding:18px" },
      h("p", {}, `navigator.vibrate: ${typeof navigator.vibrate === "function" ? "yes" : "no"}`),
      row("On tap", (k) => haptic(k)),
      row("On touch down", (k) => haptic(k), "pointerdown"),
      row("300 ms after the tap", (k) => setTimeout(() => haptic(k), 300)),
      pad,
    ),
  );
}
