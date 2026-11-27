// Study tab: the table. Every language and every sticker has a spot printed on
// it with its pile for today: thickness = cards left, the top card face up, the
// colours of the cards under it (fixed once shown, the same in study:
// src/session.ts). Tap a pile to study it. A finished pile leaves its spot with
// its checks (src/ui/checks.ts; drawn in study when it was finished); tapping
// the spot opens its finish in study (more cards, the same ones again, Add
// words: src/screens/study.ts). A sticker with no words has its spot
// printed empty, and the last spot is always a new pile (a new sticker). First
// launch asks which language to learn.
import { launchToTable, launchToWelcome } from "../ui/launch";
import { app, go, page } from "../app";
import { derivedEntityId } from "../domain/ids";
import { labelPile } from "../domain/labels";
import { languagePile } from "../domain/piles";
import { AHEAD } from "../pictures";
import { StudySession } from "../session";
import { checks } from "../ui/checks";
import { h, langName } from "../ui/h";
import { seeded } from "../ui/paper";
import { autoReadScrap } from "../ui/autoread";
import { cutout } from "../ui/picture";
import { editSticker, languageForm, languages, rememberLanguage } from "./languages";
import { newStickerSheet, stickerTag } from "./stickers";

/** Edges drawn under the top card; deeper cards only make the pile no thicker. */
const EDGES = 30;
/** Thickness of one card, px. */
const CARD_PX = 1.5;

/** "Study", and the scrap that switches cards reading aloud by themselves, so it can be set before a pile is opened. */
const title = () => h("div", { class: "title-row" }, h("h1", {}, "Study"), autoReadScrap());

const ICON_PLUS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';

export async function home(): Promise<void> {
  if (app.reloadPending) return location.reload();
  const langs = languages();
  if (langs.length === 0) {
    // A card, the shape of the launch pile's: on a first launch the RCFC card turns over into it.
    const card = h("div", { class: "welcome-card" }, h("p", {}, "Flashcards scheduled by RWKV, a neural memory model that runs on your device."), languageForm(() => go.add(), "Start"));
    page("home", "Welcome", card);
    launchToWelcome(app.root, card);
    return;
  }
  const gen = ++drawn;
  const { store } = app;
  const piles = [...langs.map((l) => ({ s: new StudySession(store, languagePile(l)), label: langName(l) })), ...store.col.liveLabels().map((l) => ({ s: new StudySession(store, labelPile(l.id)), label: l.name }))];
  const cards = new Map(piles.flatMap(({ s }) => s.source().map((c) => [c.id, c] as const)));
  const refresh = () => store.predict([...cards.values()]);
  // With the last predictions the table is drawn at once; fresh ones come after
  // (all piles in one go) and redraw only the spots they change. The first time
  // there are none yet: the table waits for them.
  const ready = piles.every(({ s }) => s.predicted());
  if (!ready) {
    if (!(app.current === "home" && app.root.querySelector(".table"))) page("home", title(), h("p", { class: "muted" }, "Loading…"));
    await refresh();
    if (gen !== drawn || app.current !== "home") return; // drawn again, or left, meanwhile
  }
  const spots = piles.map(({ s, label }) => spot(s, label));
  page("home", title(), h("div", { class: "table" }, ...spots.map((x) => x.el), newPile()));
  launchToTable(app.root); // at launch: the launch pile is dealt onto it
  if (!ready) return;
  await refresh();
  if (gen !== drawn || app.current !== "home") return;
  piles.forEach(({ s, label }, i) => {
    const fresh = spot(s, label);
    if (fresh.key !== spots[i].key) spots[i].el.replaceWith(fresh.el);
  });
}

/** Draws of the table: a later one wins over an earlier one still waiting for predictions. */
let drawn = 0;

