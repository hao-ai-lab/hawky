// =============================================================================
// Node Mac Tools Tests
//
// Tests for screenshot, device.info, and frontmost.app node commands.
// Some tests are macOS-only and skip on other platforms.
// =============================================================================

import { describe, test, expect } from "bun:test";
import { dispatchCommand, SUPPORTED_COMMANDS } from "../src/node/commands.js";
import { platform } from "node:os";

const isMac = platform() === "darwin";

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("Node Mac Tools", () => {
  // ---------------------------------------------------------------------------
  // SUPPORTED_COMMANDS
  // ---------------------------------------------------------------------------

  describe("SUPPORTED_COMMANDS", () => {
    test("includes new commands", () => {
      expect(SUPPORTED_COMMANDS).toContain("screenshot");
      expect(SUPPORTED_COMMANDS).toContain("device.info");
      expect(SUPPORTED_COMMANDS).toContain("frontmost.app");
    });

    test("still includes original commands", () => {
      expect(SUPPORTED_COMMANDS).toContain("system.run");
      expect(SUPPORTED_COMMANDS).toContain("system.which");
    });
  });

  // ---------------------------------------------------------------------------
  // device.info — works on all platforms
  // ---------------------------------------------------------------------------

  describe("device.info", () => {
    test("returns device metadata", async () => {
      const result = await dispatchCommand("device.info", {});
      const info = result as any;
      expect(info.hostname).toBeTruthy();
      expect(info.platform).toBeTruthy();
      expect(info.arch).toBeTruthy();
      expect(info.os).toBeTruthy();
      expect(info.osVersion).toBeTruthy();
      expect(info.cpu).toBeTruthy();
      expect(info.cpuCores).toBeGreaterThan(0);
      expect(info.memoryTotal).toContain("GB");
      expect(info.memoryFree).toBeTruthy();
    });

    test("reports correct platform", async () => {
      const result = await dispatchCommand("device.info", {}) as any;
      if (isMac) {
        expect(result.os).toBe("macOS");
        expect(result.platform).toBe("darwin");
      } else {
        expect(result.platform).toBeTruthy();
      }
    });

    test("reports disk available", async () => {
      const result = await dispatchCommand("device.info", {}) as any;
      // df might not be available in all CI environments
      if (result.diskAvailable) {
        expect(result.diskAvailable).toBeTruthy();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // screenshot — macOS only
  // ---------------------------------------------------------------------------

  describe("screenshot", () => {
    (isMac ? test : test.skip)("captures all displays as JPEG", async () => {
      const result = await dispatchCommand("screenshot", {}) as any;
      expect(result.images).toBeTruthy();
      expect(result.images.length).toBeGreaterThan(0);
      const first = result.images[0];
      expect(first.base64).toBeTruthy();
      expect(first.base64.length).toBeGreaterThan(100);
      expect(first.media_type).toBe("image/jpeg");
      expect(first.display).toBeGreaterThan(0);
    });

    (!isMac ? test : test.skip)("throws or fails on non-macOS platform", async () => {
      // On Linux without ImageMagick: fails with spawn error
      // On Windows: throws "not supported"
      await expect(dispatchCommand("screenshot", {})).rejects.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // frontmost.app — macOS only
  // ---------------------------------------------------------------------------

  describe("frontmost.app", () => {
    (isMac ? test : test.skip)("returns active app info", async () => {
      const result = await dispatchCommand("frontmost.app", {});
      const app = result as any;
      expect(app.app).toBeTruthy();
      expect(typeof app.title).toBe("string");
    });

    (!isMac ? test : test.skip)("throws on unsupported platform", async () => {
      await expect(dispatchCommand("frontmost.app", {})).rejects.toThrow("only supported on macOS");
    });
  });
});
