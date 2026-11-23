// Entry point: open the store, start sync, wire navigation, show home.
// Screens live in src/screens/, shared shell state in src/app.ts.
import "./style.css";
import { app, go, reloadWhenSafe, requestPersistence, type Screens } from "./app";
import { add } from "./screens/add";
import { browse, edit } from "./screens/browse";
import { home } from "./screens/home";
import { importScreen } from "./screens/import";
import { settings } from "./screens/settings";
import { sortWords } from "./screens/sort";
import { study } from "./screens/study";
import { joinFromLink } from "./screens/sync";
import { Store } from "./store";
import { Sync } from "./sync";
import { clear, h } from "./ui/h";
import { setupInstallPrompt } from "./ui/install";
import { setupUpdates } from "./ui/update";

const screens: Screens = { home, study, sortWords, add, import: importScreen, browse, edit, settings };
Object.assign(go, screens);

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
    if (await joinFromLink()) return;
    app.sync.onPulled = () => {
      if (app.current === "home") void home();
    };
    app.sync.onReplay = reloadWhenSafe;
    await home();
    app.sync.start();
  } catch (e) {
    console.error(e);
    clear(root);
    root.appendChild(h("div", { class: "card-box" }, h("h2", {}, "Something went wrong"), h("pre", { class: "small" }, String(e instanceof Error ? (e.stack ?? e.message) : e)), h("button", { class: "primary", onclick: () => location.reload() }, "Reload")));
  }
}

setupUpdates();
setupInstallPrompt();
void boot();