/** One pile's spot (a language's or a sticker's): its pile, or the outline a finished pile leaves; `key` = what it shows. */
function spot(s: StudySession, label: string): { el: HTMLElement; key: string } {
  const name = h("div", { class: "pile-name" }, s.label === undefined ? label : stickerTag(app.store.col.liveLabel(s.label)!));
  const seed = derivedEntityId(s.pile) % 233280; // the pile's own poses, the same every time
  if (s.label !== undefined && s.allCount() === 0) {
    const id = s.label;
    return { el: h("div", { class: "pile-cell" }, askew(h("button", { class: "spot empty", "aria-label": `${label}: add words`, onclick: () => editSticker(id) }), seed), name, h("div", { class: "pile-count" }, "no words yet")), key: "empty" };
  }
  s.settle();
  const n = s.next();
  const crossedN = s.crossed().length;
  if (!n) {
    const done = s.doneToday().length;
    const rounds = s.rounds();
    const b = h("button", { class: "spot finished", "aria-label": `${label}: more cards`, onclick: () => open(s) }, crossed(crossedN, seed), done ? checks(rounds) : null);
    return { el: h("div", { class: "pile-cell" }, askew(b, seed), name, h("div", { class: "pile-count" }, done ? "done for today" : "nothing due")), key: `finished:${done}:${rounds}:${crossedN}` };
  }
  const coming = s.upcoming(AHEAD);
  void app.pictures.ahead(coming);
  void app.speech.ahead(coming);
  const pile = h("span", { class: "pile-stack" }, crossed(crossedN, seed));
  const faces = s.faces(Math.min(EDGES, n.left - 1));
  const r = seeded(seed);
  for (let i = faces.length; i >= 1; i--) {
    const edge = h("span", { class: `pile-edge${faces[i - 1] === "reverse" ? " known" : ""}${i === faces.length ? " last" : ""}` });
    edge.style.transform = `translate(${((r() - 0.5) * 2).toFixed(1)}px,${(i * CARD_PX).toFixed(1)}px) rotate(${((r() - 0.5) * 1).toFixed(2)}deg)`;
    pile.appendChild(edge);
  }
  pile.appendChild(topCard(n.pick.card));
  const study = (e: Event) => {
    const spot = e.currentTarget as HTMLElement;
    app.opening = { pile: s.pile, rect: spot.getBoundingClientRect(), copy: pile.cloneNode(true) as HTMLElement };
    open(s);
  };
  const b = h("button", { class: "spot", "aria-label": `Study ${label}`, onclick: study }, pile);
  b.style.setProperty("--thick", `${Math.round(faces.length * CARD_PX)}px`);
  return { el: h("div", { class: "pile-cell" }, askew(b, seed), name, h("div", { class: "pile-count" }, `${n.left} ${n.left === 1 ? "card" : "cards"}`)), key: `${n.pick.card}:${n.left}:${faces.join(",")}:${crossedN}` };
}

/** Today's cards from a pile, crosswise under it as in study (src/ui/crossed.ts): one card, its edges as thick as they are many. */
function crossed(count: number, seed: number): HTMLElement | null {
  if (!count) return null;
  const el = h("span", { class: "spot-cross", "aria-hidden": "true" });
  const edges = Math.min(count, 12);
  const shadow: string[] = [];
  for (let i = 1; i < edges; i++) shadow.push(`0 ${(i * 1.2).toFixed(1)}px 0 ${i % 2 ? "var(--cross-edge)" : "var(--card)"}`);
  shadow.push(`0 ${(edges * 1.2 + 2).toFixed(1)}px 6px rgb(var(--shadow) / 0.2)`);
  el.style.boxShadow = shadow.join(",");
  el.style.rotate = `${((seeded(seed + 11)() - 0.5) * 3).toFixed(2)}deg`;
  return el;
}

/** A spot's outline, printed a little askew: 0.7–1.9°, either way, the same every time. */
function askew(spot: HTMLElement, seed: number): HTMLElement {
  const r = seeded(seed + 3);
  const deg = (r() < 0.5 ? -1 : 1) * (0.7 + r() * 1.2);
  spot.style.setProperty("--askew", `${deg.toFixed(2)}deg`);
  return spot;
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
  return h("div", { class: "pile-cell" }, askew(b, 41), h("div", { class: "pile-name" }, "New pile"), h("div", { class: "pile-count" }, "\u00a0"));
}

/** Study a pile: its cards, or its finish (from a finished spot). */
function open(s: StudySession): void {
  if (s.lang === undefined) return void go.study(s.pile);
  rememberLanguage(s.lang);
  void go.study(s.lang);
}
