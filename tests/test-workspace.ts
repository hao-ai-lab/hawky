// =============================================================================
// Workspace Manager Tests
//
// Tests for PA workspace: template initialization, file CRUD, daily logs,
// bootstrap file loading with truncation, idempotency.
// All tests use temp directories (never touch real ~/.hawky/).
// =============================================================================

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  WorkspaceManager,
  WORKSPACE_FILES,
  EXTRA_TEMPLATE_FILES,
  formatDate,
  truncateBootstrapContent,
  type BootstrapFile,
} from "../src/storage/workspace.js";

// =============================================================================
// Helpers
// =============================================================================

let tempDir: string;

function makeTempDir(): string {
  const dir = join(tmpdir(), `hawky-test-workspace-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

beforeEach(() => {
  tempDir = makeTempDir();
});

afterEach(() => {
  if (existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// =============================================================================
// init()
// =============================================================================

describe("WorkspaceManager.init()", () => {
  test("creates workspace directory if not exists", () => {
    const wsDir = join(tempDir, "workspace");
    const ws = new WorkspaceManager(wsDir);
    ws.init();
    expect(existsSync(wsDir)).toBe(true);
  });

  test("creates memory/ subdirectory", () => {
    const wsDir = join(tempDir, "workspace");
    const ws = new WorkspaceManager(wsDir);
    ws.init();
    expect(existsSync(join(wsDir, "memory"))).toBe(true);
  });

  test("copies all template files (bootstrap + extra)", () => {
    const wsDir = join(tempDir, "workspace");
    const ws = new WorkspaceManager(wsDir);
    const created = ws.init();

    const allTemplates = [...WORKSPACE_FILES, ...EXTRA_TEMPLATE_FILES];
    expect(created.length).toBe(allTemplates.length);
    for (const filename of allTemplates) {
      expect(existsSync(join(wsDir, filename))).toBe(true);
    }
  });

  test("template files have non-empty content", () => {
    const wsDir = join(tempDir, "workspace");
    const ws = new WorkspaceManager(wsDir);
    ws.init();

    for (const filename of WORKSPACE_FILES) {
      const content = readFileSync(join(wsDir, filename), "utf-8");
      expect(content.length).toBeGreaterThan(0);
    }
  });

  test("idempotent: re-running doesn't overwrite existing files", () => {
    const wsDir = join(tempDir, "workspace");
    const ws = new WorkspaceManager(wsDir);
    ws.init();

    // Modify SOUL.md
    const soulPath = join(wsDir, "SOUL.md");
    writeFileSync(soulPath, "My custom soul", "utf-8");

    // Re-init
    const created = ws.init();
    expect(created.length).toBe(0); // Nothing new created

    // SOUL.md should still have custom content
    expect(readFileSync(soulPath, "utf-8")).toBe("My custom soul");
  });

  test("idempotent: creates missing files in partial workspace (except BOOTSTRAP)", () => {
    const wsDir = join(tempDir, "workspace");
    mkdirSync(wsDir, { recursive: true });

    // Only create SOUL.md manually — workspace dir already exists (not first init)
    writeFileSync(join(wsDir, "SOUL.md"), "existing", "utf-8");

    const ws = new WorkspaceManager(wsDir);
    const created = ws.init();

    // Should create all files except SOUL.md (exists) and BOOTSTRAP.md (not first init)
    // Includes extra templates (SETUP.md)
    expect(created.length).toBe(WORKSPACE_FILES.length - 2 + EXTRA_TEMPLATE_FILES.length);
    expect(created).not.toContain("SOUL.md");
    expect(created).not.toContain("BOOTSTRAP.md");
    expect(created).toContain("USER.md");
    expect(created).toContain("AGENTS.md");
  });

  test("returns list of created files", () => {
    const wsDir = join(tempDir, "workspace");
    const ws = new WorkspaceManager(wsDir);
    const created = ws.init();

    expect(created).toContain("SOUL.md");
    expect(created).toContain("USER.md");
    expect(created).toContain("IDENTITY.md");
    expect(created).toContain("AGENTS.md");
    expect(created).toContain("MEMORY.md");
    expect(created).toContain("TOOLS.md");
    expect(created).toContain("HEARTBEAT.md");
    expect(created).toContain("BOOTSTRAP.md");
  });
});

// =============================================================================
// readFile()
// =============================================================================

describe("WorkspaceManager.readFile()", () => {
  test("reads existing workspace file", () => {
    const wsDir = join(tempDir, "workspace");
    const ws = new WorkspaceManager(wsDir);
    ws.init();

    const content = ws.readFile("SOUL.md");
    expect(content).not.toBeNull();
    expect(content!).toContain("SOUL.md");
  });

  test("returns null for non-existent file", () => {
    const wsDir = join(tempDir, "workspace");
    const ws = new WorkspaceManager(wsDir);
    ws.init();

    expect(ws.readFile("NONEXISTENT.md")).toBeNull();
  });

  test("reads daily log by relative path", () => {
    const wsDir = join(tempDir, "workspace");
    const ws = new WorkspaceManager(wsDir);
    ws.init();

    // Create a daily log
    writeFileSync(join(wsDir, "memory", "2026-03-14.md"), "# 2026-03-14\nStuff happened", "utf-8");

    const content = ws.readFile("memory/2026-03-14.md");
    expect(content).not.toBeNull();
    expect(content!).toContain("Stuff happened");
  });

  test("handles empty files", () => {
    const wsDir = join(tempDir, "workspace");
    const ws = new WorkspaceManager(wsDir);
    ws.init();

    writeFileSync(join(wsDir, "empty.md"), "", "utf-8");
    const content = ws.readFile("empty.md");
    expect(content).toBe("");
  });
});

// =============================================================================
// writeFile()
// =============================================================================

describe("WorkspaceManager.writeFile()", () => {
  test("writes to existing file (overwrites)", () => {
    const wsDir = join(tempDir, "workspace");
    const ws = new WorkspaceManager(wsDir);
    ws.init();

    ws.writeFile("SOUL.md", "New soul content");
    expect(ws.readFile("SOUL.md")).toBe("New soul content");
  });

  test("creates parent directories if needed", () => {
    const wsDir = join(tempDir, "workspace");
    const ws = new WorkspaceManager(wsDir);
    ws.init();

    ws.writeFile("memory/notes/project-x.md", "Project X notes");
    expect(ws.readFile("memory/notes/project-x.md")).toBe("Project X notes");
  });

  test("writes daily log with correct path", () => {
    const wsDir = join(tempDir, "workspace");
    const ws = new WorkspaceManager(wsDir);
    ws.init();

    ws.writeFile("memory/2026-03-14.md", "# 2026-03-14\nToday's log");
    expect(existsSync(join(wsDir, "memory", "2026-03-14.md"))).toBe(true);
  });
});

// =============================================================================
// Path containment
// =============================================================================

describe("WorkspaceManager path containment", () => {
  test("readFile rejects traversal outside the workspace", () => {
    const wsDir = join(tempDir, "workspace");
    const outside = join(tempDir, "outside.md");
    writeFileSync(outside, "outside", "utf-8");

    const ws = new WorkspaceManager(wsDir);
    ws.init();

    expect(() => ws.readFile("../outside.md")).toThrow("escapes workspace");
  });

  test("writeFile rejects traversal outside the workspace", () => {
    const wsDir = join(tempDir, "workspace");
    const outside = join(tempDir, "outside.md");

    const ws = new WorkspaceManager(wsDir);
    ws.init();

    expect(() => ws.writeFile("../outside.md", "hacked")).toThrow("escapes workspace");
    expect(existsSync(outside)).toBe(false);
  });

  test("absolute paths are rejected", () => {
    const wsDir = join(tempDir, "workspace");
    const outside = join(tempDir, "outside.md");

    const ws = new WorkspaceManager(wsDir);
    ws.init();

    expect(() => ws.writeFile(outside, "hacked")).toThrow("escapes workspace");
    expect(existsSync(outside)).toBe(false);
  });

  test("exists and deleteFile reject traversal outside the workspace", () => {
    const wsDir = join(tempDir, "workspace");
    const outside = join(tempDir, "outside.md");
    writeFileSync(outside, "outside", "utf-8");

    const ws = new WorkspaceManager(wsDir);
    ws.init();

    expect(() => ws.exists("../outside.md")).toThrow("escapes workspace");
    expect(() => ws.deleteFile("../outside.md")).toThrow("escapes workspace");
    expect(readFileSync(outside, "utf-8")).toBe("outside");
  });

  test("readFile rejects a symlink that points outside the workspace", () => {
    const wsDir = join(tempDir, "workspace");
    const outside = join(tempDir, "outside.md");
    writeFileSync(outside, "outside", "utf-8");

    const ws = new WorkspaceManager(wsDir);
    ws.init();
    symlinkSync(outside, join(wsDir, "linked.md"));

    expect(() => ws.readFile("linked.md")).toThrow("escapes workspace");
  });

  test("writeFile rejects parent symlinks that point outside the workspace", () => {
    const wsDir = join(tempDir, "workspace");
    const outsideDir = join(tempDir, "outside-dir");
    mkdirSync(outsideDir, { recursive: true });

    const ws = new WorkspaceManager(wsDir);
    ws.init();
    symlinkSync(outsideDir, join(wsDir, "linked-dir"), "dir");

    expect(() => ws.writeFile("linked-dir/evil.md", "hacked")).toThrow("escapes workspace");
    expect(existsSync(join(outsideDir, "evil.md"))).toBe(false);
  });
});

// =============================================================================
// appendToDaily()
// =============================================================================

describe("WorkspaceManager.appendToDaily()", () => {
  test("creates daily log file if not exists", () => {
    const wsDir = join(tempDir, "workspace");
    const ws = new WorkspaceManager(wsDir);
    ws.init();

    const date = new Date(2026, 2, 14, 10, 30); // March 14, 2026, 10:30
    ws.appendToDaily("Met with John about project X", date);

    const content = ws.readFile("memory/2026-03-14.md");
    expect(content).not.toBeNull();
    expect(content!).toContain("# 2026-03-14");
    expect(content!).toContain("[10:30] Met with John about project X");
  });

  test("appends to existing daily log", () => {
    const wsDir = join(tempDir, "workspace");
    const ws = new WorkspaceManager(wsDir);
    ws.init();

    const date1 = new Date(2026, 2, 14, 9, 0);
    const date2 = new Date(2026, 2, 14, 14, 30);

    ws.appendToDaily("Morning standup", date1);
    ws.appendToDaily("Afternoon review", date2);

    const content = ws.readFile("memory/2026-03-14.md");
    expect(content!).toContain("[09:00] Morning standup");
    expect(content!).toContain("[14:30] Afternoon review");
  });

  test("uses current date when no date provided", () => {
    const wsDir = join(tempDir, "workspace");
    const ws = new WorkspaceManager(wsDir);
    ws.init();

    ws.appendToDaily("Test entry");

    const today = formatDate(new Date());
    expect(ws.exists(`memory/${today}.md`)).toBe(true);
  });

  test("creates memory/ directory if not exists", () => {
    const wsDir = join(tempDir, "workspace");
    mkdirSync(wsDir, { recursive: true });
    // Don't call init — no memory/ dir yet

    const ws = new WorkspaceManager(wsDir);
    const date = new Date(2026, 2, 14, 10, 0);
    ws.appendToDaily("Entry without init", date);

    expect(existsSync(join(wsDir, "memory", "2026-03-14.md"))).toBe(true);
  });
});

// =============================================================================
// exists()
// =============================================================================

describe("WorkspaceManager.exists()", () => {
  test("returns true for existing file", () => {
    const wsDir = join(tempDir, "workspace");
    const ws = new WorkspaceManager(wsDir);
    ws.init();

    expect(ws.exists("SOUL.md")).toBe(true);
  });

  test("returns false for missing file", () => {
    const wsDir = join(tempDir, "workspace");
    const ws = new WorkspaceManager(wsDir);
    ws.init();

    expect(ws.exists("NONEXISTENT.md")).toBe(false);
  });

  test("checks relative paths", () => {
    const wsDir = join(tempDir, "workspace");
    const ws = new WorkspaceManager(wsDir);
    ws.init();

    expect(ws.exists("memory")).toBe(true); // directory
    expect(ws.exists("memory/2026-03-14.md")).toBe(false); // no log yet
  });
});

// =============================================================================
// deleteFile()
// =============================================================================

describe("WorkspaceManager.deleteFile()", () => {
  test("deletes existing file", () => {
    const wsDir = join(tempDir, "workspace");
    const ws = new WorkspaceManager(wsDir);
    ws.init();

    expect(ws.exists("BOOTSTRAP.md")).toBe(true);
    const deleted = ws.deleteFile("BOOTSTRAP.md");
    expect(deleted).toBe(true);
    expect(ws.exists("BOOTSTRAP.md")).toBe(false);
  });

  test("returns false for non-existent file", () => {
    const wsDir = join(tempDir, "workspace");
    const ws = new WorkspaceManager(wsDir);
    ws.init();

    expect(ws.deleteFile("NONEXISTENT.md")).toBe(false);
  });
});

// =============================================================================
// listDailyLogs()
// =============================================================================

describe("WorkspaceManager.listDailyLogs()", () => {
  test("returns empty array when no logs exist", () => {
    const wsDir = join(tempDir, "workspace");
    const ws = new WorkspaceManager(wsDir);
    ws.init();

    expect(ws.listDailyLogs()).toEqual([]);
  });

  test("returns sorted list of daily log filenames", () => {
    const wsDir = join(tempDir, "workspace");
    const ws = new WorkspaceManager(wsDir);
    ws.init();

    // Create logs out of order
    ws.writeFile("memory/2026-03-12.md", "day 1");
    ws.writeFile("memory/2026-03-14.md", "day 3");
    ws.writeFile("memory/2026-03-13.md", "day 2");

    const logs = ws.listDailyLogs();
    expect(logs).toEqual(["2026-03-12.md", "2026-03-13.md", "2026-03-14.md"]);
  });

  test("ignores non-date files in memory/", () => {
    const wsDir = join(tempDir, "workspace");
    const ws = new WorkspaceManager(wsDir);
    ws.init();

    ws.writeFile("memory/2026-03-14.md", "daily log");
    ws.writeFile("memory/notes.md", "not a daily log");
    ws.writeFile("memory/README.md", "also not");

    const logs = ws.listDailyLogs();
    expect(logs).toEqual(["2026-03-14.md"]);
  });

  test("returns empty when memory/ doesn't exist", () => {
    const wsDir = join(tempDir, "workspace");
    mkdirSync(wsDir, { recursive: true });
    // No memory/ dir

    const ws = new WorkspaceManager(wsDir);
    expect(ws.listDailyLogs()).toEqual([]);
  });
});

// =============================================================================
// getWorkspacePath()
// =============================================================================

describe("WorkspaceManager.getWorkspacePath()", () => {
  test("returns the configured workspace directory", () => {
    const wsDir = join(tempDir, "my-workspace");
    const ws = new WorkspaceManager(wsDir);
    expect(ws.getWorkspacePath()).toBe(wsDir);
  });
});

// =============================================================================
// loadBootstrapFiles()
// =============================================================================

describe("WorkspaceManager.loadBootstrapFiles()", () => {
  test("loads all workspace files in order", () => {
    const wsDir = join(tempDir, "workspace");
    const ws = new WorkspaceManager(wsDir);
    ws.init();

    const files = ws.loadBootstrapFiles();
    expect(files.length).toBe(WORKSPACE_FILES.length);
    // Verify order matches WORKSPACE_FILES
    for (let i = 0; i < WORKSPACE_FILES.length; i++) {
      expect(files[i].filename).toBe(WORKSPACE_FILES[i]);
    }
  });

  test("skips files that don't exist", () => {
    const wsDir = join(tempDir, "workspace");
    const ws = new WorkspaceManager(wsDir);
    ws.init();

    // Delete BOOTSTRAP.md
    ws.deleteFile("BOOTSTRAP.md");

    const files = ws.loadBootstrapFiles();
    expect(files.length).toBe(WORKSPACE_FILES.length - 1);
    expect(files.map((f) => f.filename)).not.toContain("BOOTSTRAP.md");
  });

  test("excludes MEMORY.md when mainSession is false", () => {
    const wsDir = join(tempDir, "workspace");
    const ws = new WorkspaceManager(wsDir);
    ws.init();

    const files = ws.loadBootstrapFiles({ mainSession: false });
    expect(files.map((f) => f.filename)).not.toContain("MEMORY.md");
  });

  test("includes MEMORY.md when mainSession is true (default)", () => {
    const wsDir = join(tempDir, "workspace");
    const ws = new WorkspaceManager(wsDir);
    ws.init();

    const files = ws.loadBootstrapFiles();
    expect(files.map((f) => f.filename)).toContain("MEMORY.md");
  });

  test("truncates large files", () => {
    const wsDir = join(tempDir, "workspace");
    const ws = new WorkspaceManager(wsDir);
    ws.init();

    // Write a large MEMORY.md
    const largeContent = "x".repeat(50_000);
    ws.writeFile("MEMORY.md", largeContent);

    const files = ws.loadBootstrapFiles({ maxCharsPerFile: 1000 });
    const memory = files.find((f) => f.filename === "MEMORY.md")!;
    expect(memory.truncated).toBe(true);
    expect(memory.content.length).toBeLessThan(50_000);
    expect(memory.content).toContain("[...truncated MEMORY.md");
  });

  test("respects total character budget", () => {
    const wsDir = join(tempDir, "workspace");
    const ws = new WorkspaceManager(wsDir);
    ws.init();

    // Make all files large
    for (const filename of WORKSPACE_FILES) {
      ws.writeFile(filename, "x".repeat(5000));
    }

    // Set a very small total budget — should load only some files
    const files = ws.loadBootstrapFiles({ maxCharsTotal: 10_000 });
    expect(files.length).toBeLessThan(8);

    const totalChars = files.reduce((sum, f) => sum + f.content.length, 0);
    expect(totalChars).toBeLessThanOrEqual(10_000);
  });

  test("skips empty files", () => {
    const wsDir = join(tempDir, "workspace");
    const ws = new WorkspaceManager(wsDir);
    ws.init();

    // Write empty content to TOOLS.md
    ws.writeFile("TOOLS.md", "   \n  \n  ");

    const files = ws.loadBootstrapFiles();
    expect(files.map((f) => f.filename)).not.toContain("TOOLS.md");
  });
});

// =============================================================================
// Template content validation
// =============================================================================

describe("Template content", () => {
  test("SOUL.md contains personality guidance", () => {
    const wsDir = join(tempDir, "workspace");
    const ws = new WorkspaceManager(wsDir);
    ws.init();

    const content = ws.readFile("SOUL.md")!;
    expect(content).toContain("genuinely helpful");
    expect(content).toContain("Have opinions");
    expect(content).toContain("Boundaries");
  });

  test("USER.md contains profile fields", () => {
    const wsDir = join(tempDir, "workspace");
    const ws = new WorkspaceManager(wsDir);
    ws.init();

    const content = ws.readFile("USER.md")!;
    expect(content).toContain("Name:");
    expect(content).toContain("Timezone:");
    expect(content).toContain("Context");
  });

  test("IDENTITY.md contains identity fields", () => {
    const wsDir = join(tempDir, "workspace");
    const ws = new WorkspaceManager(wsDir);
    ws.init();

    const content = ws.readFile("IDENTITY.md")!;
    expect(content).toContain("Name:");
    expect(content).toContain("Creature:");
    expect(content).toContain("Vibe:");
    expect(content).toContain("Emoji:");
  });

  test("AGENTS.md contains session startup instructions", () => {
    const wsDir = join(tempDir, "workspace");
    const ws = new WorkspaceManager(wsDir);
    ws.init();

    const content = ws.readFile("AGENTS.md")!;
    expect(content).toContain("Session Startup");
    expect(content).toContain("SOUL.md");
    expect(content).toContain("memory/YYYY-MM-DD.md");
    expect(content).toContain("Red Lines");
    expect(content).toContain("Heartbeats");
  });

  test("MEMORY.md is a minimal template", () => {
    const wsDir = join(tempDir, "workspace");
    const ws = new WorkspaceManager(wsDir);
    ws.init();

    const content = ws.readFile("MEMORY.md")!;
    expect(content).toContain("Long-Term Memory");
    // Should be short — just a header and instructions
    expect(content.length).toBeLessThan(500);
  });

  test("HEARTBEAT.md has template structure with no actionable tasks", () => {
    const wsDir = join(tempDir, "workspace");
    const ws = new WorkspaceManager(wsDir);
    ws.init();

    const content = ws.readFile("HEARTBEAT.md")!;
    expect(content).toContain("Heartbeat Tasks");
    expect(content).toContain("Active Tasks");
    // Template should have no uncommented task items (all examples are HTML comments)
    const { isHeartbeatContentEffectivelyEmpty } = require("../src/gateway/heartbeat-prompt.js");
    expect(isHeartbeatContentEffectivelyEmpty(content)).toBe(true);
  });

  test("BOOTSTRAP.md contains onboarding instructions", () => {
    const wsDir = join(tempDir, "workspace");
    const ws = new WorkspaceManager(wsDir);
    ws.init();

    const content = ws.readFile("BOOTSTRAP.md")!;
    expect(content).toContain("Hello, World");
    expect(content).toContain("Who am I");
    expect(content).toContain("IDENTITY.md");
    expect(content).toContain("Delete this file");
  });

  test("TOOLS.md contains environment notes guidance", () => {
    const wsDir = join(tempDir, "workspace");
    const ws = new WorkspaceManager(wsDir);
    ws.init();

    const content = ws.readFile("TOOLS.md")!;
    expect(content).toContain("Local Notes");
    expect(content).toContain("SSH");
  });
});

// =============================================================================
// Truncation logic
// =============================================================================

describe("truncateBootstrapContent()", () => {
  test("returns content unchanged when under limit", () => {
    const result = truncateBootstrapContent("short content", "test.md", 1000);
    expect(result.content).toBe("short content");
    expect(result.wasTruncated).toBe(false);
  });

  test("truncates with 70% head + 20% tail", () => {
    const content = "A".repeat(100);
    const result = truncateBootstrapContent(content, "test.md", 50);

    expect(result.wasTruncated).toBe(true);
    expect(result.content).toContain("[...truncated test.md");
    // Head should be ~35 chars (70% of 50)
    expect(result.content.startsWith("A".repeat(35))).toBe(true);
    // Tail should be ~10 chars (20% of 50)
    expect(result.content.endsWith("A".repeat(10))).toBe(true);
  });

  test("includes original size in truncation marker", () => {
    const content = "B".repeat(200);
    const result = truncateBootstrapContent(content, "BIG.md", 100);

    expect(result.content).toContain("200");
    expect(result.content).toContain("BIG.md");
  });

  test("trims trailing whitespace before checking", () => {
    const content = "short" + " ".repeat(100);
    const result = truncateBootstrapContent(content, "test.md", 1000);
    expect(result.wasTruncated).toBe(false);
    expect(result.content).toBe("short");
  });
});

// =============================================================================
// formatDate()
// =============================================================================

describe("formatDate()", () => {
  test("formats date as YYYY-MM-DD", () => {
    expect(formatDate(new Date(2026, 2, 14))).toBe("2026-03-14");
    expect(formatDate(new Date(2026, 0, 1))).toBe("2026-01-01");
    expect(formatDate(new Date(2026, 11, 31))).toBe("2026-12-31");
  });

  test("pads single-digit months and days", () => {
    expect(formatDate(new Date(2026, 0, 5))).toBe("2026-01-05");
    expect(formatDate(new Date(2026, 8, 9))).toBe("2026-09-09");
  });
});
