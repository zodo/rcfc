// Settings: study preset, sync, backup/restore, speed test.
import { app, errorText, page } from "../app";
import { h, toast } from "../ui/h";
import { syncBox } from "./sync";

declare const __BUILD__: string;

export function settings(): void {
  const { store } = app;
  const p = store.preset();
  const retention = h("input", { type: "number", min: 70, max: 99, step: 1, value: String(Math.round(p.desired_retention * 100)) });
  const perDay = h("input", { type: "number", min: 0, max: 200, step: 1, value: String(p.new_per_day) });
  const rollover = h("input", { type: "number", min: 0, max: 23, step: 1, value: String(p.day_rollover_hour) });
  const speedOut = h("pre", { class: "small" });
  const storageOut = h("p", { class: "muted small" });
  void (async () => {
    try {
      const est = await navigator.storage?.estimate?.();
      const persisted = await navigator.storage?.persisted?.();
      const stats = await store.engine.stats();
      storageOut.textContent = `${store.col.reviews.length} reviews, ${store.col.liveCards().length} cards. Model state ${(stats.memoryBytes / 1e6).toFixed(1)} MB in memory. Storage used ${est?.usage ? (est.usage / 1e6).toFixed(1) : "?"} MB${persisted ? ", protected from automatic cleanup" : ""}.`;
    } catch {
      /* ignore */
    }
  })();

  page(
    "settings",
    "Settings",
    h(
      "form",
      {
        class: "card-box",
        onsubmit: async (e: Event) => {
          e.preventDefault();
          const r = Math.min(99, Math.max(70, Number(retention.value))) / 100;
          const n = Math.min(200, Math.max(0, Math.round(Number(perDay.value))));
          const h0 = Math.min(23, Math.max(0, Math.round(Number(rollover.value))));
          const res = await store.append([store.factory.preset({ preset_id: p.preset_id, desired_retention: r, new_per_day: n, day_rollover_hour: h0 })]);
          // A new rollover hour re-derives every RWKV row: replay from scratch.
          if (res.replay) location.reload();
          else toast("Saved");
        },
      },
      h("h2", {}, "Study"),
      h("label", {}, "Target recall, %", retention, h("span", { class: "muted small" }, "A word comes back when the model thinks your chance of remembering it fell below this.")),
      h("label", {}, "New words per day", perDay),
      h("label", {}, "New day starts at (hour)", rollover),
      h("button", { class: "primary", type: "submit" }, "Save"),
    ),
    syncBox(),
    h(
      "div",
      { class: "card-box" },
      h("h2", {}, "Your data"),
      storageOut,
      h("p", { class: "muted small" }, "A backup file is a copy you keep yourself, apart from sync."),
      h(
        "button",
        {
          class: "secondary",
          onclick: async () => {
            const events = await store.allEvents();
            const blob = new Blob([JSON.stringify({ app: "rcfc", version: 1, exported_at: new Date().toISOString(), events })], { type: "application/json" });
            const a = h("a", { href: URL.createObjectURL(blob), download: `rcfc-backup-${new Date().toISOString().slice(0, 10)}.json` });
            document.body.appendChild(a);
            a.click();
            a.remove();
          },
        },
        "Download backup",
      ),
      h(
        "label",
        { class: "secondary file-btn" },
        "Restore from backup",
        h("input", {
          type: "file",
          accept: ".json,application/json",
          onchange: async (e: Event) => {
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
          },
        }),
      ),
    ),
    h(
      "div",
      { class: "card-box" },
      h("h2", {}, "Speed test"),
      h("p", { class: "muted small" }, "Measures the model on this device. Takes up to a minute on a phone."),
      h(
        "button",
        {
          class: "secondary",
          onclick: async (e: Event) => {
            const b = e.target as HTMLButtonElement;
            b.disabled = true;
            speedOut.textContent = "Running…";
            try {
              const r = await store.engine.speedTest(3000, 600);
              const year = 82_000 / r.reviewsPerSec;
              speedOut.textContent = [
                `replay: ${r.reviewsPerSec.toFixed(0)} reviews/s`,
                `predict: ${r.predictMsPerCard.toFixed(2)} ms/card`,
                `≈ a year of daily use (82k reviews) replays in ${year.toFixed(0)} s`,
                `≈ scoring 7,300 cards takes ${((r.predictMsPerCard * 7300) / 1000).toFixed(1)} s`,
                navigator.userAgent,
              ].join("\n");
            } catch (err) {
              speedOut.textContent = `failed: ${err}`;
            } finally {
              b.disabled = false;
            }
          },
        },
        "Run speed test",
      ),
      speedOut,
    ),
    h("p", { class: "muted small center" }, `rcfc · ${__BUILD__}`),
  );
}
