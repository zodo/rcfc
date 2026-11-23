// Import a Duocards CSV export into creation events.
//
// Export format (observed Nov 2026): header `front,back,hint,publishedAt`, one row
// per card, newest first. `hint` is an example sentence (often empty), and
// `publishedAt` is ISO 8601. There is no review history, so imported cards start new.
//
// Pure function: CSV text in, events out. The caller appends the events to the
// local log. Imported notes are not queued for enrichment.

import { parseCsv, CsvError } from "./csv";
import { newEntityId, uuidv7, type EntityId } from "../domain/ids";
import type { AppEvent, CardTemplate, NoteFields } from "../domain/events";

export interface DuocardsImportOptions {
  deckId: EntityId;
  /** `from` is the studied language (front side) and drives pronunciation. */
  langPair: { from: string; to: string };
  deviceId: string;
  /** Default: forward and reverse, one card each per note. */
  templates?: CardTemplate[];
  /** Notes already in the collection, to make re-imports skip what exists. */
  existing?: Iterable<Pick<NoteFields, "front" | "back">>;
  /** Clock for envelope `ts`; injectable for tests. */
  now?: () => number;
}

export interface SkippedRow {
  line: number;
  front: string;
  back: string;
  reason: "duplicate_in_file" | "already_exists";
}

export interface RowError {
  line: number;
  message: string;
}

export interface DuocardsImportResult {
  events: AppEvent[];
  notes: number;
  cards: number;
  skipped: SkippedRow[];
  errors: RowError[];
}

export class DuocardsFormatError extends Error {}

const REQUIRED = ["front", "back"] as const;

/** Dedup key: NFC, trimmed, inner whitespace collapsed, case-folded. */
export function noteKey(front: string, back: string): string {
  const norm = (s: string) => s.normalize("NFC").trim().replace(/\s+/g, " ").toLocaleLowerCase();
  return `${norm(front)}\u0000${norm(back)}`;
}

/** `duo_cards_es_export.csv` → "es". Undefined when the name does not say. */
export function guessSourceLang(filename: string): string | undefined {
  return /duo_?cards_([a-z]{2,3}(?:-[a-z]{2,4})?)_export/i.exec(filename)?.[1]?.toLowerCase();
}

/** Text cleanup that keeps the user's content: NFC, trim, CRLF → LF. */
const clean = (s: string) => s.normalize("NFC").replace(/\r\n?/g, "\n").trim();

export function importDuocardsCsv(text: string, opts: DuocardsImportOptions): DuocardsImportResult {
  let records;
  try {
    records = parseCsv(text);
  } catch (e) {
    if (e instanceof CsvError) throw new DuocardsFormatError(`Not a valid CSV file (${e.message})`);
    throw e;
  }
  if (records.length === 0) throw new DuocardsFormatError("The file is empty");

  const header = records[0].values.map((h) => h.trim().toLowerCase());
  const col = (name: string) => header.indexOf(name.toLowerCase());
  const missing = REQUIRED.filter((n) => col(n) < 0);
  if (missing.length) {
    throw new DuocardsFormatError(
      `Not a Duocards export: missing column(s) ${missing.join(", ")} (found: ${records[0].values.join(", ")})`,
    );
  }
  const iFront = col("front");
  const iBack = col("back");
  const iHint = col("hint");
  const iPublished = col("publishedat");

  const templates = opts.templates ?? ["forward", "reverse"];
  if (templates.length === 0) throw new Error("at least one card template is required");
  const seen = new Set<string>();
  for (const n of opts.existing ?? []) seen.add(noteKey(n.front, n.back));
  const fromFile = new Set<string>();

  const skipped: SkippedRow[] = [];
  const errors: RowError[] = [];
  type Row = { line: number; front: string; back: string; example: string; createdAt?: string; createdMs: number };
  const rows: Row[] = [];

  for (const rec of records.slice(1)) {
    const v = rec.values;
    if (v.length !== header.length) {
      errors.push({ line: rec.line, message: `expected ${header.length} columns, found ${v.length}` });
      continue;
    }
    const front = clean(v[iFront]);
    const back = clean(v[iBack]);
    if (!front || !back) {
      errors.push({ line: rec.line, message: `empty ${!front ? "front" : "back"}` });
      continue;
    }
    const key = noteKey(front, back);
    if (seen.has(key)) {
      skipped.push({ line: rec.line, front, back, reason: fromFile.has(key) ? "duplicate_in_file" : "already_exists" });
      continue;
    }
    seen.add(key);
    fromFile.add(key);

    const raw = iPublished >= 0 ? v[iPublished].trim() : "";
    const ms = raw ? Date.parse(raw) : NaN;
    rows.push({
      line: rec.line,
      front,
      back,
      example: iHint >= 0 ? clean(v[iHint]) : "",
      createdAt: Number.isFinite(ms) ? new Date(ms).toISOString() : undefined,
      createdMs: Number.isFinite(ms) ? ms : Infinity,
    });
  }

  // Oldest first, so new cards come up in the order they were learned.
  // Stable sort; rows without a date keep file order at the end.
  rows.sort((a, b) => a.createdMs - b.createdMs);

  const now = opts.now ?? Date.now;
  const events: AppEvent[] = [];
  for (const r of rows) {
    const ts = now();
    const note_id = newEntityId();
    const fields: NoteFields = { front: r.front, back: r.back };
    if (r.example) fields.example = r.example;
    events.push({
      event_id: uuidv7(ts),
      type: "note_created",
      ts,
      device_id: opts.deviceId,
      payload: {
        note_id,
        deck_id: opts.deckId,
        fields,
        lang_pair: opts.langPair,
        source: { kind: "duocards", ...(r.createdAt && { created_at: r.createdAt }) },
      },
    });
    for (const template of templates) {
      events.push({
        event_id: uuidv7(ts),
        type: "card_created",
        ts,
        device_id: opts.deviceId,
        payload: { card_id: newEntityId(), note_id, template },
      });
    }
  }

  return { events, notes: rows.length, cards: rows.length * templates.length, skipped, errors };
}
