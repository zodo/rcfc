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
    // A deployed origin is installable: its install banner would cover the tab bar. Snoozed, as "Not now" does.
    await b.send("Page.addScriptToEvaluateOnNewDocument", { source: "try { localStorage.setItem('rcfc.install-dismissed-at', String(Date.now())); } catch {}" });
    await b.send("Page.addScriptToEvaluateOnNewDocument", { source: "window.__rcfcSpoken = []; if (window.speechSynthesis) speechSynthesis.speak = () => {}; addEventListener('rcfc-said', (e) => void window.__rcfcSpoken.push(e.detail.text));" });
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
    if (process.env.RCFC_TRACE) console.log(`    click ${css} "${text}" at ${x.toFixed(0)},${y.toFixed(0)} on: ${await this.text("header.top h1, .study-top, .pile-sheet h2")}`);
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

/** The same screen on a wide window (screenshots only). */
async function wideShot(s: Browser, name: string) {
  if (!process.env.RCFC_SHOTS) return;
  await s.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
  await s.js(`await new Promise((r) => setTimeout(r, 200));`);
  await shot(s, name);
  await s.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
}

async function answerUntilDone(s: Browser, max: number): Promise<number> {
  let n = 0;
  for (; n < max; n++) {
    const state = await s.until<string>("a card or the end", `document.querySelector(".flashcard:not(.leaving)") ? "card" : document.querySelector(".finish, .table") ? "done" : ""`);
    if (state === "done") return n;
    await s.click("button", "Show answer");
    await s.click("button.rate", n % 4 === 3 ? "Again" : "Got it");
    // Wait for the next card to replace this one.
    await s.until("next screen", `!document.querySelector(".flashcard:not(.leaving) .answer:not(.hidden)")`);
  }
  return n;
}

/** A pencil note's words as read, without the options of the picker lying in it. */
const noteText = (css: string) => `(() => { const c = document.querySelector(${JSON.stringify(css)})?.cloneNode(true); c?.querySelectorAll("select").forEach((x) => x.remove()); return c?.textContent; })()`;

const words = (s: Browser) => s.js<number>(`return document.querySelectorAll(".list button.word").length;`);

