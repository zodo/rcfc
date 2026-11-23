// Home: decks with due/new counts, study entry points, new deck.
import { app, go, page } from "../app";
import { dueCount } from "../domain/scheduler";
import { h, langName } from "../ui/h";
import { decks, newDeckForm } from "./decks";
import { unsortedWords } from "./sort";

export async function home(): Promise<void> {
  if (app.reloadPending) return location.reload();
  const { store } = app;
  page("home", "rcfc", h("p", { class: "muted" }, "Loading…"));
  if (decks().length === 0) {
    page(
      "home",
      "Welcome",
      h("p", {}, "Flashcards scheduled by RWKV, a neural memory model that runs on your device."),
      newDeckForm(() => go.home()),
      h("button", { class: "secondary wide", onclick: () => go.import() }, "Import from Duocards"),
    );
    return;
  }
  await store.predict(store.col.liveCards());
  const desired = store.preset().desired_retention;
  const rows = decks().map((d) => {
    const cards = store.col.liveCards(d.id);
    const due = dueCount(store.predsOf(cards), desired);
    const fresh = store.newQueue(d.id).length;
    return h(
      "div",
      { class: "deck" },
      h("div", { class: "deck-main" }, h("div", { class: "deck-name" }, d.name), h("div", { class: "muted small" }, `${langName(d.lang_pair.from)} → ${langName(d.lang_pair.to)} · ${cards.length} cards`)),
      h("div", { class: "counts" }, h("span", { class: "due" }, `${due} due`), h("span", { class: "new" }, `${fresh} new`)),
      h("button", { class: "primary", onclick: () => go.study(d.id) }, "Study"),
    );
  });
  const allDue = dueCount(store.predsOf(store.col.liveCards()), desired);
  page(
    "home",
    "Study",
    decks().length > 1 ? h("button", { class: "primary wide big", onclick: () => go.study() }, `Study all · ${allDue} due · ${store.newQueue().length} new`) : null,
    h("div", { class: "decks" }, ...rows),
    ...decks().map((d) => {
      const n = unsortedWords(d.id).length;
      return n >= 5
        ? h(
            "button",
            { class: "secondary wide sort-entry", onclick: () => go.sortWords(d.id) },
            h("strong", {}, `Already know some ${d.name} words?`),
            h("span", { class: "muted small" }, `Swipe through ${n} unseen words`),
          )
        : null;
    }),
    h("details", { class: "card-box" }, h("summary", {}, "New deck"), newDeckForm(() => go.home())),
  );
}
