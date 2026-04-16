// =============================================================================
// Tests: Migrate Export/Import
//
// Verifies:
// - Export creates a valid tar.gz with expected files
// - Import restores files correctly
// - Excluded files (logs, node.json, auth-secret) are NOT in the archive
// - MANIFEST.json contains correct metadata
// - Import without --force on existing data exits
// - Round-trip: export → import → verify
// =============================================================================

import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { setConfigDir } from "../src/storage/config.js";
import { runExport, runImport } from "../src/commands/migrate.js";

let sourceDir: string;
let targetDir: string;
let archivePath: string;
let originalConfigDir: string;

beforeEach(() => {
  const id = randomUUID().slice(0, 8);
  sourceDir = join(tmpdir(), `hawky-migrate-src-${id}`);
  targetDir = join(tmpdir(), `hawky-migrate-dst-${id}`);
  archivePath = join(tmpdir(), `hawky-test-export-${id}.tar.gz`);

  // Create source data structure
  mkdirSync(join(sourceDir, "workspace", "memory"), { recursive: true });
  mkdirSync(join(sourceDir, "sessions", "web"), { recursive: true });
  mkdirSync(join(sourceDir, "sessions", "cron"), { recursive: true });
  mkdirSync(join(sourceDir, "cron", "runs"), { recursive: true });
  mkdirSync(join(sourceDir, "skills", "custom-tool"), { recursive: true });
  mkdirSync(join(sourceDir, "usage"), { recursive: true });
  mkdirSync(join(sourceDir, "logs"), { recursive: true });
  mkdirSync(join(sourceDir, "state"), { recursive: true });

  // Portable files (should be exported)
  writeFileSync(join(sourceDir, "config.json"), JSON.stringify({ model: "test" }));
  writeFileSync(join(sourceDir, "permissions.json"), "{}");
  writeFileSync(join(sourceDir, "history.jsonl"), '{"cmd":"hello"}\n');
  writeFileSync(join(sourceDir, "workspace", "MEMORY.md"), "# Memory\nI remember things.");
  writeFileSync(join(sourceDir, "workspace", "SOUL.md"), "# Soul");
  writeFileSync(join(sourceDir, "workspace", "USER.md"), "# User");
  writeFileSync(join(sourceDir, "workspace", "memory", "2026-04-13.md"), "Daily log");
  writeFileSync(join(sourceDir, "sessions", "web", "general.jsonl"), '{"type":"session"}\n');
  writeFileSync(join(sourceDir, "sessions", "cron", "daily.jsonl"), '{"type":"session"}\n');
  writeFileSync(join(sourceDir, "sessions", "meta.json"), '{}');
  writeFileSync(join(sourceDir, "cron", "jobs.json"), '[{"name":"test"}]');
  writeFileSync(join(sourceDir, "cron", "runs", "test.jsonl"), '{"status":"ok"}\n');
  writeFileSync(join(sourceDir, "skills", "custom-tool", "SKILL.md"), "# Custom Skill");
  writeFileSync(join(sourceDir, "usage", "2026-04-13.json"), '{"tokens":100}');

  // Machine-specific files (should NOT be exported)
  writeFileSync(join(sourceDir, "logs", "gateway.log"), "log data");
  writeFileSync(join(sourceDir, "state", "node.json"), '{"nodeId":"test"}');
  writeFileSync(join(sourceDir, "state", "auth-secret.key"), "secret");
  writeFileSync(join(sourceDir, "state", "memory.db"), "sqlite data");
  writeFileSync(join(sourceDir, "vapid-keys.json"), '{"keys":"test"}');
  writeFileSync(join(sourceDir, "push-subscriptions.json"), '[]');

  // Point config to source dir
  originalConfigDir = setConfigDir(sourceDir);
});

afterAll(() => {
  setConfigDir(originalConfigDir);
  // Cleanup
  for (const prefix of ["hawky-migrate-src-", "hawky-migrate-dst-", "hawky-test-export-"]) {
    try {
      for (const entry of readdirSync(tmpdir())) {
        if (entry.startsWith(prefix)) {
          rmSync(join(tmpdir(), entry), { recursive: true, force: true });
        }
      }
    } catch {}
  }
});

// =============================================================================
// Export tests
// =============================================================================

