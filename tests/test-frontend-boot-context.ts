import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  FRONTEND_BOOT_CONTEXT_EXTENSION_MANIFEST,
  FRONTEND_MEMORY_DISTILL_TOOL,
  FRONTEND_BOOT_CONTEXT_TOOL,
  SEND_MESSAGE_BACKEND_TOOL,
  buildFrontendBootContext,
  getFrontendBootContextBackendTools,
  registerFrontendBootContextMethods,
  toOpenAIToolDefinition,
} from "../src/gateway/frontend-boot-context.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { getWorkspaceDir, setWorkspaceDir, WorkspaceManager } from "../src/storage/workspace.js";

function makeMockServer() {
  const methods: Record<string, Function> = {};
  return {
    registerMethod(name: string, handler: Function) {
      methods[name] = handler;
    },
    call(name: string, params?: unknown) {
      const method = methods[name];
      if (!method) throw new Error(`Method not found: ${name}`);
      return method(null, params, this);
    },
  };
}

let testDir: string;
let workspaceDir: string;
let originalWorkspaceDir: string;

beforeEach(() => {
  originalWorkspaceDir = getWorkspaceDir();
  testDir = join(tmpdir(), `hawky-boot-context-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  workspaceDir = join(testDir, "workspace");
  mkdirSync(join(workspaceDir, "memory"), { recursive: true });
  writeFileSync(join(workspaceDir, "USER.md"), "# User\n\nJunda prefers concise realtime help.\n");
  writeFileSync(join(workspaceDir, "IDENTITY.md"), "# Identity\n\nHawky is the backend agent.\n");
  writeFileSync(join(workspaceDir, "MEMORY.md"), "# Memory\n\nLive startup should use backend boot context.\n");
  writeFileSync(join(workspaceDir, "memory", "2026-06-05.md"), "# 2026-06-05\n\n[23:10] Focus on Live memory bridge.\n");
  setWorkspaceDir(workspaceDir);
});

afterEach(() => {
  setWorkspaceDir(originalWorkspaceDir);
  rmSync(testDir, { recursive: true, force: true });
});

describe("frontend.boot_context", () => {
  test("builds compact deterministic context from workspace memory", () => {
    const result = buildFrontendBootContext(
      {
        channel_id: "realtime:test",
        session_key: "realtime:test",
        participant_id: "ios-live",
        mode: "realtime",
        capabilities: ["audio", "image"],
        tools: [
          {
            type: "function",
            name: "session_send_message",
            description: "Send a structured request to the backend session.",
            parameters: {
              type: "object",
              properties: {
                message: { type: "string" },
              },
              required: ["message"],
              additionalProperties: false,
          },
          strict: true,
          x_tool_metadata: {
            category: "session_bridge",
            latency: "background",
            durability: "durable",
            risk: "medium",
            visibility: "model",
            whenToUse: ["durable backend work"],
          },
        },
      ],
      },
      {
        workspace: new WorkspaceManager(workspaceDir),
        now: new Date("2026-06-05T20:00:00.000Z"),
      },
    );

    expect(result.ok).toBe(true);
    expect(result.channel_id).toBe("realtime:test");
    expect(result.first_contact.active).toBe(false);
    expect(result.context).toContain("# Backend Boot Context");
    expect(result.context).toContain("Junda prefers concise realtime help");
    expect(result.context).toContain("Live startup should use backend boot context");
    expect(result.context).toContain("Focus on Live memory bridge");
    expect(result.context).toContain("## Toolbox");
    expect(result.context).toContain("session_send_message");
    expect(result.toolbox.version).toBe(1);
    expect(result.toolbox.frontend_tools[0].name).toBe("session_send_message");
    expect(result.toolbox.frontend_tools[0].x_tool_metadata.category).toBe("session_bridge");
    expect(result.toolbox.backend_tools[0].name).toBe("frontend_boot_context");
    expect(result.toolbox.backend_tools.map((tool) => tool.name)).toEqual([
      "frontend_boot_context",
      "send_message",
      "frontend_memory_distill",
    ]);
    expect(result.sources).toContain("MEMORY.md");
    expect(result.sources).toContain("memory/2026-06-05.md");
  });

  test("declares backend toolbox through the frontend boot-context extension manifest", () => {
    const tools = getFrontendBootContextBackendTools();

    expect(FRONTEND_BOOT_CONTEXT_EXTENSION_MANIFEST.surfaces).toContain("frontend.boot_context");
    expect(FRONTEND_BOOT_CONTEXT_EXTENSION_MANIFEST.frontendTools?.length).toBe(3);
    expect(tools.map((tool) => tool.name)).toEqual([
      "frontend_boot_context",
      "send_message",
      "frontend_memory_distill",
    ]);
    expect(tools).toEqual([
      FRONTEND_BOOT_CONTEXT_TOOL,
      SEND_MESSAGE_BACKEND_TOOL,
      FRONTEND_MEMORY_DISTILL_TOOL,
    ]);

    const registry = new ToolRegistry();
    registry.registerExtension(FRONTEND_BOOT_CONTEXT_EXTENSION_MANIFEST, []);
    expect(registry.getManifestProjection("frontend.boot_context").map((manifest) => manifest.id)).toEqual([
      FRONTEND_BOOT_CONTEXT_EXTENSION_MANIFEST.id,
    ]);
  });

  test("backend toolbox projection ignores wrong surfaces, roles, and malformed definitions", () => {
    const tools = getFrontendBootContextBackendTools({
      id: "test.frontend-toolbox",
      version: "0.1.0",
      displayName: "Test Frontend Toolbox",
      frontendTools: [
        {
          surface: "frontend.boot_context",
          role: "backend",
          definition: FRONTEND_BOOT_CONTEXT_TOOL,
        },
        {
          surface: "frontend.boot_context",
          role: "frontend",
          definition: FRONTEND_BOOT_CONTEXT_TOOL,
        },
        {
          surface: "agent",
          role: "backend",
          definition: FRONTEND_BOOT_CONTEXT_TOOL,
        },
        {
          surface: "frontend.boot_context",
          role: "backend",
          definition: { type: "function", name: "", description: "Invalid", parameters: {} },
        },
      ],
    });

    expect(tools.map((tool) => tool.name)).toEqual(["frontend_boot_context"]);
  });

  test("backend toolbox projection sanitizes malformed manifest metadata", () => {
    const tools = getFrontendBootContextBackendTools({
      id: "test.frontend-toolbox",
      version: "0.1.0",
      displayName: "Test Frontend Toolbox",
      frontendTools: [
        {
          surface: "frontend.boot_context",
          role: "backend",
          definition: {
            ...FRONTEND_BOOT_CONTEXT_TOOL,
            strict: "yes",
            x_tool_metadata: {
              category: "invalid",
              latency: "fast",
              durability: "session",
              risk: "low",
              visibility: "model",
            },
          },
        },
      ],
    });

    expect(tools.length).toBe(1);
    expect(tools[0].name).toBe("frontend_boot_context");
    expect(tools[0].strict).toBeUndefined();
    expect(tools[0].x_tool_metadata).toBeUndefined();
  });

  test("drops invalid tool metadata while keeping valid OpenAI tool schema", () => {
    const result = buildFrontendBootContext(
      {
        session_key: "realtime:tools",
        tools: [
          {
            type: "function",
            name: "device_info",
            description: "Return device info.",
            parameters: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
            x_tool_metadata: {
              category: "dangerous_invalid",
              latency: "instant",
              durability: "ephemeral",
              risk: "low",
              visibility: "model",
            },
          },
        ],
      },
      { workspace: new WorkspaceManager(workspaceDir) },
    );

    expect(result.toolbox.frontend_tools[0].name).toBe("device_info");
    expect(result.toolbox.frontend_tools[0].x_tool_metadata).toBeUndefined();
  });

  test("registers RPC method", () => {
    const server = makeMockServer();
    registerFrontendBootContextMethods(server as any);

    const result = server.call("frontend.boot_context", {
      session_key: "realtime:abc",
    }) as any;

    expect(result.ok).toBe(true);
    expect(result.session_key).toBe("realtime:abc");
    expect(result.first_contact.reason).toBe("initialized");
    expect(result.context).toContain("Backend session: realtime:abc");
  });

  test("marks first contact when BOOTSTRAP.md is present", () => {
    writeFileSync(
      join(workspaceDir, "BOOTSTRAP.md"),
      "# BOOTSTRAP.md\n\nYou just woke up. Time to figure out who you are.\n",
    );

    const result = buildFrontendBootContext(
      { session_key: "realtime:first-contact" },
      { workspace: new WorkspaceManager(workspaceDir) },
    );

    expect(result.first_contact).toEqual({
      active: true,
      reason: "bootstrap_present",
      marker_file: "BOOTSTRAP.md",
    });
    expect(result.sources).toContain("BOOTSTRAP.md");
    expect(result.context).toContain("## First Contact");
    expect(result.context).toContain("You just woke up");
  });

  test("returns untrimmed context by default and only truncates when requested", () => {
    const longFact = "ambient-agent memory contract ".repeat(120);
    writeFileSync(join(workspaceDir, "MEMORY.md"), `# Memory\n\n${longFact}\n`);
    writeFileSync(join(workspaceDir, "memory", "2026-06-06.md"), `# 2026-06-06\n\n${longFact}\n`);

    const full = buildFrontendBootContext(
      { session_key: "realtime:full" },
      { workspace: new WorkspaceManager(workspaceDir) },
    );
    expect(full.context).toContain(longFact.trim());
    expect(full.context).not.toContain("[... boot context truncated ...]");

    const capped = buildFrontendBootContext(
      { session_key: "realtime:capped", max_chars: 800 },
      { workspace: new WorkspaceManager(workspaceDir) },
    );
    expect(capped.context.length).toBeLessThanOrEqual(850);
    expect(capped.context).toContain("[... boot context truncated ...]");
  });

  test("exports OpenAI-compatible tool definition without internal extension metadata", () => {
    const openaiTool = toOpenAIToolDefinition(FRONTEND_BOOT_CONTEXT_TOOL) as any;

    expect(openaiTool.type).toBe("function");
    expect(openaiTool.name).toBe("frontend_boot_context");
    expect(openaiTool.parameters.type).toBe("object");
    expect(openaiTool.strict).toBe(true);
    expect(openaiTool.x_tool_metadata).toBeUndefined();
  });

  test("registers OpenAI-compatible tool metadata RPC", () => {
    const server = makeMockServer();
    registerFrontendBootContextMethods(server as any);

    const result = server.call("frontend.boot_context.tool") as any;

    expect(result.tool.name).toBe("frontend_boot_context");
    expect(result.tool.x_tool_metadata).toBeUndefined();
    expect(result.x_tool_metadata.category).toBe("session_bridge");
  });
});
