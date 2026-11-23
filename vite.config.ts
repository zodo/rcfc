import { execSync } from "node:child_process";
import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { VitePWA } from "vite-plugin-pwa";

const sha = (() => {
  try {
    return execSync("git rev-parse --short HEAD").toString().trim();
  } catch {
    return "dev";
  }
})();

// The Cloudflare environment (preview / production) is chosen at build time
// with CLOUDFLARE_ENV; scripts/deploy.sh sets it. Plain `vite` = local dev.
export default defineConfig({
  define: {
    __BUILD__: JSON.stringify(`${sha} · ${new Date().toISOString().slice(0, 16).replace("T", " ")}`),
  },
  worker: { format: "es" },
  plugins: [
    cloudflare(),
    VitePWA({
      registerType: "prompt",
      injectRegister: false,
      manifest: {
        name: "Really Cool Flashcards",
        short_name: "rcfc",
        start_url: "/",
        display: "standalone",
        background_color: "#111114",
        theme_color: "#111114",
        icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
      },
      workbox: {
        navigateFallbackDenylist: [/^\/api\//],
        // The RWKV model (~11 MB) and engine must be precached for offline use;
        // Workbox silently skips files over its 2 MiB default.
        globPatterns: ["**/*.{js,css,html,svg,webmanifest,wasm,safetensors}"],
        maximumFileSizeToCacheInBytes: 16 * 1024 * 1024,
      },
    }),
  ],
});
