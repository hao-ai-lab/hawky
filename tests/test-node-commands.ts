// =============================================================================
// Node Commands Tests
//
// Tests for node host command implementations: system.run, system.which,
// and command dispatch.
// =============================================================================

import { describe, test, expect } from "bun:test";
import { dispatchCommand, SUPPORTED_COMMANDS } from "../src/node/commands.js";

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("Node Commands", () => {
  // ---------------------------------------------------------------------------
  // SUPPORTED_COMMANDS
  // ---------------------------------------------------------------------------

  describe("SUPPORTED_COMMANDS", () => {
    test("includes system.run and system.which", () => {
      expect(SUPPORTED_COMMANDS).toContain("system.run");
      expect(SUPPORTED_COMMANDS).toContain("system.which");
    });
  });

  // ---------------------------------------------------------------------------
  // system.run
  // ---------------------------------------------------------------------------

  describe("system.run", () => {
    test("executes simple command", async () => {
      const result = await dispatchCommand("system.run", {
        command: ["echo", "hello"],
      });
      expect((result as any).stdout.trim()).toBe("hello");
      expect((result as any).exitCode).toBe(0);
    });

    test("captures stderr", async () => {
      const result = await dispatchCommand("system.run", {
        command: ["bash", "-c", "echo error >&2"],
      });
      expect((result as any).stderr.trim()).toBe("error");
    });

    test("returns non-zero exit code", async () => {
      const result = await dispatchCommand("system.run", {
        command: ["bash", "-c", "exit 42"],
      });
      expect((result as any).exitCode).toBe(42);
    });

    test("respects cwd parameter", async () => {
      const result = await dispatchCommand("system.run", {
        command: ["pwd"],
        cwd: "/tmp",
      });
      // macOS /tmp is a symlink to /private/tmp
      expect((result as any).stdout.trim()).toMatch(/\/?tmp$/);
    });

    test("times out long-running commands", async () => {
      const result = await dispatchCommand("system.run", {
        command: ["sleep", "10"],
        timeoutMs: 100,
      });
      expect((result as any).timedOut).toBe(true);
      expect((result as any).exitCode).toBe(124);
    });

    test("returns error for empty command", async () => {
      const result = await dispatchCommand("system.run", {
        command: [],
      });
      expect((result as any).exitCode).toBe(1);
      expect((result as any).stderr).toContain("empty command");
    });

    test("rejects malformed command params before spawning", async () => {
      await expect(dispatchCommand("system.run", {})).rejects.toThrow("system.run.command");
      await expect(dispatchCommand("system.run", { command: "echo hi" })).rejects.toThrow("array of strings");
      await expect(dispatchCommand("system.run", { command: ["echo", 1] })).rejects.toThrow("array of strings");
      await expect(dispatchCommand("system.run", { command: ["echo"], cwd: 42 })).rejects.toThrow("system.run.cwd");
      await expect(dispatchCommand("system.run", { command: ["echo"], timeoutMs: 0 })).rejects.toThrow("system.run.timeoutMs");
    });
  });

  // ---------------------------------------------------------------------------
  // system.which
  // ---------------------------------------------------------------------------

  describe("system.which", () => {
    test("resolves known binary", async () => {
      const result = await dispatchCommand("system.which", {
        bins: ["bash"],
      });
      expect((result as any).bins.bash).toBeTruthy();
      expect((result as any).bins.bash).toContain("/bash");
    });

    test("returns null for unknown binary", async () => {
      const result = await dispatchCommand("system.which", {
        bins: ["nonexistent_binary_xyz"],
      });
      expect((result as any).bins.nonexistent_binary_xyz).toBeNull();
    });

    test("resolves multiple binaries", async () => {
      const result = await dispatchCommand("system.which", {
        bins: ["bash", "ls", "nonexistent_xyz"],
      });
      const bins = (result as any).bins;
      expect(bins.bash).toBeTruthy();
      expect(bins.ls).toBeTruthy();
      expect(bins.nonexistent_xyz).toBeNull();
    });

    test("rejects malformed bins params", async () => {
      await expect(dispatchCommand("system.which", {})).rejects.toThrow("system.which.bins");
      await expect(dispatchCommand("system.which", { bins: "bash" })).rejects.toThrow("array of strings");
      await expect(dispatchCommand("system.which", { bins: ["bash", 1] })).rejects.toThrow("array of strings");
    });
  });

  // ---------------------------------------------------------------------------
  // Dispatch
  // ---------------------------------------------------------------------------

  describe("dispatch", () => {
    test("throws for unknown command", async () => {
      await expect(dispatchCommand("unknown.cmd", {})).rejects.toThrow("Unknown node command");
    });

    test("validates optional command params", async () => {
      await expect(dispatchCommand("screenshot", { timeoutMs: -1 })).rejects.toThrow("screenshot.timeoutMs");
      await expect(dispatchCommand("screenshot", { display: 1.5 })).rejects.toThrow("screenshot.display");
      await expect(dispatchCommand("frontmost.app", { timeoutMs: "soon" })).rejects.toThrow("frontmost.app.timeoutMs");
      await expect(dispatchCommand("device.info", [])).rejects.toThrow("device.info params");
    });
  });
});
