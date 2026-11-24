#!/usr/bin/env bun
// UI smoke test in headless Chromium (the Android/Vivaldi engine), driven over
// the Chrome DevTools Protocol. No dependencies. Starts a dev server unless
// given a URL; each run uses a fresh browser profile.
//
//   bun run smoke                        dev server on :5199, then the checks
//   bun run smoke http://localhost:5173  an already running dev server
//   RCFC_HEADFUL=1 bun run smoke         watch it in a window
//   RCFC_SHOTS=1 bun run smoke           also save screenshots of key screens to .wrangler/smoke/
//   RCFC_TRACE=1 bun run smoke           log every click
//
// Browser: $RCFC_CHROMIUM, else Chromium.app, else Google Chrome. Uses the
// dev-only ?reset / ?seed hooks (src/dev/hooks.ts), so it cannot run against
// preview or production. On failure a screenshot is saved to .wrangler/smoke/.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const DEV_PORT = 5199;
const BROWSERS = [process.env.RCFC_CHROMIUM, "/Applications/Chromium.app/Contents/MacOS/Chromium", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];

const children: { kill(): void }[] = [];
const cleanups: (() => void)[] = [];
function cleanup() {
  for (const c of children) c.kill();
  for (const f of cleanups) f();
}
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});

async function waitHttp(url: string, ms: number): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    try {
      await fetch(url);
      return;
    } catch {
      if (Date.now() > end) throw new Error(`${url} did not come up in ${ms / 1000}s`);
      await Bun.sleep(300);
    }
  }
}

// ---------- Chrome DevTools Protocol ----------

export class Browser {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  /** Uncaught exceptions and console.error output from the page. */
  readonly errors: string[] = [];

  private constructor(private ws: WebSocket) {
    ws.onmessage = (m) => {
      const msg = JSON.parse(String(m.data));
      if (msg.id) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p?.reject(new Error(msg.error.message));
        else p?.resolve(msg.result);
      } else if (msg.method === "Runtime.exceptionThrown") {
        const d = msg.params.exceptionDetails;
        this.errors.push(d.exception?.description ?? d.text);
      } else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
        this.errors.push(msg.params.args.map((a: { value?: unknown; description?: string }) => a.value ?? a.description).join(" "));
      }
    };
  }

  static async start(): Promise<Browser> {
    const exe = BROWSERS.find((b) => b && existsSync(b));
    if (!exe) throw new Error("no Chromium found: install Chromium.app or set RCFC_CHROMIUM");
    const profile = mkdtempSync(join(tmpdir(), "rcfc-smoke-"));
    cleanups.push(() => rmSync(profile, { recursive: true, force: true }));
    const proc = Bun.spawn(
      [exe, ...(process.env.RCFC_HEADFUL ? [] : ["--headless=new"]), "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--mute-audio", "--window-size=430,932", "about:blank"],
      { stdout: "ignore", stderr: "pipe" },
    );
    children.push(proc);
    // Chromium prints "DevTools listening on ws://127.0.0.1:PORT/..." on stderr.
    const reader = proc.stderr.getReader();
    let err = "";
    let port = "";
    const deadline = Date.now() + 20_000;
    while (!port) {
      const { value, done } = await reader.read();
      if (done || Date.now() > deadline) throw new Error(`Chromium did not start:\n${err}`);
      err += new TextDecoder().decode(value);
      port = /DevTools listening on ws:\/\/[^:]+:(\d+)\//.exec(err)?.[1] ?? "";
    }
    void (async () => {
      while (!(await reader.read()).done); // keep draining
    })();
    // The first tab can appear a moment after the DevTools endpoint.
    let page: { type: string; webSocketDebuggerUrl: string } | undefined;
    for (let i = 0; !page; i++) {
      if (i > 50) throw new Error("Chromium opened no page");
      if (i) await Bun.sleep(100);
      const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
      page = targets.find((t) => t.type === "page");
    }
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((ok, fail) => {
      ws.onopen = ok;
      ws.onerror = () => fail(new Error("DevTools connection failed"));
    });
    const b = new Browser(ws);
    await b.send("Runtime.enable");
    await b.send("Page.enable");
    // Speech goes through the OS text-to-speech, which --mute-audio does not
    // silence: keep the API (the speak buttons still render) but only count calls.
    await b.send("Page.addScriptToEvaluateOnNewDocument", { source: "window.__rcfcSpoken = []; if (window.speechSynthesis) speechSynthesis.speak = (u) => void window.__rcfcSpoken.push(u.text);" });
    // iPhone 14-sized viewport.
    await b.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    return b;
  }

  send<T = unknown>(method: string, params: object = {}): Promise<T> {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise<T>((resolve, reject) => this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject }));
  }

  async quit(): Promise<void> {
    await this.send("Browser.close").catch(() => {});
  }

  async go(url: string): Promise<void> {
    await this.send("Page.navigate", { url });
  }

  /** Evaluate a function body in the page; `args` are available as `args`. */
  async js<T>(body: string, ...args: unknown[]): Promise<T> {
    const r = await this.send<{ result: { value: T }; exceptionDetails?: { exception?: { description?: string }; text: string } }>("Runtime.evaluate", {
      expression: `(async (args) => { ${body} })(${JSON.stringify(args)})`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }

  /** Poll a JS expression until it is truthy; returns its value. */
  async until<T>(what: string, expr: string, ms = 15_000): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
      // Evaluation fails while a navigation swaps the document: just retry.
      const v = await this.js<T>(`return (${expr});`).catch(() => undefined);
      if (v) return v;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await Bun.sleep(100);
    }
  }

  /** Centre of the first visible element matching `css` whose text includes `text`. */
  private async find(css: string, text: string, ms = 15_000): Promise<{ x: number; y: number }> {
    return this.until(
      `${css} "${text}"`,
      `(() => {
        const el = [...document.querySelectorAll(${JSON.stringify(css)})].find((e) => e.offsetParent !== null && e.textContent.includes(${JSON.stringify(text)}));
        if (!el) return null;
        el.scrollIntoView({ block: "center", behavior: "instant" });
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2, y = r.top + r.height / 2;
        // Only once nothing covers it and layout has settled under the pointer.
        const hit = document.elementFromPoint(x, y);
        return hit && (hit === el || el.contains(hit)) ? { x, y } : null;
      })()`,
      ms,
    );
  }

  /** A real mouse click (pointer events included) on the element. */
  async click(css: string, text = ""): Promise<void> {
    const { x, y } = await this.find(css, text);
    if (process.env.RCFC_TRACE) console.log(`    click ${css} "${text}" at ${x.toFixed(0)},${y.toFixed(0)} on: ${await this.text("header.top h1, .study-top, .done h2")}`);
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
      await this.send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 });
    }
  }

  /** Replace the field's value as if typed. */
  async type(css: string, value: string): Promise<void> {
    await this.click(css);
    await this.js(`const el = document.querySelector(${JSON.stringify(css)}); el.focus(); el.select?.();`);
    await this.send("Input.insertText", { text: value });
  }

  text(css: string): Promise<string> {
    return this.js<string>(`return document.querySelector(${JSON.stringify(css)})?.textContent ?? "";`);
  }

  async screenshot(file: string): Promise<void> {
    const { data } = await this.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
    writeFileSync(file, Buffer.from(data, "base64"));
  }
}

