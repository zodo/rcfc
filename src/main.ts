import "./style.css";
import type { Card, Deck } from "./domain/collection";
import type { AppEvent, DeckCreatedPayload, LangPair, NoteFields, ReviewPayload } from "./domain/events";
import type { EntityId } from "./domain/ids";
import { dueCount, pickNext, type Pick } from "./domain/scheduler";
import { DuocardsFormatError, guessSourceLang, importDuocardsCsv, noteKey } from "./import/duocards";
import { Store } from "./store";
import { append, clear, h, langName, langSelect, toast } from "./ui/h";
import { canSpeak, speak } from "./ui/speech";
import { swipeable } from "./ui/swipe";

const root = document.getElementById("app")!;
let store: Store;

type Screen = "home" | "add" | "import" | "browse" | "settings";

// ---------- shell ----------

function nav(active: Screen | "study") {
  const item = (s: Screen, label: string, icon: string) =>
    h("button", { class: `nav-item${active === s ? " active" : ""}`, onclick: () => go(s), "aria-label": label }, h("span", { class: "nav-icon", "aria-hidden": "true" }, icon), h("span", {}, label));
  return h("nav", { class: "nav" }, item("home", "Study", "◎"), item("add", "Add", "+"), item("browse", "Words", "≡"), item("import", "Import", "⇩"), item("settings", "Settings", "⚙"));
}

/** One keyboard handler for the current screen. */
let keyHandler: ((e: KeyboardEvent) => void) | null = null;
function setKeys(f: ((e: KeyboardEvent) => void) | null) {
  if (keyHandler) document.removeEventListener("keydown", keyHandler);
  keyHandler = f;
  if (f) document.addEventListener("keydown", f);
}

function page(active: Screen, title: string, ...body: (Node | string | null | false)[]) {
  setKeys(null);
  clear(root);
  append(root, [h("header", { class: "top" }, h("h1", {}, title)), h("section", { class: "content" }, ...body), nav(active)]);
}

function go(s: Screen) {
  ({ home, add, import: importScreen, browse, settings })[s]();
}

function decks(): Deck[] {
  return [...store.col.decks.values()];
}

function deckSelect(name: string, selected?: EntityId) {
  const s = h("select", { name });
  for (const d of decks()) s.appendChild(h("option", { value: String(d.id), selected: d.id === selected }, d.name));
  return s;
}

function lastDeck(): EntityId | undefined {
  try {
    const v = Number(localStorage.getItem("rcfc:lastDeck"));
    if (store.col.decks.has(v)) return v;
  } catch {
    /* storage unavailable */
  }
  return decks()[0]?.id;
}
function rememberDeck(id: EntityId) {
  try {
    localStorage.setItem("rcfc:lastDeck", String(id));
  } catch {
    /* ignore */
  }
}

async function createDeck(name: string, lang_pair: LangPair): Promise<EntityId> {
  const ev = store.factory.deck(name.trim() || langName(lang_pair.from), store.preset().preset_id, lang_pair);
  await store.append([ev]);
  return (ev.payload as DeckCreatedPayload).deck_id;
}

function newDeckForm(onDone: (id: EntityId) => void, from = "es") {
  const name = h("input", { name: "name", placeholder: `e.g. ${langName(from)}`, autocomplete: "off" });
  const fromSel = langSelect("from", from);
  const toSel = langSelect("to", "en");
  return h(
    "form",
    {
      class: "card-box",
      onsubmit: async (e: Event) => {
        e.preventDefault();
        const id = await createDeck(name.value || langName(fromSel.value), { from: fromSel.value, to: toSel.value });
        onDone(id);
      },
    },
    h("h2", {}, "New deck"),
    h("label", {}, "Name", name),
    h("div", { class: "row2" }, h("label", {}, "I'm learning", fromSel), h("label", {}, "I speak", toSel)),
    h("button", { class: "primary", type: "submit" }, "Create deck"),
  );
}

// ---------- home ----------

