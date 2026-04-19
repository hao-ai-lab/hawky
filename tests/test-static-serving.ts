// =============================================================================
// Tests: Static File Serving
//
// Unit tests for the gateway's static file serving (web frontend in production).
// =============================================================================

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serveStatic } from "../src/gateway/static.js";

// -----------------------------------------------------------------------------
// Setup
// -----------------------------------------------------------------------------

let testDir: string;

beforeAll(() => {
  testDir = join(tmpdir(), `hawky-static-test-${Date.now()}`);
  mkdirSync(join(testDir, "assets"), { recursive: true });

  // Create test files
  writeFileSync(join(testDir, "index.html"), "<html><body>Hawky</body></html>");
  writeFileSync(join(testDir, "assets", "index-abc123.js"), "console.log('app')");
  writeFileSync(join(testDir, "assets", "index-abc123.css"), "body { color: red }");
  writeFileSync(join(testDir, "favicon.svg"), "<svg></svg>");
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("serveStatic", () => {
  test("serves index.html for root path", () => {
    const res = serveStatic(testDir, "/");
    // Root "/" is a directory, not a file — falls to SPA fallback
    expect(res).not.toBeNull();
    expect(res!.headers.get("Content-Type")).toContain("text/html");
  });

  test("serves JavaScript files with correct MIME type", () => {
    const res = serveStatic(testDir, "/assets/index-abc123.js");
    expect(res).not.toBeNull();
    expect(res!.headers.get("Content-Type")).toContain("javascript");
  });

  test("serves CSS files with correct MIME type", () => {
    const res = serveStatic(testDir, "/assets/index-abc123.css");
    expect(res).not.toBeNull();
    expect(res!.headers.get("Content-Type")).toContain("text/css");
  });

  test("serves SVG files with correct MIME type", () => {
    const res = serveStatic(testDir, "/favicon.svg");
    expect(res).not.toBeNull();
    expect(res!.headers.get("Content-Type")).toContain("svg");
  });

  test("assets get immutable cache header", () => {
    const res = serveStatic(testDir, "/assets/index-abc123.js");
    expect(res).not.toBeNull();
    expect(res!.headers.get("Cache-Control")).toContain("immutable");
  });

  test("non-asset files get must-revalidate cache header", () => {
    const res = serveStatic(testDir, "/favicon.svg");
    expect(res).not.toBeNull();
    expect(res!.headers.get("Cache-Control")).toContain("must-revalidate");
  });

  test("blocks path traversal (../../etc/passwd)", () => {
    const res = serveStatic(testDir, "/../../../etc/passwd");
    expect(res).toBeNull();
  });

  test("encoded dots stay within webDistDir (no real traversal)", () => {
    const res = serveStatic(testDir, "/%2e%2e/%2e%2e/etc/passwd");
    // join doesn't decode %2e, so path stays inside testDir (safe).
    // SPA fallback serves index.html for extensionless paths.
    // The key assertion: no file outside webDistDir is served.
    if (res) {
      expect(res.headers.get("Content-Type")).toContain("text/html");
    }
  });

  test("returns null for /ws path (WebSocket)", () => {
    const res = serveStatic(testDir, "/ws");
    expect(res).toBeNull();
  });

  test("returns null for /api/ paths", () => {
    const res = serveStatic(testDir, "/api/status");
    expect(res).toBeNull();
  });

  test("SPA fallback: unknown extensionless path returns index.html", () => {
    const res = serveStatic(testDir, "/channels/general");
    expect(res).not.toBeNull();
    expect(res!.headers.get("Content-Type")).toContain("text/html");
  });

  test("returns null for unknown file with extension", () => {
    const res = serveStatic(testDir, "/nonexistent.xyz");
    expect(res).toBeNull();
  });
});
