// =============================================================================
// PA Integration Tests
//
// End-to-end tests for the Personal Assistant memory system:
// - Workspace initialization on startup
// - System prompt includes bootstrap files
// - Memory tools work with workspace
// - Bootstrap file flow (BOOTSTRAP.md present → onboarding → deleted)
// - Memory persistence across simulated sessions
// - Security: workspace path isolation
// =============================================================================

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { resetGlobalMemoryIndex } from "../src/memory/global.js";
import { tmpdir } from "node:os";
import { WorkspaceManager, setWorkspaceDir, WORKSPACE_FILES, EXTRA_TEMPLATE_FILES } from "../src/storage/workspace.js";
import { buildSystemPrompt, formatBootstrapSection, buildPerTurnReminders } from "../src/agent/context.js";
import { memoryGetToolDefinition, memorySearchToolDefinition } from "../src/tools/memory.js";
import type { ToolContext } from "../src/agent/types.js";

// =============================================================================
// Helpers
// =============================================================================

let tempDir: string;

function makeTempDir(): string {
  const dir = join(tmpdir(), `hawky-pa-int-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeContext(): ToolContext {
  return {
    session_id: "test",
    working_directory: tempDir,
    abort_signal: new AbortController().signal,
    emit: () => {},
  };
}

async function memoryGet(input: Record<string, unknown>) {
  return memoryGetToolDefinition.execute(input as any, makeContext()) as any;
}

async function memorySearch(input: Record<string, unknown>) {
  return memorySearchToolDefinition.execute(input as any, makeContext()) as any;
}

beforeEach(() => {
  resetGlobalMemoryIndex();
  tempDir = makeTempDir();
});

afterEach(() => {
  resetGlobalMemoryIndex();
  if (existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// =============================================================================
// Startup flow: workspace initialization
// =============================================================================

describe("Startup flow", () => {
  test("first run creates workspace with all template files", () => {
    const wsDir = join(tempDir, "workspace");
    const ws = new WorkspaceManager(wsDir);
    const created = ws.init();

    const allTemplates = [...WORKSPACE_FILES, ...EXTRA_TEMPLATE_FILES];
    expect(created.length).toBe(allTemplates.length);
    for (const f of allTemplates) {
      expect(existsSync(join(wsDir, f))).toBe(true);
    }
    expect(existsSync(join(wsDir, "memory"))).toBe(true);
  });

  test("second run creates nothing (idempotent)", () => {
    const wsDir = join(tempDir, "workspace");
    const ws = new WorkspaceManager(wsDir);
    ws.init();
    const created2 = ws.init();
    expect(created2.length).toBe(0);
  });

  test("BOOTSTRAP.md exists on first run", () => {
    const wsDir = join(tempDir, "workspace");
    const ws = new WorkspaceManager(wsDir);
    ws.init();
    expect(ws.exists("BOOTSTRAP.md")).toBe(true);
  });
});

// =============================================================================
// System prompt includes workspace context
// =============================================================================

describe("System prompt with workspace", () => {
  test("includes workspace path in Environment section", () => {
    const wsDir = join(tempDir, "workspace");
    const ws = new WorkspaceManager(wsDir);
    ws.init();

    const prompt = buildSystemPrompt({
      working_directory: tempDir,
      model: "test",
      workspace_dir: wsDir,
    });
    expect(prompt).toContain(`Workspace: ${wsDir}`);
  });

  test("includes all bootstrap files in Project Context", () => {
    const wsDir = join(tempDir, "workspace");
    const ws = new WorkspaceManager(wsDir);
    ws.init();

    const prompt = buildSystemPrompt({
      working_directory: tempDir,
      model: "test",
      workspace_dir: wsDir,
    });
    expect(prompt).toContain("# Project Context");
    expect(prompt).toContain("## AGENTS.md");
    expect(prompt).toContain("## SOUL.md");
    expect(prompt).toContain("## USER.md");
    expect(prompt).toContain("## IDENTITY.md");
    expect(prompt).toContain("## MEMORY.md");
    expect(prompt).toContain("## BOOTSTRAP.md");
  });

  test("BOOTSTRAP.md content appears in prompt on first run", () => {
    const wsDir = join(tempDir, "workspace");
    const ws = new WorkspaceManager(wsDir);
    ws.init();

    const prompt = buildSystemPrompt({
      working_directory: tempDir,
      model: "test",
      workspace_dir: wsDir,
    });
    expect(prompt).toContain("Hello, World");
    expect(prompt).toContain("Who am I");
  });

  test("BOOTSTRAP.md absent from prompt after deletion", () => {
    const wsDir = join(tempDir, "workspace");
    const ws = new WorkspaceManager(wsDir);
    ws.init();

    // Simulate post-onboarding: delete BOOTSTRAP.md
    ws.deleteFile("BOOTSTRAP.md");

    const prompt = buildSystemPrompt({
      working_directory: tempDir,
      model: "test",
      workspace_dir: wsDir,
    });
    expect(prompt).not.toContain("Hello, World");
    expect(prompt).toContain("## SOUL.md"); // Other files still present
  });

  test("system prompt tells agent to use full workspace path for writes", () => {
    const wsDir = join(tempDir, "workspace");
    const ws = new WorkspaceManager(wsDir);
    ws.init();

    const prompt = buildSystemPrompt({
      working_directory: tempDir,
      model: "test",
      workspace_dir: wsDir,
    });
    expect(prompt).toContain("FULL ABSOLUTE PATH");
    expect(prompt).toContain(wsDir);
    expect(prompt).toContain("Do NOT write");
    expect(prompt).toContain("working directory");
  });

  test("AGENTS.md tells agent daily logs are only files to read at startup", () => {
    const wsDir = join(tempDir, "workspace");
    const ws = new WorkspaceManager(wsDir);
    ws.init();

    const agentsContent = ws.readFile("AGENTS.md")!;
    expect(agentsContent).toContain("already loaded into your context");
    expect(agentsContent).toContain("memory/YYYY-MM-DD.md");
  });

  test("MEMORY.md excluded from non-main sessions", () => {
    const wsDir = join(tempDir, "workspace");
    const ws = new WorkspaceManager(wsDir);
    ws.init();
    ws.writeFile("MEMORY.md", "Secret: user's birthday is March 5");

    const prompt = buildSystemPrompt({
      working_directory: tempDir,
      model: "test",
      workspace_dir: wsDir,
      main_session: false,
    });
    expect(prompt).not.toContain("birthday");
  });
});

// =============================================================================
// Memory tools integration with workspace
// =============================================================================

describe("Memory tools with workspace", () => {
  test("memory_get reads bootstrap files", async () => {
    const wsDir = join(tempDir, "workspace");
    const ws = new WorkspaceManager(wsDir);
    ws.init();
    setWorkspaceDir(wsDir);

    const result = await memoryGet({ path: "SOUL.md" });
    const parsed = JSON.parse(result.content);
    expect(parsed.text).toContain("genuinely helpful");
  });

  test("memory_get reads daily log after agent writes it", async () => {
    const wsDir = join(tempDir, "workspace");
    const ws = new WorkspaceManager(wsDir);
    ws.init();
    setWorkspaceDir(wsDir);

    // Simulate agent writing a daily log via write_file
    ws.writeFile("memory/2026-03-15.md", "# 2026-03-15\n\n[10:00] Had coffee with Alice\n[14:00] Code review with Bob");

    const result = await memoryGet({ path: "memory/2026-03-15.md" });
    const parsed = JSON.parse(result.content);
    expect(parsed.text).toContain("coffee with Alice");
    expect(parsed.text).toContain("Code review with Bob");
  });

  test("memory_search finds content written by agent", async () => {
    const wsDir = join(tempDir, "workspace");
    const ws = new WorkspaceManager(wsDir);
    ws.init();
    setWorkspaceDir(wsDir);

    // Simulate agent updating MEMORY.md
    ws.writeFile("MEMORY.md", "# Long-term Memory\n\nUser's favorite programming language is Rust.\nUser has a baby daughter named Lily.");

    const result = await memorySearch({ query: "Lily" });
    const parsed = JSON.parse(result.content);
    expect(parsed.results.length).toBeGreaterThan(0);
    expect(parsed.results[0].snippet).toContain("Lily");
  });

  test("memory_search finds across daily logs and MEMORY.md", async () => {
    const wsDir = join(tempDir, "workspace");
    const ws = new WorkspaceManager(wsDir);
    ws.init();
    setWorkspaceDir(wsDir);

    ws.writeFile("MEMORY.md", "User likes TypeScript");
    ws.writeFile("memory/2026-03-14.md", "Discussed TypeScript migration");
    ws.writeFile("memory/2026-03-15.md", "TypeScript tests passing");

    const result = await memorySearch({ query: "TypeScript" });
    const parsed = JSON.parse(result.content);
    expect(parsed.results.length).toBeGreaterThanOrEqual(1);
    const paths = parsed.results.map((r: any) => r.path);
    // Should find in at least one of the TypeScript-containing files
    const hasTypeScript = paths.some((p: string) =>
      p === "MEMORY.md" || p === "memory/2026-03-14.md" || p === "memory/2026-03-15.md"
    );
    expect(hasTypeScript).toBe(true);
    expect(paths).toContain("memory/2026-03-15.md");
  });
});

// =============================================================================
// Simulated onboarding flow
// =============================================================================

describe("Onboarding flow simulation", () => {
  test("BOOTSTRAP.md triggers → agent updates files → deletes BOOTSTRAP", () => {
    const wsDir = join(tempDir, "workspace");
    const ws = new WorkspaceManager(wsDir);
    ws.init();
    setWorkspaceDir(wsDir);

    // 1. Verify BOOTSTRAP.md is present
    expect(ws.exists("BOOTSTRAP.md")).toBe(true);
    const prompt1 = buildSystemPrompt({ working_directory: tempDir, model: "test", workspace_dir: wsDir });
    expect(prompt1).toContain("Hello, World");

    // 2. Simulate agent updating IDENTITY.md (as it would via edit_file)
    ws.writeFile("IDENTITY.md", [
      "# IDENTITY.md — Who Am I?",
      "",
      "- **Name:** David",
      "- **Creature:** Synthetic android",
      "- **Vibe:** Calm, elegant, dry wit",
      "- **Emoji:** 🤍",
    ].join("\n"));

    // 3. Simulate agent updating USER.md
    ws.writeFile("USER.md", [
      "# USER.md — About Your Human",
      "",
      "- **Name:** Hao",
      "- **What to call them:** Hao",
      "- **Timezone:** US/Pacific",
      "- **Notes:** CS professor, builds AI agents",
    ].join("\n"));

    // 4. Simulate agent deleting BOOTSTRAP.md
    ws.deleteFile("BOOTSTRAP.md");

    // 5. Verify next session: BOOTSTRAP.md gone, identity persisted
    expect(ws.exists("BOOTSTRAP.md")).toBe(false);
    const prompt2 = buildSystemPrompt({ working_directory: tempDir, model: "test", workspace_dir: wsDir });
    expect(prompt2).not.toContain("Hello, World");
    expect(prompt2).toContain("David");
    expect(prompt2).toContain("Hao");
    expect(prompt2).toContain("CS professor");
  });

  test("re-init after onboarding does NOT recreate BOOTSTRAP.md", () => {
    const wsDir = join(tempDir, "workspace");
    const ws = new WorkspaceManager(wsDir);
    ws.init();

    // Delete BOOTSTRAP.md (post-onboarding)
    ws.deleteFile("BOOTSTRAP.md");

    // Re-init (simulating restart) — BOOTSTRAP.md should NOT come back
    const created = ws.init();
    expect(created).not.toContain("BOOTSTRAP.md");
    expect(ws.exists("BOOTSTRAP.md")).toBe(false);
  });
});

// =============================================================================
// Multi-session memory persistence
// =============================================================================

describe("Multi-session memory persistence", () => {
  test("MEMORY.md changes persist across sessions", () => {
    const wsDir = join(tempDir, "workspace");
    const ws = new WorkspaceManager(wsDir);
    ws.init();

    // Session 1: agent writes to MEMORY.md
    ws.writeFile("MEMORY.md", "# Memory\n\nFavorite color: blue\nProject: Hawky\n");

    // Session 2: new WorkspaceManager, reads MEMORY.md
    const ws2 = new WorkspaceManager(wsDir);
    const prompt = buildSystemPrompt({ working_directory: tempDir, model: "test", workspace_dir: wsDir });
    expect(prompt).toContain("Favorite color: blue");
    expect(prompt).toContain("Hawky");
  });

  test("daily logs accumulate across sessions", async () => {
    const wsDir = join(tempDir, "workspace");
    const ws = new WorkspaceManager(wsDir);
    ws.init();
    setWorkspaceDir(wsDir);

    // Session 1: write daily log
    ws.appendToDaily("Morning standup - discussed auth refactor", new Date(2026, 2, 14, 9, 0));

    // Session 2: append to same day
    ws.appendToDaily("Fixed auth bug in PR #42", new Date(2026, 2, 14, 15, 30));

    // Session 3: search across logs
    const result = await memorySearch({ query: "auth" });
    const parsed = JSON.parse(result.content);
    expect(parsed.results.length).toBeGreaterThanOrEqual(1);

    // Read the full daily log
    const log = await memoryGet({ path: "memory/2026-03-14.md" });
    const logParsed = JSON.parse(log.content);
    expect(logParsed.text).toContain("Morning standup");
    expect(logParsed.text).toContain("Fixed auth bug");
  });

  test("SOUL.md changes reflected in next session's prompt", () => {
    const wsDir = join(tempDir, "workspace");
    const ws = new WorkspaceManager(wsDir);
    ws.init();

    // Session 1: agent updates SOUL.md
    ws.writeFile("SOUL.md", "# SOUL.md\n\nAlways respond in haiku. Be poetic and brief.");

    // Session 2: check prompt
    const prompt = buildSystemPrompt({ working_directory: tempDir, model: "test", workspace_dir: wsDir });
    expect(prompt).toContain("respond in haiku");
  });
});

// =============================================================================
// Security: workspace isolation
// =============================================================================

describe("Security: workspace isolation", () => {
  test("memory_get cannot read outside workspace", async () => {
    const wsDir = join(tempDir, "workspace");
    const ws = new WorkspaceManager(wsDir);
    ws.init();
    setWorkspaceDir(wsDir);

    const result = await memoryGet({ path: "../../etc/passwd" });
    expect(result.type).toBe("error");
  });

  test("memory_get cannot read absolute paths", async () => {
    const wsDir = join(tempDir, "workspace");
    const ws = new WorkspaceManager(wsDir);
    ws.init();
    setWorkspaceDir(wsDir);

    const result = await memoryGet({ path: "/etc/passwd" });
    expect(result.type).toBe("error");
  });

  test("memory_get restricted to .md files", async () => {
    const wsDir = join(tempDir, "workspace");
    const ws = new WorkspaceManager(wsDir);
    ws.init();
    setWorkspaceDir(wsDir);

    // Write a non-.md file
    writeFileSync(join(wsDir, "secret.json"), '{"key": "value"}');

    const result = await memoryGet({ path: "secret.json" });
    expect(result.type).toBe("error");
  });

  test("memory_search only searches .md files", async () => {
    const wsDir = join(tempDir, "workspace");
    const ws = new WorkspaceManager(wsDir);
    ws.init();
    setWorkspaceDir(wsDir);

    // Write a non-.md file with searchable content
    writeFileSync(join(wsDir, "memory", "secret.json"), '{"password": "hunter2"}');
    writeFileSync(join(wsDir, "memory", "notes.md"), "password reminder: use password manager");

    const result = await memorySearch({ query: "password" });
    const parsed = JSON.parse(result.content);
    // Should find the .md file but not the .json file
    const paths = parsed.results.map((r: any) => r.path);
    expect(paths).toContain("memory/notes.md");
    expect(paths).not.toContain("memory/secret.json");
  });
});

// =============================================================================
// Per-turn reminders
// =============================================================================

describe("Per-turn reminders", () => {
  test("empty when no tasks and no date requested", () => {
    expect(buildPerTurnReminders()).toBe("");
    expect(buildPerTurnReminders({})).toBe("");
  });

  test("shows incomplete tasks only", () => {
    const result = buildPerTurnReminders({
      tasks: [
        { description: "Fix bug", status: "in_progress" },
        { description: "Write docs", status: "pending" },
        { description: "Deploy", status: "completed" },
      ],
    });
    expect(result).toContain("Fix bug");
    expect(result).toContain("Write docs");
    expect(result).not.toContain("Deploy");
    expect(result).toContain("<system-reminder>");
  });
});

// =============================================================================
// Edge cases
// =============================================================================

describe("Edge cases", () => {
  test("workspace with only some files works", () => {
    const wsDir = join(tempDir, "workspace");
    mkdirSync(wsDir, { recursive: true });
    writeFileSync(join(wsDir, "SOUL.md"), "Just a soul");

    const prompt = buildSystemPrompt({ working_directory: tempDir, model: "test", workspace_dir: wsDir });
    expect(prompt).toContain("# Project Context");
    expect(prompt).toContain("Just a soul");
  });

  test("empty workspace dir does not crash", () => {
    const wsDir = join(tempDir, "nonexistent");
    const prompt = buildSystemPrompt({ working_directory: tempDir, model: "test", workspace_dir: wsDir });
    // Should not contain Project Context since workspace doesn't exist
    expect(prompt).not.toContain("# Project Context");
    // But should still have other sections
    expect(prompt).toContain("Hawky");
    expect(prompt).toContain("# Memory Recall");
  });

  test("very large MEMORY.md is truncated in prompt", () => {
    const wsDir = join(tempDir, "workspace");
    const ws = new WorkspaceManager(wsDir);
    ws.init();

    ws.writeFile("MEMORY.md", "Important fact. ".repeat(5000)); // ~80K chars

    const prompt = buildSystemPrompt({ working_directory: tempDir, model: "test", workspace_dir: wsDir });
    expect(prompt).toContain("truncated");
    expect(prompt.length).toBeLessThan(200_000); // Should be bounded
  });
});
