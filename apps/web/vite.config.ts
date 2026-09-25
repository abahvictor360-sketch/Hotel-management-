import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "prompt",
      manifest: {
        name: "Hotel Hub",
        short_name: "Hotel Hub",
        theme_color: "#18181b",
        background_color: "#ffffff",
        display: "standalone",
        start_url: "/",
        icons: [
          {
            src: "/icon.svg",
            sizes: "any",
            type: "image/svg+xml",
            purpose: "any",
          },
        ],
      },
      workbox: {
        navigateFallbackDenylist: [/^\/api/],
        globPatterns: ["**/*.{js,css,html,svg}"],
        runtimeCaching: [],
      },
    }),
  ],
  server: { port: 5173, proxy: { "/api": "http://localhost:4000" } },
});
