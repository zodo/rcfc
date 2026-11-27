// Your AI (docs/design.md "Your AI"): the user's own chat (ChatGPT, Claude,
// Gemini…) adds words and changes them. The slip on the Words title line opens
// a sheet: Copy prompt (to add words), Share my words (to change them: a CSV
// file with the prompt inside), a box for the reply, and the Claude connector.
// A reply becomes a proposal that Words shows as pencil corrections on the
// list (`proposal`, `previewRows`) until Apply or Throw away.
import { app, go, requestPersistence, sheet } from "../app";
import type { NoteDeleted } from "../domain/events";
import type { EntityId } from "../domain/ids";
import { labelPile } from "../domain/labels";
import {
  exportWords,
  fileLang,
  importPrompt,
  mergeOf,
  planChanges,
  planImport,
  readImport,
  scriptLang,
  type ChangePlan,
  type ImportPlan,
  type ReadResult,
} from "../import/anything";
import { refreshStatuses, statusById } from "../statuses";
import { h, LANGS, langName, langSelect, slip, toast } from "../ui/h";
import { marks } from "../ui/marks";
import { deckFor, languages, lastLanguage, rememberLanguage, rememberTranslation, setOpenChip, translationFor } from "./languages";

const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

/** The language the user's translations are mostly in: what they speak. */
function spokenLanguage(): string {
  const n = new Map<string, number>();
  for (const x of app.store.col.liveNotes()) n.set(x.lang_pair.to, (n.get(x.lang_pair.to) ?? 0) + 1);
  const top = [...n].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (top) return top;
  const nav = typeof navigator !== "undefined" ? navigator.language?.split("-")[0]?.toLowerCase() : undefined;
  return nav && LANGS.includes(nav) ? nav : "en";
}

function prompt(words: boolean): string {
  const stickers = app.store.col.liveLabels().map((l) => l.name);
  return importPrompt(languages().map((l) => ({ from: l, to: translationFor(l) })), spokenLanguage(), langName, { stickers, words });
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older WebViews: copy from a selected textarea.
    const t = h("textarea", { readonly: true, style: "position:fixed;opacity:0" }, text);
    document.body.appendChild(t);
    t.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      /* not allowed */
    }
    t.remove();
    return ok;
  }
}

/** The slip on the Words title line: the chats' marks and "Your AI". */
export function yourAiSlip(): HTMLElement {
  return h("button", { class: "secondary your-ai", type: "button", "aria-label": "Your AI: ChatGPT, Claude, Gemini", onclick: () => openYourAi() }, marks(20), h("span", {}, "Your AI"));
}

// ---------------------------------------------------------------- the sheet

let openNext = false;
let openedEmpty = false;

/**
 * Other places point here (the card editor's hint): they leave the way they
 * always do (a card not added yet is asked about first), then Words opens
 * with the sheet up.
 */
export function yourAiOnWords(): void {
  openNext = true;
  go.words();
}

/** Called by Words once drawn: the sheet comes up if asked for, or once a launch while there are no words. */
export function openIfAsked(empty: boolean): void {
  const asked = openNext || (empty && !openedEmpty);
  openNext = false;
  if (empty) openedEmpty = true;
  if (asked) openYourAi();
}

