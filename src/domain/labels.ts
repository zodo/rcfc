// Stickers: labels stuck on words (docs/design.md "Piles, labels and
// languages"). Many to many, across languages; never fed to the model. Each
// sticker is a pile on the table. Pure helpers; the fold is in collection.ts.
import type { Collection } from "./collection";
import { derivedEntityId, newEntityId, type EntityId } from "./ids";

/** Longest sticker name, in characters. */
export const LABEL_MAX = 30;

/** A name as stored: spaces trimmed and collapsed, at most LABEL_MAX characters. */
export function labelName(s: string): string {
  return [...s.trim().replace(/\s+/g, " ")].slice(0, LABEL_MAX).join("").trim();
}

/** Names that are the same sticker: "Kitchen", "kitchen " and "kitchen". */
export function nameKey(s: string): string {
  return labelName(s).toLocaleLowerCase();
}

/** The pile of a sticker's words. */
export function labelPile(id: EntityId): string {
  return `label:${id}`;
}

/** The sticker id in a pile key, if it is a sticker's pile. */
export function pileLabel(pile: string): EntityId | undefined {
  const m = /^label:(\d+)$/.exec(pile);
  return m ? Number(m[1]) : undefined;
}

/**
 * The id for a sticker made with this name: the live one with the same name,
 * else one derived from the name (two devices making it offline agree), unless
 * that id was used before (renamed or deleted since), then a random one.
 */
export function labelIdFor(col: Collection, name: string): { id: EntityId; exists: boolean } {
  const same = col.labelByName(name);
  if (same) return { id: same.id, exists: true };
  const id = derivedEntityId(`label:${nameKey(name)}`);
  return { id: col.labels.has(id) ? newEntityId() : id, exists: false };
}
