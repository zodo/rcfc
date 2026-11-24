// Study tab: the table. Every language and every sticker has a spot printed on
// it with its pile for today: thickness = cards left, the top card face up, the
// colours of the cards under it (fixed once shown, the same in study:
// src/session.ts). Tap a pile to study it. A finished pile leaves its spot with
// a check; tap the spot for more cards or the same ones again: they land on the
// spot, and a tap on the pile studies them. A sticker with no words has its spot
// printed empty, and the last spot is always a new pile (a new sticker). First
// launch asks which language to learn.
import { app, go, page, sheet as openSheet } from "../app";
import { derivedEntityId } from "../domain/ids";
import { labelPile } from "../domain/labels";
import { languagePile, MORE } from "../domain/piles";
import { StudySession } from "../session";
import { h, langName } from "../ui/h";
import { haptic, seeded } from "../ui/paper";
import { cutout } from "../ui/picture";
import { editSticker, languageForm, languages, rememberLanguage, setOpenLanguage } from "./languages";
import { newStickerSheet, stickerTag } from "./stickers";

/** Edges drawn under the top card; deeper cards only make the pile no thicker. */
const EDGES = 30;
/** Thickness of one card, px. */
const CARD_PX = 1.5;

const ICON_PLUS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
const ICON_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path pathLength="1" d="M5 12.5l4.5 4.5L19 7"/></svg>';

export async function home(): Promise<void> {
  if (app.reloadPending) return location.reload();
  const langs = languages();
  if (langs.length === 0) {
    page(
      "home",
      "Welcome",
      h("p", {}, "Flashcards scheduled by RWKV, a neural memory model that runs on your device."),
      languageForm(() => go.add(), "Start"),
    );
    return;
  }
  // Re-drawn in place (a pile refilled): the table stays while the new one is made.
  if (!(app.current === "home" && app.root.querySelector(".table"))) page("home", "Study", h("p", { class: "muted" }, "Loading…"));
  const moved = { cleared: app.cleared, refilled: app.refilled };
  app.cleared = app.refilled = null;
  const spots = [];
  for (const l of langs) spots.push(await spot(languagePile(l), langName(l), moved));
  for (const l of app.store.col.liveLabels()) spots.push(await spot(labelPile(l.id), l.name, moved));
  spots.push(newPile());
  if (app.current !== "home") return; // left while loading
  page("home", "Study", h("div", { class: "table" }, ...spots));
}

/** What just happened to a pile, for its spot to show it. */
interface Moved {
  cleared: string | null;
  refilled: string | null;
}

/** When the check is drawn (ms after the spot appears; style.css .spot.fresh). */
const CHECK_DRAWN = 780;
/** How long the cards of a refilled pile take to land, all of them (style.css .spot.dealt). */
const LANDING_MS = 420;

