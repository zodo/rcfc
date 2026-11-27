// Import from anything (docs/design.md "Import from anything"): copy a prompt
// for an AI chat, paste its answer (or pick a file), see what comes in, add it.
import { app, go, requestPersistence, subPage } from "../app";
import { fileLang, importPrompt, mergeOf, planImport, readImport, scriptLang, type ImportPlan, type ReadResult } from "../import/anything";
import { labelPile } from "../domain/labels";
import { append, clear, h, LANGS, langName, langSelect, toast } from "../ui/h";
import { deckFor, languages, lastLanguage, rememberLanguage, rememberTranslation, setOpenChip, translationFor } from "./languages";

/** The language the user's translations are mostly in: what they speak. */
function spokenLanguage(): string {
  const n = new Map<string, number>();
  for (const x of app.store.col.liveNotes()) n.set(x.lang_pair.to, (n.get(x.lang_pair.to) ?? 0) + 1);
  const top = [...n].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (top) return top;
  const nav = typeof navigator !== "undefined" ? navigator.language?.split("-")[0]?.toLowerCase() : undefined;
  return nav && LANGS.includes(nav) ? nav : "en";
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

export function importScreen(): void {
  const { store } = app;
  const prompt = () => importPrompt(languages().map((l) => ({ from: l, to: translationFor(l) })), spokenLanguage(), langName);

  const copy = h("button", { class: "primary", type: "button" }, "Copy prompt for your AI chat");
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;
  copy.addEventListener("click", async () => {
    const text = prompt();
    if (await copyText(text)) {
      copy.textContent = "Copied";
      clearTimeout(copiedTimer);
      copiedTimer = setTimeout(() => (copy.textContent = "Copy prompt for your AI chat"), 2500);
    } else {
      // No clipboard: show the prompt to copy by hand.
      const shown = h("textarea", { class: "import-prompt", readonly: true, rows: 8 }, text);
      copy.replaceWith(shown);
      shown.select();
    }
  });

  const paste = h("textarea", { class: "import-paste", rows: 6, placeholder: "Paste the AI's answer here", "aria-label": "The AI's answer" });
  paste.spellcheck = false;
  const file = h("input", { type: "file", accept: ".csv,.tsv,.txt,.md,text/*", hidden: true });
  const pick = h("button", { class: "link", type: "button", onclick: () => file.click() }, "or pick a file");
  file.addEventListener("change", async () => {
    const f = file.files?.[0];
    if (!f) return;
    paste.value = await f.text();
    file.value = "";
    // A Duocards export says its language only in its name.
    named = fileLang(f.name);
    pickers = null;
    update();
  });

  const box = h("div", {});
  let pickers: { from: HTMLSelectElement; to: HTMLSelectElement } | null = null;
  /** The studied language the picked file's name gives. */
  let named: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  paste.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(update, 200);
  });

  function update(): void {
    const text = paste.value;
    clear(box);
    if (!text.trim()) {
      pickers = null;
      named = undefined;
      return;
    }
    const read = readImport(text);
    if (read.noTable || !read.rows.length) {
      pickers = null;
      append(box, [
        h(
          "div",
          { class: "card-box" },
          read.noTable
            ? h("p", {}, "There are no words to add in this. Paste the AI's whole answer, or just the block from it. An export from another app goes to the AI first, with the prompt.")
            : h("p", {}, "None of these rows could be read."),
          errorLine(read.errors),
        ),
      ]);
      return;
    }
    // Rows that don't name their languages take the pickers' (kept while the paste changes).
    if (!pickers) {
      const from = named ?? scriptLang(read.rows.map((r) => r.word)) ?? lastLanguage() ?? "es";
      pickers = { from: langSelect("from", from), to: langSelect("to", scriptLang(read.rows.map((r) => r.translation)) ?? translationFor(from)) };
      pickers.from.addEventListener("change", () => ((pickers!.to.value = translationFor(pickers!.from.value)), update()));
      pickers.to.addEventListener("change", update);
    }
    const plan = planImport(read, store.col.liveNotes(), { from: pickers.from.value, to: pickers.to.value });
    box.appendChild(preview(read, plan));
  }

  function preview(read: ReadResult, plan: ImportPlan): HTMLElement {
    const n = plan.ready.length;
    const studied = new Set(languages());
    const groups = new Map<string, number>();
    for (const r of plan.ready) groups.set(`${r.pair.from}>${r.pair.to}`, (groups.get(`${r.pair.from}>${r.pair.to}`) ?? 0) + 1);
    const known = plan.ready.filter((r) => r.status === "known").length;
    const learning = plan.ready.filter((r) => r.status === "learning").length;
    const stickers = [...new Set(plan.ready.flatMap((r) => r.stickers))];
    const exists = plan.skipped.filter((s) => s.reason === "exists").length;
    const repeated = plan.skipped.length - exists;
    // Words already there get the stickers, example and notes they lack.
    const merges = plan.existing.map((e) => mergeOf(store.col, e)).filter((m) => m.edits.length || m.stickers.length);
    const u = merges.length;
    const label = n ? (n === 1 ? "Add 1 word" : `Add ${n} words`) : u === 1 ? "Update 1 word" : `Update ${u} words`;
    const add = h("button", { class: "primary", type: "button", disabled: n === 0 && u === 0 }, label);
    add.addEventListener("click", async () => {
      add.disabled = true;
      for (const r of plan.ready) if (!studied.has(r.pair.from)) rememberTranslation(r.pair.from, r.pair.to);
      const res = await store.importWords(plan.ready, deckFor, plan.existing);
      await requestPersistence();
      const first = plan.ready[0] ?? plan.existing[0].row;
      rememberLanguage(first.pair.from);
      const said = [res.words ? (res.words === 1 ? "Added 1 word" : `Added ${res.words} words`) : "", res.updated ? (res.updated === 1 ? "updated 1" : `updated ${res.updated}`) : ""].filter(Boolean).join(", ");
      toast(said.charAt(0).toUpperCase() + said.slice(1));
      setOpenChip(res.labels.length === 1 ? labelPile(res.labels[0]) : groups.size === 1 ? `lang:${first.pair.from}` : null);
      go.words();
    });
    return h(
      "div",
      { class: "card-box import-preview" },
      h("p", {}, h("strong", {}, n === 1 ? "1 word" : `${n} words`)),
      groups.size
        ? h(
            "ul",
            { class: "import-groups" },
            ...[...groups].map(([k, c]) => {
              const [from, to] = k.split(">");
              return h("li", {}, `${langName(from)} → ${langName(to)}: ${c}`, studied.has(from) ? null : h("span", { class: "muted" }, " (new language)"));
            }),
          )
        : null,
      known || learning ? h("p", { class: "muted small" }, [known ? `${known} known` : "", learning ? `${learning} learning` : ""].filter(Boolean).join(", ")) : null,
      stickers.length ? h("p", { class: "muted small" }, `Stickers: ${stickers.slice(0, 8).join(", ")}${stickers.length > 8 ? ` and ${stickers.length - 8} more` : ""}`) : null,
      n ? h("ul", { class: "import-sample" }, ...plan.ready.slice(0, 5).map((r) => h("li", {}, h("strong", {}, r.word), ` ${r.translation}`))) : null,
      plan.unnamed && pickers ? h("div", { class: "row2" }, h("label", {}, plan.unnamed === read.rows.length ? "Words are in" : "Words without a language are in", pickers.from), h("label", {}, "Translations in", pickers.to)) : null,
      exists ? h("p", { class: "muted small" }, `${exists} already in your words.${u ? ` ${u === exists ? (u === 1 ? "It gets" : "They get") : `${u} of them get`} ${gets(merges)}.` : ""}`) : null,
      repeated ? h("p", { class: "muted small" }, `${repeated} repeated in the paste.`) : null,
      errorLine(plan.errors),
      add,
    );
  }

  subPage(
    "words",
    "Import from anything",
    () => go.words(),
    h(
      "div",
      { class: "card-box" },
      h("p", { class: "muted" }, "Paste this prompt into ChatGPT, Claude or Gemini, then add an export from another app, or say what you'd like to learn."),
      copy,
    ),
    h("div", { class: "card-box" }, paste, h("p", { class: "small center" }, pick), file),
    box,
  );
}

/** What words already there get from the paste, e.g. "their new stickers and missing examples". */
function gets(merges: { edits: { field: string }[]; stickers: string[] }[]): string {
  const parts: string[] = [];
  if (merges.some((m) => m.stickers.length)) parts.push("new stickers");
  if (merges.some((m) => m.edits.some((e) => e.field === "example"))) parts.push("missing examples");
  if (merges.some((m) => m.edits.some((e) => e.field !== "example"))) parts.push("missing notes");
  return parts.length < 2 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

function errorLine(errors: { line: number; message: string }[]): HTMLElement | null {
  if (!errors.length) return null;
  const shown = errors.slice(0, 3).map((e) => `line ${e.line}: ${e.message}`).join("; ");
  return h("p", { class: "muted small" }, `${errors.length === 1 ? "1 row" : `${errors.length} rows`} couldn't be read (${shown}${errors.length > 3 ? "…" : ""}).`);
}
