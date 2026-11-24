// Stickers, shared by several screens (Words, the word page, the table): the
// sheets that make, stick, rename and delete them. A sticker is a label stuck
// on words (src/domain/labels.ts); each one is a pile on the table.
import { app, errorText, sheet } from "../app";
import type { Label } from "../domain/collection";
import type { EntityId } from "../domain/ids";
import { LABEL_COLORS, LABEL_MAX, labelColor, labelName } from "../domain/labels";
import { h, toast } from "../ui/h";

const plural = (n: number, word: string) => `${n} ${n === 1 ? word : `${word}s`}`;

/** Give an element (and what is inside it) a sticker's paper colour; it follows later changes (`repaint`). */
export function paint<E extends HTMLElement>(el: E, l: Pick<Label, "id" | "color">): E {
  const c = labelColor(l);
  el.style.setProperty("--sticker", `var(--st-${c})`);
  el.style.setProperty("--sticker-on", `var(--st-${c}-on)`);
  el.dataset.label = String(l.id);
  return el;
}

/** After a colour change: everything painted with that sticker takes the new colour. */
function repaint(l: Label): void {
  for (const el of document.querySelectorAll<HTMLElement>(`[data-label="${l.id}"]`)) paint(el, l);
}

/** A sticker as it looks: a scrap of coloured paper with its name. */
export function stickerTag(l: Pick<Label, "id" | "name" | "color">, ...extra: (Node | string | null)[]): HTMLElement {
  return paint(h("span", { class: "sticker" }, h("span", { class: "t" }, l.name), ...extra), l);
}

function nameInput(value = ""): HTMLInputElement {
  return h("input", { name: "sticker", value, maxlength: LABEL_MAX, autocomplete: "off", autocapitalize: "off", required: true });
}

async function saving(f: () => Promise<void>): Promise<void> {
  try {
    await f();
  } catch (e) {
    toast(`Could not save: ${errorText(e)}`);
  }
}

/** "New sticker": a name, then it is made (or the one with that name found) and `made` gets it. */
export function newStickerSheet(made: (id: EntityId) => void): void {
  const name = nameInput();
  const go = h("button", { class: "primary wide", type: "submit", disabled: true }, "Make sticker");
  name.addEventListener("input", () => (go.disabled = !labelName(name.value)));
  const close = sheet(
    "New sticker",
    "New sticker",
    h(
      "form",
      {
        class: "sheet-form",
        onsubmit: (e: Event) => {
          e.preventDefault();
          if (!labelName(name.value)) return;
          void saving(async () => {
            const id = await app.store.makeLabel(name.value);
            close();
            made(id);
          });
        },
      },
      h("label", {}, "Name", name),
      go,
    ),
  );
}

/**
 * Stickers on these words: every sticker with a box on for all of them, half
 * for some, off for none. A tap sticks it on all or peels it off all, at once.
 * A name typed makes a new one, stuck on all.
 */
export function stickersSheet(noteIds: EntityId[], changed: () => void): void {
  const { store } = app;
  const rows = h("div", { class: "sticker-rows" });
  const render = () => {
    rows.replaceChildren(
      ...store.col.liveLabels().map((l) => {
        const on = noteIds.filter((id) => store.col.wears(id, l.id)).length;
        const state = on === 0 ? "none" : on === noteIds.length ? "all" : "some";
        return h(
          "button",
          {
            class: "sticker-opt",
            type: "button",
            role: "checkbox",
            "aria-checked": state === "all" ? "true" : state === "some" ? "mixed" : "false",
            onclick: () =>
              saving(async () => {
                await store.stick(l.id, noteIds, state !== "all");
                render();
                changed();
              }),
          },
          h("span", { class: `box ${state}`, "aria-hidden": "true" }),
          stickerTag(l),
          state === "some" ? h("span", { class: "n small" }, `${on} of ${noteIds.length}`) : null,
        );
      }),
    );
  };
  render();
  const name = nameInput();
  name.placeholder = "New sticker";
  name.required = false;
  name.setAttribute("aria-label", "New sticker");
  const add = h("button", { class: "secondary", type: "submit" }, "Stick");
  const close = sheet(
    "Stickers",
    noteIds.length === 1 ? "Stickers" : `Stickers for ${plural(noteIds.length, "word")}`,
    rows,
    h(
      "form",
      {
        class: "inline",
        onsubmit: (e: Event) => {
          e.preventDefault();
          if (!labelName(name.value)) return;
          void saving(async () => {
            const id = await store.makeLabel(name.value);
            await store.stick(id, noteIds, true);
            name.value = "";
            render();
            changed();
          });
        },
      },
      name,
      add,
    ),
    h("button", { class: "primary wide", type: "button", onclick: () => close() }, "Done"),
  );
}

/**
 * The pencil on an open sticker: rename it (to another sticker's name: merge
 * into that one), or delete it. `changed` gets the sticker its words wear
 * now, or undefined once deleted.
 */
export function pencilSheet(id: EntityId, changed: (now: EntityId | undefined) => void): void {
  const { store } = app;
  const label = store.col.liveLabel(id);
  if (!label) return;
  const words = store.col.labelNotes(id).length;
  const name = nameInput(label.name);
  const rename = h("button", { class: "primary wide", type: "submit" }, "Rename");
  name.addEventListener("input", () => {
    const other = store.col.labelByName(name.value);
    rename.textContent = other && other.id !== id ? `Merge into ${other.name}` : "Rename";
    rename.disabled = !labelName(name.value);
  });
  // Its colour: a row of dot stickers, the current one ringed; a tap changes it at once.
  const swatches = h("div", { class: "swatches", role: "radiogroup", "aria-label": "Colour" });
  const renderSwatches = () =>
    swatches.replaceChildren(
      ...LABEL_COLORS.map((c) => {
        const on = labelColor(label) === c;
        const b = h("button", {
          class: `swatch${on ? " on" : ""}`,
          type: "button",
          role: "radio",
          "aria-checked": String(on),
          "aria-label": c,
          onclick: () =>
            saving(async () => {
              if (labelColor(label) === c) return;
              await store.colorLabel(id, c);
              repaint(label);
              renderSwatches();
            }),
        });
        b.style.setProperty("--sticker", `var(--st-${c})`);
        return b;
      }),
    );
  renderSwatches();
  const close = sheet(
    label.name,
    h("span", {}, "Sticker ", stickerTag(label)),
    swatches,
    h(
      "form",
      {
        class: "sheet-form",
        onsubmit: (e: Event) => {
          e.preventDefault();
          if (!labelName(name.value)) return;
          void saving(async () => {
            const now = await store.renameLabel(id, name.value);
            close();
            changed(now);
          });
        },
      },
      h("label", {}, "Name", name),
      rename,
    ),
    h(
      "button",
      {
        class: "danger wide",
        type: "button",
        onclick: () =>
          saving(async () => {
            if (!confirm(`Delete the sticker "${label.name}"?${words ? ` It comes off its ${plural(words, "word")}; the words stay.` : ""}`)) return;
            await store.deleteLabel(id);
            close();
            changed(undefined);
          }),
      },
      "Delete sticker",
    ),
  );
}
