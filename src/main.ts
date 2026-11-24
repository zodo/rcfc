// Entry point: open the store, start sync, wire navigation (src/router.ts), show a screen.
// Screens live in src/screens/, shared shell state in src/app.ts.
import "@fontsource/balsamiq-sans/400.css";
import "@fontsource/balsamiq-sans/700.css";
import "./style.css";
import { app, go, reloadWhenSafe, requestPersistence, setHold, type Screens } from "./app";
import { router } from "./router";
import { add } from "./screens/add";
import { home } from "./screens/home";
import { importScreen } from "./screens/import";
import { settings } from "./screens/settings";
import { study } from "./screens/study";
import { addLanguage, edit, words } from "./screens/words";
import { joinFromLink } from "./screens/sync";
import { Pictures } from "./pictures";
import { Store } from "./store";
import { setupPaper } from "./ui/paper";
import { Sync } from "./sync";
import { clear, h } from "./ui/h";
import { setupInstallPrompt } from "./ui/install";
import { setupUpdates } from "./ui/update";

const screens: Screens = { home, study, words, add, import: importScreen, edit, addLanguage, settings };

async function boot() {
  const { root } = app;
  const status = h("p", { class: "muted center" }, "Loading your words…");
  clear(root);
  root.appendChild(status);
  try {
    if (import.meta.env.DEV && (await (await import("./dev/hooks")).devHooks())) return;
    const { store, info } = await Store.open({
      onProgress: (done, total) => {
        status.textContent = `Updating the memory model… ${Math.round((100 * done) / total)}%`;
      },
    });
    app.store = store;
    console.info("rcfc startup", info);
    if (import.meta.env.DEV) (window as unknown as { rcfc: typeof app }).rcfc = app;
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") void store.engine.flush();
    });
    if (store.col.reviews.length || store.col.notes.size) void requestPersistence();
    app.sync = await Sync.open(store);
    app.pictures = await Pictures.open(store, () => app.sync.code);
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
    app.sync.start();
    app.pictures.start();
  } catch (e) {
    console.error(e);
    clear(root);
    root.appendChild(h("div", { class: "card-box" }, h("h2", {}, "Something went wrong"), h("pre", { class: "small" }, String(e instanceof Error ? (e.stack ?? e.message) : e)), h("button", { class: "primary", onclick: () => location.reload() }, "Reload")));
  }
}

setupPaper();
setupUpdates();
setupInstallPrompt();
void boot();
