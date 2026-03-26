// =============================================================================
// Tests for gateway probe (src/gateway/probe.ts)
// =============================================================================

import { describe, expect, test } from "bun:test";
import { isGatewayRunning } from "../src/gateway/probe.js";

// =============================================================================
// isGatewayRunning
// =============================================================================

describe("isGatewayRunning", () => {
  test("returns false for port with no server", async () => {
    // Use a random high port that's almost certainly not in use
    const result = await isGatewayRunning(59999);
    expect(result).toBe(false);
  });

  test("returns false quickly (within timeout)", async () => {
    const start = Date.now();
    await isGatewayRunning(59998);
    const elapsed = Date.now() - start;
    // Should fail fast, not wait the full 2s timeout
    expect(elapsed).toBeLessThan(3000);
  });

  test("returns true for running HTTP server", async () => {
    // Spin up a minimal Bun server that responds to /health
    const server = Bun.serve({
      port: 0, // random available port
      fetch(req) {
        if (new URL(req.url).pathname === "/health") {
          return Response.json({ ok: true });
        }
        return new Response("not found", { status: 404 });
      },
    });

    try {
      const result = await isGatewayRunning(server.port);
      expect(result).toBe(true);
    } finally {
      server.stop();
    }
  });

  test("returns false for server without /health endpoint", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("not found", { status: 404 });
      },
    });

    try {
      const result = await isGatewayRunning(server.port);
      expect(result).toBe(false);
    } finally {
      server.stop();
    }
  });
});
