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
//   launch/*.webp         the splash pile's cards, for the app's launch screen
//                         (src/ui/launch.ts); index.html gets the block that lays
//                         them out where the splash draws them (src/ui/launch.json)
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

const G = JSON.parse(readFileSync(join(root, "src/ui/launch.json"), "utf8")) as {
  width: number; maxWidth: number; centerY: number; card: [number, number]; pad: number; under: [string, number, number, number][]; top: [number, number, number];
};

/** Replaces what is between `<!-- name: scripts/build-icons.ts -->` and `<!-- /name -->` in index.html. */
function replaceBlock(html: string, name: string, body: string): string {
  const block = new RegExp(`( *<!-- ${name}: scripts/build-icons\\.ts -->\\n)[\\s\\S]*?( *<!-- /${name} -->)`);
  if (!block.test(html)) throw new Error(`index.html has no <!-- ${name}: scripts/build-icons.ts --> block`);
  return html.replace(block, (_, open, close) => `${open}${body}\n${close}`);
}

/**
 * The launch screen as index.html shows it at the very first paint: the
 * splash's cards, laid out by an inline script where the splash draws them,
 * with their own styles (the app's stylesheet may not be there yet).
 */
function launchBlock(): string {
  const [w, h] = G.card, p = G.pad;
  const pic = (name: string) =>
    `<picture><source media="(prefers-color-scheme: dark)" srcset="/launch/${name}-dark.webp" /><img src="/launch/${name}-light.webp" alt="" /></picture>`;
  const at = (dx: number, dy: number, deg: number) => `translate: calc(${dx} * var(--u)) calc(${dy} * var(--u)); rotate: ${deg}deg`;
  const cards = G.under.map(([name, dx, dy, deg]) => `      <div class="launch-card" style="${at(dx, dy, deg)}">${pic(name)}</div>`);
  const [tx, ty, tdeg] = G.top;
  return `    <div id="launch" aria-hidden="true">
    <div class="launch-pile">
${cards.join("\n")}
      <div class="launch-card launch-top" style="${at(tx, ty, tdeg)}"><div class="launch-flip"><div class="launch-front">${pic("top")}</div></div></div>
    </div>
    </div>
    <style>
      #launch { position: fixed; inset: 0; z-index: 20; pointer-events: none; background: url(/launch/fibre.png) 0 0 / 256px, url(/launch/mottle.png) 0 0 / 1024px, #a9bfa3; }
      @media (prefers-color-scheme: dark) { #launch { background-color: #2f3431; } }
      .launch-pile { position: absolute; left: calc(var(--cx) - ${w / 2} * var(--u)); top: calc(var(--cy) - ${h / 2} * var(--u)); width: calc(${w} * var(--u)); height: calc(${h} * var(--u)); }
      .launch-card { position: absolute; left: calc(${-p} * var(--u)); top: calc(${-p} * var(--u)); width: calc(${w + 2 * p} * var(--u)); height: calc(${h + 2 * p} * var(--u)); }
      .launch-shuffling .launch-card { transition: translate 0.42s cubic-bezier(0.3, 0.7, 0.3, 1), rotate 0.42s cubic-bezier(0.3, 0.7, 0.3, 1); }
      .launch-card picture, .launch-card img { display: block; width: 100%; height: 100%; }
      .launch-top { z-index: 10; perspective: calc(1600 * var(--u)); }
      .launch-flip, .launch-front { position: absolute; inset: 0; transform-style: preserve-3d; }
      .launch-front { backface-visibility: hidden; -webkit-backface-visibility: hidden; }
      .launch-back { position: absolute; left: calc(${p} * var(--u)); top: calc(${p} * var(--u)); width: calc(${w} * var(--u)); height: calc(${h} * var(--u)); transform: rotateY(180deg); backface-visibility: hidden; -webkit-backface-visibility: hidden; }
      .launch-note { position: absolute; left: calc(${p + 40} * var(--u)); right: calc(${p + 40} * var(--u)); top: calc(${p + h / 2 + 70} * var(--u)); display: grid; justify-items: center; gap: calc(8 * var(--u)); color: rgb(52 56 60 / 0.78); font: calc(27 * var(--u)) "Balsamiq Sans", system-ui, sans-serif; text-align: center; }
      .launch-note svg { width: 100%; height: calc(18 * var(--u)); overflow: visible; }
      .launch-note path { fill: none; stroke: currentColor; stroke-width: 2.2; stroke-linecap: round; stroke-dasharray: 1; stroke-dashoffset: 1; transition: stroke-dashoffset 0.3s; }
    </style>
    <script>
      // The pile where the iOS splash draws it: ${G.width * 100}% of the screen's width (at most ${G.maxWidth} px), centred at ${G.centerY * 100}% of
      // its height. On iOS from the home screen the page may start below the status bar: placed against the screen, not the page.
      (function () {
        var l = document.getElementById("launch"), st = navigator.standalone && innerWidth < innerHeight;
        var W = st ? screen.width : innerWidth, H = st ? screen.height : innerHeight;
        l.style.setProperty("--u", Math.min(W * ${G.width}, ${G.maxWidth}) / ${w} + "px");
        l.style.setProperty("--cx", innerWidth / 2 + "px");
        l.style.setProperty("--cy", H * ${G.centerY} - (st ? screen.height - innerHeight : 0) + "px");
      })();
    </script>`;
}

