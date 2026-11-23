#!/usr/bin/env bun
// UI smoke test in real Safari (WebKit, the iPhone engine) through safaridriver's
// WebDriver API. No dependencies. Starts a dev server unless given a URL.
//
//   bun run smoke                      dev server on :5199, then the checks
//   bun run smoke http://localhost:5173  an already running dev server
//
// Needs Safari ▸ Settings ▸ Advanced ▸ "Show features for web developers", then
// Develop ▸ "Allow Remote Automation" (once). Uses the dev-only ?reset / ?seed
// hooks (src/dev/hooks.ts), so it cannot run against preview or production.
// On failure a screenshot is saved to .wrangler/smoke/.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const DRIVER_PORT = 4445;
const DEV_PORT = 5199;
const ELEMENT = "element-6066-11e4-a52e-4f735466cecf";

const children: { kill(): void }[] = [];
function cleanup() {
  for (const c of children) c.kill();
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

// ---------- WebDriver ----------

class Safari {
  private constructor(private base: string) {}

  static async start(): Promise<Safari> {
    children.push(Bun.spawn(["safaridriver", "-p", String(DRIVER_PORT)], { stdout: "ignore", stderr: "inherit" }));
    await waitHttp(`http://localhost:${DRIVER_PORT}/status`, 10_000);
    const res = await fetch(`http://localhost:${DRIVER_PORT}/session`, {
      method: "POST",
      body: JSON.stringify({ capabilities: { alwaysMatch: { browserName: "safari" } } }),
    });
    const body = (await res.json()) as { value: { sessionId?: string; message?: string } };
    if (!body.value.sessionId) throw new Error(`safaridriver: ${body.value.message}\n(Is Develop ▸ Allow Remote Automation on, and no other automation session open?)`);
    const s = new Safari(`http://localhost:${DRIVER_PORT}/session/${body.value.sessionId}`);
    await s.cmd("POST", "/window/rect", { width: 430, height: 900 });
    return s;
  }

  async cmd<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(this.base + path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = (await res.json()) as { value: T & { error?: string; message?: string } };
    if (!res.ok) throw new Error(`${method} ${path}: ${json.value?.error} ${json.value?.message ?? ""}`);
    return json.value;
  }

  async quit(): Promise<void> {
    await this.cmd("DELETE", "").catch(() => {});
  }

  go(url: string) {
    return this.cmd("POST", "/url", { url });
  }

  js<T>(script: string, ...args: unknown[]): Promise<T> {
    return this.cmd<T>("POST", "/execute/sync", { script, args });
  }

  /** Poll a JS expression until it is truthy; returns its value. */
  async until<T>(what: string, expr: string, ms = 15_000): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
      const v = await this.js<T>(`return (${expr});`);
      if (v) return v;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await Bun.sleep(150);
    }
  }

  /** The first visible element matching `css` whose text includes `text`. */
  async find(css: string, text = "", ms = 15_000): Promise<string> {
    const el = await this.until<Record<string, string>>(
      `${css} "${text}"`,
      `[...document.querySelectorAll(${JSON.stringify(css)})].find((e) => e.offsetParent !== null && e.textContent.includes(${JSON.stringify(text)}))`,
      ms,
    );
    return el[ELEMENT];
  }

  async click(css: string, text = ""): Promise<void> {
    await this.cmd("POST", `/element/${await this.find(css, text)}/click`, {});
  }

  async type(css: string, value: string): Promise<void> {
    const id = await this.find(css);
    await this.cmd("POST", `/element/${id}/clear`, {});
    await this.cmd("POST", `/element/${id}/value`, { text: value });
  }

  text(css: string): Promise<string> {
    return this.js<string>(`return document.querySelector(${JSON.stringify(css)})?.textContent ?? "";`);
  }

  async screenshot(file: string): Promise<void> {
    const png = await this.cmd<string>("GET", "/screenshot");
    writeFileSync(file, Buffer.from(png, "base64"));
  }
}

// ---------- checks ----------

let step = "";
function log(s: string) {
  step = s;
  console.log(`· ${s}`);
}

const title = (s: Safari) => s.text("header.top h1");

async function answerUntilDone(s: Safari, max: number): Promise<number> {
  let n = 0;
  for (; n < max; n++) {
    const state = await s.until<string>("a card or the end", `document.querySelector(".flashcard") ? "card" : document.querySelector(".done") ? "done" : ""`);
    if (state === "done") return n;
    await s.click("button", "Show answer");
    await s.click("button.rate", n % 4 === 3 ? "Again" : "Good");
    // Wait for the next card to replace this one.
    await s.until("next screen", `!document.querySelector(".answer:not(.hidden)")`);
  }
  return n;
}

async function run(s: Safari, url: string) {
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
  const answered = await answerUntilDone(s, 10);
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
    await s.until(`sort card ${i + 1}`, `document.querySelector(".study-top")?.textContent.startsWith("${i + 1} /")`);
    await s.click("button.rate", i === 1 ? "Teach me" : "I know it");
  }
  await s.click("button[aria-label=Stop]");
  await s.until("paused", `document.querySelector(".done h2")?.textContent === "Paused"`);
  await s.click("button", "Done");
  await s.until("home", `document.querySelector(".deck-name")`);

  log("no uncaught errors");
  const errors = await s.js<string[]>("return window.__rcfcErrors ?? [];");
  if (errors.length) throw new Error(`uncaught errors:\n${errors.join("\n")}`);
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
  const s = await Safari.start();
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

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  cleanup();
  process.exit(1);
});