async function home() {
  page("home", "rcfc", h("p", { class: "muted" }, "Loading…"));
  if (decks().length === 0) {
    page(
      "home",
      "Welcome",
      h("p", {}, "Flashcards scheduled by RWKV, a neural memory model that runs on your device. Start with a deck, or bring your words from Duocards."),
      newDeckForm(() => home()),
      h("button", { class: "secondary wide", onclick: () => importScreen() }, "Import from Duocards"),
      installTip(),
    );
    return;
  }
  await store.predict(store.col.liveCards());
  const desired = store.preset().desired_retention;
  const rows = decks().map((d) => {
    const cards = store.col.liveCards(d.id);
    const preds = new Map(cards.filter((c) => store.preds.has(c.id)).map((c) => [c.id, store.preds.get(c.id)!]));
    const due = dueCount(preds, desired);
    const fresh = store.newQueue(d.id).length;
    return h(
      "div",
      { class: "deck" },
      h("div", { class: "deck-main" }, h("div", { class: "deck-name" }, d.name), h("div", { class: "muted small" }, `${langName(d.lang_pair.from)} → ${langName(d.lang_pair.to)} · ${cards.length} cards`)),
      h("div", { class: "counts" }, h("span", { class: "due", title: "due" }, String(due)), h("span", { class: "new", title: "new" }, String(fresh))),
      h("button", { class: "primary", onclick: () => study(d.id) }, "Study"),
    );
  });
  const all = store.col.liveCards();
  const allPreds = new Map(all.filter((c) => store.preds.has(c.id)).map((c) => [c.id, store.preds.get(c.id)!]));
  page(
    "home",
    "Study",
    decks().length > 1 ? h("button", { class: "primary wide big", onclick: () => study() }, `Study all · ${dueCount(allPreds, desired)} due · ${store.newQueue().length} new`) : null,
    h("div", { class: "decks" }, ...rows),
    ...decks().map((d) => {
      const n = unsortedWords(d.id).length;
      return n >= 5
        ? h(
            "button",
            { class: "secondary wide sort-entry", onclick: () => sortWords(d.id) },
            h("strong", {}, `Already know some ${d.name} words?`),
            h("span", { class: "muted small" }, `Swipe through ${n} unseen words: → I know it, ← teach me`),
          )
        : null;
    }),
    h("p", { class: "muted small legend" }, h("span", { class: "due" }, "■"), " due  ", h("span", { class: "new" }, "■"), " new today"),
    h("details", { class: "card-box" }, h("summary", {}, "New deck"), newDeckForm(() => home())),
    installTip(),
  );
}

function installTip() {
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone = matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone;
  if (!ios || standalone) return null;
  return h("p", { class: "tip" }, "On iPhone, tap Share → Add to Home Screen. Safari may delete data of websites you don't open for a while; installed apps keep it.");
}

// ---------- study ----------

interface Session {
  deckId?: EntityId;
  recent: EntityId[];
  sinceNew: number;
  answered: number;
  ahead: boolean;
  newQueue: Card[];
}

const HOT = 50;
const REFRESH = 100;

async function study(deckId?: EntityId) {
  clear(root);
  root.appendChild(h("p", { class: "muted center" }, "Preparing…"));
  const s: Session = { deckId, recent: [], sinceNew: 99, answered: 0, ahead: false, newQueue: [] };
  await store.predict(store.col.liveCards(deckId));
  next(s);
}

function scopePreds(s: Session): Map<EntityId, number> {
  const m = new Map<EntityId, number>();
  for (const c of store.col.liveCards(s.deckId)) {
    const p = store.preds.get(c.id);
    if (c.reviews > 0 && p !== undefined) m.set(c.id, p);
  }
  return m;
}

function next(s: Session) {
  s.newQueue = store.newQueue(s.deckId);
  const preds = scopePreds(s);
  const pick = pickNext({
    preds,
    recent: s.recent,
    newQueue: s.newQueue.map((c) => c.id),
    newLeft: s.newQueue.length,
    sinceNew: s.sinceNew,
    desired: store.preset().desired_retention,
    ahead: s.ahead,
  });
  if (!pick) return done(s);
  showCard(s, pick, dueCount(preds, store.preset().desired_retention));
}

