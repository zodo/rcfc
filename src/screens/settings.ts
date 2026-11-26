// Settings: your data, in one place: sync (the server copy is the cloud
// backup), pairing another device, a backup file kept yourself, and the
// address that connects Claude chats to your words (worker/mcp.ts). Study has
// no settings: the target recall and day start are fixed, and new words per
// day is a default that "Learn more" extends in place.
import { app, errorText, page } from "../app";
import { h, toast } from "../ui/h";
import { syncParts } from "./sync";

declare const __BUILD__: string;

export function settings(): void {
  const { store } = app;
  const sync = syncParts();

  const download = async () => {
    const events = await store.allEvents();
    const blob = new Blob([JSON.stringify({ app: "rcfc", version: 1, exported_at: new Date().toISOString(), events })], { type: "application/json" });
    const a = h("a", { href: URL.createObjectURL(blob), download: `rcfc-backup-${new Date().toISOString().slice(0, 10)}.json` });
    document.body.appendChild(a);
    a.click();
    a.remove();
  };
  const restore = async (e: Event) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (data?.app !== "rcfc" || !Array.isArray(data.events)) throw new Error("not an rcfc backup");
      const n = await store.importBackup(data.events);
      toast(n ? `Restored ${n} events, reloading…` : "Nothing new in that backup");
      if (n) setTimeout(() => location.reload(), 800);
    } catch (err) {
      toast(`Restore failed: ${errorText(err)}`);
    }
  };

  page(
    "settings",
    "Settings",
    h(
      "div",
      { class: "card-box" },
      h("h2", {}, "Your data"),
      sync.status,
      h("p", { class: "muted small" }, "Your words are kept on this device and copied to the server. To use them on another device, scan this with its camera or open the link there."),
      ...sync.pairing,
      sync.code,
      h(
        "details",
        { class: "stack" },
        h("summary", {}, "Backup file"),
        h("p", { class: "muted small" }, "A copy you keep yourself, apart from sync."),
        h("div", { class: "row2" }, h("button", { class: "secondary", onclick: download }, "Download"), h("label", { class: "secondary file-btn" }, "Restore", h("input", { type: "file", accept: ".json,application/json", onchange: restore }))),
      ),
    ),
    claude(),
    h("p", { class: "muted small center" }, `rcfc · ${__BUILD__}`),
  );
}

/**
 * Claude chats can see and change the words through a connector: the address
 * to paste in Claude. Claude then opens the approval page on this origin
 * (worker/oauth.ts), which finds this browser's code by itself; a browser
 * without rcfc (an iPhone home-screen app keeps its storage apart from
 * Safari's) takes the pairing link from "Copy link" above.
 */
function claude(): HTMLElement {
  const address = `${location.origin}/mcp`;
  return h(
    "div",
    { class: "card-box" },
    h("h2", {}, "Claude"),
    h("p", { class: "muted small" }, "Claude can add and change your words from a chat. In Claude, open Settings → Connectors → Add custom connector and paste this address:"),
    h("code", { class: "sync-code connector" }, address),
    h(
      "button",
      {
        class: "secondary",
        type: "button",
        onclick: async () => {
          try {
            await navigator.clipboard.writeText(address);
            toast("Address copied");
          } catch {
            prompt("Copy this address", address);
          }
        },
      },
      "Copy address",
    ),
    h("p", { class: "muted small" }, "Claude then asks you to allow it. If that page doesn't find your words, paste the link from Copy link above."),
  );
}
