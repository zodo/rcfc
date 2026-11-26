// A card's picture, pasted on: shared by study, the card editor and lists.
import { app } from "../app";
import type { EntityId } from "../domain/ids";
import { h } from "./h";
import { SketchNote } from "./sketch";

/**
 * A card picture. With a white paper background it blends into the card, so
 * only the drawn paper cut-outs and their shadows show; otherwise (or in dark
 * mode, or with `paper`: the card editor) it is a scissor-cut piece glued onto the card.
 */
export function cutout(key: string, tilt: "l" | "r" = "l", paper = false): HTMLElement {
  const img = h("img", { alt: "", decoding: "async" });
  const el = h("div", { class: `pic tilt-${tilt}` }, img);
  void app.pictures.view(key).then((v) => {
    if (!v) return el.remove(); // offline and never downloaded
    el.classList.add(v.flat && !paper ? "flat" : "cut");
    img.src = v.url;
  });
  return el;
}

/** A card picture once its image is ready to show (for gluing it on); null if it can't be had. `paper`: always on its piece of paper. */
export async function cutoutReady(key: string, tilt: "l" | "r" = "l", paper = false): Promise<HTMLElement | null> {
  const v = await app.pictures.view(key);
  if (!v) return null;
  const img = h("img", { alt: "", decoding: "async" });
  img.src = v.url;
  await img.decode().catch(() => {});
  return h("div", { class: `pic tilt-${tilt} ${v.flat && !paper ? "flat" : "cut"}` }, img);
}

/**
 * The picture of a card that has none yet (study): nothing until the queue
 * draws it; then the pencil writes what it will show, and the picture is
 * glued on when it comes. `covered`: the card lies under another one (study's
 * peeked card): the picture is just put in its place, never brought in, since
 * the flight would show over the card on top of it.
 */
export function livePicture(noteId: EntityId, tilt: "l" | "r" = "l", covered = false): HTMLElement {
  const el = h("div", { class: "pic-live" });
  let sketch: SketchNote | undefined;
  let seen = false;
  let done = false;
  const update = () => {
    if (done) return;
    const n = app.store.col.liveNote(noteId);
    if (n?.picture) {
      done = true;
      off();
      const key = n.picture.key;
      void cutoutReady(key, tilt).then(async (pic) => {
        if (!pic) return;
        if (sketch && el.isConnected && !covered) await sketch.glue(pic);
        sketch?.close();
        el.replaceChildren(pic);
      });
      return;
    }
    if (app.pictures.state(noteId) !== "drawing") return;
    if (!sketch) el.replaceChildren((sketch = new SketchNote()).el);
    const t = app.pictures.text(noteId);
    if (t) sketch.text(t);
  };
  const off = app.pictures.subscribe((id) => {
    if (el.isConnected) seen = true;
    else if (seen) {
      // taken off the screen
      off();
      sketch?.close();
      return;
    }
    if (id === noteId) update();
  });
  update();
  return el;
}
