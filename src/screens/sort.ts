// Sort known words: swipe through never-studied words. "I know it" records a
// real answer (Easy): the model then schedules the word far out and checks it
// later. "Teach me" leaves it new, to be introduced under the daily limit.
import { app, errorText, fullScreen, go, setKeys } from "../app";
import type { Card } from "../domain/collection";
import type { EntityId } from "../domain/ids";
import { h, langName, toast } from "../ui/h";
import { canSpeak, speak } from "../ui/speech";
import { swipeable } from "../ui/swipe";

const SORTED_KEY = "rcfc:sortedLater";

/** Cards the user swiped "teach me" on: not shown in sorting again. */
function sortedLater(): Set<EntityId> {
  try {
    return new Set(JSON.parse(localStorage.getItem(SORTED_KEY) ?? "[]") as EntityId[]);
  } catch {
    return new Set();
  }
}

function saveSortedLater(s: Set<EntityId>) {
  try {
    localStorage.setItem(SORTED_KEY, JSON.stringify([...s]));
  } catch {
    /* ignore */
  }
}

export function unsortedWords(deckId: EntityId): Card[] {
  const later = sortedLater();
  return app.store.unseenWords(deckId).filter((c) => !later.has(c.id));
}

export function sortWords(deckId: EntityId): void {
  const { store } = app;
  const queue = unsortedWords(deckId);
  const total = queue.length;
  let known = 0;
  let later = 0;
  const laterSet = sortedLater();
  const deck = store.col.decks.get(deckId)!;

  const finish = () => {
    fullScreen(
      h(
        "section",
        { class: "done" },
        h("div", { class: "big-emoji", "aria-hidden": "true" }, "✓"),
        h("h2", {}, queue.length ? "Paused" : "All sorted"),
        h("p", { class: "muted" }, `${known} you know. The model will check them now and then. ${later} to learn, ${store.preset().new_per_day} a day.`),
        queue.length ? h("p", { class: "muted small" }, `${queue.length} left to sort; continue any time from Words.`) : null,
        h("button", { class: "primary wide", onclick: () => go.words() }, "Done"),
      ),
    );
  };

  const show = () => {
    const card = queue[0];
    if (!card) return finish();
    const note = store.col.notes.get(card.note_id)!;
    const shownAt = performance.now();
    let peeked = false;
    let busy = false;
    const tapHint = h("div", { class: "muted small" }, "tap to see the translation");
    const translation = h("div", { class: "answer hidden" }, h("div", { class: "divider" }), h("div", { class: "face small-face" }, note.fields.back), note.fields.example ? h("div", { class: "example" }, note.fields.example) : null);
    const peek = () => {
      peeked = true;
      translation.classList.remove("hidden");
      tapHint.classList.add("hidden");
    };
    const decide = async (knows: boolean) => {
      if (busy) return;
      busy = true;
      setKeys(null);
      queue.shift();
      if (knows) {
        try {
          await store.answer(card, 4, Math.min(performance.now() - shownAt, 120_000));
          known++;
        } catch (e) {
          toast(`Could not save: ${errorText(e)}`);
        }
      } else {
        laterSet.add(card.id);
        saveSortedLater(laterSet);
        later++;
      }
      // Stopped (or left) while the answer was saving: don't come back.
      if (el.isConnected) show();
    };
    const el = h(
      "div",
      { class: "flashcard sort-card" },
      h("div", { class: "muted small lang" }, `${langName(deck.lang_pair.from)} · do you know it?`),
      h("div", { class: "face prompt" }, note.fields.front),
      canSpeak() ? h("button", { class: "icon", onclick: () => speak(note.fields.front, note.lang_pair.from), "aria-label": "Pronounce" }, "🔊") : null,
      tapHint,
      translation,
    );
    swipeable(el, { onTap: () => (peeked ? undefined : peek()), onRight: () => void decide(true), onLeft: () => void decide(false) });
    fullScreen(
      h(
        "section",
        { class: "study" },
        h(
          "div",
          { class: "study-top" },
          h("button", { class: "icon", onclick: finish, "aria-label": "Stop" }, "✕"),
          h("span", { class: "muted small" }, `${total - queue.length + 1} / ${total}`),
          h("span", { class: "muted small" }, `✓ ${known}`),
        ),
        el,
        h(
          "div",
          { class: "controls" },
          h("div", { class: "sort-buttons" }, h("button", { class: "rate r1", onclick: () => decide(false) }, "← Teach me"), h("button", { class: "rate r3", onclick: () => decide(true) }, "I know it →")),
        ),
      ),
    );
    setKeys((e) => {
      if (e.key === "ArrowRight") void decide(true);
      else if (e.key === "ArrowLeft") void decide(false);
      else if (e.key === " ") {
        e.preventDefault();
        peek();
      }
    });
  };
  show();
}
