// Picture UI shared by screens: the pasted cut-out on cards, and the editor on
// the add and edit screens (status, what it shows, meaning + details, redraw).
import { app } from "../app";
import type { EntityId } from "../domain/ids";
import { meanings } from "../domain/pictures";
import type { PicState } from "../pictures";
import { clear, h } from "./h";

/** A picture as a scissor-cut piece glued onto the card. Empty until the image is loaded. */
export function cutout(key: string, tilt: "l" | "r" = "l"): HTMLElement {
  const img = h("img", { alt: "", decoding: "async" });
  const el = h("div", { class: `cut cut-${tilt}` }, img);
  void app.pictures.url(key).then((url) => {
    if (url) img.src = url;
    else el.remove(); // offline and never downloaded
  });
  return el;
}

const STATE_TEXT: Record<PicState, string> = {
  queued: "Picture queued",
  drawing: "Drawing a picture…",
  waiting: "Today's free picture limit is used up. It will be drawn tomorrow.",
  failed: "The picture could not be drawn.",
};

/** Picture status and controls for one note. Updates itself while on screen. */
export function pictureEditor(noteId: EntityId): HTMLElement {
  const { store, pictures } = app;
  const media = h("div", { class: "pic-media" });
  const status = h("p", { class: "muted small pic-status" });
  const sense = h("input", { name: "sense", autocomplete: "off", placeholder: "Meaning to draw, e.g. bench" });
  const details = h("textarea", { name: "details", rows: 2, maxLength: 300, placeholder: "Details, e.g. a wooden bench in a park in autumn" });
  const chips = h("div", { class: "chips" });
  const drawBtn = h("button", { class: "secondary", type: "button" }, "Redraw");
  const removeBtn = h("button", { class: "secondary", type: "button" }, "No picture");
  const adjust = h(
    "details",
    { class: "pic-adjust" },
    h("summary", {}, "Change picture"),
    chips,
    h("label", {}, "Meaning", sense),
    h("label", {}, "Details", details),
    h("div", { class: "row" }, drawBtn, removeBtn),
  );
  const box = h("div", { class: "picture-editor" }, media, status, adjust);

  let shownKey: string | undefined;
  let filled = false;
  const render = () => {
    const n = store.col.liveNote(noteId);
    if (!n) return;
    const p = n.picture;
    const st = pictures.state(noteId);
    if (p?.key !== shownKey || (!p && !media.firstChild)) {
      shownKey = p?.key;
      clear(media);
      media.appendChild(p ? cutout(p.key) : h("div", { class: "pic-empty" }, st ? "" : n.noPicture ? "No picture" : "No picture yet"));
    }
    media.classList.toggle("busy", st === "drawing" || st === "queued");
    status.textContent = st ? STATE_TEXT[st] : p?.sense ? `Shows: ${p.sense}` : "";
    if (st === "failed") status.appendChild(h("button", { class: "link", type: "button", onclick: () => void pictures.retry(noteId) }, " Try again"));
    drawBtn.textContent = p ? "Redraw" : "Draw picture";
    drawBtn.disabled = st === "drawing" || st === "queued";
    removeBtn.hidden = !p;
    // Fill the fields once from the stored picture; never overwrite typing.
    if (!filled && p) {
      filled = true;
      sense.value = p.sense ?? "";
      details.value = p.details ?? "";
    }
    clear(chips);
    const ms = meanings(n.fields.back);
    if (ms.length > 1) for (const m of ms) chips.appendChild(h("button", { type: "button", class: `chip${sense.value.trim() === m ? " on" : ""}`, onclick: () => ((sense.value = m), render()) }, m));
  };
  sense.addEventListener("input", render);
  drawBtn.addEventListener("click", () => void pictures.draw(noteId, { sense: sense.value, details: details.value }));
  removeBtn.addEventListener("click", () => void pictures.remove(noteId));
  const off = pictures.subscribe((id) => {
    if (!box.isConnected) return off();
    if (id === noteId) render();
  });
  render();
  return box;
}
