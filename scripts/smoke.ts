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
      [exe, ...(process.env.RCFC_HEADFUL ? [] : ["--headless=new"]), "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--window-size=430,932", "about:blank"],
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
    const state = await s.until<string>("a card or the end", `document.querySelector(".flashcard") ? "card" : document.querySelector(".done") ? "done" : ""`);
    if (state === "done") return n;
    await s.click("button", "Show answer");
    await s.click("button.rate", n % 4 === 3 ? "Again" : "Got it");
    // Wait for the next card to replace this one.
    await s.until("next screen", `!document.querySelector(".answer:not(.hidden)")`);
  }
  return n;
}

async function run(s: Browser, url: string) {
  log("fresh start shows the welcome screen");
  await s.go(`${url}/?reset`);
  await s.until("welcome", `document.querySelector("header.top h1")?.textContent === "Welcome"`, 60_000);

  log("create a deck");
  await s.type("input[name=name]", "Smoke");
  await s.click("button", "Create deck");
  await s.until("home", `document.querySelector(".deck-name")?.textContent === "Smoke"`);

  log("add two words");
  await s.click("nav .nav-item", "Add");
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

  log("home counts the new words");
  await s.click("nav .nav-item", "Study");
  await s.until("2 new", `document.querySelector(".counts .new")?.textContent === "2 new"`);

  log("study both words");
  await s.click(".deck button", "Study");
  const first = await s.until<string>("first card", `document.querySelector(".face.prompt")?.textContent`);
  if (first !== "hola") throw new Error(`first card is "${first}", expected "hola"`);
  await s.click("button", "Show answer");
  await s.until("picture with the answer", `document.querySelector(".answer:not(.hidden) .pic img")?.naturalWidth > 0`, 30_000);
  await shot(s, "study-picture");
  await s.click("button.rate", "Got it");
  await s.until("next screen", `!document.querySelector(".answer:not(.hidden)")`);
  const answered = 1 + (await answerUntilDone(s, 10));
  if (answered < 2) throw new Error(`only ${answered} cards shown`);
  await s.click("button", "Done");
  await s.until("0 new", `document.querySelector(".counts .new")?.textContent === "0 new"`);

  log("words list and edit");
  await s.click("nav .nav-item", "Words");
  await s.until("Words · 2", `document.querySelector("header.top h1")?.textContent === "Words · 2"`);
  await s.click("button.word", "adiós");
  await s.type("textarea", "¡Adiós, amigo!");
  await s.click("button", "Save");
  await s.until("back to list", `document.querySelector("header.top h1")?.textContent === "Words · 2"`);

  log("settings show the sync code and sync with the local Worker");
  await s.click("nav .nav-item", "Settings");
  await s.until("sync code", `/^[A-Z2-7]{4}(-[A-Z2-7]{4}){3}$/.test(document.querySelector(".sync-code")?.textContent ?? "")`);
  await s.click("button", "Sync now");
  await s.until("synced", `document.body.textContent.includes("Synced ")`, 20_000);

  log("seeded collection: replay, due cards, sorting");
  await s.go(`${url}/?reset&seed=60`);
  await s.until("seeded home", `document.querySelector(".deck-name")?.textContent === "Demo Spanish"`, 90_000);
  const due = Number((await s.text(".counts .due")).split(" ")[0]);
  if (!(due > 0)) throw new Error(`seeded deck shows ${due} due`);
  await s.click(".deck button", "Study");
  await answerUntilDone(s, 6);
  await s.click("button[aria-label=Close]");
  await s.until("home", `document.querySelector(".deck-name")`);
  await s.click(".sort-entry");
  for (let i = 0; i < 3; i++) {
    await s.until(`sort card ${i + 1}`, `document.querySelector(".study-top span")?.textContent.startsWith("${i + 1} /")`);
    await s.click("button.rate", i === 1 ? "Teach me" : "I know it");
  }
  await s.click("button[aria-label=Stop]");
  await s.until("paused", `document.querySelector(".done h2")?.textContent === "Paused"`);
  await s.click("button", "Done");
  await s.until("home", `document.querySelector(".deck-name")`);

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
