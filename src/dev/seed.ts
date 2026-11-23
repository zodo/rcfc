// Demo collection for development and the UI smoke test: one deck of `words`
// notes, about 60% of them with a month of review history, so home shows due
// and new cards right away. Deterministic for a given (words, now).
import { EventFactory } from "../domain/collection";
import type { AppEvent, DeckCreatedPayload, NoteCreatedPayload, Review } from "../domain/events";
import type { EntityId } from "../domain/ids";
import { localTzOffsetMin } from "../domain/rows";

const WORDS: [string, string][] = [
  ["casa", "house"], ["perro", "dog"], ["gato", "cat"], ["agua", "water"], ["libro", "book"],
  ["mesa", "table"], ["silla", "chair"], ["ventana", "window"], ["puerta", "door"], ["calle", "street"],
  ["ciudad", "city"], ["árbol", "tree"], ["flor", "flower"], ["cielo", "sky"], ["nube", "cloud"],
  ["lluvia", "rain"], ["sol", "sun"], ["luna", "moon"], ["estrella", "star"], ["mar", "sea"],
  ["río", "river"], ["montaña", "mountain"], ["camino", "road"], ["coche", "car"], ["tren", "train"],
  ["pan", "bread"], ["queso", "cheese"], ["leche", "milk"], ["manzana", "apple"], ["naranja", "orange"],
  ["rojo", "red"], ["verde", "green"], ["azul", "blue"], ["blanco", "white"], ["negro", "black"],
  ["hablar", "to speak"], ["comer", "to eat"], ["beber", "to drink"], ["dormir", "to sleep"], ["leer", "to read"],
];

const DAY = 86_400_000;

/** Small deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seedEvents(opts: { deviceId: string; presetId: EntityId; words: number; now: number }): AppEvent[] {
  const rand = rng(opts.words);
  let t = opts.now - 31 * DAY;
  const f = new EventFactory(opts.deviceId, () => t);
  const tz = localTzOffsetMin(new Date(opts.now));
  const out: AppEvent[] = [];
  const deck = f.deck("Demo Spanish", opts.presetId, { from: "es", to: "en" });
  const deckId = (deck.payload as DeckCreatedPayload).deck_id;
  out.push(deck);

  const reviews: Review[] = [];
  for (let i = 0; i < opts.words; i++) {
    t += 1000;
    const [es, en] = WORDS[i % WORDS.length];
    const round = Math.floor(i / WORDS.length);
    const evs = f.note(deckId, { front: round ? `${es} ${round + 1}` : es, back: round ? `${en} ${round + 1}` : en }, { from: "es", to: "en" });
    out.push(...evs);
    if (rand() > 0.6) continue;
    const noteId = (evs[0].payload as NoteCreatedPayload).note_id;
    for (const card of evs.slice(1)) {
      const cardId = (card.payload as { card_id: EntityId }).card_id;
      // First seen 30..10 days ago, then intervals growing ~2.5x, mostly "Good".
      let at = opts.now - (10 + rand() * 20) * DAY;
      let interval = 1;
      while (at < opts.now - DAY / 2) {
        const rating = rand() < 0.15 ? 1 : rand() < 0.1 ? 2 : rand() < 0.1 ? 4 : 3;
        t = Math.floor(at);
        reviews.push(f.make<Review>("review", { card_id: cardId, note_id: noteId, deck_id: deckId, preset_id: opts.presetId, rating, duration_ms: 2000 + Math.floor(rand() * 6000), tz_offset_min: tz }));
        interval = rating === 1 ? 1 : interval * 2.5;
        at += interval * DAY * (0.8 + rand() * 0.4);
      }
    }
  }
  return [...out, ...reviews.sort((a, b) => a.ts - b.ts)];
}