/** One pile's spot (a language's or a sticker's): its pile, or the outline a finished pile leaves. */
async function spot(key: string, label: string, moved: Moved): Promise<HTMLElement> {
  const s = new StudySession(app.store, key);
  const name = h("div", { class: "pile-name" }, s.label === undefined ? label : stickerTag(app.store.col.liveLabel(s.label)!));
  if (s.label !== undefined && s.allCount() === 0) {
    const id = s.label;
    return h("div", { class: "pile-cell" }, h("button", { class: "spot empty", "aria-label": `${label}: add words`, onclick: () => editSticker(id) }), name, h("div", { class: "pile-count" }, "no words yet"));
  }
  const seed = derivedEntityId(s.pile) % 233280; // the pile's own poses, the same every time
  await s.prepare();
  const n = s.next();
  if (!n) {
    const done = s.doneToday().length;
    const fresh = moved.cleared === s.pile && done > 0;
    const b = h("button", { class: `spot finished${fresh ? " fresh" : ""}`, "aria-label": `${label}: more cards`, onclick: () => sheet(label, s) });
    if (done) b.innerHTML = ICON_CHECK;
    if (fresh) {
      b.append(...flecks(seed));
      setTimeout(() => haptic("double"), CHECK_DRAWN);
    }
    return h("div", { class: "pile-cell" }, b, name, h("div", { class: "pile-count" }, done ? "done for today" : "nothing due"));
  }
  const pile = h("span", { class: "pile-stack" });
  const faces = s.faces(Math.min(EDGES, n.left - 1));
  const r = seeded(seed);
  for (let i = faces.length; i >= 1; i--) {
    const edge = h("span", { class: `pile-edge${faces[i - 1] === "reverse" ? " known" : ""}${i === faces.length ? " last" : ""}` });
    edge.style.transform = `translate(${((r() - 0.5) * 2).toFixed(1)}px,${(i * CARD_PX).toFixed(1)}px) rotate(${((r() - 0.5) * 1).toFixed(2)}deg)`;
    pile.appendChild(edge);
  }
  pile.appendChild(topCard(n.pick.card));
  const dealt = moved.refilled === s.pile;
  if (dealt) {
    // Dropped on the spot as one handful: the bottom card first, the top one last, nothing turned up on the way.
    const cards = [...pile.children] as HTMLElement[];
    const step = Math.min(60, LANDING_MS / cards.length);
    cards.forEach((c, i) => c.style.setProperty("--d", `${Math.round(i * step)}ms`));
    setTimeout(() => haptic("thud"), Math.round(cards.length * step) + 180);
  }
  const study = () => {
    if (s.lang === undefined) return go.study(s.pile);
    rememberLanguage(s.lang);
    go.study(s.lang);
  };
  const b = h("button", { class: `spot${dealt ? " dealt" : ""}`, "aria-label": `Study ${label}`, onclick: study }, pile);
  b.style.marginBottom = `${Math.round(faces.length * CARD_PX)}px`;
  return h("div", { class: "pile-cell" }, b, name, h("div", { class: "pile-count" }, `${n.left} ${n.left === 1 ? "card" : "cards"}`));
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

/** The top card as it lies: a forward card white side up (the word), a reverse one cream side up (picture and translation). */
function topCard(cardId: number): HTMLElement {
  const { col } = app.store;
  const card = col.cards.get(cardId)!;
  const note = col.notes.get(card.note_id)!;
  if (card.template === "forward") return h("span", { class: "pile-top", lang: note.lang_pair.from }, h("span", { class: "pile-word" }, note.fields.front));
  return h("span", { class: "pile-top known", lang: note.lang_pair.to }, note.picture ? cutout(note.picture.key) : null, h("span", { class: "pile-word" }, note.fields.back));
}

/** The spot for a new pile, always last: makes a sticker, then Words opens on it to stick it on words. */
function newPile(): HTMLElement {
  const b = h("button", { class: "spot new-pile", "aria-label": "New pile", onclick: () => newStickerSheet(editSticker) });
  b.innerHTML = ICON_PLUS;
  return h("div", { class: "pile-cell" }, b, h("div", { class: "pile-name" }, "New pile"), h("div", { class: "pile-count" }, "\u00a0"));
}

/**
 * A finished spot, tapped: more cards or the same ones again (put on the spot,
 * not studied yet), or words to add. A sticker's pile also deals all its words.
 */
function sheet(label: string, s: StudySession): void {
  const done = s.doneToday();
  const more = s.moreCount();
  const all = s.allCount();
  const showMore = more > 0 && (s.label === undefined || all > MORE);
  /** The pile is on its spot again: back to the table to watch it land. */
  const refill = () => {
    close();
    if (s.lang !== undefined) rememberLanguage(s.lang);
    app.refilled = s.pile;
    void home();
  };
  const buttons: HTMLElement[] = [];
  const button = (text: string, f: () => void) => buttons.push(h("button", { class: `${buttons.length ? "secondary" : "primary"} wide`, onclick: f }, text));
  if (showMore)
    button(`Deal ${more} more`, async () => {
      await s.more();
      refill();
    });
  if (all > 0)
    button(`Deal all ${all}`, async () => {
      await s.all();
      refill();
    });
  if (done.length) button(done.length === 1 ? "Go through it again" : `Go through these ${done.length} again`, () => (s.againThese(done), refill()));
  if (s.lang !== undefined && !more && !s.unseenLeft())
    button("Add words", () => {
      close();
      setOpenLanguage(s.lang!);
      go.add();
    });
  const close = openSheet(label, s.label === undefined ? label : stickerTag(app.store.col.liveLabel(s.label)!), ...buttons);
}
