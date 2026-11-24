// Study tab: one row per language with the cards left in its pile today;
// first launch asks which language to learn.
import { app, go, page } from "../app";
import { StudySession } from "../session";
import { h } from "../ui/h";
import { deckLabel, decks, languageForm, rememberDeck } from "./decks";

export async function home(): Promise<void> {
  if (app.reloadPending) return location.reload();
  const { store } = app;
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
  await store.predict(store.col.liveCards());
  const rows = decks().map((d) => {
    const cards = store.col.liveCards(d.id);
    const left = cards.length ? new StudySession(store, d.lang_pair).view().left() : 0;
    const counts = !cards.length
      ? h("span", { class: "muted" }, "no words yet")
      : left
        ? h("span", {}, `${left} ${left === 1 ? "card" : "cards"}`)
        : h("span", { class: "muted" }, "done for today");
    return h(
      "div",
      { class: "deck" },
      h("div", { class: "deck-main" }, h("div", { class: "deck-name" }, deckLabel(d)), h("div", { class: "counts small" }, counts)),
      cards.length ? h("button", { class: "primary", onclick: () => go.study(d.id) }, "Study") : h("button", { class: "secondary", onclick: () => (rememberDeck(d.id), go.words()) }, "Add words"),
    );
  });
  page("home", "Study", h("div", { class: "decks" }, ...rows));
}
