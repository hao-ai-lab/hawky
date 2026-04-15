// =============================================================================
// Tests for /doctor health check (src/commands/doctor.ts)
// =============================================================================

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  runDoctorChecks,
  runDoctorChecksAsync,
  formatDoctorReport,
} from "../src/commands/doctor.js";
import { setWorkspaceDir } from "../src/storage/workspace.js";
import { WorkspaceManager } from "../src/storage/workspace.js";
import { setConfigDir, resetConfigDir, resetConfig } from "../src/storage/config.js";
import {
  executeCommand,
  getCommands,
} from "../src/tui/commands.js";
import type { CommandContext } from "../src/tui/commands.js";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

let testDir: string;
let wsDir: string;

function makeContext(): CommandContext {
  return {
    model: "claude-sonnet-4-6",
    workingDirectory: testDir,
    sessionId: "test-session",
    tokenUsage: null,
    messageCount: 0,
    previousSessionKey: null,
    setPreviousSessionKey: () => {},
    exit: () => {},
    clearMessages: () => {},
    newSession: () => {},
    flushMemory: () => {},
    triggerCompaction: () => {},
    fetchMcpStatus: () => {},
    switchModel: () => {},
    resumeSession: () => {},
    showStatusPanel: () => {},
  };
}

beforeEach(() => {
  testDir = join(tmpdir(), `hawky-doctor-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  wsDir = join(testDir, "workspace");
  setWorkspaceDir(wsDir);
  const ws = new WorkspaceManager(wsDir);
  ws.init();
});

afterEach(() => {
  try { rmSync(testDir, { recursive: true, force: true }); } catch {}
});

// =============================================================================
// runDoctorChecks
// =============================================================================

describe("runDoctorChecks", () => {
  test("returns a report with multiple sections", () => {
    const report = runDoctorChecks();
    expect(report.sections.length).toBeGreaterThan(0);
    const titles = report.sections.map((s) => s.title);
    expect(titles).toContain("API Keys");
    expect(titles).toContain("Skills");
    expect(titles).toContain("Heartbeat");
    expect(titles).toContain("Cron");
    expect(titles).toContain("Memory");
    expect(titles).toContain("Workspace Files");
    expect(titles).toContain("Config");
  });

  test("each section has a title and lines", () => {
    const report = runDoctorChecks();
    for (const section of report.sections) {
      expect(typeof section.title).toBe("string");
      expect(Array.isArray(section.lines)).toBe(true);
      expect(section.lines.length).toBeGreaterThan(0);
    }
  });

  test("Skills section includes discovered skills", () => {
    const report = runDoctorChecks();
    const skills = report.sections.find((s) => s.title === "Skills")!;
    const text = skills.lines.join("\n");
    expect(text).toContain("commit");
  });

  test("Memory section reports MEMORY.md and daily logs", () => {
    const report = runDoctorChecks();
    const mem = report.sections.find((s) => s.title === "Memory")!;
    const text = mem.lines.join("\n");
    expect(text).toContain("MEMORY.md");
    expect(text).toContain("Daily logs");
  });

  test("Memory section counts daily log files", () => {
    const memDir = join(wsDir, "memory");
    writeFileSync(join(memDir, "2026-04-01.md"), "# Log 1", "utf-8");
    writeFileSync(join(memDir, "2026-04-02.md"), "# Log 2", "utf-8");

    const report = runDoctorChecks();
    const mem = report.sections.find((s) => s.title === "Memory")!;
    const text = mem.lines.join("\n");
    expect(text).toContain("2 files");
  });

  test("Workspace Files section checks template files", () => {
    const report = runDoctorChecks();
    const ws = report.sections.find((s) => s.title === "Workspace Files")!;
    const text = ws.lines.join("\n");
    expect(text).toContain("SOUL.md");
    expect(text).toContain("USER.md");
  });

  test("Config section shows config path", () => {
    const report = runDoctorChecks();
    const cfg = report.sections.find((s) => s.title === "Config")!;
    const text = cfg.lines.join("\n");
    expect(text).toContain("config.json");
  });

  test("accepts active model override", () => {
    const report = runDoctorChecks("claude-opus-4-6");
    const cfg = report.sections.find((s) => s.title === "Config")!;
    const text = cfg.lines.join("\n");
    expect(text).toContain("claude-opus-4-6");
  });
});

// =============================================================================
// API Keys section is provider-aware (Anthropic vs Vertex)
// =============================================================================

describe("runDoctorChecks API Keys section honors provider", () => {
  afterEach(() => {
    resetConfigDir();
    resetConfig();
  });

  function writeConfig(configObj: object): void {
    setConfigDir(testDir);
    resetConfig();
    mkdirSync(testDir, { recursive: true });
    writeFileSync(join(testDir, "config.json"), JSON.stringify(configObj, null, 2));
  }

  test("Anthropic provider flags missing API key as required", () => {
    writeConfig({
      provider: "anthropic",
      api_keys: { anthropic: "", brave_search: "", openai: "" },
      model: "claude-opus-4-7",
    });
    const report = runDoctorChecks();
    const api = report.sections.find((s) => s.title === "API Keys")!;
    const text = api.lines.join("\n");
    expect(text).toContain("Provider: Anthropic");
    expect(text).toContain("Anthropic");
    expect(text).toContain("missing (required)");
  });

  test("Vertex provider does NOT require Anthropic key", () => {
    writeConfig({
      provider: "vertex",
      vertex: { project_id: "hawky-prod", region: "global" },
      api_keys: { anthropic: "", brave_search: "", openai: "" },
      model: "claude-opus-4-7",
    });
    const report = runDoctorChecks();
    const api = report.sections.find((s) => s.title === "API Keys")!;
    const text = api.lines.join("\n");
    expect(text).toContain("Provider: Vertex AI");
    expect(text).toContain("hawky-prod");
    // Missing Anthropic key should NOT be flagged as required anymore.
    expect(text).not.toContain("Anthropic     missing (required)");
    expect(text).toContain("ADC auth");
  });

  test("Vertex provider flags missing project_id as required", () => {
    writeConfig({
      provider: "vertex",
      vertex: { project_id: "", region: "global" },
      api_keys: { anthropic: "", brave_search: "", openai: "" },
      model: "claude-opus-4-7",
    });
    const report = runDoctorChecks();
    const api = report.sections.find((s) => s.title === "API Keys")!;
    const text = api.lines.join("\n");
    expect(text).toContain("project_id missing");
    expect(text).toContain("deploy/VERTEX_SETUP.md");
  });

  test("OpenAI provider with openai_base_url shows Endpoint line", () => {
    writeConfig({
      provider: "openai",
      api_keys: { anthropic: "", brave_search: "", openai: "sk-test" },
      openai_base_url: "http://localhost:8000/v1",
      model: "meta-llama/Llama-3.1-8B-Instruct",
    });
    const report = runDoctorChecks();
    const api = report.sections.find((s) => s.title === "API Keys")!;
    const text = api.lines.join("\n");
    expect(text).toContain("Endpoint: http://localhost:8000/v1");
  });

  test("OpenAI provider without openai_base_url shows (api.openai.com)", () => {
    writeConfig({
      provider: "openai",
      api_keys: { anthropic: "", brave_search: "", openai: "sk-test" },
      model: "gpt-5.4-mini",
    });
    const report = runDoctorChecks();
    const api = report.sections.find((s) => s.title === "API Keys")!;
    const text = api.lines.join("\n");
    expect(text).toContain("Provider: OpenAI (api.openai.com)");
    expect(text).not.toContain("Endpoint:");
  });

  test("openai_compatible with two profiles shows active line and profile listing", () => {
    writeConfig({
      provider: "openai_compatible",
      api_keys: { anthropic: "", brave_search: "", openai: "" },
      openai_compatible: {
        active_profile: "groq",
        profiles: {
          groq: { base_url: "https://api.groq.com/openai/v1", api_key: "gsk-test" },
          vllm: { base_url: "http://localhost:8000/v1", api_key: "local-key" },
        },
      },
      model: "llama-3.1-70b",
    });
    const report = runDoctorChecks();
    const api = report.sections.find((s) => s.title === "API Keys")!;
    const text = api.lines.join("\n");
    expect(text).toContain("Provider: OpenAI-compatible");
    expect(text).toContain("Active profile: groq");
    expect(text).toContain("Endpoint: https://api.groq.com/openai/v1");
    expect(text).toContain("Key source: literal");
    expect(text).toContain("◦ vllm → http://localhost:8000/v1");
  });

  test("runDoctorChecksAsync augments API Keys with reachability for openai+base_url (success)", async () => {
    writeConfig({
      provider: "openai",
      api_keys: { anthropic: "", brave_search: "", openai: "sk-test" },
      openai_base_url: "http://localhost:8000/v1",
      model: "gpt-5.4-mini",
    });
    const savedFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ data: [{ id: "gpt-5.4-mini" }, { id: "gpt-5.4" }] }), { status: 200 }) as Response;
    try {
      const report = await runDoctorChecksAsync();
      const api = report.sections.find((s) => s.title === "API Keys")!;
      const text = api.lines.join("\n");
      expect(text).toContain("✓ /v1/models reachable");
      expect(text).toContain("2 models");
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  test("runDoctorChecksAsync augments API Keys with reachability for openai+base_url (404 soft warn)", async () => {
    writeConfig({
      provider: "openai",
      api_keys: { anthropic: "", brave_search: "", openai: "sk-test" },
      openai_base_url: "http://localhost:8000/v1",
      model: "gpt-5.4-mini",
    });
    const savedFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("Not Found", { status: 404 }) as Response;
    try {
      const report = await runDoctorChecksAsync();
      const api = report.sections.find((s) => s.title === "API Keys")!;
      const text = api.lines.join("\n");
      expect(text).toContain("⚠ /v1/models returned 404");
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  test("runDoctorChecksAsync skips reachability for openai without base_url (api.openai.com)", async () => {
    writeConfig({
      provider: "openai",
      api_keys: { anthropic: "", brave_search: "", openai: "sk-test" },
      model: "gpt-5.4-mini",
    });
    const report = await runDoctorChecksAsync();
    const api = report.sections.find((s) => s.title === "API Keys")!;
    const text = api.lines.join("\n");
    expect(text).not.toContain("/v1/models");
  });

  test("openai_compatible with unset active_profile shows UNSET", () => {
    writeConfig({
      provider: "openai_compatible",
      api_keys: { anthropic: "", brave_search: "", openai: "" },
      openai_compatible: { active_profile: "", profiles: {} },
      model: "some-model",
    });
    const report = runDoctorChecks();
    const api = report.sections.find((s) => s.title === "API Keys")!;
    const text = api.lines.join("\n");
    expect(text).toContain("Active profile: — UNSET —");
  });

});

// =============================================================================
// formatDoctorReport
// =============================================================================

describe("formatDoctorReport", () => {
  test("produces readable multi-line output", () => {
    const report = runDoctorChecks();
    const formatted = formatDoctorReport(report);
    expect(formatted).toContain("Health Check");
    expect(formatted).toContain("API Keys");
    expect(formatted).toContain("Skills");
    expect(formatted.split("\n").length).toBeGreaterThan(10);
  });
});

// =============================================================================
// /doctor command registration
// =============================================================================

describe("/doctor command", () => {
  test("is registered", () => {
    const commands = getCommands();
    const doctor = commands.find((c) => c.name === "doctor");
    expect(doctor).toBeDefined();
    expect(doctor!.description).toContain("health");
  });

  test("has /health alias", () => {
    const result = executeCommand("/health", makeContext());
    expect(result.handled).toBe(true);
    expect(result.text).toContain("Health Check");
  });

  test("returns formatted report as text", () => {
    const result = executeCommand("/doctor", makeContext());
    expect(result.handled).toBe(true);
    expect(result.text).toContain("Health Check");
    expect(result.text).toContain("API Keys");
    expect(result.text).toContain("Skills");
  });

  test("shows in /help output", () => {
    const result = executeCommand("/help", makeContext());
    expect(result.text).toContain("/doctor");
    expect(result.text).toContain("health");
  });
});

