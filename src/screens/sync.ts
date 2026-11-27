// Sync UI: the code, pairing QR/link, joining another device's account.
import { renderSVG } from "uqr";
import { app } from "../app";
import { formatSyncCode, pairingLink, parseSyncCode } from "../domain/sync";
import type { SyncStatus } from "../sync";
import { h, toast } from "../ui/h";

const joinPrompt = (code: string) => `Join ${formatSyncCode(code)}? Words on this device are added to that account, and its words come here.`;

function syncStatusText(st: SyncStatus): string {
  if (st.state === "syncing") return "Syncing…";
  if (st.state === "offline") return "Offline. Changes sync when you're back online.";
  if (st.state === "error") return `Sync failed: ${st.error}`;
  if (!st.lastOk) return "Not synced yet.";
  const d = new Date(st.lastOk);
  const sameDay = d.toDateString() === new Date().toDateString();
  return `Synced ${sameDay ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}.`;
}

let joinAsked = false;
/** The next Settings opens on the code field, to join another device's account (empty Words asks). */
export function joinNext(): void {
  joinAsked = true;
}

/** Sync status, pairing (QR, link) and joining: the top of "Your data" in Settings. */
export function syncParts(): { status: HTMLElement; pairing: Node[]; code: HTMLElement } {
  const { sync } = app;
  const link = pairingLink(location.origin, sync.code);
  const status = h("p", { class: "muted small" }, syncStatusText(sync.status));
  sync.onStatus = (st) => {
    if (status.isConnected) status.textContent = syncStatusText(st);
  };
  const qr = h("div", { class: "qr", role: "img", "aria-label": "QR code of the pairing link" });
  qr.innerHTML = renderSVG(link, { pixelSize: 4 });

  const input = h("input", { name: "code", autocomplete: "off", autocapitalize: "characters", spellcheck: false, placeholder: "ABCD-EFGH-IJKL-MNOP" });
  const hint = h("p", { class: "muted small" });
  const join = h(
    "form",
    {
      class: "stack",
      onsubmit: async (e: Event) => {
        e.preventDefault();
        const code = parseSyncCode(input.value);
        if (!code) return void (hint.textContent = "That isn't a valid code. It has 16 letters and digits.");
        if (code === sync.code) return void (hint.textContent = "This device already uses that code.");
        if (!confirm(joinPrompt(code))) return;
        hint.textContent = "Joining…";
        await sync.join(code);
        location.reload();
      },
    },
    h("label", {}, "Code from the other device", input),
    hint,
    h("button", { class: "secondary", type: "submit" }, "Join"),
  );

  const code = h(
    "details",
    { class: "stack" },
    h("summary", {}, "Sync code"),
    h("code", { class: "sync-code" }, formatSyncCode(sync.code)),
    h("p", { class: "muted small" }, "Whoever has this code can read and change your words, so keep it private."),
    join,
  );
  if (joinAsked) {
    joinAsked = false;
    code.open = true;
    hint.textContent = "It's in Settings on the other device, under Sync code.";
    requestAnimationFrame(() => {
      input.scrollIntoView({ block: "center" });
      input.focus();
    });
  }

  return {
    status,
    pairing: [
      qr,
      h(
        "div",
        { class: "row2" },
        h(
          "button",
          {
            class: "secondary",
            type: "button",
            onclick: async () => {
              try {
                await navigator.clipboard.writeText(link);
                toast("Link copied");
              } catch {
                prompt("Copy this link", link);
              }
            },
          },
          "Copy link",
        ),
        h("button", { class: "secondary", type: "button", onclick: () => void sync.now() }, "Sync now"),
      ),
    ],
    code,
  };
}

/** A pairing link (#k=CODE) opened on this device: join that account. True if the page is reloading. */
export async function joinFromLink(): Promise<boolean> {
  const { store, sync, root } = app;
  const code = parseSyncCode(location.hash);
  if (!code) return false;
  history.replaceState(null, "", location.pathname + location.search);
  if (code === sync.code) return false;
  const hasData = store.col.liveNotes().length > 0 || store.col.reviews.length > 0;
  if (hasData && !confirm(joinPrompt(code))) return false;
  root.replaceChildren(h("p", { class: "muted center" }, "Getting your words from the other device…"));
  await sync.join(code);
  location.reload();
  return true;
}
