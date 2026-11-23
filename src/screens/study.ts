// Study: one card at a time, reveal, answer Again / Got it (buttons, arrow keys or swipe).
import { app, errorText, fullScreen, go, setKeys } from "../app";
import type { ReviewPayload } from "../domain/events";
import type { EntityId } from "../domain/ids";
import type { Pick } from "../domain/scheduler";
import { StudySession } from "../session";
import { h, langName, toast } from "../ui/h";
import { canSpeak, speak } from "../ui/speech";
import { cutout } from "../ui/picture";
import { swipeable } from "../ui/swipe";

type Rating = ReviewPayload["rating"];

export async function study(deckId?: EntityId): Promise<void> {
  fullScreen(h("p", { class: "muted center" }, "Preparing…"));
  const s = new StudySession(app.store, deckId);
  await s.start();
  next(s);
}

function next(s: StudySession) {
  const n = s.next();
  if (!n) return done(s);
  showCard(s, n.pick, n.due);
}

function done(s: StudySession) {
  fullScreen(
    h(
      "section",
      { class: "done" },
      h("div", { class: "big-emoji", "aria-hidden": "true" }, "✓"),
      h("h2", {}, s.answered ? "All caught up" : "Nothing due right now"),
      h("p", { class: "muted" }, s.answered ? `${s.answered} ${s.answered === 1 ? "answer" : "answers"} this session. Come back later.` : "No words are below your target recall, and today's new words are done."),
      s.preds().size > 0
        ? h(
            "button",
            {
              class: "secondary wide",
              onclick: () => {
                s.ahead = true;
                next(s);
              },
            },
            "Keep practicing",
          )
        : null,
      h("button", { class: "primary wide", onclick: () => go.home() }, "Done"),
    ),
  );
}

function showCard(s: StudySession, pick: Pick, due: number) {
  const { store } = app;
  const card = store.col.cards.get(pick.card)!;
  const note = store.col.notes.get(card.note_id)!;
  const lang = note.lang_pair;
  const studied = note.fields.front;
  const forward = card.template === "forward";
  const prompt = forward ? note.fields.front : note.fields.back;
  const answer = forward ? note.fields.back : note.fields.front;
  const shownAt = performance.now();
  // Reverse cards (translation → word): the picture is part of the cue.
  // Forward cards: it comes with the answer. No picture yet: draw one for next time.
  const pic = note.picture ? cutout(note.picture.key, forward ? "r" : "l") : null;
  if (!note.picture) void app.pictures.ensure(note.id);
  let revealed = false;

  const say = () => speak(studied, lang.from);
  const speakBtn = canSpeak() ? h("button", { class: "icon", onclick: say, "aria-label": "Pronounce", title: "Pronounce" }, "🔊") : null;
  const status = h(
    "div",
    { class: "study-top" },
    h("button", { class: "icon", onclick: () => go.home(), "aria-label": "Close" }, "✕"),
    h("span", { class: "muted small" }, pick.kind === "new" ? "New word" : pick.kind === "ahead" ? "Extra practice" : `${due} due`),
    h("span", { class: "muted small" }, pick.p !== undefined ? `recall ${(pick.p * 100).toFixed(0)}%` : ""),
  );
  const back = h(
    "div",
    { class: "answer hidden" },
    h("div", { class: "divider" }),
    forward ? pic : null,
    h("div", { class: "face" }, answer),
    note.fields.example ? h("div", { class: "example" }, note.fields.example) : null,
  );
  const reveal = h("button", { class: "primary wide big", onclick: () => doReveal() }, "Show answer");
  const ratings = h(
    "div",
    { class: "hidden" },
    h("div", { class: "ratings two" }, h("button", { class: "rate r1", onclick: () => rate(1) }, "← Again"), h("button", { class: "rate r3", onclick: () => rate(3) }, "Got it →")),
    h("p", { class: "muted small center swipe-hint" }, "or swipe the card"),
  );

  function doReveal() {
    if (revealed) return;
    revealed = true;
    back.classList.remove("hidden");
    ratings.classList.remove("hidden");
    reveal.classList.add("hidden");
    if (!forward && canSpeak()) say();
  }

  let busy = false;
  async function rate(r: Rating) {
    if (busy || !revealed) return;
    busy = true;
    setKeys(null);
    const duration = Math.min(performance.now() - shownAt, 120_000);
    try {
      await s.answer(card, pick, r, duration);
    } catch (e) {
      busy = false;
      setKeys(onKey);
      flashcard.style.transform = "";
      toast(`Could not save: ${errorText(e)}`);
      return;
    }
    await s.refresh(card);
    // Closed while the answer was saving: don't draw the next card over home.
    if (flashcard.isConnected) next(s);
  }

  function onKey(e: KeyboardEvent) {
    if (e.target instanceof HTMLInputElement) return;
    if (!revealed && (e.key === " " || e.key === "Enter")) {
      e.preventDefault();
      doReveal();
    } else if (revealed && e.key === "ArrowRight") rate(3);
    else if (revealed && e.key === "ArrowLeft") rate(1);
  }

  const flashcard = h(
    "div",
    { class: "flashcard" },
    h("div", { class: "muted small lang" }, forward ? `${langName(lang.from)} → ${langName(lang.to)}` : `${langName(lang.to)} → ${langName(lang.from)}`),
    !forward ? pic : null,
    h("div", { class: "face prompt" }, prompt),
    forward ? speakBtn : null,
    back,
    !forward ? speakBtn && h("div", { class: "answer-speak" }, speakBtn) : null,
  );
  swipeable(flashcard, { onTap: doReveal, canSwipe: () => revealed && !busy, onRight: () => rate(3), onLeft: () => rate(1) });

  fullScreen(h("section", { class: "study" }, status, flashcard, h("div", { class: "controls" }, reveal, ratings)));
  setKeys(onKey);
  if (forward && canSpeak() && pick.kind === "new") say();
}