/** Opens the sheet over whatever screen is showing (Words, the card editor). */
export function openYourAi(): void {
  const { store } = app;
  const count = store.col.liveNotes().length;
  // Statuses for the words file come from fresh predictions, made now so the share stays in the tap.
  void refreshStatuses();

  const copy = h("button", { class: "primary", type: "button" }, "Copy prompt");
  const copied = h("p", { class: "muted small ya-after" }, "then paste it into your chat");
  copy.addEventListener("click", async () => {
    const text = prompt(false);
    if (await copyText(text)) {
      copy.textContent = "Copied";
      copied.textContent = "Now paste it into your chat";
    } else {
      // No clipboard: show the prompt to copy by hand.
      const shown = h("textarea", { class: "import-prompt", readonly: true, rows: 6 }, text);
      copy.replaceWith(shown);
      shown.select();
    }
  });

  const file = () => {
    const name = `rcfc-words-${new Date().toISOString().slice(0, 10)}.csv`;
    return new File([exportWords(store.col, statusById, prompt(true))], name, { type: "text/csv" });
  };
  const canShare = (() => {
    try {
      return typeof navigator.canShare === "function" && navigator.canShare({ files: [new File([""], "x.csv", { type: "text/csv" })] });
    } catch {
      return false;
    }
  })();
  const share = h("button", { class: "secondary", type: "button", disabled: count === 0 }, canShare ? `Share my ${plural(count, "word")}` : `Download my ${plural(count, "word")}`);
  const shareNote = h("p", { class: "muted small ya-after" }, count ? "your chat gets all of them, the prompt inside" : "no words yet");
  share.addEventListener("click", async () => {
    const f = file();
    if (canShare) {
      try {
        await navigator.share({ files: [f], text: "My flashcards. The instructions are at the top of the file." });
      } catch (e) {
        if ((e as Error).name !== "AbortError") toast("Couldn't share the file");
      }
      return;
    }
    // No share sheet (a computer): the file downloads, and the prompt goes on the clipboard too.
    const url = URL.createObjectURL(f);
    const a = h("a", { href: url, download: f.name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    if (await copyText(prompt(true))) shareNote.textContent = "Downloaded, and the prompt is copied. Attach the file in your chat.";
  });

  const paste = h("textarea", { class: "import-paste", rows: 3, placeholder: "Paste it here", "aria-label": "Its reply" });
  paste.spellcheck = false;
  const said = h("p", { class: "muted small", role: "status" });
  const input = h("input", { type: "file", accept: ".csv,.tsv,.txt,.md,text/*", hidden: true });
  const pick = h("button", { class: "link small", type: "button", onclick: () => input.click() }, "or pick a file");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const take = (text: string, named?: string) => {
    const why = propose(text, named);
    said.textContent = why ?? "";
    if (!why) {
      close();
      go.words();
    }
  };
  paste.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => paste.value.trim() && take(paste.value), 300);
  });
  input.addEventListener("change", async () => {
    const f = input.files?.[0];
    if (!f) return;
    input.value = "";
    // A Duocards export says its language only in its name.
    take(await f.text(), fileLang(f.name));
  });

  const address = `${location.origin}/mcp`;
  const copyAddress = h("button", { class: "secondary", type: "button" }, "Copy");
  copyAddress.addEventListener("click", async () => {
    if (await copyText(address)) toast("Address copied");
  });

  const section = (title: string, ...body: (Node | null)[]) => h("section", { class: "ya-part" }, h("h3", {}, title), ...body);
  const close = sheet(
    "Your AI",
    h("span", { class: "ya-title" }, marks(32), "Your AI"),
    h("div", { class: "ya" },
      section("Add words", h("p", { class: "muted small" }, "From another app, a list or a topic."), h("div", { class: "ya-act" }, copy, copied)),
      section("Change your words", h("p", { class: "muted small" }, "Translate, fix, sort into stickers, check."), h("div", { class: "ya-act" }, share, shareNote)),
      section("Its reply", paste, h("div", { class: "ya-pick" }, pick), said, input),
      section(
        "Claude",
        h("p", { class: "muted small" }, "Connect it once and ask without copying. In Claude: Settings → Connectors → Add custom connector, then paste:"),
        h("div", { class: "ya-addr" }, h("code", {}, address), copyAddress),
        h("p", { class: "muted small" }, "If Claude's approval page doesn't find your words, paste the link from Settings → Copy link."),
      ),
    ),
  );
  // The sheet focuses its first button; on a phone that's just a ring round Copy prompt.
  copy.blur();
}

// ---------------------------------------------------------------- the proposal

/** A reply read and planned against the words as they are: what Words shows until Apply or Throw away. */
export interface Proposal {
  read: ReadResult;
  plan: ImportPlan;
  changes: ChangePlan;
  /** Languages for rows that name none (the preview's pickers). */
  fallback: { from: string; to: string };
  text: string;
  named?: string;
}

let pending: Proposal | undefined;

/** The reply waiting on Words, if any. */
export function proposal(): Proposal | undefined {
  return pending;
}

export function throwAway(): void {
  pending = undefined;
}