function done(s: Session) {
  setKeys(null);
  clear(root);
  append(root, [
    h(
      "section",
      { class: "done" },
      h("div", { class: "big-emoji", "aria-hidden": "true" }, "✓"),
      h("h2", {}, s.answered ? "All caught up" : "Nothing due right now"),
      h("p", { class: "muted" }, s.answered ? `${s.answered} ${s.answered === 1 ? "answer" : "answers"} this session. Come back later: the model will tell when a word is about to slip.` : "No words are below your target recall, and today's new words are done."),
      scopePreds(s).size > 0
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
      h("button", { class: "primary wide", onclick: () => home() }, "Done"),
    ),
  ]);
}

function showCard(s: Session, pick: Pick, due: number) {
  const card = store.col.cards.get(pick.card)!;
  const note = store.col.notes.get(card.note_id)!;
  const lang = note.lang_pair;
  const studied = note.fields.front;
  const forward = card.template === "forward";
  const prompt = forward ? note.fields.front : note.fields.back;
  const answer = forward ? note.fields.back : note.fields.front;
  const shownAt = performance.now();
  let revealed = false;

  const say = () => speak(studied, lang.from);
  const speakBtn = canSpeak() ? h("button", { class: "icon", onclick: say, "aria-label": "Pronounce", title: "Pronounce" }, "🔊") : null;
  const status = h(
    "div",
    { class: "study-top" },
    h("button", { class: "icon", onclick: () => home(), "aria-label": "Close" }, "✕"),
    h("span", { class: "muted small" }, pick.kind === "new" ? "New word" : pick.kind === "ahead" ? "Extra practice" : `${due} due`),
    h("span", { class: "muted small" }, pick.p !== undefined ? `recall ${(pick.p * 100).toFixed(0)}%` : ""),
  );
  const back = h(
    "div",
    { class: "answer hidden" },
    h("div", { class: "divider" }),
    h("div", { class: "face" }, answer),
    note.fields.example ? h("div", { class: "example" }, note.fields.example) : null,
  );
  const reveal = h("button", { class: "primary wide big", onclick: () => doReveal() }, "Show answer");
  const label = ["Again", "Hard", "Good", "Easy"];
  const ratings = h(
    "div",
    { class: "hidden" },
    h("div", { class: "ratings" }, ...label.map((l, i) => h("button", { class: `rate r${i + 1}`, onclick: () => rate((i + 1) as ReviewPayload["rating"]) }, l))),
    h("p", { class: "muted small center swipe-hint" }, "or swipe the card: → Good, ← Again"),
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
  async function rate(r: ReviewPayload["rating"]) {
    if (busy || !revealed) return;
    busy = true;
    setKeys(null);
    const duration = Math.min(performance.now() - shownAt, 120_000);
    try {
      await store.answer(card, r, duration);
    } catch (e) {
      busy = false;
      setKeys(onKey);
      flashcard.style.transform = "";
      toast(`Could not save: ${e instanceof Error ? e.message : e}`);
      return;
    }
    s.answered++;
    s.sinceNew = pick.kind === "new" ? 0 : s.sinceNew + 1;
    s.recent.push(card.id);
    if (s.recent.length > HOT) s.recent.shift();
    // The answered card's prediction must be fresh before it can be picked
    // again; others refresh in the background (hot set + stalest).
    await store.predict([card]);
    const scope = store.col.liveCards(s.deckId);
    const hot = s.recent.map((id) => store.col.cards.get(id)!).filter(Boolean);
    void store.predict([...hot, ...store.stalest(scope, REFRESH)]);
    next(s);
  }

  function onKey(e: KeyboardEvent) {
    if (e.target instanceof HTMLInputElement) return;
    if (!revealed && (e.key === " " || e.key === "Enter")) {
      e.preventDefault();
      doReveal();
    } else if (revealed && ["1", "2", "3", "4"].includes(e.key)) rate(Number(e.key) as ReviewPayload["rating"]);
    else if (revealed && e.key === "ArrowRight") rate(3);
    else if (revealed && e.key === "ArrowLeft") rate(1);
  }

  const flashcard = h(
    "div",
    { class: "flashcard" },
    h("div", { class: "muted small lang" }, forward ? `${langName(lang.from)} → ${langName(lang.to)}` : `${langName(lang.to)} → ${langName(lang.from)}`),
    h("div", { class: "face prompt" }, prompt),
    forward ? speakBtn : null,
    back,
    !forward ? speakBtn && h("div", { class: "answer-speak" }, speakBtn) : null,
  );
  swipeable(flashcard, { onTap: doReveal, canSwipe: () => revealed && !busy, onRight: () => rate(3), onLeft: () => rate(1) });

  setKeys(null);
  clear(root);
  append(root, [
    h(
      "section",
      { class: "study" },
      status,
      flashcard,
      h("div", { class: "controls" }, reveal, ratings),
    ),
  ]);
  setKeys(onKey);
  if (forward && canSpeak() && pick.kind === "new") say();
}

// ---------- sort known words ----------

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

function unsortedWords(deckId: EntityId): Card[] {
  const later = sortedLater();
  return store.unseenWords(deckId).filter((c) => !later.has(c.id));
}

/**
 * Swipe through never-studied words. "I know it" records a real answer (Easy):
 * the model then schedules the word far out and checks it later. "Teach me"
 * leaves it new, to be introduced under the daily limit.
 */
function sortWords(deckId: EntityId) {
  const queue = unsortedWords(deckId);
  const total = queue.length;
  let known = 0;
  let later = 0;
  const laterSet = sortedLater();
  const deck = store.col.decks.get(deckId)!;

  const finish = () => {
    setKeys(null);
    clear(root);
    append(root, [
      h(
        "section",
        { class: "done" },
        h("div", { class: "big-emoji", "aria-hidden": "true" }, "✓"),
        h("h2", {}, queue.length ? "Paused" : "All sorted"),
        h("p", { class: "muted" }, `${known} you know: the model will check them now and then. ${later} to learn: they come in ${store.preset().new_per_day} a day.`),
        queue.length ? h("p", { class: "muted small" }, `${queue.length} left to sort; continue any time from the Study tab.`) : null,
        h("button", { class: "primary wide", onclick: () => home() }, "Done"),
      ),
    ]);
  };

  const show = () => {
    const card = queue[0];
    if (!card) return finish();
    const note = store.col.notes.get(card.note_id)!;
    const shownAt = performance.now();
    let peeked = false;
    let busy = false;
    const translation = h("div", { class: "answer hidden" }, h("div", { class: "divider" }), h("div", { class: "face small-face" }, note.fields.back), note.fields.example ? h("div", { class: "example" }, note.fields.example) : null);
    const peek = () => {
      peeked = true;
      translation.classList.remove("hidden");
      tapHint.classList.add("hidden");
    };
    const tapHint = h("div", { class: "muted small" }, "tap to see the translation");
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
          toast(`Could not save: ${e instanceof Error ? e.message : e}`);
        }
      } else {
        laterSet.add(card.id);
        saveSortedLater(laterSet);
        later++;
      }
      show();
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
    clear(root);
    append(root, [
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
    ]);
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

// ---------- add ----------

function add() {
  if (decks().length === 0) return home();
  const deck = h("select", { name: "deck" });
  for (const d of decks()) deck.appendChild(h("option", { value: String(d.id), selected: d.id === lastDeck() }, d.name));
  const front = h("input", { name: "front", required: true, autocomplete: "off", autocapitalize: "off", spellcheck: false });
  const back = h("input", { name: "back", required: true, autocomplete: "off" });
  const example = h("textarea", { name: "example", rows: 2 });
  const hint = h("p", { class: "muted small" });
  const updateLabels = () => {
    const d = store.col.decks.get(Number(deck.value))!;
    front.placeholder = `Word in ${langName(d.lang_pair.from)}`;
    back.placeholder = `Translation in ${langName(d.lang_pair.to)}`;
  };
  deck.addEventListener("change", updateLabels);
  page(
    "add",
    "Add a word",
    h(
      "form",
      {
        class: "card-box",
        onsubmit: async (e: Event) => {
          e.preventDefault();
          const d = store.col.decks.get(Number(deck.value))!;
          const f = front.value.trim().normalize("NFC");
          const b = back.value.trim().normalize("NFC");
          if (!f || !b) return;
          if (store.col.liveNotes().some((n) => noteKey(n.fields.front, n.fields.back) === noteKey(f, b))) {
            hint.textContent = `"${f}" is already in your words.`;
            return;
          }
          const fields: NoteFields = { front: f, back: b };
          const ex = example.value.trim();
          if (ex) fields.example = ex;
          await store.append(store.factory.note(d.id, fields, d.lang_pair));
          rememberDeck(d.id);
          toast(`Added "${f}"`);
          front.value = back.value = example.value = "";
          hint.textContent = "";
          front.focus();
        },
      },
      decks().length > 1 ? h("label", {}, "Deck", deck) : null,
      h("label", {}, "Word", front),
      h("label", {}, "Translation", back),
      h("label", {}, "Example (optional)", example),
      hint,
      h("button", { class: "primary", type: "submit" }, "Add"),
      h("p", { class: "muted small" }, "Each word gets two cards: word → translation, and later translation → word."),
    ),
  );
  updateLabels();
  front.focus();
}

// ---------- import ----------

function importScreen() {
  const file = h("input", { type: "file", accept: ".csv,text/csv" });
  const box = h("div", {});
  file.addEventListener("change", async () => {
    const f = file.files?.[0];
    if (!f) return;
    const text = await f.text();
    const from = guessSourceLang(f.name) ?? "es";
    clear(box);
    let preview;
    try {
      preview = importDuocardsCsv(text, { deckId: 0, langPair: { from, to: "en" }, deviceId: store.deviceId, existing: store.col.liveNotes().map((n) => n.fields) });
    } catch (e) {
      box.appendChild(h("p", { class: "error" }, e instanceof DuocardsFormatError ? e.message : `Could not read the file: ${e}`));
      return;
    }
    const target = h("select", { name: "target" });
    target.appendChild(h("option", { value: "new" }, `New deck: ${langName(from)}`));
    for (const d of decks()) target.appendChild(h("option", { value: String(d.id), selected: d.lang_pair.from === from }, d.name));
    const fromSel = langSelect("from", from);
    const toSel = langSelect("to", "en");
    const langs = h("div", { class: "row2" }, h("label", {}, "Words are in", fromSel), h("label", {}, "Translations in", toSel));
    const syncLangs = () => langs.classList.toggle("hidden", target.value !== "new");
    target.addEventListener("change", syncLangs);
    append(box, [
      h(
        "div",
        { class: "card-box" },
        h("p", {}, h("strong", {}, `${preview.notes} words`), ` found in ${f.name}.`),
        preview.skipped.length ? h("p", { class: "muted small" }, `${preview.skipped.length} skipped (already in your words or repeated in the file).`) : null,
        preview.errors.length ? h("p", { class: "muted small" }, `${preview.errors.length} rows could not be read (line ${preview.errors.map((e) => e.line).slice(0, 5).join(", ")}).`) : null,
        h("label", {}, "Import into", target),
        langs,
        h(
          "button",
          {
            class: "primary",
            disabled: preview.notes === 0,
            onclick: async (e: Event) => {
              (e.target as HTMLButtonElement).disabled = true;
              const lang_pair = { from: fromSel.value, to: toSel.value };
              const deckId = target.value === "new" ? await createDeck(langName(lang_pair.from), lang_pair) : Number(target.value);
              const deck = store.col.decks.get(deckId)!;
              const res = importDuocardsCsv(text, { deckId, langPair: deck.lang_pair, deviceId: store.deviceId, existing: store.col.liveNotes().map((n) => n.fields) });
              await store.append(res.events as AppEvent[]);
              await requestPersistence();
              rememberDeck(deckId);
              toast(`Imported ${res.notes} words`);
              home();
            },
          },
          `Import ${preview.notes} words`,
        ),
      ),
    ]);
    syncLangs();
  });
  page(
    "import",
    "Import",
    h(
      "div",
      { class: "card-box" },
      h("h2", {}, "From Duocards"),
      h("p", { class: "muted" }, "In Duocards, export your cards as CSV, then pick the file here. Words come in as new cards, oldest first. Importing the same file again only adds what's missing."),
      file,
    ),
    box,
  );
}

async function requestPersistence() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch {
    /* not supported */
  }
}