// ---------- checks ----------

let step = "";
function log(s: string) {
  step = s;
  console.log(`· ${s}`);
}

const title = (s: Browser) => s.text("header.top h1");

async function shot(s: Browser, name: string) {
  if (!process.env.RCFC_SHOTS) return;
  mkdirSync(".wrangler/smoke", { recursive: true });
  await s.screenshot(`.wrangler/smoke/${name}.png`);
}

async function answerUntilDone(s: Browser, max: number): Promise<number> {
  let n = 0;
  for (; n < max; n++) {
    const state = await s.until<string>("a card or the end", `document.querySelector(".flashcard:not(.leaving)") ? "card" : document.querySelector(".done") ? "done" : ""`);
    if (state === "done") return n;
    await s.click("button", "Show answer");
    await s.click("button.rate", n % 4 === 3 ? "Again" : "Got it");
    // Wait for the next card to replace this one.
    await s.until("next screen", `!document.querySelector(".flashcard:not(.leaving) .answer:not(.hidden)")`);
  }
  return n;
}

const words = (s: Browser) => s.js<number>(`return document.querySelectorAll(".list button.word").length;`);

async function run(s: Browser, url: string) {
  log("fresh start shows the welcome screen");
  await s.go(`${url}/?reset`);
  await s.until("welcome", `document.querySelector("header.top h1")?.textContent === "Welcome"`, 60_000);

  log("pick a language: lands on its empty word list");
  await s.click("button", "Start");
  await s.until("Words: Spanish", `document.querySelector(".lang-picker")?.selectedOptions[0]?.textContent === "Spanish"`);

  log("add two words");
  await s.click("button", "Add a word");
  for (const [front, back] of [["hola", "hello"], ["adiós", "goodbye"]]) {
    await s.type("input[name=front]", front);
    await s.type("input[name=back]", back);
    await s.click("button[type=submit]", "Add");
    await s.until(`toast for ${front}`, `document.getElementById("toast")?.textContent === 'Added "${front}"'`);
  }
  log("the last word's picture is drawn on the add screen");
  await s.until("picture", `document.querySelector(".last-added .pic img")?.src.startsWith("blob:") && document.querySelector(".last-added .pic img").naturalWidth > 0`, 90_000);
  await s.until("picture sense", `document.querySelector(".last-added .pic-status")?.textContent.startsWith("Shows: ")`);
  await shot(s, "add-picture");
  await s.type("input[name=front]", "hola");
  await s.type("input[name=back]", "hello");
  await s.click("button[type=submit]", "Add");
  await s.until("duplicate hint", `document.body.textContent.includes('"hola" is already in your words.')`);
  await s.click("button[aria-label=Back]");
  await s.until("2 words listed", `document.querySelectorAll(".list button.word").length === 2`);

  log("Study tab counts the pile: both new words");
  await s.click("nav .nav-item", "Study");
  await s.until("2 cards", `document.querySelector(".counts")?.textContent === "2 cards"`);

  log("study both words");
  await s.click(".deck button", "Study");
  const first = await s.until<string>("first card", `document.querySelector(".flashcard:not(.leaving) .face.prompt")?.textContent`);
  if (first !== "hola") throw new Error(`first card is "${first}", expected "hola"`);
  await s.until("a new word is pronounced (silently)", `window.__rcfcSpoken.includes("hola")`);
  await s.click("button", "Show answer");
  await s.until("picture with the answer", `document.querySelector(".answer:not(.hidden) .pic img")?.naturalWidth > 0`, 30_000);
  await shot(s, "study-picture");
  log("a tap on the turned card turns it over again; the answer stays given");
  await s.click(".flashcard:not(.leaving) .side.back");
  await s.until("front up again", `/rotateY\\(360/.test(document.querySelector(".flashcard:not(.leaving) .flipper")?.style.transform ?? "")`);
  await s.until("ratings still there", `document.querySelector("button.rate")`);
  await s.click("button.rate", "Got it");
  await s.until("next screen", `!document.querySelector(".flashcard:not(.leaving) .answer:not(.hidden)")`);
  const answered = 1 + (await answerUntilDone(s, 10));
  if (answered < 2) throw new Error(`only ${answered} cards shown`);
  log("done screen: no words left to learn, so it offers adding some");
  await s.until("Add words", `[...document.querySelectorAll(".done button")].some((b) => b.textContent === "Add words")`);
  await s.click("button", "Done");
  await s.until("pile done", `document.querySelector(".counts")?.textContent === "done for today"`);

  log("words list and edit");
  await s.click("nav .nav-item", "Words");
  await s.until("2 words", `document.querySelectorAll(".list button.word").length === 2`);
  await s.click("button.word", "adiós");
  await s.type("textarea", "¡Adiós, amigo!");
  await s.click("button", "Save");
  await s.until("back to list", `document.querySelectorAll(".list button.word").length === 2`);

  log("the back gesture walks back: word → list → Study");
  await s.click("button.word", "adiós");
  await s.until("edit screen", `document.querySelector("header.sub h1")`);
  await s.js(`history.back();`);
  await s.until("list after back", `document.querySelectorAll(".list button.word").length === 2 && !document.querySelector("header.sub")`);
  await s.js(`history.back();`);
  await s.until("Study after back", `document.querySelector(".deck-name")`);
  await s.click("nav .nav-item", "Words");
  await s.until("words again", `document.querySelectorAll(".list button.word").length === 2`);

  log("settings show the sync code and sync with the local Worker");
  await s.click("nav .nav-item", "Settings");
  await s.until("sync code", `/^[A-Z2-7]{4}(-[A-Z2-7]{4}){3}$/.test(document.querySelector(".sync-code")?.textContent ?? "")`);
  await s.click("button", "Sync now");
  await s.until("synced", `document.body.textContent.includes("Synced ")`, 20_000);

  log("seeded collection: replay, due cards");
  await s.go(`${url}/?reset&seed=60`);
  await s.until("seeded home", `document.querySelector(".deck-name")?.textContent === "Demo Spanish"`, 90_000);
  const pile = Number((await s.text(".counts")).split(" ")[0]);
  if (!(pile > 0)) throw new Error(`seeded deck shows a pile of ${pile}`);
  await s.click(".deck button", "Study");
  await answerUntilDone(s, 6);
  await s.click("button[aria-label=Close]");
  await s.until("home", `document.querySelector(".deck-name")`);

  await s.click("nav .nav-item", "Words");
  await s.until("words", `document.querySelectorAll(".list button.word").length > 0`);

  log("select words: know, don't know, delete");
  const before = await words(s);
  await s.click(".select-info button", "Select");
  await s.until("selecting", `document.querySelector(".list.selecting")`);
  // Two words never studied: the model must call them known once marked.
  const fresh = await s.js<string[]>(`return [...document.querySelectorAll(".list button.word")].filter((b) => b.querySelector(".st-new")).slice(0, 3).map((b) => b.querySelector(".w-front").textContent);`);
  if (fresh.length < 3) throw new Error("seeded list has fewer than 3 new words");
  for (const w of fresh.slice(0, 2)) await s.click(".list button.word", w);
  await s.until("2 selected", `document.querySelector(".select-info")?.textContent.startsWith("2 selected")`);
  await s.click(".select-actions button", "I know");
  await s.until("marked known", `document.getElementById("toast")?.textContent === "2 words marked as known"`);
  await s.until("still selecting, none selected", `document.querySelector(".list.selecting") && document.querySelector(".select-info")?.textContent.startsWith("0 selected")`);
  await s.until("marked words show known", `${JSON.stringify(fresh.slice(0, 2))}.every((w) => [...document.querySelectorAll(".list button.word")].some((b) => b.querySelector(".w-front").textContent === w && b.querySelector(".w-p").textContent === "known"))`);
  await s.click(".list button.word", fresh[2]);
  await s.click(".select-actions button", "Don't know");
  await s.until("learn next", `document.getElementById("toast")?.textContent === "1 word to learn next"`);
  await s.js(`window.confirm = () => true;`);
  await s.click(".list button.word:nth-of-type(1)");
  await s.click(".select-actions button", "Delete");
  await s.until("one fewer", `document.querySelectorAll(".list button.word").length === ${before - 1}`);
  await s.click(".select-info button", "Cancel");
  await s.until("tab bar back", `!document.querySelector(".list.selecting") && document.querySelector(".select-actions.hidden")`);
  log("the word asked for comes first in study");
  await s.click("nav .nav-item", "Study");
  await s.click(".deck button", "Study");
  // New words come after the due ones; deal more until one shows.
  for (let i = 0; ; i++) {
    if (i > 80) throw new Error("no new card in 80 answers");
    const state = await s.until<string>("a card or the end", `document.querySelector(".flashcard:not(.leaving)") ? "card" : document.querySelector(".done") ? "done" : ""`);
    if (state === "done") {
      const more = await s.js<string | null>(`return [...document.querySelectorAll(".done button")].map((b) => b.textContent).find((t) => / more$/.test(t)) ?? null;`);
      if (!more) throw new Error("pile done without the new word, and nothing more to deal");
      await s.click(".done button", more);
      continue;
    }
    if ((await s.text(".study-top")).includes("New word")) {
      const w = await s.text(".flashcard:not(.leaving) .face.prompt");
      if (w !== fresh[2]) throw new Error(`first new word is "${w}", expected "${fresh[2]}"`);
      break;
    }
    await s.click("button", "Show answer");
    await s.click("button.rate", "Got it");
    await s.until("next", `!document.querySelector(".flashcard:not(.leaving) .answer:not(.hidden)")`);
  }

  log("no uncaught errors");
  const errors = [...s.errors, ...(await s.js<string[]>("return window.__rcfcErrors ?? [];"))];
  if (errors.length) throw new Error(`page errors:\n${errors.join("\n")}`);
}

async function main() {
  let url = process.argv[2]?.replace(/\/$/, "");
  if (!url) {
    console.log("building the engine and starting the dev server…");
    const wasm = Bun.spawnSync(["bun", "run", "build:wasm"], { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
    if (wasm.exitCode !== 0) throw new Error("build:wasm failed");
    url = `http://localhost:${DEV_PORT}`;
    children.push(Bun.spawn(["bunx", "vite", "--port", String(DEV_PORT), "--strictPort"], { cwd: ROOT, stdout: "ignore", stderr: "inherit" }));
    await waitHttp(url, 60_000);
  }
  const s = await Browser.start();
  const t0 = Date.now();
  try {
    await run(s, url);
    console.log(`ok   UI smoke test passed in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  } catch (e) {
    const dir = join(ROOT, ".wrangler/smoke");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "failure.png");
    await s.screenshot(file).catch(() => {});
    console.error(`FAIL ${step}: ${e instanceof Error ? e.message : e}\n     screenshot: ${file}`);
    process.exitCode = 1;
  } finally {
    await s.quit();
    cleanup();
  }
}

if (import.meta.main) main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  cleanup();
  process.exit(1);
});
