import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// Gateway URL for WebSocket proxy during development.
const GATEWAY_WS_URL = process.env.VITE_GATEWAY_URL ?? "ws://localhost:4242";
// HTTP form of the same target, used for /ws (upgrade), /auth, and /api proxies.
const GATEWAY_HTTP_URL = GATEWAY_WS_URL.replace(/^ws:/, "http:").replace(/^wss:/, "https:");

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw-custom.ts",
      registerType: "autoUpdate",
      manifest: {
        name: "Hawky",
        short_name: "Hawky",
        description: "AI companion & coding agent",
        theme_color: "#ffffff",
        background_color: "#ffffff",
        display: "standalone",
        orientation: "portrait",
        start_url: "/",
        icons: [
          {
            src: "/pwa-icon-192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "/pwa-icon-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "/pwa-icon-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
          {
            src: "/pwa-icon.svg",
            sizes: "any",
            type: "image/svg+xml",
            purpose: "any",
          },
        ],
      },
      injectManifest: {
        globPatterns: ["**/*.{js,css,html,svg,png,ico,woff2}"],
      },
    }),
  ],
  resolve: {
    alias: {
      "@hawky/protocol": path.resolve(__dirname, "../src/gateway/protocol.ts"),
      "@hawky/transcript": path.resolve(__dirname, "../src/transcript/index.ts"),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // WebSocket RPC + event stream.
      "/ws": {
        target: GATEWAY_HTTP_URL,
        ws: true,
        changeOrigin: true,
      },
      // Device-token auth issuer (socket-store acquireToken) — needed in dev so
      // the web app can authenticate against the gateway through the dev server.
      // Without it, `/auth/device?mode=json` hits the SPA fallback (text/html),
      // acquireToken() rejects it, and the page redirects to mode=web in an
      // infinite return_url re-encoding loop. In production the gateway serves
      // the web app same-origin, so this only matters for local dev.
      "/auth": {
        target: GATEWAY_HTTP_URL,
        changeOrigin: true,
      },
      // HTTP endpoints: push resubscribe + the OpenAI Realtime broker. The web
      // demo normally uses the WS `live.openaiClientSecret` method, but proxying
      // /api keeps the dev server at full hosting parity with the gateway.
      "/api": {
        target: GATEWAY_HTTP_URL,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
  },
});