// ---------- browse ----------

function browse() {
  const q = h("input", { type: "search", placeholder: "Search", autocomplete: "off" });
  const list = h("div", { class: "list" });
  const render = () => {
    clear(list);
    const term = q.value.trim().toLocaleLowerCase();
    const notes = store.col.liveNotes().reverse();
    const hits = term ? notes.filter((n) => `${n.fields.front}\n${n.fields.back}\n${n.fields.example ?? ""}`.toLocaleLowerCase().includes(term)) : notes;
    for (const n of hits.slice(0, 300)) {
      const cards = (store.col.cardsByNote.get(n.id) ?? []).map((id) => store.col.cards.get(id)!);
      const ps = cards.map((c) => store.preds.get(c.id)).filter((p): p is number => p !== undefined);
      const recall = ps.length ? `${Math.round(Math.min(...ps) * 100)}%` : "new";
      list.appendChild(
        h("button", { class: "word", onclick: () => edit(n.id) }, h("span", { class: "w-front" }, n.fields.front), h("span", { class: "w-back muted" }, n.fields.back), h("span", { class: "w-p muted small" }, recall)),
      );
    }
    if (hits.length > 300) list.appendChild(h("p", { class: "muted small center" }, `${hits.length - 300} more; refine the search.`));
    if (!hits.length) list.appendChild(h("p", { class: "muted center" }, term ? "No matches." : "No words yet."));
  };
  q.addEventListener("input", render);
  page("browse", `Words · ${store.col.liveNotes().length}`, q, list);
  render();
}

