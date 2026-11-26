// Entry point: open the store, start sync, wire navigation (src/router.ts), show a screen.
// Screens live in src/screens/, shared shell state in src/app.ts.
import "@fontsource/balsamiq-sans/400.css";
import "@fontsource/balsamiq-sans/700.css";
import "./style.css";
import { app, go, reloadWhenSafe, requestPersistence, setBack, setHold, type Screens } from "./app";
import { router } from "./router";
import { add } from "./screens/add";
import { home } from "./screens/home";
import { importScreen } from "./screens/import";
import { settings } from "./screens/settings";
import { study } from "./screens/study";
import { addLanguage, edit, words } from "./screens/words";
import { joinFromLink } from "./screens/sync";
import { Filler } from "./fill";
import { Pictures } from "./pictures";
import { Speech, webAudio } from "./speech";
import { Store } from "./store";
import { Summaries } from "./summaries";
import { launchAway, launchProgress, startLaunch } from "./ui/launch";
import { setupPaper } from "./ui/paper";
import { Sync } from "./sync";
import { clear, h } from "./ui/h";
import { setupInstallPrompt } from "./ui/install";
import { setupUpdates } from "./ui/update";

const screens: Screens = { home, study, words, add, import: importScreen, edit, addLanguage, settings };

async function boot() {
  const { root } = app;
  try {
    if (import.meta.env.DEV && (await (await import("./dev/hooks")).devHooks())) return launchAway();
    // While this runs the launch screen (src/ui/launch.ts) covers the app; the first screen shown sends it away.
    const { store, info } = await Store.open({ onProgress: launchProgress });
    app.store = store;
    console.info("rcfc startup", info);
    if (import.meta.env.DEV) (window as unknown as { rcfc: typeof app }).rcfc = app;
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") void store.engine.flush();
    });
    if (store.col.reviews.length || store.col.notes.size) void requestPersistence();
    const repaired = await store.repairKnown();
    if (repaired) console.info("rcfc: marked the other face of known words", repaired);
    app.sync = await Sync.open(store);
    app.pictures = await Pictures.open(store, () => app.sync.code);
    app.filler = new Filler(() => app.sync.code);
    app.speech = await Speech.open(store, () => app.sync.code, webAudio());
    app.summaries = await Summaries.open(store, () => app.sync.code);
    if (await joinFromLink()) return;
    app.sync.onPulled = () => {
      void app.pictures.prefetch();
      if (app.current === "home") void home();
    };
    app.sync.onReplay = reloadWhenSafe;
    // Navigation through browser history; shows home, or the screen a reload left.
    const nav = router(screens);
    Object.assign(go, nav.go);
    setHold(nav.hold);
    setBack(nav.back);
    app.sync.start();
    app.pictures.start();
  } catch (e) {
    console.error(e);
    launchAway();
    clear(root);
    root.appendChild(h("div", { class: "card-box" }, h("h2", {}, "Something went wrong"), h("pre", { class: "small" }, String(e instanceof Error ? (e.stack ?? e.message) : e)), h("button", { class: "primary", onclick: () => location.reload() }, "Reload")));
  }
}

setupPaper();
startLaunch();
setupUpdates();
setupInstallPrompt();
void boot();
