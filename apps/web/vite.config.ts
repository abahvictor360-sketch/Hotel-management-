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
        theme_color: "#1b8a4f",
        background_color: "#eceeec",
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
        // The remote dashboard is a separate page served by the cloud, never the staff shell.
        navigateFallbackDenylist: [/^\/api/, /^\/dashboard/, /^\/book\//],
        globPatterns: ["**/*.{js,css,html,svg}"],
        runtimeCaching: [],
      },
    }),
  ],
  build: {
    rollupOptions: {
      input: {
        main: "index.html",
        dashboard: "dashboard.html",
        book: "book.html",
      },
    },
  },
  server: { port: 5173, proxy: { "/api": "http://localhost:4000" } },
});