/** Reads a reply; undefined when it's ready to show, else why not. */
function propose(text: string, named?: string, fallback?: { from: string; to: string }): string | undefined {
  const read = readImport(text);
  if (read.noTable) return "There are no words in this. Paste the chat's whole reply, or just the block from it.";
  if (!read.rows.length && !read.changes.length) return "None of these rows could be read.";
  const from = fallback?.from ?? named ?? scriptLang(read.rows.map((r) => r.word)) ?? lastLanguage() ?? "es";
  const to = fallback?.to ?? scriptLang(read.rows.map((r) => r.translation)) ?? translationFor(from);
  const { col } = app.store;
  const plan = planImport(read, col.liveNotes(), { from, to });
  const changes = planChanges(read.changes, col, statusById);
  pending = { read, plan, changes, fallback: { from, to }, text, named };
  return undefined;
}

/** Rows naming no language take these instead: the proposal planned again. */
export function setFallback(from: string, to: string): void {
  if (pending) propose(pending.text, pending.named, { from, to });
}

/** What a proposal holds, counted: "3 changes · 1 deleted · 2 new". Empty when it changes nothing. */
export function proposalCount(p: Proposal): string {
  const changed = p.changes.changes.filter((c) => !c.remove).length;
  const removed = p.changes.changes.length - changed;
  const merged = p.plan.existing.filter((e) => { const m = mergeOf(app.store.col, e); return m.edits.length || m.stickers.length; }).length;
  return [
    changed + merged ? plural(changed + merged, "change") : "",
    removed ? `${removed} deleted` : "",
    p.plan.ready.length ? `${p.plan.ready.length} new` : "",
  ].filter(Boolean).join(" · ");
}

/** The pickers for rows that name no language, or null. */
export function fallbackPickers(p: Proposal, redraw: () => void): HTMLElement | null {
  if (!p.plan.unnamed) return null;
  const from = langSelect("from", p.fallback.from), to = langSelect("to", p.fallback.to);
  from.addEventListener("change", () => (setFallback(from.value, translationFor(from.value)), redraw()));
  to.addEventListener("change", () => (setFallback(from.value, to.value), redraw()));
  return h("div", { class: "row2 ya-langs" }, h("label", {}, p.plan.unnamed === p.read.rows.length ? "Words are in" : "Words without a language are in", from), h("label", {}, "Translations in", to));
}

/** The note fields a reply can change, as the preview names them. */
const FIELD_NAMES: Record<string, string> = { example: "example", memo_target: "note", memo_known: "translation note" };

const pen = (text: string, cls = "") => h("span", { class: `pen${cls}` }, text);
/** A place changed: the old text crossed out, the new in pencil. */
const changed = (from: string, to: string) => h("span", {}, from ? h("s", {}, from) : null, from && to ? " " : null, to ? pen(to) : null);

/** The proposal as rows on the Words list: pencil corrections over the words as they are. */
export function previewRows(p: Proposal): HTMLElement[] {
  const { col } = app.store;
  const out: HTMLElement[] = [];
  const row = (cls: string, ...cells: (Node | string | null)[]) => h("div", { class: `word pv ${cls}` }, ...cells);
  const sub = (notes: string[], cls = "") => (notes.length ? h("div", { class: `word pv-sub${cls}` }, pen(notes.join(" · "))) : null);
  const status = (id: EntityId) => h("span", { class: `w-p small st-${statusById(id)}` }, statusById(id));

  // New words, written in at the top.
  for (const r of p.plan.ready) {
    out.push(row("pv-new", pen(r.word, " w-front"), pen(r.translation, " w-back"), h("span", { class: "w-p small st-new" }, "new")));
    const notes = [r.stickers.length ? r.stickers.map((s) => `+${s}`).join(" ") : "", r.status !== "new" ? r.status : "", languages().includes(r.pair.from) ? "" : `new language: ${langName(r.pair.from)}`].filter(Boolean);
    const s = sub(notes);
    if (s) out.push(s);
  }
  // Words added again: what they bring.
  for (const e of p.plan.existing) {
    const n = col.notes.get(e.noteId);
    const m = mergeOf(col, e);
    if (!n || (!m.edits.length && !m.stickers.length)) continue;
    out.push(row("", h("span", { class: "w-front" }, n.fields.front), h("span", { class: "w-back muted" }, n.fields.back), status(n.id)));
    const s = sub([...m.stickers.map((x) => `+${x}`), ...m.edits.map((x) => `+${FIELD_NAMES[x.field] ?? x.field}`)]);
    if (s) out.push(s);
  }
  // Changes and deletions.
  for (const c of p.changes.changes) {
    const n = col.notes.get(c.noteId)!;
    if (c.remove) {
      out.push(row("pv-gone", h("span", { class: "w-front" }, h("s", {}, n.fields.front)), h("span", { class: "w-back" }, h("s", {}, n.fields.back)), pen("deleted", " w-p small")));
      continue;
    }
    const f = (field: string) => c.fields.find((x) => x.field === field);
    const front = f("front"), back = f("back");
    out.push(
      row(
        "",
        h("span", { class: "w-front" }, front ? changed(front.from, front.to) : n.fields.front),
        h("span", { class: "w-back muted" }, back ? changed(back.from, back.to) : n.fields.back),
        c.status ? pen(c.status === "known" ? "known" : "don't know", " w-p small") : status(n.id),
      ),
    );
    const notes = [
      c.lang ? `${langName(c.lang.from)} → ${langName(c.lang.to)}` : "",
      ...c.fields.filter((x) => x.field !== "front" && x.field !== "back").map((x) => (x.to ? `${FIELD_NAMES[x.field] ?? x.field}: ${x.to}` : `no ${FIELD_NAMES[x.field] ?? x.field}`)),
      ...c.stickOn.map((s) => `+${s}`),
      ...c.peelOff.map((id) => `−${col.labels.get(id)?.name ?? "sticker"}`),
    ].filter(Boolean);
    const s = sub(notes);
    if (s) out.push(s);
  }
  // Rows that can't be done, with why.
  for (const r of p.changes.refused) {
    const n = col.notes.get(r.noteId);
    out.push(row("pv-refused", h("span", { class: "w-front" }, n?.fields.front ?? r.word ?? `#${r.noteId}`), h("span", { class: "w-back muted" }, n?.fields.back ?? ""), h("span", {})));
    out.push(sub([r.reason], " pv-why")!);
  }
  return out;
}