/**
 * The launch screen alone, as index.html shows it, and compare(shot, splash):
 * how far the screenshot is from the splash picture over the pile, unshifted
 * and shifted by a few device pixels each way: the best match must be at most
 * two device pixels off.
 */
function launchCheckPage(): string {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<body style="margin:0">
${launchBlock()}
<script>
  Promise.all([...document.images].map((i) => i.decode())).then(() => (document.title = "ready"));
  const load = (src) => new Promise((ok) => { const i = new Image(); i.onload = () => ok(i); i.src = src; });
  window.compare = async (shotUrl, splashUrl) => {
    const [a, b] = await Promise.all([load(shotUrl), load(splashUrl)]);
    const px = (img) => { const c = document.createElement("canvas"); c.width = img.width; c.height = img.height; const x = c.getContext("2d"); x.drawImage(img, 0, 0); return x.getImageData(0, 0, img.width, img.height); };
    const A = px(a), B = px(b);
    if (A.width !== B.width || A.height !== B.height) return { error: "size " + A.width + "x" + A.height + " vs " + B.width + "x" + B.height };
    const r = document.querySelector(".launch-pile").getBoundingClientRect(), d = devicePixelRatio;
    const x0 = Math.round(r.left * d), y0 = Math.round(r.top * d), x1 = Math.round(r.right * d), y1 = Math.round(r.bottom * d);
    const diff = (sx, sy) => { let t = 0, n = 0; for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) { const i = (y * A.width + x) * 4, j = ((y + sy) * B.width + x + sx) * 4; t += Math.abs(A.data[i] - B.data[j]) + Math.abs(A.data[i + 1] - B.data[j + 1]) + Math.abs(A.data[i + 2] - B.data[j + 2]); n += 3; } return t / n; };
    const at0 = diff(0, 0); let best = [0, 0], low = at0;
    for (const [sx, sy] of [[-6,0],[-3,0],[-2,0],[-1,0],[1,0],[2,0],[3,0],[6,0],[0,-6],[0,-3],[0,-2],[0,-1],[0,1],[0,2],[0,3],[0,6]]) { const v = diff(sx, sy); if (v < low) { low = v; best = [sx, sy]; } }
    return { diff: low, best };
  };