async function run(s: Browser, url: string) {
  log("fresh start shows the welcome screen");
  await s.go(`${url}/?reset`);
  await s.until("welcome", `document.querySelector("header.top h1")?.textContent === "Welcome"`, 60_000);
  log("the launch pile turns over into the welcome card and goes");
  await s.until("launch screen gone", `!document.getElementById("launch") && getComputedStyle(document.querySelector(".welcome-card")).opacity === "1"`);
  log("Words with no words brings Your AI up by itself, once");
  await s.click("nav .nav-item", "Words");
  await s.until("the sheet up", `document.querySelector(".pile-sheet .ya") && document.querySelector(".card-box")?.textContent.includes("No words yet.")`);
  await s.js(`history.back();`);
  await s.until("closed", `!document.querySelector(".pile-sheet") && document.querySelector(".card-box")`);
  log("empty Words: words on another device leads to Settings, its code field open");
  await shot(s, "words-empty");
  await s.click(".card-box button.link", "Get them here");
  await s.until("Settings on the code field", `document.querySelector("header.top h1")?.textContent === "Settings" && document.querySelector("details:has(input[name=code])")?.open && document.activeElement?.name === "code"`);
  await shot(s, "settings-join");
  await s.js(`history.back();`); // tabs replace each other: back is Study
  await s.until("welcome", `document.querySelector(".welcome-card")`);

  log("pick a language: lands on adding its first word");
  await s.click("button", "Start");
  await s.until("Add: Spanish", `document.querySelector("select[name=language]")?.selectedOptions[0]?.textContent === "Spanish"`);

  log("a blank card: pencil notes point at its places, the languages in them");
  await s.until("arrow notes", `${noteText(".ed-note-word")} === "the Spanish word goes here" && ${noteText(".ed-note-trans")} === "its English translation goes here"`);
  await shot(s, "add-blank");

  log("add two cards; the second one's picture draws itself on the card before Add");
  const addedRow = (front: string) => `[...document.querySelectorAll(".ed-added-word")].some((e) => e.textContent === ${JSON.stringify(front)})`;
  await s.type("input[name=front]", "hola");
  await s.type("input[name=back]", "hello");
  await s.click("button.ed-add", "Add");
  await s.until("hola added", addedRow("hola"));
  await s.until("a fresh card", `document.querySelector("input[name=front]").value === "" && document.activeElement?.name === "front"`);
  await s.type("input[name=front]", "adiós");
  await s.type("input[name=back]", "goodbye");
  await s.type("input[name=example]", "¡Adiós, amigo!"); // leaving the translation starts the drawing
  await s.until("picture on the card", `document.querySelector(".ed-pic .pic img")?.src.startsWith("blob:") && document.querySelector(".ed-pic .pic img").naturalWidth > 0`, 90_000);
  await shot(s, "add-picture");
  await wideShot(s, "add-wide");
  await s.click("button.ed-add", "Add");
  await s.until("adiós added with its picture", `${addedRow("adiós")} && document.querySelector(".ed-added-row .pic img")`);
  await s.type("input[name=front]", "hola");
  await s.type("input[name=back]", "hello");
  await s.until("told before Add", `document.querySelector(".ed-dup")?.textContent.startsWith("this card is already in your words")`);
  await s.until("its picture drawn (so Add doesn't move under the click)", `document.querySelector(".ed-pic .pic img")?.naturalWidth > 0`, 90_000);
  await s.click("button.ed-add", "Add");
  await s.until("duplicate refused", `document.querySelector(".ed-hint")?.textContent === "This card is already in your words."`);
  log("back on a card not added yet asks; keep editing stays, back again throws it away");
  await s.click("button[aria-label=Back]");
  await s.until("asked", `document.querySelector(".pile-sheet h2")?.textContent === "This card is already in your words"`);
  await s.click(".pile-sheet button", "Keep editing");
  await s.until("still editing", `!document.querySelector(".pile-sheet") && document.querySelector("input[name=front]")?.value === "hola"`);
  await s.js(`history.back();`);
  await s.until("asked by the gesture too", `document.querySelector(".pile-sheet")`);
  await s.js(`history.back();`);
  await s.until("2 words listed", `document.querySelectorAll(".list button.word").length === 2 && !document.querySelector(".pile-sheet")`);

  log("the table shows the pile: both new words, the first face up");
  await s.click("nav .nav-item", "Study");
  await s.until("2 cards", `document.querySelector(".pile-count")?.textContent === "2 cards"`);
  await s.until("top card face up", `document.querySelector(".spot .pile-top .pile-word")?.textContent === "hola"`);

  log("study both words");
  await s.click("button.spot");
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
  log("the pencil on the turned card opens it in the editor; back is the same card, still turned, changed");
  await s.click(".flashcard:not(.leaving) .side.front .edit-card");
  await s.until("Edit card", `document.querySelector("header.sub h1")?.textContent === "Edit card" && document.querySelector("input[name=front]")?.value === "hola"`);
  await s.type("input[name=memo_known]", "a greeting");
  await s.click("button[aria-label=Back]"); // leaving saves
  await s.until("hola again, turned", `document.querySelector(".flashcard.turned:not(.leaving) .face.prompt")?.textContent === "hola" && document.querySelector("button.rate")`);
  await s.until("the note on it", `document.querySelector(".flashcard:not(.leaving) .answer:not(.hidden) .memo")?.textContent === "a greeting"`);
  await shot(s, "study-memo");
  log("the word's notes: a tap on the tiny print zooms in onto the whole page at once; back puts the card down");
  await s.until("notes on the card", `document.querySelector(".flashcard:not(.leaving) .answer:not(.hidden) .fine:not(.empty)")`, 20_000);
  await s.click(".flashcard:not(.leaving) .answer .fine");
  await s.until("the page, every line there", `document.querySelector(".sum-view .sum-page")?.textContent.includes("Dev placeholder") && !document.querySelector(".sum-view .sum-page *")?.getAnimations().length`);
  await s.click(".sum-back");
  await s.until("card down again", `!document.querySelector(".sum-view, .sum-stand") && document.querySelector("button.rate")`);
  await s.click("button.rate", "Got it");
  await s.until("next screen", `!document.querySelector(".flashcard:not(.leaving) .answer:not(.hidden)")`);
  log("a card lying word side up says its word; the example has its own speak button");
  await s.until("adiós on top", `document.querySelector(".flashcard:not(.leaving) .face.prompt")?.textContent === "adiós"`);
  await s.until("adiós said", `window.__rcfcSpoken.includes("adiós")`);
  await s.click(".flashcard:not(.leaving) .example .speak");
  await s.until("example said", `window.__rcfcSpoken.includes("¡Adiós, amigo!")`);
  await shot(s, "study-example");
  if (await s.js<boolean>(`return !document.querySelector(".flashcard:not(.leaving) .answer.hidden");`)) throw new Error("the example's speak button turned the card over");
  log("the corner speaker switches reading by itself off (the card's speakers still say it) and on again (it says the word now)");
  await s.click(".study-top .auto-read");
  await s.until("switched off", `document.querySelector(".study-top .auto-read")?.getAttribute("aria-pressed") === "false"`);
  await shot(s, "study-quiet");
  await s.js(`window.__rcfcSpoken.length = 0;`);
  await s.click(".flashcard:not(.leaving) .face.prompt .speak");
  await s.until("word said on a tap", `window.__rcfcSpoken.includes("adiós")`);
  await s.js(`window.__rcfcSpoken.length = 0;`);
  await s.click(".study-top .auto-read");
  await s.until("on again, the word said", `document.querySelector(".study-top .auto-read")?.getAttribute("aria-pressed") === "true" && window.__rcfcSpoken.includes("adiós")`);
  const answered = 1 + (await answerUntilDone(s, 10));
  if (answered < 2) throw new Error(`only ${answered} cards shown`);
  log("a finished pile draws its check in study, today's cards crosswise under it, nothing else; back to the table, its spot keeps both");
  await s.until("pile done", `document.querySelector(".finish .checks.fresh svg") && document.querySelector(".finish-title")?.textContent === "Done for today"`);
  await s.until("today's 2 crosswise, no handful, no Add words", `document.querySelector(".finish .cross-note")?.textContent === "tap for today's 2 again" && document.querySelectorAll(".crossed .cross-sheet").length === 2 && !document.querySelector(".finish .handful") && ![...document.querySelectorAll(".controls button")].some((b) => b.textContent === "Add words")`);
  await s.js(`await new Promise((r) => setTimeout(r, 1500));`); // the check draws itself in
  await shot(s, "study-done");
  await s.click("button", "Back to the table");
  await s.until("spot done", `document.querySelector(".pile-count")?.textContent === "done for today" && document.querySelector(".spot.finished .checks svg") && document.querySelector(".spot.finished .spot-cross")`);
  await shot(s, "table-done");
  log("the finished spot opens the same finish (its check already drawn); today's cards tapped stand up into the pile");
  await s.click("button.spot.finished");
  await s.until("the finish again", `document.querySelector(".finish .checks:not(.fresh) svg") && document.querySelector(".finish .cross-tap")`);
  await s.click(".finish .cross-tap");
  await s.until("studying them", `document.querySelector(".flashcard:not(.leaving)") && !document.querySelector(".finish")`);
  if ((await answerUntilDone(s, 4)) !== 2) throw new Error("going through them again did not show the same 2 cards");
  await s.until("pile done again", `document.querySelector(".finish .checks svg")`);
  await s.click("button", "Back to the table");
  await s.until("table", `document.querySelector(".spot.finished")`);

  log("words list and edit");
  await s.click("nav .nav-item", "Words");
  await s.until("2 words", `document.querySelectorAll(".list button.word").length === 2`);
  await s.click("button.word", "adiós");
  await s.until("the card filled in", `document.querySelector("header.sub h1")?.textContent === "Edit card" && document.querySelector("input[name=back]")?.value === "goodbye" && ${noteText(".ed-note-word")} === "Spanish" && !document.querySelector(".ed-note-word select")`);
  await s.until("its picture", `document.querySelector(".ed-pic .pic img")`);
  await shot(s, "edit");
  await s.type("input[name=back]", "bye");
  await s.type("input[name=memo_known]", "said when leaving");
  await s.click("button[aria-label=Back]");
  await s.until("back to the list, changed", `[...document.querySelectorAll(".list button.word")].some((b) => b.textContent.includes("bye")) && document.querySelectorAll(".list button.word").length === 2`);
  await s.until("saved, with Undo", `document.querySelector("#slip span")?.textContent === "Saved adiós"`);
  log("the bin deletes at once; Undo brings the card back");
  await s.click("button.word", "adiós");
  await s.click("button.ed-bin");
  await s.until("1 word", `document.querySelectorAll(".list button.word").length === 1 && document.querySelector("#slip span")?.textContent === "Deleted adiós"`);
  await s.click("#slip button", "Undo");
  await s.until("back again", `document.querySelectorAll(".list button.word").length === 2`);
  await s.click("button.word", "adiós");
  await s.until("saved", `document.querySelector("input[name=memo_known]")?.value === "said when leaving"`);
  await s.click("button[aria-label=Back]");
  await s.until("list", `document.querySelectorAll(".list button.word").length === 2 && !document.querySelector("header.sub")`);

  log("the back gesture walks back: word → list → Study");
  await s.click("button.word", "adiós");
  await s.until("edit screen", `document.querySelector("header.sub h1")`);
  await s.js(`history.back();`);
  await s.until("list after back", `document.querySelectorAll(".list button.word").length === 2 && !document.querySelector("header.sub")`);
  await s.js(`history.back();`);
  await s.until("Study after back", `document.querySelector(".pile-name")`);
  await s.click("nav .nav-item", "Words");
  await s.until("words again", `document.querySelectorAll(".list button.word").length === 2`);

  log("settings show the sync code and sync with the local Worker");
  await s.click("nav .nav-item", "Settings");
  await s.until("sync code", `/^[A-Z2-7]{4}(-[A-Z2-7]{4}){3}$/.test(document.querySelector(".sync-code")?.textContent ?? "")`);
  await s.click("button", "Sync now");
  await s.until("synced", `document.body.textContent.includes("Synced ")`, 20_000);

  log("seeded collection: replay, due cards");
  await s.go(`${url}/?reset&seed=60`);
  await s.until("seeded home", `document.querySelector(".pile-name")?.textContent === "Spanish"`, 90_000);
  log("the launch pile is dealt onto the table and goes; the pile's top card shows");
  await s.until("launch screen gone", `!document.getElementById("launch") && getComputedStyle(document.querySelector(".spot .pile-top")).opacity === "1"`);
  const pile = Number((await s.text(".pile-count")).split(" ")[0]);
  if (!(pile > 0)) throw new Error(`seeded deck shows a pile of ${pile}`);
  const edges = await s.js<number>(`return document.querySelectorAll(".spot .pile-edge").length;`);
  await shot(s, "table");
  if (pile > 1 && !(edges > 0 && edges <= Math.min(30, pile - 1))) throw new Error(`a pile of ${pile} shows ${edges} card edges`);
  await s.click("button.spot");
  log("a card lying translation side up shows its example with the word blanked out; turned, the whole example");
  let cloze = "";
  for (let n = 0; n < 6; n++) {
    const state = await s.until<string>("a card or the end", `document.querySelector(".flashcard:not(.leaving)") ? "card" : document.querySelector(".finish") ? "done" : ""`);
    if (state === "done") break;
    const gap = cloze ? "" : await s.js<string>(`return document.querySelector(".flashcard:not(.leaving) .side.front.known .cloze")?.textContent ?? "";`);
    if (gap) {
      cloze = gap;
      const word = await s.js<string>(`return document.querySelector(".flashcard:not(.leaving) .side.back .face")?.textContent ?? "";`);
      if (cloze.toLowerCase().includes(word.toLowerCase())) throw new Error(`the blanked example "${cloze}" gives "${word}" away`);
      if (process.env.RCFC_SHOTS) await s.js(`await new Promise((r) => setTimeout(r, 1500));`); // the pile is brought in
      await shot(s, "study-cloze");
    }
    await s.click("button", "Show answer");
    if (gap) await s.until("the whole example on the word side", `document.querySelector(".flashcard:not(.leaving) .answer:not(.hidden) .example:not(.cloze)")`);
    await s.click("button.rate", n % 4 === 3 ? "Again" : "Got it"); // as answerUntilDone: later steps expect these answers
    await s.until("next screen", `!document.querySelector(".flashcard:not(.leaving) .answer:not(.hidden)")`);
  }
  if (!cloze) throw new Error("no reverse card with a blanked example among the first 6 cards");
  await s.click("button[aria-label=Close]");
  await s.until("home", `document.querySelector(".pile-name")`);

  await s.click("nav .nav-item", "Words");
  await s.until("words", `document.querySelectorAll(".list button.word").length > 0`);

  log("select words: know, don't know, delete");
  const before = await words(s);
  await s.js(`window.firstRow = document.querySelector(".list button.word");`);
  await s.click(".select-info button", "Select");
  await s.until("selecting", `document.querySelector(".list.selecting")`);
  // The same rows stay, so the words slide over to make room for the circles.
  await s.until("same rows slide over", `document.querySelector(".list button.word") === window.firstRow`, 1000);
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
  // Back on the table: drawn at once from the last predictions, never "Loading…" first.
  await s.js(`window.sawLoading = false; new MutationObserver(() => { if (document.body.textContent.includes("Loading…")) window.sawLoading = true; }).observe(document.body, { childList: true, subtree: true });`);
  await s.click("nav .nav-item", "Study");
  await s.until("table", `document.querySelector(".table")`);
  if (await s.js<boolean>(`return window.sawLoading;`)) throw new Error("the Study tab showed Loading… before the table");
  await s.click("button.spot");
  // New words come after the due ones; deal more until one shows.
  for (let i = 0; ; i++) {
    if (i > 80) throw new Error("no new card in 80 answers");
    const state = await s.until<string>("a card or the end", `document.querySelector(".flashcard:not(.leaving)") ? "card" : document.querySelector(".finish") ? "done" : ""`);
    if (state === "done") {
      // The finish screen: a handful of more cards lies aside; taken, studying goes on.
      if (!(await s.js<boolean>(`return !!document.querySelector(".finish .handful.more");`))) throw new Error("pile done without the new word, and nothing more to deal");
      await s.js(`await new Promise((r) => setTimeout(r, 1600));`); // the handful is laid aside
      await shot(s, "study-handful");
      await s.click(".finish .handful.more");
      await s.until("more on the table", `document.querySelector(".flashcard:not(.leaving)") && !document.querySelector(".finish")`);
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

  log("a second language: picked on the Add screen, made with its first word; Words gets chips, the table a pile");
  await s.click("button[aria-label=Close]");
  await s.until("home", `document.querySelector(".pile-name")`);
  await s.click("nav .nav-item", "Words");
  if (await s.js<boolean>(`return !!document.querySelector(".lang-chips");`)) throw new Error("language chips with one language");
  await s.click("button[aria-label='Add a word']");
  await s.until("Add", `document.querySelector("select[name=language]")`);
  await s.type("input[name=front]", "der");
  await s.js(`const l = document.querySelector("select[name=language]"); l.value = "new"; l.dispatchEvent(new Event("change"));`);
  await s.until("Add a language", `document.querySelector(".pile-sheet h2")?.textContent === "Add a language"`);
  await s.js(`const l = document.querySelector(".pile-sheet select[name=from]"); l.value = "de"; l.dispatchEvent(new Event("change"));`);
  await s.click(".pile-sheet button[type=submit]", "Use it");
  await s.until("German, what was typed kept", `document.querySelector("select[name=language]")?.selectedOptions[0]?.textContent === "German" && document.querySelector("input[name=front]").value === "der" && !document.querySelector(".pile-sheet")`);
  await shot(s, "add-language");
  await s.type("input[name=front]", "der Schlüssel");
  await s.type("input[name=back]", "key");
  await s.click("button.ed-add", "Add");
  await s.until("der Schlüssel added", addedRow("der Schlüssel"));
  log("a Spanish word translated into Russian joins the Spanish pile; Cyrillic typed on the English side makes it Russian");
  await s.js(`const l = document.querySelector("select[name=language]"); l.value = "es"; l.dispatchEvent(new Event("change"));`);
  await s.until("Spanish into English", `document.querySelector("select[name=language]")?.value === "es" && document.querySelector("select[name=to]")?.value === "en"`);
  await s.type("input[name=front]", "el gato");
  await s.type("input[name=back]", "кот");
  await s.until("its Russian translation", `document.querySelector("select[name=to]")?.value === "ru" && ${noteText(".ed-note-trans")} === "Russian"`);
  await s.click("button.ed-add", "Add");
  await s.until("el gato added", addedRow("el gato"));
  await s.click("button[aria-label=Back]");
  await s.until("chips", `document.querySelectorAll(".lang-chips .chip").length === 2`);
  await shot(s, "words-languages");
  const everything = await words(s);
  await s.click(".lang-chips .chip", "German");
  await s.until("German only", `document.querySelectorAll(".list button.word").length === 1`);
  await s.click(".lang-chips .chip", "German");
  await s.until("all again", `document.querySelectorAll(".list button.word").length === ${everything}`);
  await s.click("nav .nav-item", "Study");
  await s.until("two piles and the new pile", `[...document.querySelectorAll(".pile-name")].map((e) => e.textContent).join() === "Spanish,German,New pile"`);

  log("a sticker from the New pile spot: named, then Words opens on it in Edit; taps stick it on");
  await s.click("button[aria-label='New pile']");
  await s.until("name sheet", `document.querySelector(".pile-sheet input[name=sticker]")`);
  await s.type(".pile-sheet input[name=sticker]", "kitchen");
  await s.click(".pile-sheet button[type=submit]", "Make sticker");
  await s.until("Edit on kitchen", `document.querySelector(".list.editing") && document.querySelector(".chip.sticker.on")?.textContent === "kitchen"`);
  await s.click(".list.editing button.word", "el gato");
  await s.click(".list.editing button.word", "der Schlüssel");
  await s.until("two stuck", `document.querySelectorAll(".list.editing .word.stuck").length === 2`);
  await shot(s, "words-edit");
  await s.click(".select-info button.link", "Done");
  await s.until("kitchen's words", `!document.querySelector(".list.editing") && document.querySelectorAll(".list button.word").length === 2`);
  log("back closes Select and Edit instead of leaving Words");
  await s.click(".select-info button.link", "Select");
  await s.until("selecting", `document.querySelector(".list.selecting")`);
  await s.js(`history.back();`);
  await s.until("Select closed, still Words", `!document.querySelector(".list.selecting") && document.querySelector("header.top h1")?.textContent === "Words"`);
  log("the selection bar sticks stickers on: a new one from its sheet");
  await s.click(".select-info button.link", "Select");
  await s.click(".list.selecting button.word", "el gato");
  await s.until("Stickers on yellow paper", `getComputedStyle(document.querySelector(".select-actions .sticker-btn"), "::before").backgroundColor !== "rgba(0, 0, 0, 0)"`);
  await s.click(".select-actions button", "Stickers");
  await s.until("stickers sheet", `document.querySelector(".pile-sheet .sticker-opt")`);
  await s.type(".pile-sheet input[name=sticker]", "animals");
  await s.click(".pile-sheet button[type=submit]", "Stick");
  await s.until("animals on", `[...document.querySelectorAll(".sticker-opt")].some((o) => o.textContent.includes("animals") && o.getAttribute("aria-checked") === "true")`);
  await shot(s, "words-stickers-sheet");
  await s.js(`history.back();`);
  await s.until("sheet closed, still selecting", `!document.querySelector(".pile-sheet") && document.querySelector(".list.selecting")`);
  await s.click(".select-info button.link", "Cancel");
  log("an empty sticker points at Edit; the pencil renames and deletes");
  await s.click(".chip.new-sticker");
  await s.type(".pile-sheet input[name=sticker]", "travel");
  await s.click(".pile-sheet button[type=submit]", "Make sticker");
  await s.until("Edit on travel", `document.querySelector(".list.editing") && document.querySelector(".chip.sticker.on")?.textContent === "travel"`);
  await s.click(".select-info button.link", "Done");
  await s.until("empty sticker", `document.querySelector(".list.none .pencil-note") && document.querySelector(".select-info")?.textContent.startsWith("0 words")`);
  await shot(s, "words-empty-sticker");
  await s.until("the open sticker is as tall as the others", `(() => { const h = (el) => el.offsetHeight; const on = document.querySelector(".chip.sticker.on"); const off = document.querySelector("button.chip.sticker"); return on && off && h(on) === h(off) && h(on) === h(document.querySelector(".chip.new-sticker")); })()`, 3000);
  await s.click(".chip.sticker.on .pen");
  await s.click(".pile-sheet .swatch[aria-label=pink]");
  await s.until("pink at once", `document.querySelector(".chip.sticker.on").style.getPropertyValue("--sticker") === "var(--st-pink)" && document.querySelector(".swatch.on")?.getAttribute("aria-label") === "pink"`);
  await shot(s, "words-pencil");
  await s.type(".pile-sheet input[name=sticker]", "trips");
  await s.click(".pile-sheet button[type=submit]", "Rename");
  await s.until("renamed", `document.querySelector(".chip.sticker.on")?.textContent === "trips"`);
  await s.click(".chip.sticker.on .pen");
  await s.js(`window.confirm = () => true;`);
  await s.click(".pile-sheet button", "Delete sticker");
  await s.until("deleted", `![...document.querySelectorAll(".chip.sticker")].some((c) => c.textContent === "trips")`);
  await s.click("nav .nav-item", "Study");
  await s.until("sticker piles", `[...document.querySelectorAll(".pile-name")].map((e) => e.textContent).join() === "Spanish,German,animals,kitchen,New pile"`);
  await shot(s, "table-stickers");
  await s.click("button[aria-label='Study kitchen']");
  await s.until("studying kitchen", `document.querySelector(".flashcard") && !document.querySelector(".table")`);
  await s.click("button[aria-label=Close]");
  await s.until("home", `document.querySelector(".pile-name")`);

  log("the card editor's edges: same word, no picture, offline, a card left unsaved");
  await s.click("nav .nav-item", "Words");
  await s.click("button[aria-label='Add a word']");
  await s.js(`const l = document.querySelector("select[name=language]"); l.value = "es"; l.dispatchEvent(new Event("change"));`);
  await s.js(`const t = document.querySelector("select[name=to]"); t.value = "en"; t.dispatchEvent(new Event("change"));`);
  await s.type("input[name=front]", "la casa");
  await s.type("input[name=back]", "house");
  await s.until("its picture", `document.querySelector(".ed-pic .pic img")`, 90_000);
  await s.click("button.ed-add", "Add");
  await s.until("la casa added", `[...document.querySelectorAll(".ed-added-row")].some((r) => r.textContent.includes("house"))`);
  await s.type("input[name=front]", "la casa");
  await s.type("input[name=back]", "home");
  await s.until("the same word, told", `document.querySelector(".ed-dup")?.textContent === "you already have la casa · house"`);
  log("the card it names opens on top of the one being filled in; back puts that one back as it was");
  const draftKept = `document.querySelector("header.sub h1")?.textContent === "Add a card" && document.querySelector("input[name=front]")?.value === "la casa" && document.querySelector("input[name=back]")?.value === "home" && document.querySelector(".ed-added-row")`;
  await s.click(".ed-dup button.link");
  await s.until("la casa · house open", `document.querySelector("header.sub h1")?.textContent === "Edit card" && document.querySelector("input[name=back]")?.value === "house"`);
  await s.js(`history.back();`);
  await s.until("the draft, after the back gesture", draftKept);
  await s.click(".ed-dup button.link");
  await s.until("open again", `document.querySelector("header.sub h1")?.textContent === "Edit card"`);
  await s.click("button[aria-label=Back]");
  await s.until("the draft, after Back", draftKept);
  await s.js(`history.back();`);
  await s.until("the draft not added yet: asked", `document.querySelector(".pile-sheet h2")?.textContent === "la casa isn't added yet"`);
  await s.js(`history.back();`);
  await s.until("then back leaves Add for Words", `document.querySelector(".list button.word") && !document.querySelector("header.sub")`);
  await s.click("button[aria-label='Add a word']");
  await s.until("a blank card", `document.querySelector("input[name=front]")?.value === ""`);
  await s.type("input[name=front]", "la casa");
  await s.type("input[name=back]", "home");
  await s.js(`document.activeElement.blur();`); // typing done: the picture for these words, not the filled-in translation's
  await s.until("its picture, loaded", `document.querySelector(".ed-pic .pic img")?.naturalWidth > 0 && document.querySelector(".ed-pic-edit") && !document.querySelector(".ed-pic.busy")`, 90_000);
  await s.js(`await new Promise((r) => setTimeout(r, 1300));`); // the pencil comes once the picture lies flat
  await s.click(".ed-pic-edit");
  await s.click(".ed-pic-actions button", "No picture");
  await s.until("no picture", `document.querySelector(".ed-pic-box")?.textContent === "no picture"`);
  await s.click("button.ed-add", "Add");
  await s.until("la casa · home added, without a picture", `[...document.querySelectorAll(".ed-added-row")].some((r) => r.textContent.includes("home") && !r.querySelector(".pic"))`);
  await s.send("Network.enable");
  await s.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await s.type("input[name=front]", "la luna");
  await s.type("input[name=back]", "moon");
  await s.type("input[name=example]", "");
  await s.until("offline, said", `document.querySelector(".ed-pic-says")?.textContent === "it draws itself once you're online"`);
  await s.click("button.ed-add", "Add");
  await s.until("la luna added, picture to come", `[...document.querySelectorAll(".ed-added-row")].some((r) => r.textContent.includes("la luna"))`);
  await s.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await s.js(`dispatchEvent(new Event("online"));`);
  await s.until("its picture once online", `[...document.querySelectorAll(".ed-added-row")].find((r) => r.textContent.includes("la luna"))?.querySelector(".pic img")`, 90_000);
  await s.type("input[name=front]", "el sol");
  await s.type("input[name=back]", "sun");
  await s.click("button[aria-label=Back]");
  await s.until("asked", `document.querySelector(".pile-sheet h2")?.textContent === "el sol isn't added yet" && [...document.querySelectorAll(".pile-sheet button")].some((b) => b.textContent === "Add el sol")`);
  await s.js(`history.back();`); // back again: thrown away
  await s.until("Words", `document.querySelector(".list button.word") && !document.querySelector("header.sub")`);
  if (await s.js<boolean>(`return [...document.querySelectorAll(".list button.word")].some((b) => b.textContent.includes("el sol"));`)) throw new Error("a card left unsaved was added");

  log("the card fills itself in: the translation and an example; another meaning swaps in; a typed translation brings the word");
  await s.click("button[aria-label='Add a word']");
  await s.until("a blank card", `document.querySelector("input[name=front]")?.value === ""`);
  await s.type("input[name=front]", "el perro");
  await s.js(`document.activeElement.blur();`);
  await s.until("translation and example filled in", `document.querySelector("input[name=back]").value === "el perro (en)" && document.querySelector("input[name=example]").value === "el perro, el perro: dev example."`);
  await s.until("another meaning offered", `document.querySelector(".ed-side.known .ed-fill")?.textContent === "or: el perro (en) 2"`);
  await shot(s, "add-filled");
  await s.click(".ed-side.known .ed-fill button");
  await s.until("swapped in", `document.querySelector("input[name=back]").value === "el perro (en) 2" && document.querySelector("input[name=example]").value === "el perro, el perro: dev example. 2" && document.querySelector(".ed-side.known .ed-fill")?.textContent === "or: el perro (en)"`);
  await s.click("button.ed-add", "Add");
  await s.until("el perro added as filled in", `[...document.querySelectorAll(".ed-added-row")].some((r) => r.textContent.includes("el perro (en) 2"))`);
  await s.type("input[name=back]", "dog");
  await s.js(`document.activeElement.blur();`);
  await s.until("the word filled in", `document.querySelector("input[name=front]").value === "dog (es)" && document.querySelector("input[name=example]").value !== ""`);
  log("emptying what was typed takes back what was filled in");
  await s.js(`const b = document.querySelector("input[name=back]"); b.value = ""; b.dispatchEvent(new Event("input"));`);
  await s.until("a blank card again", `document.querySelector("input[name=front]").value === "" && document.querySelector("input[name=example]").value === ""`);
  log("the editor's hint brings Your AI up on Words; a card typed first is asked about, and Keep editing keeps it");
  await s.js(`const f = document.querySelector("input[name=front]"); f.value = "la mesa"; f.dispatchEvent(new Event("input"));`);
  await s.click(".ed-ai button.link", "use your AI");
  await s.until("asked about the card", `document.querySelector(".pile-sheet h2")?.textContent.startsWith("la mesa")`);
  await s.click(".pile-sheet button.secondary", "Keep editing");
  await s.until("still there", `!document.querySelector(".pile-sheet") && document.querySelector("header.sub") && document.querySelector("input[name=front]").value === "la mesa"`);
  await s.js(`const f = document.querySelector("input[name=front]"); f.value = ""; f.dispatchEvent(new Event("input"));`);
  await s.until("a blank card again", `document.querySelector("input[name=back]").value === "" && document.querySelector("input[name=example]").value === ""`);
  await s.click(".ed-ai button.link", "use your AI");
  await s.until("Words with the sheet up", `!document.querySelector("header.sub") && document.querySelector(".list button.word") && document.querySelector(".pile-sheet .ya")`);
  await s.js(`history.back();`);
  await s.until("back closes the sheet, Words stays", `!document.querySelector(".pile-sheet") && document.querySelector(".list button.word") && !document.querySelector("header.sub")`);

  log("Your AI: Copy prompt copies; a chat's reply lies on the list in pencil; Apply adds its words with their sticker and progress");
  const paste = async (text: string) => {
    await s.click("button.your-ai");
    await s.until("the Your AI sheet", `document.querySelector(".pile-sheet .ya")`);
    await s.js(`const t = document.querySelector(".ya textarea.import-paste"); t.value = ${JSON.stringify(text)}; t.dispatchEvent(new Event("input"));`);
  };
  await s.click("button.your-ai");
  await s.until("the Your AI sheet", `document.querySelector(".pile-sheet .ya")`);
  await s.click(".ya button.primary", "Copy prompt");
  // Headless Chromium may refuse the clipboard: then the prompt is shown to copy by hand.
  await s.until("copied", `document.querySelector(".ya button.primary")?.textContent === "Copied" || document.querySelector(".ya textarea.import-prompt")?.value.includes("id,word,translation")`);
  await s.js(`document.querySelector(".sheet-backdrop").click();`);
  const reply = [
    "Here are your cards:",
    "",
    "```csv",
    "word,translation,example,lang,to,note,translation_note,picture,stickers,status",
    "il gatto,cat,Il gatto dorme.,it,en,,,,Smoke,known",
    "la casa,house,\"La casa è grande, bella.\",it,en,,,,Smoke,learning",
    "il cane,dog,Il cane corre.,it,en,,,,Smoke,new",
    "```",
    "",
    "Copy the block, then paste it in the app under Words → Your AI → Its reply.",
  ].join("\n");
  await paste(reply);
  await s.until("the reply in pencil on the list", `document.querySelector(".pv-count")?.textContent === "3 new" && document.querySelectorAll(".pv-list .pv-new").length === 3 && document.querySelector(".pv-list").textContent.includes("new language: Italian")`);
  await shot(s, "ai-preview");
  await s.click(".pv-actions button.primary", "Apply");
  await s.until("Words on the Smoke sticker, 3 words", `!document.querySelector(".pv-list") && document.querySelector(".chip.on")?.textContent.includes("Smoke") && document.querySelectorAll(".list button.word").length === 3 && document.getElementById("slip")?.textContent.startsWith("3 words added")`);
  log("an imported word opened draws its picture at once; it stays the card's when left unsaved, by the back gesture too");
  await s.click("button.word", "il cane");
  await s.until("its picture on the card", `document.querySelector("header.sub h1")?.textContent === "Edit card" && document.querySelector(".ed-pic .pic img")?.naturalWidth > 0`, 90_000);
  await s.js(`history.back();`);
  await s.until("Words again", `document.querySelector(".list button.word") && !document.querySelector("header.sub")`);
  await s.click("button.word", "il cane");
  // Kept, not drawn again: there at once (a drawing takes 0.9 s in dev).
  await s.until("the picture kept", `document.querySelector("header.sub h1")?.textContent === "Edit card" && document.querySelector(".ed-pic .pic img") && !document.querySelector(".ed-pic.busy")`, 600);
  await s.js(`history.back();`);
  await s.until("Words again", `document.querySelector(".list button.word") && !document.querySelector("header.sub")`);
  log("the same reply again changes nothing; back throws it away");
  await paste(reply);
  await s.until("nothing to change", `document.querySelector(".pv-count")?.textContent === "Nothing in this reply changes your words" && document.querySelector(".pv-actions button.primary")?.disabled`);
  await s.js(`history.back();`);
  await s.until("thrown away", `!document.querySelector(".pv-list") && document.querySelector(".list button.word")`);
  log("again with another sticker: the words there get it, nothing added");
  await paste(reply.replace(/,Smoke,/g, ",Smoke;Pets,"));
  await s.until("3 words get Pets", `document.querySelector(".pv-count")?.textContent === "3 changes" && document.querySelector(".pv-list").textContent.includes("+Pets")`);
  await s.click(".pv-actions button.primary", "Apply");
  await s.until("updated", `document.getElementById("slip")?.textContent.startsWith("3 changed") && document.querySelector(".list button.word")`);
  const pets = await s.js<string[]>(`return [...document.querySelectorAll(".list button.word .w-front")].map((e) => e.textContent).sort();`);
  if (pets.join() !== "il cane,il gatto,la casa") throw new Error(`the Pets sticker shows ${pets.join(", ")}`);
  log("a change by id: translated into Russian on the list, applied, then undone");
  const gatto = await s.js<number>(`return window.rcfc.store.col.liveNotes().find((n) => n.fields.front === "il gatto").id;`);
  await paste("```\nid,word,translation,example,lang,to,note,translation_note,picture,stickers,status\n" + gatto + ",,кошка,,,ru,,,,,\n```");
  await s.until("crossed out, in pencil", `document.querySelector(".pv-count")?.textContent === "1 change" && document.querySelector(".pv-list s")?.textContent === "cat" && document.querySelector(".pv-list").textContent.includes("English → Russian")`);
  await s.click(".pv-actions button.primary", "Apply");
  await s.until("translated", `[...document.querySelectorAll(".list button.word")].some((w) => w.textContent.includes("кошка")) && document.getElementById("slip")`);
  await s.click("#slip button", "Undo");
  await s.until("put back", `document.getElementById("toast")?.textContent === "Put back" && window.rcfc.store.col.notes.get(${gatto}).fields.back === "cat" && window.rcfc.store.col.notes.get(${gatto}).lang_pair.to === "en"`);
  log("a raw Duocards export picked as a file: its language from the file name");
  await s.click("button.your-ai");
  await s.until("the Your AI sheet", `document.querySelector(".pile-sheet .ya")`);
  const { root } = await s.send<{ root: { nodeId: number } }>("DOM.getDocument", {});
  const { nodeId } = await s.send<{ nodeId: number }>("DOM.querySelector", { nodeId: root.nodeId, selector: ".ya input[type=file]" });
  await s.send("DOM.setFileInputFiles", { nodeId, files: [new URL("../test/fixtures/import/duocards_es_export.csv", import.meta.url).pathname] });
  await s.until("Duocards words in Spanish", `document.querySelector(".ya-langs select[name=from]")?.value === "es" && document.querySelectorAll(".pv-list .pv-new").length > 0`);
  await s.click(".pv-actions button.secondary", "Throw away");
  await s.until("Words again", `!document.querySelector(".pv-list") && document.querySelector(".list button.word")`);

  log("a sticker's pile: answered cards go crosswise under it; finished, the words left lie aside as one handful, all of them");
  await s.click(".chip.new-sticker");
  await s.type(".pile-sheet input[name=sticker]", "big");
  await s.click(".pile-sheet button[type=submit]", "Make sticker");
  await s.until("Edit on big", `document.querySelector(".list.editing") && document.querySelector(".chip.sticker.on")?.textContent === "big"`);
  for (let i = 0; i < 12; i++) await s.click(".list.editing button.word:not(.stuck)");
  await s.until("12 stuck", `document.querySelectorAll(".list.editing .word.stuck").length === 12`);
  await s.click(".select-info button.link", "Done");
  await s.click("nav .nav-item", "Study");
  await s.click("button[aria-label='Study big']");
  await answerUntilDone(s, 3); // the third answered Got it too
  await s.until("crosswise under the pile", `document.querySelectorAll(".crossed .cross-sheet").length >= 2`);
  await s.js(`await new Promise((r) => setTimeout(r, 800));`); // the last one slides in
  await shot(s, "study-crossed");
  await answerUntilDone(s, 40);
  const lefts = await s.until<string>("all left, one handful", `!document.querySelector(".finish .handful.rest") && document.querySelector(".finish .cross-tap") && /^all \\d+ left$/.test(document.querySelector(".finish .handful.more .handful-note")?.textContent ?? "") && document.querySelector(".finish .handful.more .handful-note").textContent`);
  const rest = Number(lefts.split(" ")[1]);
  await s.js(`await new Promise((r) => setTimeout(r, 1700));`); // laid aside
  await shot(s, "study-handfuls");
  await s.click(".finish .handful.more");
  await s.until("dealt", `!document.querySelector(".finish") && document.querySelector(".flashcard:not(.leaving)")`);
  const left = await s.text(".study-top");
  if (!new RegExp(`\\b${rest} left|New word`).test(left)) throw new Error(`after all ${rest} left: "${left}"`);
  await s.click("button[aria-label=Close]");

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