/** What else a proposal says, under the list: rows repeated or unreadable. */
export function proposalNotes(p: Proposal): string[] {
  const exists = p.plan.skipped.filter((s) => s.reason === "exists").length;
  const repeated = p.plan.skipped.length - exists;
  const errors = p.plan.errors;
  return [
    repeated ? `${plural(repeated, "row")} repeated in the reply` : "",
    errors.length ? `${plural(errors.length, "row")} couldn't be read (${errors.slice(0, 3).map((e) => `line ${e.line}: ${e.message}`).join("; ")}${errors.length > 3 ? "…" : ""})` : "",
  ].filter(Boolean);
}

/** Apply: the new words added, the changes made; an Undo slip puts them back. */
export async function applyProposal(p: Proposal): Promise<void> {
  const { store } = app;
  pending = undefined;
  const hadStickers = new Set(store.col.liveLabels().map((l) => l.id));
  const studied = new Set(languages());
  for (const r of p.plan.ready) if (!studied.has(r.pair.from)) rememberTranslation(r.pair.from, r.pair.to);
  const added = p.plan.ready.length || p.plan.existing.length ? await store.importWords(p.plan.ready, deckFor, p.plan.existing) : { words: 0, updated: 0, labels: [], noteIds: [] as EntityId[] };
  const undo = await store.applyChanges(p.changes.changes);
  await requestPersistence();
  if (p.plan.ready[0]) rememberLanguage(p.plan.ready[0].pair.from);
  // Words come in: Words opens on their sticker, or their language.
  if (added.words || added.updated) {
    const langs = new Set([...p.plan.ready, ...p.plan.existing.map((e) => e.row)].map((r) => r.pair.from));
    setOpenChip(added.labels.length === 1 ? labelPile(added.labels[0]) : langs.size === 1 ? `lang:${[...langs][0]}` : null);
  }
  const changed = p.changes.changes.filter((c) => !c.remove).length + added.updated;
  const removed = p.changes.changes.length - p.changes.changes.filter((c) => !c.remove).length;
  const said = [added.words ? `${plural(added.words, "word")} added` : "", changed ? `${changed} changed` : "", removed ? `${removed} deleted` : ""].filter(Boolean).join(", ");
  slip(said || "Nothing to change", "Undo", async () => {
    await undo();
    if (added.noteIds.length) await store.append(added.noteIds.map((note_id) => store.factory.make<NoteDeleted>("note_deleted", { note_id })));
    // Stickers this reply made go again once nothing wears them.
    for (const l of store.col.liveLabels()) if (!hadStickers.has(l.id) && !store.col.labelNotes(l.id).length) await store.deleteLabel(l.id);
    toast("Put back");
    go.words();
  });
}
