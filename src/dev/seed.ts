// Demo collection for development and the UI smoke test: one deck of `words`
// notes, about 60% of them with a month of review history, so home shows due
// and new cards right away. Deterministic for a given (words, now).
import { EventFactory } from "../domain/collection";
import type { AppEvent, DeckCreatedPayload, NoteCreatedPayload, Review } from "../domain/events";
import type { EntityId } from "../domain/ids";
import { localTzOffsetMin } from "../domain/rows";

const WORDS: [string, string, string][] = [
  ["casa", "house", "Mi casa es pequeña."], ["perro", "dog", "El perro duerme en el sofá."], ["gato", "cat", "Tengo dos gatos negros."],
  ["agua", "water", "Bebo agua fría."], ["libro", "book", "Leo un libro cada mes."], ["mesa", "table", "La comida está en la mesa."],
  ["silla", "chair", "Siéntate en esta silla."], ["ventana", "window", "Abre la ventana, por favor."], ["puerta", "door", "Cierra la puerta."],
  ["calle", "street", "Vivo en una calle tranquila."], ["ciudad", "city", "Madrid es una ciudad grande."], ["árbol", "tree", "Hay un árbol en el jardín."],
  ["flor", "flower", "Te compré una flor."], ["cielo", "sky", "El cielo está azul."], ["nube", "cloud", "No hay ni una nube."],
  ["lluvia", "rain", "Me gusta la lluvia."], ["sol", "sun", "Hace sol hoy."], ["luna", "moon", "La luna está llena."],
  ["estrella", "star", "Veo una estrella."], ["mar", "sea", "Nadamos en el mar."], ["río", "river", "El río es muy largo."],
  ["montaña", "mountain", "Subimos la montaña."], ["camino", "road", "El camino es largo."], ["coche", "car", "Mi coche es rojo."],
  ["tren", "train", "El tren sale a las ocho."], ["pan", "bread", "Compro pan cada día."], ["queso", "cheese", "Me encanta el queso."],
  ["leche", "milk", "Quiero café con leche."], ["manzana", "apple", "Como una manzana."], ["naranja", "orange", "Esta naranja es dulce."],
  ["rojo", "red", "Llevo un vestido rojo."], ["verde", "green", "La hierba es verde."], ["azul", "blue", "Mi color favorito es el azul."],
  ["blanco", "white", "La nieve es blanca."], ["negro", "black", "Tengo un gato negro."], ["hablar", "to speak", "Hablamos español."],
  ["comer", "to eat", "Comemos a las dos."], ["beber", "to drink", "No bebo café."], ["dormir", "to sleep", "Duermo ocho horas."],
  ["leer", "to read", "Me gusta leer."],
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
    const [es, en, example] = WORDS[i % WORDS.length];
    const round = Math.floor(i / WORDS.length);
    const evs = f.note(deckId, { front: round ? `${es} ${round + 1}` : es, back: round ? `${en} ${round + 1}` : en, example }, { from: "es", to: "en" });
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
