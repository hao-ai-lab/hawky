import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, appendFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryIndex } from "../src/memory/index.js";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

let tempDir: string;

beforeEach(() => {
  tempDir = join(tmpdir(), `hawky-session-idx-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {}
});

function makeWorkspace(files: Record<string, string>): string {
  const wsDir = join(tempDir, "workspace");
  mkdirSync(join(wsDir, "memory"), { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    const absPath = join(wsDir, path);
    mkdirSync(join(absPath, ".."), { recursive: true });
    writeFileSync(absPath, content);
  }
  return wsDir;
}

function makeSessionsDir(): string {
  const sessDir = join(tempDir, "sessions");
  mkdirSync(sessDir, { recursive: true });
  return sessDir;
}

function writeSession(sessDir: string, relPath: string, entries: any[]): string {
  const absPath = join(sessDir, relPath);
  mkdirSync(join(absPath, ".."), { recursive: true });
  const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(absPath, content);
  return absPath;
}

function makeHeader(): any {
  return {
    type: "session",
    version: 1,
    id: "test-session",
    model: "claude-sonnet-4-6",
    working_directory: "/tmp/test",
    created_at: "2026-04-12T10:00:00Z",
  };
}

function makeMessage(role: "user" | "assistant", text: string): any {
  return {
    type: "message",
    timestamp: "2026-04-12T10:01:00Z",
    message: {
      role,
      content: [{ type: "text", text }],
    },
  };
}

function makeToolOnlyMessage(): any {
  return {
    type: "message",
    timestamp: "2026-04-12T10:02:00Z",
    message: {
      role: "assistant",
      content: [
        { type: "tool_use", id: "t1", name: "bash", input: { command: "ls" } },
      ],
    },
  };
}

function createIndex(wsDir: string, sessDir: string | null): MemoryIndex {
  return new MemoryIndex({
    dbPath: join(tempDir, "test.db"),
    workspacePath: wsDir,
    sessionsPath: sessDir,
    enableWatcher: false,
  });
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("session indexing", () => {
  test("session files within 30 days are discovered and indexed", async () => {
    const wsDir = makeWorkspace({ "MEMORY.md": "# Memory\n" });
    const sessDir = makeSessionsDir();
    writeSession(sessDir, "tui/main.jsonl", [
      makeHeader(),
      makeMessage("user", "What is TypeScript?"),
      makeMessage("assistant", "TypeScript is a typed superset of JavaScript."),
    ]);

    const index = createIndex(wsDir, sessDir);
    try {
      const stats = await index.sync();
      expect(stats.indexed).toBeGreaterThanOrEqual(2); // MEMORY.md + session
      const results = await index.search("TypeScript superset");
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.some((r) => r.path.startsWith("sessions/"))).toBe(true);
    } finally {
      index.close();
    }
  });

  test("session files older than 30 days are NOT indexed", async () => {
    const wsDir = makeWorkspace({ "MEMORY.md": "# Memory\n" });
    const sessDir = makeSessionsDir();
    const filePath = writeSession(sessDir, "old/stale.jsonl", [
      makeHeader(),
      makeMessage("user", "Ancient conversation"),
      makeMessage("assistant", "Very old reply"),
    ]);

    // Set mtime to 60 days ago
    const sixtyDaysAgo = new Date(Date.now() - 60 * 86_400_000);
    utimesSync(filePath, sixtyDaysAgo, sixtyDaysAgo);

    const index = createIndex(wsDir, sessDir);
    try {
      await index.sync();
      const results = await index.search("Ancient conversation");
      expect(results.length).toBe(0);
    } finally {
      index.close();
    }
  });

  test("indexed session chunks have source 'sessions'", async () => {
    const wsDir = makeWorkspace({ "MEMORY.md": "# Memory\nSome facts here\n" });
    const sessDir = makeSessionsDir();
    writeSession(sessDir, "web/general.jsonl", [
      makeHeader(),
      makeMessage("user", "Unique session content xyzzy"),
      makeMessage("assistant", "Reply about xyzzy topic"),
    ]);

    const index = createIndex(wsDir, sessDir);
    try {
      await index.sync();
      const results = await index.search("xyzzy");
      expect(results.length).toBeGreaterThanOrEqual(1);
      for (const r of results) {
        if (r.path.startsWith("sessions/")) {
          expect(r.source).toBe("sessions");
        }
      }
    } finally {
      index.close();
    }
  });

  test("search returns results from both memory and session files", async () => {
    const wsDir = makeWorkspace({
      "MEMORY.md": "# Memory\n",
      "memory/2026-04-12.md": "Discussed the frobnicator design decision today.\n",
    });
    const sessDir = makeSessionsDir();
    writeSession(sessDir, "tui/main.jsonl", [
      makeHeader(),
      makeMessage("user", "Tell me about the frobnicator"),
      makeMessage("assistant", "The frobnicator is the core component."),
    ]);

    const index = createIndex(wsDir, sessDir);
    try {
      await index.sync();
      const results = await index.search("frobnicator");
      const sources = new Set(results.map((r) => r.source));
      expect(sources.has("memory")).toBe(true);
      expect(sources.has("sessions")).toBe(true);
    } finally {
      index.close();
    }
  });

  test("unchanged session files are skipped on second sync", async () => {
    const wsDir = makeWorkspace({ "MEMORY.md": "# Memory\n" });
    const sessDir = makeSessionsDir();
    writeSession(sessDir, "tui/main.jsonl", [
      makeHeader(),
      makeMessage("user", "Hello"),
      makeMessage("assistant", "Hi"),
    ]);

    const index = createIndex(wsDir, sessDir);
    try {
      const first = await index.sync();
      index.markDirty();
      const second = await index.sync();
      // Session file was unchanged — should be skipped
      expect(second.indexed).toBe(0);
      expect(second.skipped).toBeGreaterThanOrEqual(1);
    } finally {
      index.close();
    }
  });

  test("modified session file triggers re-index", async () => {
    const wsDir = makeWorkspace({ "MEMORY.md": "# Memory\n" });
    const sessDir = makeSessionsDir();
    const filePath = writeSession(sessDir, "tui/main.jsonl", [
      makeHeader(),
      makeMessage("user", "First message"),
    ]);

    const index = createIndex(wsDir, sessDir);
    try {
      await index.sync();
      const first = await index.search("First message");
      expect(first.length).toBeGreaterThanOrEqual(1);

      // Append more messages (changes mtime + size)
      appendFileSync(filePath, JSON.stringify(makeMessage("user", "Brand new appended content")) + "\n");

      index.markDirty();
      const stats = await index.sync();
      expect(stats.indexed).toBeGreaterThanOrEqual(1);

      const second = await index.search("Brand new appended content");
      expect(second.length).toBeGreaterThanOrEqual(1);
    } finally {
      index.close();
    }
  });

  test("deleted session file is removed from index on next sync", async () => {
    const wsDir = makeWorkspace({ "MEMORY.md": "# Memory\n" });
    const sessDir = makeSessionsDir();
    const filePath = writeSession(sessDir, "tui/main.jsonl", [
      makeHeader(),
      makeMessage("user", "Ephemeral content for deletion test"),
      makeMessage("assistant", "This will be deleted"),
    ]);

    const index = createIndex(wsDir, sessDir);
    try {
      await index.sync();
      const before = await index.search("Ephemeral content deletion");
      expect(before.length).toBeGreaterThanOrEqual(1);

      // Delete the file
      rmSync(filePath);

      index.markDirty();
      const stats = await index.sync();
      expect(stats.removed).toBeGreaterThanOrEqual(1);

      const after = await index.search("Ephemeral content deletion");
      expect(after.length).toBe(0);
    } finally {
      index.close();
    }
  });

  test("tool-only session produces no chunks but is tracked in files table", async () => {
    const wsDir = makeWorkspace({ "MEMORY.md": "# Memory\n" });
    const sessDir = makeSessionsDir();
    writeSession(sessDir, "tui/tools.jsonl", [
      makeHeader(),
      makeToolOnlyMessage(),
    ]);

    const index = createIndex(wsDir, sessDir);
    try {
      const stats = await index.sync();
      // File should be tracked (indexed count includes it)
      expect(stats.indexed).toBeGreaterThanOrEqual(1);

      // But search shouldn't find anything from it
      const results = await index.search("bash ls");
      const sessionResults = results.filter((r) => r.path.includes("tools.jsonl"));
      expect(sessionResults.length).toBe(0);

      // Second sync should skip it (already tracked)
      index.markDirty();
      const second = await index.sync();
      expect(second.indexed).toBe(0);
    } finally {
      index.close();
    }
  });

  test("null sessionsPath disables session indexing", async () => {
    const wsDir = makeWorkspace({ "MEMORY.md": "# Memory\n" });
    const sessDir = makeSessionsDir();
    writeSession(sessDir, "tui/main.jsonl", [
      makeHeader(),
      makeMessage("user", "This should not be indexed"),
    ]);

    // Explicitly pass null for sessionsPath
    const index = new MemoryIndex({
      dbPath: join(tempDir, "test.db"),
      workspacePath: wsDir,
      sessionsPath: null,
      enableWatcher: false,
    });

    try {
      await index.sync();
      const results = await index.search("should not be indexed");
      expect(results.length).toBe(0);
    } finally {
      index.close();
    }
  });
});
