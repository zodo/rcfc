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
  // Ways of clicking a hidden switch, to find the one WebKit gives a tap for.
  const variants: [string, () => void][] = [
    ["head, display none, label", () => tryClick(document.head, "none", "label")],
    ["body, display none, label", () => tryClick(document.body, "none", "label")],
    ["body, transparent, label", () => tryClick(document.body, "clear", "label")],
    ["body, transparent, input", () => tryClick(document.body, "clear", "input")],
    ["kept in body, transparent, label", () => kept.click()],
  ];
  const kept = makeSwitch("clear");
  document.body.append(kept);
  const real = h("label", { style: "display:flex;gap:10px;align-items:center;font-size:18px" }, h("input", { type: "checkbox", switch: "" }), "A real switch: tap it yourself");
  root.replaceChildren(
    h(
      "section",
      { style: "display:flex;flex-direction:column;gap:14px;padding:18px" },
      h("p", {}, `navigator.vibrate: ${typeof navigator.vibrate === "function" ? "yes" : "no"}`),
      h("p", {}, navigator.userAgent),
      h("div", { class: "card-box" }, real),
      h("div", { class: "card-box" }, h("h2", {}, "Hidden switch, clicked from code"), ...variants.map(([name, fire]) => h("button", { class: "secondary", type: "button", onclick: fire }, name))),
      row("haptic(): on tap", (k) => haptic(k)),
      row("On touch down", (k) => haptic(k), "pointerdown"),
      row("300 ms after the tap", (k) => setTimeout(() => haptic(k), 300)),
      pad,
    ),
  );
}

function makeSwitch(hide: "none" | "clear"): HTMLLabelElement {
  const label = document.createElement("label");
  label.ariaHidden = "true";
  label.style.cssText = hide === "none" ? "display:none" : "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0.01;pointer-events:none";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.setAttribute("switch", "");
  label.append(input);
  return label;
}

function tryClick(parent: HTMLElement, hide: "none" | "clear", what: "label" | "input"): void {
  const label = makeSwitch(hide);
  parent.append(label);
  (what === "label" ? label : label.querySelector("input")!).click();
  label.remove();
}
