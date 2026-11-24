// Study tab: the table. Every language has a spot printed on it with its pile
// for today: thickness = cards left, the top card face up, the colours of the
// cards under it (fixed once shown, the same in study: src/session.ts). Tap a
// pile to study it. A finished pile leaves its spot with a check; tap the spot
// for more cards or the same ones again. First launch asks which language to
// learn.
import { app, go, page } from "../app";
import type { Deck } from "../domain/collection";
import { StudySession } from "../session";
import { h } from "../ui/h";
import { haptic, seeded } from "../ui/paper";
import { cutout } from "../ui/picture";
import { deckLabel, decks, languageForm, rememberDeck } from "./decks";

/** Edges drawn under the top card; deeper cards only make the pile no thicker. */
const EDGES = 30;
/** Thickness of one card, px. */
const CARD_PX = 1.5;

const ICON_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path pathLength="1" d="M5 12.5l4.5 4.5L19 7"/></svg>';

export async function home(): Promise<void> {
  if (app.reloadPending) return location.reload();
  if (decks().length === 0) {
    page(
      "home",
      "Welcome",
      h("p", {}, "Flashcards scheduled by RWKV, a neural memory model that runs on your device."),
      languageForm(() => go.words(), "Start"),
    );
    return;
  }
  page("home", "Study", h("p", { class: "muted" }, "Loading…"));
  const cleared = app.cleared;
  app.cleared = null;
  const spots = [];
  for (const d of decks()) spots.push(await spot(d, cleared));
  if (app.current !== "home") return; // left while loading
  page("home", "Study", h("div", { class: "table" }, ...spots));
  if (cleared) haptic("double");
}

/** One language's spot: its pile, or the outline a finished pile leaves. */
async function spot(d: Deck, cleared: string | null): Promise<HTMLElement> {
  const { store } = app;
  const name = h("div", { class: "pile-name" }, deckLabel(d));
  if (!store.col.liveCards(d.id).length) {
    const b = h("button", { class: "spot empty", "aria-label": `Add words to ${deckLabel(d)}`, onclick: () => (rememberDeck(d.id), go.words()) });
    return h("div", { class: "pile-cell" }, b, name, h("div", { class: "pile-count" }, "no words yet"));
  }
  const s = new StudySession(store, d.lang_pair);
  await s.prepare();
  const n = s.next();
  if (!n) {
    const done = s.doneToday().length;
    const b = h("button", { class: `spot finished${cleared === s.pile ? " fresh" : ""}`, "aria-label": `${deckLabel(d)}: more cards`, onclick: () => sheet(d, s) });
    if (done) b.innerHTML = ICON_CHECK;
    return h("div", { class: "pile-cell" }, b, name, h("div", { class: "pile-count" }, done ? "done for today" : "nothing due"));
  }
  const pile = h("span", { class: "pile-stack" });
  const faces = s.faces(Math.min(EDGES, n.left - 1));
  const r = seeded(d.id % 233280);
  for (let i = faces.length; i >= 1; i--) {
    const edge = h("span", { class: `pile-edge${faces[i - 1] === "reverse" ? " known" : ""}${i === faces.length ? " last" : ""}` });
    edge.style.transform = `translate(${((r() - 0.5) * 2).toFixed(1)}px,${(i * CARD_PX).toFixed(1)}px) rotate(${((r() - 0.5) * 1).toFixed(2)}deg)`;
    pile.appendChild(edge);
  }
  pile.appendChild(topCard(n.pick.card));
  const b = h("button", { class: "spot", "aria-label": `Study ${deckLabel(d)}`, onclick: () => (rememberDeck(d.id), go.study(d.id)) }, pile);
  b.style.marginBottom = `${Math.round(faces.length * CARD_PX)}px`;
  return h("div", { class: "pile-cell" }, b, name, h("div", { class: "pile-count" }, `${n.left} ${n.left === 1 ? "card" : "cards"}`));
}

/** The top card as it lies: a forward card white side up (the word), a reverse one cream side up (picture and translation). */
function topCard(cardId: number): HTMLElement {
  const { col } = app.store;
  const card = col.cards.get(cardId)!;
  const note = col.notes.get(card.note_id)!;
  if (card.template === "forward") return h("span", { class: "pile-top", lang: note.lang_pair.from }, h("span", { class: "pile-word" }, note.fields.front));
  return h("span", { class: "pile-top known", lang: note.lang_pair.to }, note.picture ? cutout(note.picture.key) : null, h("span", { class: "pile-word" }, note.fields.back));
}

/** A finished (or empty) spot, tapped: more cards, the same ones again, or words to add. */
function sheet(d: Deck, s: StudySession): void {
  const done = s.doneToday();
  const more = s.moreCount();
  const close = () => {
    backdrop.remove();
    el.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
  const backdrop = h("div", { class: "sheet-backdrop", onclick: close });
  const el = h(
    "div",
    { class: "pile-sheet", role: "dialog", "aria-label": deckLabel(d) },
    h("h2", {}, deckLabel(d)),
    more
      ? h(
          "button",
          {
            class: "primary wide",
            onclick: async () => {
              await s.more();
              close();
              rememberDeck(d.id);
              go.study(d.id);
            },
          },
          `Deal ${more} more`,
        )
      : null,
    done.length
      ? h("button", { class: more ? "secondary wide" : "primary wide", onclick: () => (close(), rememberDeck(d.id), go.study(d.id, true)) }, done.length === 1 ? "Go through it again" : `Go through these ${done.length} again`)
      : null,
    !more && !s.unseenLeft() ? h("button", { class: "secondary wide", onclick: () => (close(), rememberDeck(d.id), go.words()) }, "Add words") : null,
  );
  document.addEventListener("keydown", onKey);
  app.root.append(backdrop, el);
  (el.querySelector("button") as HTMLElement | null)?.focus();
}
