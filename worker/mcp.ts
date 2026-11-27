// The Claude connector: an MCP server over the user's words (docs/design.md
// "Claude connector"). Stateless: each call loads the user's events from D1,
// folds them, lets src/domain/wordbook.ts make the change, and appends the
// events it made, which the app gets on its next sync like another device's.
// Who the user is comes from the OAuth token (worker/oauth.ts): its props hold
// the sync code.
import { createMcpHandler, McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import * as z from "zod";
import { Collection, EventFactory } from "../src/domain/collection";
import type { AppEvent } from "../src/domain/events";
import { monotonicClock, Wordbook, WordbookError } from "../src/domain/wordbook";
import { appendEvents, loadEvents, type SqlDb, type WireEvent } from "./sync";

/** device_id of the events the connector writes. */
export const MCP_DEVICE = "claude";

const INSTRUCTIONS = `rcfc is the user's flashcard app for learning languages. Each word is one card, studied both ways: the word in the studied language on one side (with an example sentence), its translation on the other, and a picture the app draws by itself. Words can wear stickers (topics like "Kitchen" or "Trip to Rome"); every sticker is a pile the user can study. Status: new (never studied), learning, known.

How to use these tools:
- Call overview first to see the languages and stickers.
- Add words in their dictionary form, nouns with their article where the language has one ("el perro", "der Hund"), the translation short (a word or two, the common meaning), and an example sentence in the studied language that shows the word in use. add_words never adds a word twice: one the user already has gets the stickers given, and the example and notes it lacks.
- The example is also a fill-in-the-blank: the word is studied both ways, and when the user sees the translation and recalls the word, the app shows the example with the word blanked out ("никакой" + "No tengo ___ problema." → ningún). So write an example that holds the word itself, in this or another regular form, where the translation and the sentence together leave only this word: they pin down which word, and the sentence pins down which form. That matters most for grammar words (ningún, por, sich). The app finds the word by its letters, so a form spelt differently (fue for ir) means that side shows no sentence. A fill-in-the-blank card is never a separate card: add the word with such an example.
- Ids come from find_words or add_words. Act on the words the user means; ask before deleting many.
- The app picks up changes on its next sync, usually within a minute while it's open.`;

const ids = z.array(z.number().int().positive()).min(1).max(500).describe("Word ids, from find_words or add_words");
const status = z.enum(["new", "learning", "known"]);
const language = z.string().min(2).max(40).describe('A language code or name, e.g. "es" or "Spanish"');

const newWord = z.object({
  word: z.string().min(1).max(200).describe("The word or phrase in the studied language, in dictionary form (nouns with their article)"),
  translation: z.string().min(1).max(200).describe("Its translation, short"),
  language: language.describe("The studied language (the word's)"),
  translation_language: language.optional().describe("The translation's language; default: the one this language's words already use"),
  example: z.string().max(400).optional().describe("An example sentence in the studied language that holds the word; shown blanked out (\"No tengo ___ problema.\") when the user recalls the word from its translation, so only this word should fit"),
  note: z.string().max(400).optional().describe("A note shown on the word side (gender, irregular forms…)"),
  translation_note: z.string().max(400).optional().describe("A note shown on the translation side"),
  picture: z.string().max(200).optional().describe("What the picture should show, only when the word alone is ambiguous"),
  stickers: z.array(z.string().min(1).max(30)).max(10).optional().describe("Sticker names to stick on (made when new)"),
  status: status.optional().describe('"known" if the user already knows it, "learning" to learn it before other new words; default "new"'),
});

type Run = (w: Wordbook) => unknown;

/** One tool call: fold the user's log, run, store what it made. */
async function call(db: SqlDb, code: string, run: Run): Promise<CallToolResult> {
  const col = new Collection();
  for (const e of await loadEvents(db, code)) col.apply(e as AppEvent);
  const w = new Wordbook(col, new EventFactory(MCP_DEVICE, monotonicClock()));
  let out: unknown;
  try {
    out = run(w);
  } catch (e) {
    if (e instanceof WordbookError) return { isError: true, content: [{ type: "text", text: e.message }] };
    throw e;
  }
  if (w.made.length) await appendEvents(db, code, w.made as WireEvent[]);
  return { content: [{ type: "text", text: JSON.stringify(out) }] };
}

/** The MCP server for one request, acting for the user with this sync code. */
export function wordsServer(db: SqlDb, code: string): McpServer {
  const server = new McpServer({ name: "rcfc", title: "rcfc words", version: "1.0.0" }, { instructions: INSTRUCTIONS });
  const read = { readOnlyHint: true, openWorldHint: false } as const;
  const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

  server.registerTool(
    "overview",
    { title: "Overview", description: "The languages the user studies (word counts by status, translation languages) and their stickers (word counts). Start here.", inputSchema: z.object({}), annotations: read },
    async () => call(db, code, (w) => w.overview()),
  );

  server.registerTool(
    "find_words",
    {
      title: "Find words",
      description: "List the user's words, oldest first, optionally narrowed by language, sticker, status or text. Returns the total matching and one page of words with their ids.",
      inputSchema: z.object({
        language: language.optional(),
        sticker: z.string().max(30).optional().describe("Only words wearing this sticker"),
        status: status.optional(),
        text: z.string().max(200).optional().describe("Text anywhere in the word, translation, example or notes (case and accents ignored)"),
        deleted: z.boolean().optional().describe("List deleted words instead (to restore them)"),
        limit: z.number().int().min(1).max(500).optional().describe("Page size, default 50"),
        offset: z.number().int().min(0).optional(),
      }),
      annotations: read,
    },
    async (q) => call(db, code, (w) => w.find(q)),
  );

  server.registerTool(
    "add_words",
    {
      title: "Add words",
      description: "Add words to study. A word the user already has with the same translation isn't added again (it's listed under skipped with its id): it gets the stickers given, and the example and notes where it has none; nothing it has is written over and its progress stays (those changed are listed under updated). So repeating a call adds nothing, and adding words again with a sticker sticks it on. Pictures, audio and notes are made by the app when the word comes up.",
      inputSchema: z.object({ words: z.array(newWord).min(1).max(200) }),
      annotations: write,
    },
    async ({ words }) => call(db, code, (w) => w.add(words)),
  );

  server.registerTool(
    "edit_words",
    {
      title: "Edit words",
      description:
        "Change words' text or their translation's language, many in one call. Per word only the fields given change; an empty string clears an example or note. To translate a word into another language, give translation and translation_language together (and translation_note in that language, if it has one). The studied language can't change: delete the word and add it again. If one edit can't be made, none is made.",
      inputSchema: z.object({
        words: z
          .array(
            z.object({
              id: z.number().int().positive(),
              word: z.string().max(200).optional(),
              translation: z.string().max(200).optional(),
              example: z.string().max(400).optional().describe("A sentence that holds the word (blanked out when recalled from the translation)"),
              note: z.string().max(400).optional(),
              translation_note: z.string().max(400).optional(),
              translation_language: language.optional().describe('The translation\'s language, e.g. "ru"'),
            }),
          )
          .min(1)
          .max(200),
      }),
      annotations: { ...write, idempotentHint: true },
    },
    async ({ words }) => call(db, code, (w) => w.editAll(words)),
  );

  server.registerTool(
    "delete_words",
    { title: "Delete words", description: "Delete words. They can be brought back with restore_words, progress and all.", inputSchema: z.object({ ids }), annotations: { ...write, destructiveHint: true, idempotentHint: true } },
    async ({ ids }) => call(db, code, (w) => ({ deleted: w.remove(ids) })),
  );

  server.registerTool(
    "restore_words",
    { title: "Restore words", description: "Bring back deleted words (find them with find_words deleted=true).", inputSchema: z.object({ ids }), annotations: { ...write, idempotentHint: true } },
    async ({ ids }) => call(db, code, (w) => ({ restored: w.restore(ids) })),
  );

  server.registerTool(
    "mark_known",
    { title: "Mark words known", description: 'The user already knows these words: the app stops asking them until they are due, far out (the app\'s "I know").', inputSchema: z.object({ ids }), annotations: write },
    async ({ ids }) => call(db, code, (w) => ({ marked: w.markKnown(ids) })),
  );

  server.registerTool(
    "mark_unknown",
    { title: "Mark words not known", description: 'The user doesn\'t know these words: studied ones come back soon, new ones are learned before other new words (the app\'s "Don\'t know").', inputSchema: z.object({ ids }), annotations: write },
    async ({ ids }) => call(db, code, (w) => ({ marked: w.markUnknown(ids) })),
  );

  server.registerTool(
    "stick",
    { title: "Stick a sticker on", description: "Stick a sticker on words; a sticker with a new name is made.", inputSchema: z.object({ sticker: z.string().min(1).max(30), ids }), annotations: { ...write, idempotentHint: true } },
    async ({ sticker, ids }) => call(db, code, (w) => w.stick(sticker, ids, true)),
  );

  server.registerTool(
    "unstick",
    { title: "Peel a sticker off", description: "Peel a sticker off words (the sticker and the words stay).", inputSchema: z.object({ sticker: z.string().min(1).max(30), ids }), annotations: { ...write, idempotentHint: true } },
    async ({ sticker, ids }) => call(db, code, (w) => w.stick(sticker, ids, false)),
  );

  server.registerTool(
    "rename_sticker",
    { title: "Rename a sticker", description: "Rename a sticker. Renamed to another sticker's name, the two become one.", inputSchema: z.object({ sticker: z.string().min(1).max(30), to: z.string().min(1).max(30) }), annotations: { ...write, idempotentHint: true } },
    async ({ sticker, to }) => call(db, code, (w) => ({ sticker: w.renameSticker(sticker, to) })),
  );

  server.registerTool(
    "delete_sticker",
    { title: "Delete a sticker", description: "Delete a sticker and its pile. Its words stay.", inputSchema: z.object({ sticker: z.string().min(1).max(30) }), annotations: { ...write, destructiveHint: true, idempotentHint: true } },
    async ({ sticker }) => call(db, code, (w) => (w.deleteSticker(sticker), { deleted: sticker })),
  );

  return server;
}

/** Serve one MCP request for the user with this sync code (stateless: a fresh server per request). */
export function serveMcp(request: Request, db: SqlDb, code: string): Promise<Response> {
  return createMcpHandler(() => wordsServer(db, code)).fetch(request);
}
