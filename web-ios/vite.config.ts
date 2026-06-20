import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Gateway URL for the dev-server proxy. The web-ios app talks to the gateway
// over a relative `/ws` (WebSocket) + `/auth` + `/api` (HTTP), so in dev the
// Vite server proxies those to the running gateway.
const GATEWAY_WS_URL = process.env.VITE_GATEWAY_URL ?? "ws://localhost:4242";
const GATEWAY_HTTP_URL = GATEWAY_WS_URL.replace(/^ws:/, "http:").replace(/^wss:/, "https:");

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Reuse the gateway's wire-protocol types directly (single source of truth).
      "@hawky/protocol": path.resolve(__dirname, "../src/gateway/protocol.ts"),
    },
  },
  server: {
    port: 5273,
    strictPort: true,
    proxy: {
      "/ws": { target: GATEWAY_HTTP_URL, ws: true, changeOrigin: true },
      "/auth": { target: GATEWAY_HTTP_URL, changeOrigin: true },
      "/api": { target: GATEWAY_HTTP_URL, changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
  },
});