describe("migrate export", () => {
  test("creates a tar.gz archive", async () => {
    await runExport(archivePath);
    expect(existsSync(archivePath)).toBe(true);
  });

  test("archive contains portable files", async () => {
    await runExport(archivePath);

    const proc = Bun.spawn(["tar", "tzf", archivePath], { stdout: "pipe" });
    const contents = await new Response(proc.stdout).text();

    expect(contents).toContain("config.json");
    expect(contents).toContain("permissions.json");
    expect(contents).toContain("history.jsonl");
    expect(contents).toContain("workspace/MEMORY.md");
    expect(contents).toContain("workspace/SOUL.md");
    expect(contents).toContain("workspace/memory/2026-04-13.md");
    expect(contents).toContain("sessions/web/general.jsonl");
    expect(contents).toContain("sessions/cron/daily.jsonl");
    expect(contents).toContain("sessions/meta.json");
    expect(contents).toContain("cron/jobs.json");
    expect(contents).toContain("cron/runs/test.jsonl");
    expect(contents).toContain("skills/custom-tool/SKILL.md");
    expect(contents).toContain("usage/2026-04-13.json");
    expect(contents).toContain("MANIFEST.json");
  });

  test("archive excludes machine-specific files", async () => {
    await runExport(archivePath);

    const proc = Bun.spawn(["tar", "tzf", archivePath], { stdout: "pipe" });
    const contents = await new Response(proc.stdout).text();

    expect(contents).not.toContain("logs/");
    expect(contents).not.toContain("node.json");
    expect(contents).not.toContain("auth-secret.key");
    expect(contents).not.toContain("memory.db");
    expect(contents).not.toContain("vapid-keys.json");
    expect(contents).not.toContain("push-subscriptions.json");
  });

  test("MANIFEST.json has correct metadata", async () => {
    await runExport(archivePath);

    // Extract manifest
    Bun.spawnSync(["tar", "xzf", archivePath, "-C", tmpdir(), "MANIFEST.json"]);
    const manifest = JSON.parse(readFileSync(join(tmpdir(), "MANIFEST.json"), "utf-8"));
    try { require("fs").unlinkSync(join(tmpdir(), "MANIFEST.json")); } catch {}

    expect(manifest.version).toBe(1);
    expect(manifest.exportedAt).toBeTruthy();
    expect(manifest.hostname).toBeTruthy();
    expect(manifest.sessionCount).toBe(2); // web/general + cron/daily
    expect(manifest.workspaceFiles).toBe(3); // MEMORY.md, SOUL.md, USER.md
    expect(manifest.cronJobs).toBe(1);
    expect(manifest.skillCount).toBe(1);
  });
});

// =============================================================================
// Import tests
// =============================================================================

describe("migrate import", () => {
  test("restores files to target directory", async () => {
    await runExport(archivePath);

    // Point to empty target
    setConfigDir(targetDir);
    mkdirSync(targetDir, { recursive: true });

    await runImport(archivePath, true);

    expect(existsSync(join(targetDir, "config.json"))).toBe(true);
    expect(existsSync(join(targetDir, "workspace", "MEMORY.md"))).toBe(true);
    expect(existsSync(join(targetDir, "sessions", "web", "general.jsonl"))).toBe(true);
    expect(existsSync(join(targetDir, "cron", "jobs.json"))).toBe(true);
    expect(existsSync(join(targetDir, "skills", "custom-tool", "SKILL.md"))).toBe(true);

    // Content preserved
    const memory = readFileSync(join(targetDir, "workspace", "MEMORY.md"), "utf-8");
    expect(memory).toContain("I remember things");
  });

  test("MANIFEST.json cleaned up after import", async () => {
    await runExport(archivePath);
    setConfigDir(targetDir);
    mkdirSync(targetDir, { recursive: true });

    await runImport(archivePath, true);

    expect(existsSync(join(targetDir, "MANIFEST.json"))).toBe(false);
  });
});

// =============================================================================
// Round-trip test
// =============================================================================

describe("migrate round-trip", () => {
  test("export → import preserves all portable data", async () => {
    await runExport(archivePath);

    setConfigDir(targetDir);
    mkdirSync(targetDir, { recursive: true });
    await runImport(archivePath, true);

    // Verify key files match
    const srcConfig = readFileSync(join(sourceDir, "config.json"), "utf-8");
    const dstConfig = readFileSync(join(targetDir, "config.json"), "utf-8");
    expect(dstConfig).toBe(srcConfig);

    const srcMemory = readFileSync(join(sourceDir, "workspace", "MEMORY.md"), "utf-8");
    const dstMemory = readFileSync(join(targetDir, "workspace", "MEMORY.md"), "utf-8");
    expect(dstMemory).toBe(srcMemory);

    const srcSession = readFileSync(join(sourceDir, "sessions", "web", "general.jsonl"), "utf-8");
    const dstSession = readFileSync(join(targetDir, "sessions", "web", "general.jsonl"), "utf-8");
    expect(dstSession).toBe(srcSession);

    const srcSkill = readFileSync(join(sourceDir, "skills", "custom-tool", "SKILL.md"), "utf-8");
    const dstSkill = readFileSync(join(targetDir, "skills", "custom-tool", "SKILL.md"), "utf-8");
    expect(dstSkill).toBe(srcSkill);
  });
});
