import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { VitePWA } from "vite-plugin-pwa";

// The Cloudflare environment (preview / production) is chosen at build time
// with CLOUDFLARE_ENV; scripts/deploy.sh sets it. Plain `vite` = local dev.
export default defineConfig({
  plugins: [
    cloudflare(),
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "Really Cool Flashcards",
        short_name: "rcfc",
        start_url: "/",
        display: "standalone",
        background_color: "#111111",
        theme_color: "#111111",
        icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
      },
      workbox: {
        navigateFallbackDenylist: [/^\/api\//],
      },
    }),
  ],
});
