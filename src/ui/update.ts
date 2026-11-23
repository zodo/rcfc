// App updates. The service worker installs a new version in the background;
// we check on launch, when the app comes back to the foreground and hourly,
// then offer a one-tap reload (never reload by surprise mid-session).
import { registerSW } from "virtual:pwa-register";
import { h } from "./h";

export function setupUpdates() {
  let banner: HTMLElement | null = null;
  const updateSW = registerSW({
    immediate: true,
    onNeedRefresh() {
      if (banner) return;
      banner = h(
        "div",
        { class: "update-banner", role: "status" },
        h("span", {}, "A new version of rcfc is ready."),
        h("button", { class: "primary", onclick: () => void updateSW(true) }, "Update"),
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
