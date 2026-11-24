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
      registerType: "autoUpdate",
      injectRegister: false,
      manifest: {
        name: "Really Cool Flashcards",
        short_name: "rcfc",
        id: "/",
        start_url: "/",
        display: "standalone",
        background_color: "#a9bfa3",
        theme_color: "#a9bfa3",
        icons: [
          // PNGs from scripts/build-icons.sh; Chrome's install check wants 192 + 512.
          { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
          { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
        ],
      },
      workbox: {
        navigateFallbackDenylist: [/^\/api\//],
        // Activate new versions without waiting for a message from the page:
        // pages of older versions never send one. src/ui/update.ts offers the reload.
        skipWaiting: true,
        clientsClaim: true,
        // The RWKV model (~11 MB) and engine must be precached for offline use;
        // Workbox silently skips files over its 2 MiB default.
        globPatterns: ["**/*.{js,css,html,svg,png,woff2,webmanifest,wasm,safetensors}"],
        maximumFileSizeToCacheInBytes: 16 * 1024 * 1024,
      },
    }),
  ],
});
