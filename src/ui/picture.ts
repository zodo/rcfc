// A card's picture, pasted on: shared by study, the card editor and lists.
import { app } from "../app";
import { h } from "./h";

/**
 * A card picture. With a white paper background it blends into the card, so
 * only the drawn paper cut-outs and their shadows show; otherwise (or in dark
 * mode) it is a scissor-cut piece glued onto the card.
 */
export function cutout(key: string, tilt: "l" | "r" = "l"): HTMLElement {
  const img = h("img", { alt: "", decoding: "async" });
  const el = h("div", { class: `pic tilt-${tilt}` }, img);
  void app.pictures.view(key).then((v) => {
    if (!v) return el.remove(); // offline and never downloaded
    el.classList.add(v.flat ? "flat" : "cut");
    img.src = v.url;
  });
  return el;
}
