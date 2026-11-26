// Draw the app icons and the iPhone splash screens from scripts/icons/icon.html
// (cut paper on a canvas) by screenshotting it in headless Chromium, then write
// the splash <link> tags into index.html. The images are committed; re-run
// after changing the drawing: `bun scripts/build-icons.ts`. Needs Chromium.app
// or Google Chrome (RCFC_CHROMIUM overrides).
//   icon-192/512.png      purpose "any": rounded, transparent corners
//   icon-maskable-512.png purpose "maskable": full bleed; Android crops it
//   apple-touch-icon.png  180px full bleed (iOS rounds corners itself and turns transparency black)
//   favicon-48.png        the browser tab
//   splash/*.jpg          iOS startup images: one per iPhone screen, light and dark
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = join(import.meta.dir, "..");
const pub = join(root, "public");
const exe = [process.env.RCFC_CHROMIUM, "/Applications/Chromium.app/Contents/MacOS/Chromium", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((b) => b && existsSync(b));
if (!exe) throw new Error("no Chromium found: install Chromium.app or set RCFC_CHROMIUM");

// iPhone screens in CSS px and pixel ratio, portrait (the home screen app opens portrait).
const PHONES: [w: number, h: number, dpr: number, which: string][] = [
  [440, 956, 3, "16/17 Pro Max"],
  [420, 912, 3, "Air"],
  [402, 874, 3, "16/17 Pro, 17"],
  [430, 932, 3, "14 Pro Max, 15 Plus/Pro Max, 16 Plus"],
  [393, 852, 3, "14 Pro, 15, 15 Pro, 16"],
  [428, 926, 3, "12/13 Pro Max, 14 Plus"],
  [390, 844, 3, "12, 13, 14, 16e"],
  [375, 812, 3, "X, XS, 11 Pro, 12/13 mini"],
  [414, 896, 3, "XS Max, 11 Pro Max"],
  [414, 896, 2, "XR, 11"],
  [375, 667, 2, "8, SE"],
];

const server = Bun.serve({
  port: 0,
  fetch: (req) => {
    const path = decodeURIComponent(new URL(req.url).pathname);
    if (!path.startsWith("/scripts/icons/") && !path.startsWith("/node_modules/@fontsource/")) return new Response("no", { status: 404 });
    return new Response(Bun.file(join(root, path)));
  },
});

const profile = join(tmpdir(), `rcfc-icons-${process.pid}`);
const proc = Bun.spawn([exe, "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "about:blank"], { stdout: "ignore", stderr: "pipe" });

// The DevTools endpoint Chromium prints on stderr, then its first page.
const reader = proc.stderr.getReader();
let err = "", port = "";
while (!port) {
  const { value, done } = await reader.read();
  if (done) throw new Error(`Chromium did not start:\n${err}`);
  err += new TextDecoder().decode(value);
  port = /DevTools listening on ws:\/\/[^:]+:(\d+)\//.exec(err)?.[1] ?? "";
}
void (async () => { while (!(await reader.read()).done); })();
type Target = { type: string; webSocketDebuggerUrl: string };
let target: Target | undefined;
for (let i = 0; !target; i++) {
  if (i > 50) throw new Error("Chromium opened no page");
  await Bun.sleep(100);
  target = ((await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Target[]).find((t) => t.type === "page");
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((ok, fail) => ((ws.onopen = ok), (ws.onerror = fail)));
let nextId = 1;
const pending = new Map<number, (r: any) => void>();
ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); pending.get(m.id)?.(m); pending.delete(m.id); };
const send = (method: string, params: object = {}) => new Promise<any>((ok) => { const id = nextId++; pending.set(id, ok); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expression: string) => (await send("Runtime.evaluate", { expression, returnByValue: true })).result?.result?.value;

/** Draw one image and save the canvas as PNG, or JPEG for the splash screens. */
async function shot(kind: string, w: number, h: number, out: string): Promise<void> {
  await send("Page.navigate", { url: `http://localhost:${server.port}/scripts/icons/icon.html?w=${w}&h=${h}&kind=${kind}` });
  for (let i = 0; (await evaluate("document.title")) !== "done"; i++) {
    if (i > 200) throw new Error(`timed out drawing ${kind} ${w}x${h}`);
    await Bun.sleep(50);
  }
  const type = out.endsWith(".jpg") ? "'image/jpeg', 0.82" : "'image/png'";
  const url: string = await evaluate(`document.getElementById('c').toDataURL(${type})`);
  writeFileSync(out, Buffer.from(url.slice(url.indexOf(",") + 1), "base64"));
}

try {
  await shot("any", 512, 512, join(pub, "icon-512.png"));
  await shot("any", 192, 192, join(pub, "icon-192.png"));
  await shot("any", 48, 48, join(pub, "favicon-48.png"));
  await shot("full", 512, 512, join(pub, "icon-maskable-512.png"));
  await shot("full", 180, 180, join(pub, "apple-touch-icon.png"));

  rmSync(join(pub, "splash"), { recursive: true, force: true });
  mkdirSync(join(pub, "splash"));
  const links: string[] = [];
  for (const [w, h, dpr] of PHONES)
    for (const theme of ["light", "dark"]) {
      const name = `${w * dpr}x${h * dpr}-${theme}.jpg`;
      await shot(theme, w * dpr, h * dpr, join(pub, "splash", name));
      const media = `(device-width: ${w}px) and (device-height: ${h}px) and (-webkit-device-pixel-ratio: ${dpr}) and (orientation: portrait) and (prefers-color-scheme: ${theme})`;
      links.push(`    <link rel="apple-touch-startup-image" media="${media}" href="/splash/${name}" />`);
    }

  const index = join(root, "index.html");
  const html = readFileSync(index, "utf8");
  const block = /( *<!-- splash: scripts\/build-icons\.ts -->\n)[\s\S]*?( *<!-- \/splash -->)/;
  if (!block.test(html)) throw new Error("index.html has no <!-- splash: scripts/build-icons.ts --> block");
  writeFileSync(index, html.replace(block, (_, open, close) => `${open}${links.join("\n")}\n${close}`));
  console.log(`icons + ${links.length} splash screens written`);
} finally {
  ws.close();
  proc.kill();
  await proc.exited;
  server.stop(true);
  rmSync(profile, { recursive: true, force: true });
}
