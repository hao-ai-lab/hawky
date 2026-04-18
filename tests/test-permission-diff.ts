// =============================================================================
// computePermissionDiff Tests
//
// Exercises the diff preview generator that feeds the permission dialog's
// diff viewer. Focus is write_file coverage added to close the gap where
// the browser permission dialog showed no preview of file contents.
// =============================================================================

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { computePermissionDiff } from "../src/gateway/ws-permission.js";

let tempDir: string;

beforeEach(() => {
  tempDir = join(tmpdir(), `hawky-perm-diff-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("computePermissionDiff — write_file", () => {
  test("new file: diff against empty, every line shows as addition", () => {
    const result = computePermissionDiff(
      "write_file",
      { file_path: "new.ts", content: "line1\nline2\n" },
      tempDir,
    );
    expect(result).not.toBeNull();
    expect(result!.matchLine).toBe(1);
    expect(result!.hunks.length).toBeGreaterThan(0);
    const lines = result!.hunks.flatMap((h) => h.lines);
    const additions = lines.filter((l) => l.startsWith("+")).map((l) => l.slice(1));
    expect(additions).toContain("line1");
    expect(additions).toContain("line2");
    expect(lines.some((l) => l.startsWith("-"))).toBe(false);
  });

  test("overwrite: shows additions and deletions against existing content", () => {
    writeFileSync(join(tempDir, "file.ts"), "alpha\nbeta\n", "utf-8");
    const result = computePermissionDiff(
      "write_file",
      { file_path: "file.ts", content: "alpha\ngamma\n" },
      tempDir,
    );
    expect(result).not.toBeNull();
    const lines = result!.hunks.flatMap((h) => h.lines);
    expect(lines.some((l) => l === "-beta")).toBe(true);
    expect(lines.some((l) => l === "+gamma")).toBe(true);
  });

  test("accepts absolute file_path resolved inside the working directory", () => {
    const abs = join(tempDir, "abs.ts");
    writeFileSync(abs, "old\n", "utf-8");
    const result = computePermissionDiff(
      "write_file",
      { file_path: abs, content: "new\n" },
      tempDir,
    );
    expect(result).not.toBeNull();
    const lines = result!.hunks.flatMap((h) => h.lines);
    expect(lines.some((l) => l.startsWith("-") && l.includes("old"))).toBe(true);
    expect(lines.some((l) => l.startsWith("+") && l.includes("new"))).toBe(true);
  });

  test("returns null when content is not a string", () => {
    const result = computePermissionDiff(
      "write_file",
      { file_path: "x.ts", content: 42 },
      tempDir,
    );
    expect(result).toBeNull();
  });

  test("returns null when file_path is missing", () => {
    const result = computePermissionDiff(
      "write_file",
      { content: "hello" },
      tempDir,
    );
    expect(result).toBeNull();
  });

  test("skips diff when new content exceeds the preview size cap", () => {
    // Cap is 50_000 chars (see MAX_PREVIEW_DIFF_CHARS). Slightly over keeps
    // the check fast and avoids this test doing real work on huge strings.
    const huge = "x".repeat(50_001);
    const result = computePermissionDiff(
      "write_file",
      { file_path: "huge.ts", content: huge },
      tempDir,
    );
    expect(result).toBeNull();
  });

  test("skips diff when old + new content combined exceeds the cap", () => {
    const nearLimit = "a".repeat(30_000);
    writeFileSync(join(tempDir, "big.ts"), nearLimit, "utf-8");
    const alsoBig = "b".repeat(30_000);
    const result = computePermissionDiff(
      "write_file",
      { file_path: "big.ts", content: alsoBig },
      tempDir,
    );
    expect(result).toBeNull();
  });

  test("still diffs when content is just under the cap", () => {
    const content = "z".repeat(49_999);
    const result = computePermissionDiff(
      "write_file",
      { file_path: "ok.ts", content },
      tempDir,
    );
    expect(result).not.toBeNull();
    expect(result!.hunks.length).toBeGreaterThan(0);
  });

  test("skips the preview without reading an existing oversized file", () => {
    // If the existing file alone is already past the cap, we must decide
    // *before* readFileSync so the gateway never blocks on a multi‑MB read.
    // 'huge' is 60k chars (> cap), but new content is tiny.
    const huge = "q".repeat(60_000);
    writeFileSync(join(tempDir, "huge.ts"), huge, "utf-8");
    const result = computePermissionDiff(
      "write_file",
      { file_path: "huge.ts", content: "tiny" },
      tempDir,
    );
    expect(result).toBeNull();
  });

  test("skips the preview when target exists but is not a regular file", () => {
    // A FIFO would block readFileSync indefinitely — the preview must bail
    // before ever calling it. We create a real FIFO on systems that
    // support mkfifo; on others we skip the assertion.
    const fifo = join(tempDir, "pipe");
    try {
      execSync(`mkfifo "${fifo}"`, { stdio: "ignore" });
    } catch {
      return; // mkfifo unavailable — nothing to verify
    }
    const result = computePermissionDiff(
      "write_file",
      { file_path: "pipe", content: "tiny" },
      tempDir,
    );
    expect(result).toBeNull();
    // Clean the FIFO so afterEach's rmSync doesn't get confused
    try { rmSync(fifo); } catch {}
  });

  test("returns null on non-ENOENT stat errors (EACCES on parent dir)", () => {
    // When the parent directory is not searchable, statSync fails with
    // EACCES — not ENOENT. We must NOT treat that as "new file" and show
    // an all-additions preview; the file may well exist and be an overwrite.
    if (process.getuid?.() === 0) return;
    const locked = join(tempDir, "locked_dir");
    mkdirSync(locked);
    writeFileSync(join(locked, "inside.txt"), "existing", "utf-8");
    chmodSync(locked, 0o000);
    try {
      const result = computePermissionDiff(
        "write_file",
        { file_path: join(locked, "inside.txt"), content: "replacement" },
        tempDir,
      );
      expect(result).toBeNull();
    } finally {
      try { chmodSync(locked, 0o700); } catch {}
    }
  });

  test("skips the preview when existing file cannot be read (ACL denial)", () => {
    // On systems where the test runs as root (CI containers), chmod 000
    // does not prevent root from reading; the test is only meaningful for
    // non-root. Guard accordingly.
    if (process.getuid?.() === 0) return;
    const p = join(tempDir, "locked.bin");
    writeFileSync(p, "secret", "utf-8");
    chmodSync(p, 0o000);
    try {
      const result = computePermissionDiff(
        "write_file",
        { file_path: "locked.bin", content: "replacement" },
        tempDir,
      );
      // stat succeeded (file exists) but read failed → must be null, not a
      // misleading all-additions preview that implies new-file creation.
      expect(result).toBeNull();
    } finally {
      // Restore so afterEach cleanup can delete it
      try { chmodSync(p, 0o600); } catch {}
    }
  });
});

describe("computePermissionDiff — edit_file (regression)", () => {
  test("still returns hunks anchored at the matching line", () => {
    writeFileSync(join(tempDir, "file.ts"), "line1\nline2\nline3\n", "utf-8");
    const result = computePermissionDiff(
      "edit_file",
      { file_path: "file.ts", old_string: "line2", new_string: "LINE_TWO" },
      tempDir,
    );
    expect(result).not.toBeNull();
    expect(result!.matchLine).toBe(2);
    const lines = result!.hunks.flatMap((h) => h.lines);
    expect(lines.some((l) => l === "-line2")).toBe(true);
    expect(lines.some((l) => l === "+LINE_TWO")).toBe(true);
  });

  test("returns null when edit inputs are missing", () => {
    const result = computePermissionDiff(
      "edit_file",
      { file_path: "file.ts", old_string: "x" }, // no new_string
      tempDir,
    );
    expect(result).toBeNull();
  });
});

describe("computePermissionDiff — write_file pre-approval disclosure guard", () => {
  // The permission preview is broadcast to every subscribed client BEFORE the
  // user decides. If we read the existing file contents for an arbitrary path,
  // the model can exfiltrate sensitive files via a deny-expected write_file
  // request. The guard returns null (path-only preview) for any existing file
  // that isn't both inside the working directory AND not on the dangerous list.

  test("existing file outside working directory: returns null (no content read)", () => {
    // Set up a "sensitive" file in a sibling tempdir, then request a write_file
    // from a completely different cwd. Old behaviour leaked the file contents
    // via the preview; the guard returns null.
    const outside = join(tmpdir(), `hawky-outside-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(outside, { recursive: true });
    const sensitive = join(outside, "secret.txt");
    writeFileSync(sensitive, "TOP SECRET\n", "utf-8");
    try {
      const result = computePermissionDiff(
        "write_file",
        { file_path: sensitive, content: "pwned\n" },
        tempDir,
      );
      expect(result).toBeNull();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("dangerous file inside cwd: returns null (no content read)", () => {
    // .env is on the dangerous-files list regardless of parent directory.
    writeFileSync(join(tempDir, ".env"), "SECRET_KEY=hunter2\n", "utf-8");
    const result = computePermissionDiff(
      "write_file",
      { file_path: ".env", content: "rewritten\n" },
      tempDir,
    );
    expect(result).toBeNull();
  });

  test("new file outside cwd: still returns diff (no existing content to leak)", () => {
    // When the target does NOT exist, there is nothing to disclose — only the
    // model-supplied content is rendered, which is safe to show.
    const outside = join(tmpdir(), `hawky-outside-new-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(outside, { recursive: true });
    try {
      const nonexistent = join(outside, "new-file.ts");
      const result = computePermissionDiff(
        "write_file",
        { file_path: nonexistent, content: "hello\n" },
        tempDir,
      );
      expect(result).not.toBeNull();
      const lines = result!.hunks.flatMap((h) => h.lines);
      expect(lines.some((l) => l.startsWith("+") && l.includes("hello"))).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("computePermissionDiff — other tools", () => {
  test("returns null for bash", () => {
    const result = computePermissionDiff("bash", { command: "echo hi" }, tempDir);
    expect(result).toBeNull();
  });

  test("returns null for unknown tool", () => {
    const result = computePermissionDiff("unknown_tool", { foo: "bar" }, tempDir);
    expect(result).toBeNull();
  });
});