function edit(noteId: EntityId) {
  const n = store.col.liveNote(noteId);
  if (!n) return browse();
  const front = h("input", { value: n.fields.front });
  const back = h("input", { value: n.fields.back });
  const example = h("textarea", { rows: 2, value: n.fields.example ?? "" });
  page(
    "browse",
    "Edit word",
    h(
      "form",
      {
        class: "card-box",
        onsubmit: async (e: Event) => {
          e.preventDefault();
          const evs: AppEvent[] = [];
          const set = (field: string, value: string) => {
            if ((n.fields[field] ?? "") !== value) evs.push(store.factory.make("note_edited", { note_id: n.id, field, value }));
          };
          set("front", front.value.trim());
          set("back", back.value.trim());
          set("example", example.value.trim());
          if (evs.length) await store.append(evs);
          browse();
        },
      },
      h("label", {}, "Word", front),
      h("label", {}, "Translation", back),
      h("label", {}, "Example", example),
      h("button", { class: "primary", type: "submit" }, "Save"),
      h(
        "button",
        {
          class: "danger",
          type: "button",
          onclick: async () => {
            if (!confirm(`Delete "${n.fields.front}"? Its review history is kept for the model.`)) return;
            await store.append([store.factory.make("note_deleted", { note_id: n.id })]);
            browse();
          },
        },
        "Delete",
      ),
      h("button", { class: "secondary", type: "button", onclick: () => browse() }, "Cancel"),
    ),
  );
}

