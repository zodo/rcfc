// Install prompt. Chromium browsers (Android, desktop Chrome/Edge) fire
// beforeinstallprompt when the app is installable: we keep the event and show
// our own banner whose button opens the native install dialog. iOS has no
// install API, so there we show how to do it by hand (Share → Add to Home
// Screen). Firefox desktop cannot install PWAs and gets nothing. Hidden when
// already running installed, and for a while after the user dismisses it.
import { h } from "./h";

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const DISMISS_KEY = "rcfc.install-dismissed-at";
const SNOOZE_MS = 14 * 24 * 3600 * 1000;

function installed(): boolean {
  return matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
}

function isIos(): boolean {
  // iPadOS reports itself as a Mac; tell it apart by touch support.
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
}

function snoozed(): boolean {
  try {
    const at = Number(localStorage.getItem(DISMISS_KEY));
    return at > 0 && Date.now() - at < SNOOZE_MS;
  } catch {
    return false;
  }
}

function snooze() {
  try {
    localStorage.setItem(DISMISS_KEY, String(Date.now()));
  } catch {
    /* storage unavailable: the banner just comes back next launch */
  }
}

export function setupInstallPrompt() {
  if (installed()) return;
  let banner: HTMLElement | null = null;

  const hide = () => {
    banner?.remove();
    banner = null;
  };
  const show = (text: string, action?: { label: string; run: () => void }) => {
    if (banner || snoozed()) return;
    banner = h(
      "div",
      { class: "install-banner", role: "status" },
      h("span", {}, text),
      h(
        "div",
        { class: "install-actions" },
        action && h("button", { class: "primary", onclick: action.run }, action.label),
        h("button", { class: "install-close", "aria-label": "Not now", onclick: () => (snooze(), hide()) }, "✕"),
      ),
    );
    document.body.appendChild(banner);
  };

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); // suppress Chrome's mini-infobar; we show our own
    const evt = e as BeforeInstallPromptEvent;
    show("Install rcfc as an app.", {
      label: "Install",
      run: async () => {
        hide();
        await evt.prompt();
        if ((await evt.userChoice).outcome === "dismissed") snooze();
      },
    });
  });
  window.addEventListener("appinstalled", hide);

  if (isIos()) show("Tap Share, then “Add to Home Screen”. Safari may delete data of websites you don't open for a while; installed apps keep it.");
}
