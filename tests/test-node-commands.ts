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
  });

  // ---------------------------------------------------------------------------
  // Dispatch
  // ---------------------------------------------------------------------------

  describe("dispatch", () => {
    test("throws for unknown command", async () => {
      await expect(dispatchCommand("unknown.cmd", {})).rejects.toThrow("Unknown node command");
    });
  });
});