</script>`;
}

/** Mean difference per channel (0..255) over the pile allowed between the launch screen and its splash: JPEG noise and the splash's table texture. */
const LAUNCH_DIFF = 3;

const server = Bun.serve({
  port: 0,
  fetch: (req) => {
    const path = decodeURIComponent(new URL(req.url).pathname);
    if (path === "/launch-check") return new Response(launchCheckPage(), { headers: { "content-type": "text/html" } });
    if (path.startsWith("/launch/") || path.startsWith("/splash/")) return new Response(Bun.file(join(pub, path)));
    if (!path.startsWith("/scripts/icons/") && !path.startsWith("/node_modules/@fontsource/") && path !== "/src/ui/launch.json") return new Response("no", { status: 404 });
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
const evaluate = async (expression: string) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;

/** Draw one image and save the canvas as PNG, or JPEG for the splash screens. */
async function shot(kind: string, w: number, h: number, out: string, extra = ""): Promise<void> {
  await send("Page.navigate", { url: `http://localhost:${server.port}/scripts/icons/icon.html?w=${w}&h=${h}&kind=${kind}${extra}` });
  for (let i = 0; (await evaluate("document.title")) !== "done"; i++) {
    if (i > 200) throw new Error(`timed out drawing ${kind} ${w}x${h}`);
    await Bun.sleep(50);
  }
  const type = out.endsWith(".jpg") ? "'image/jpeg', 0.82" : out.endsWith(".webp") ? "'image/webp', 0.85" : "'image/png'";
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
      await shot(theme, w * dpr, h * dpr, join(pub, "splash", name), `&dpr=${dpr}`);
      const media = `(device-width: ${w}px) and (device-height: ${h}px) and (-webkit-device-pixel-ratio: ${dpr}) and (orientation: portrait) and (prefers-color-scheme: ${theme})`;
      links.push(`    <link rel="apple-touch-startup-image" media="${media}" href="/splash/${name}" />`);
    }

  rmSync(join(pub, "launch"), { recursive: true, force: true });
  mkdirSync(join(pub, "launch"));
  for (const theme of ["light", "dark"])
    for (const name of [...G.under.map((c) => c[0] as string), "top"]) await shot("card", 0, 0, join(pub, "launch", `${name}-${theme}.webp`), `&name=${name}&theme=${theme}`);
  for (const name of ["fibre", "mottle"]) await shot("tile", 0, 0, join(pub, "launch", `${name}.png`), `&name=${name}`);

  const index = join(root, "index.html");
  let html = readFileSync(index, "utf8");
  html = replaceBlock(html, "splash", links.join("\n"));
  html = replaceBlock(html, "launch", launchBlock());
  writeFileSync(index, html);
  console.log(`icons, ${links.length} splash screens and the launch pile written`);

  // The app's launch screen must lie exactly on the splash: checked for every screen.
  const bad: string[] = [];
  for (const [w, h, dpr, which] of PHONES)
    for (const theme of ["light", "dark"]) {
      await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: dpr, mobile: true });
      await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
      await send("Page.navigate", { url: `http://localhost:${server.port}/launch-check` });
      for (let i = 0; (await evaluate("document.title")) !== "ready"; i++) {
        if (i > 200) throw new Error(`launch check: pictures did not load (${w}x${h})`);
        await Bun.sleep(50);
      }
      const shotPng = (await send("Page.captureScreenshot", { format: "png" })).result.data as string;
      const r = await evaluate(`compare("data:image/png;base64,${shotPng}", "/splash/${w * dpr}x${h * dpr}-${theme}.jpg")`);
      const line = `${which} ${theme}: ${r.error ?? `differs by ${r.diff.toFixed(2)}/255 at best, shifted ${r.best} device px`}`;
      // Up to 2 device px (under a point at 3x) is how differently the page and the canvas round a picture's fractional position.
      if (r.error || r.diff > LAUNCH_DIFF || Math.abs(r.best[0]) > 2 || Math.abs(r.best[1]) > 2) bad.push(line);
      else if (process.env.RCFC_VERBOSE) console.log(line);
    }
  await send("Emulation.clearDeviceMetricsOverride");
  if (bad.length) throw new Error(`the launch screen does not lie on the splash:\n${bad.join("\n")}`);
  console.log(`launch screen matches all ${PHONES.length * 2} splash screens`);
} finally {
  ws.close();
  proc.kill();
  await proc.exited;
  server.stop(true);
  rmSync(profile, { recursive: true, force: true });
}
