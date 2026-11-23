// App updates. A new service worker installs in the background and takes over
// at once (skipWaiting, so clients of any older version pick it up too). We
// check on launch, when the app returns to the foreground and hourly, then
// offer a one-tap reload instead of reloading by surprise mid-session.
import { registerSW } from "virtual:pwa-register";
import { h } from "./h";

export function setupUpdates() {
  let banner: HTMLElement | null = null;
  registerSW({
    immediate: true,
    onNeedReload() {
      if (banner) return;
      banner = h(
        "div",
        { class: "update-banner", role: "status" },
        h("span", {}, "A new version of rcfc is ready."),
        h("button", { class: "primary", onclick: () => location.reload() }, "Update"),
      );
      document.body.appendChild(banner);
    },
    onRegisteredSW(_url, reg) {
      if (!reg) return;
      const check = () => {
        if (navigator.onLine !== false) void reg.update().catch(() => {});
      };
      setInterval(check, 60 * 60 * 1000);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") check();
      });
    },
  });
}