// ---------- settings ----------

function settings() {
  const p = store.preset();
  const retention = h("input", { type: "number", min: 70, max: 99, step: 1, value: String(Math.round(p.desired_retention * 100)) });
  const perDay = h("input", { type: "number", min: 0, max: 200, step: 1, value: String(p.new_per_day) });
  const rollover = h("input", { type: "number", min: 0, max: 23, step: 1, value: String(p.day_rollover_hour) });
  const speedOut = h("pre", { class: "small" });
  const storageOut = h("p", { class: "muted small" });
  void (async () => {
    try {
      const est = await navigator.storage?.estimate?.();
      const persisted = await navigator.storage?.persisted?.();
      const stats = await store.engine.stats();
      storageOut.textContent = `${store.col.reviews.length} reviews, ${store.col.liveCards().length} cards. Model state ${(stats.memoryBytes / 1e6).toFixed(1)} MB in memory. Storage used ${est?.usage ? (est.usage / 1e6).toFixed(1) : "?"} MB${persisted ? ", protected from automatic cleanup" : ""}.`;
    } catch {
      /* ignore */
    }
  })();

  page(
    "settings",
    "Settings",
    h(
      "form",
      {
        class: "card-box",
        onsubmit: async (e: Event) => {
          e.preventDefault();
          const r = Math.min(99, Math.max(70, Number(retention.value))) / 100;
          const n = Math.min(200, Math.max(0, Math.round(Number(perDay.value))));
          const h0 = Math.min(23, Math.max(0, Math.round(Number(rollover.value))));
          await store.append([store.factory.preset({ preset_id: p.preset_id, desired_retention: r, new_per_day: n, day_rollover_hour: h0 })]);
          toast("Saved");
        },
      },
      h("h2", {}, "Study"),
      h("label", {}, "Target recall, %", retention, h("span", { class: "muted small" }, "A word comes back when the model thinks your chance of remembering it fell below this.")),
      h("label", {}, "New words per day", perDay),
      h("label", {}, "New day starts at (hour)", rollover),
      h("button", { class: "primary", type: "submit" }, "Save"),
    ),
    h(
      "div",
      { class: "card-box" },
      h("h2", {}, "Your data"),
      storageOut,
      h("p", { class: "muted small" }, "Everything lives on this device until sync arrives. Download a backup now and then."),
      h(
        "button",
        {
          class: "secondary",
          onclick: async () => {
            const events = await store.allEvents();
            const blob = new Blob([JSON.stringify({ app: "rcfc", version: 1, exported_at: new Date().toISOString(), events })], { type: "application/json" });
            const a = h("a", { href: URL.createObjectURL(blob), download: `rcfc-backup-${new Date().toISOString().slice(0, 10)}.json` });
            document.body.appendChild(a);
            a.click();
            a.remove();
          },
        },
        "Download backup",
      ),
      h(
        "label",
        { class: "secondary file-btn" },
        "Restore from backup",
        h("input", {
          type: "file",
          accept: ".json,application/json",
          onchange: async (e: Event) => {
            const f = (e.target as HTMLInputElement).files?.[0];
            if (!f) return;
            try {
              const data = JSON.parse(await f.text());
              if (data?.app !== "rcfc" || !Array.isArray(data.events)) throw new Error("not an rcfc backup");
              const n = await store.importBackup(data.events);
              toast(n ? `Restored ${n} events, reloading…` : "Nothing new in that backup");
              if (n) setTimeout(() => location.reload(), 800);
            } catch (err) {
              toast(`Restore failed: ${err instanceof Error ? err.message : err}`);
            }
          },
        }),
      ),
    ),
    h(
      "div",
      { class: "card-box" },
      h("h2", {}, "Speed test"),
      h("p", { class: "muted small" }, "Measures the model on this device. Takes up to a minute on a phone."),
      h(
        "button",
        {
          class: "secondary",
          onclick: async (e: Event) => {
            const b = e.target as HTMLButtonElement;
            b.disabled = true;
            speedOut.textContent = "Running…";
            try {
              const r = await store.engine.speedTest(3000, 600);
              const year = 82_000 / r.reviewsPerSec;
              speedOut.textContent = [
                `replay: ${r.reviewsPerSec.toFixed(0)} reviews/s`,
                `predict: ${r.predictMsPerCard.toFixed(2)} ms/card`,
                `≈ a year of daily use (82k reviews) replays in ${year.toFixed(0)} s`,
                `≈ scoring 7,300 cards takes ${((r.predictMsPerCard * 7300) / 1000).toFixed(1)} s`,
                navigator.userAgent,
              ].join("\n");
            } catch (err) {
              speedOut.textContent = `failed: ${err}`;
            } finally {
              b.disabled = false;
            }
          },
        },
        "Run speed test",
      ),
      speedOut,
    ),
    h("p", { class: "muted small center" }, `rcfc · ${__BUILD__}`),
  );
}

// ---------- boot ----------

declare const __BUILD__: string;

async function boot() {
  const status = h("p", { class: "muted center" }, "Loading your words…");
  clear(root);
  root.appendChild(status);
  try {
    const { store: s, info } = await Store.open((done, total) => {
      status.textContent = `Updating the memory model… ${Math.round((100 * done) / total)}%`;
    });
    store = s;
    console.info("rcfc startup", info);
    if (import.meta.env.DEV) (window as unknown as { rcfc: Store }).rcfc = store;
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") void store.engine.flush();
    });
    if (store.col.reviews.length || store.col.notes.size) void requestPersistence();
    await home();
  } catch (e) {
    console.error(e);
    clear(root);
    root.appendChild(h("div", { class: "card-box" }, h("h2", {}, "Something went wrong"), h("pre", { class: "small" }, String(e instanceof Error ? e.stack ?? e.message : e)), h("button", { class: "primary", onclick: () => location.reload() }, "Reload")));
  }
}

void boot();
