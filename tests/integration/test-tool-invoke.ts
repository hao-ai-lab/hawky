// =============================================================================
// Integration Tests: tool.invoke RPC
//
// Exercises the gateway's standalone tool-invocation endpoint end-to-end at
// the method-handler level (no real WS, no real agent loop). Uses an isolated
// tmp workspace so memory_append writes don't touch the user's home state and
// channel_send routes through a mock AgentSessionManager.
//
// Coverage:
//   1. tool.invoke memory_append → JSONL file written at expected path
//   2. tool.invoke channel_send  → target session history receives message
//   3. tool.invoke with unknown tool  → INVALID_REQUEST
//   4. tool.invoke with missing tool_name → INVALID_REQUEST
//   5. tool.invoke memory_append missing `category` → {ok: false}
// =============================================================================

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  gatewayToolInvokeExtensionManifest,
  getToolInvokeAllowedToolNames,
  registerToolMethods,
} from "../../src/gateway/tool-methods.js";
import { MethodError } from "../../src/gateway/methods.js";
import type {
  MethodHandler,
  MethodRegistry,
} from "../../src/gateway/methods.js";
import type { GatewayServer } from "../../src/gateway/server.js";
import {
  setChannelSendDeps,
  resetChannelSendDeps,
  channelSendToolDefinition,
} from "../../src/tools/channel_send.js";
import { memoryAppendToolDefinition } from "../../src/tools/memory_append.js";
import {
  faceIdentifyToolDefinition,
  faceEnrollToolDefinition,
  faceUpdateToolDefinition,
  facePeopleToolDefinition,
  faceClearToolDefinition,
  assessHazardToolDefinition,
} from "../../src/tools/face_recognize.js";
import { sendPhotoToolDefinition } from "../../src/tools/send_photo.js";
import { generateChartToolDefinition } from "../../src/tools/generate_chart.js";
import {
  setWorkspaceDir,
  getWorkspaceDir,
} from "../../src/storage/workspace.js";

// -----------------------------------------------------------------------------
// Mock gateway server — just enough for registerToolMethods + handler calls.
// -----------------------------------------------------------------------------

function createMockServer(): {
  server: GatewayServer;
  registry: MethodRegistry;
  invoke: (method: string, params: unknown) => Promise<unknown>;
} {
  const handlers = new Map<string, MethodHandler>();
  const registry: MethodRegistry = {
    register: (m, h) => handlers.set(m, h),
    get: (m) => handlers.get(m),
    list: () => Array.from(handlers.keys()),
  };
  const server = {
    registerMethod: (m: string, h: MethodHandler) => registry.register(m, h),
    broadcast: () => {},
    broadcastToSession: () => {},
  } as unknown as GatewayServer;

  const invoke = async (method: string, params: unknown) => {
    const handler = handlers.get(method);
    if (!handler) throw new Error(`method not registered: ${method}`);
    // Pass a stub connection — tool.invoke doesn't read it.
    return await handler({} as any, params, server);
  };

  return { server, registry, invoke };
}

// -----------------------------------------------------------------------------
// Mock AgentSessionManager for channel_send
// -----------------------------------------------------------------------------

interface MockMsg { role: "user" | "assistant"; content: any[]; timestamp?: string }

class MockLoop {
  private history: MockMsg[] = [];
  getHistory(): MockMsg[] { return this.history; }
  setHistory(h: MockMsg[]): void { this.history = h; }
  async sendMessage(_text: string, _opts?: unknown): Promise<void> {}
}

class MockSessionManager {
  appended: MockMsg[] = [];
  appendMessage(m: MockMsg): void { this.appended.push(m); }
}

class MockSessions {
  sessions = new Map<string, { loop: MockLoop; sessionManager: MockSessionManager }>();
  getOrCreate(key: string) {
    let s = this.sessions.get(key);
    if (!s) {
      s = { loop: new MockLoop(), sessionManager: new MockSessionManager() };
      this.sessions.set(key, s);
    }
    return s;
  }
}

// -----------------------------------------------------------------------------
// Isolated workspace
// -----------------------------------------------------------------------------

let workDir: string;
let workspaceDir: string;
let prevWorkspaceDir: string;

beforeEach(() => {
  workDir = join(
    tmpdir(),
    `hawky-tool-invoke-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  );
  workspaceDir = join(workDir, "workspace");
  mkdirSync(workspaceDir, { recursive: true });

  prevWorkspaceDir = getWorkspaceDir();
  setWorkspaceDir(workspaceDir);

  resetChannelSendDeps();
});

afterEach(() => {
  setWorkspaceDir(prevWorkspaceDir);
  resetChannelSendDeps();
  try { rmSync(workDir, { recursive: true, force: true }); } catch {}
});

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("tool.invoke — memory_append", () => {
  test("writes JSONL file under workspace memory/<category>/", async () => {
    const { server, invoke } = createMockServer();
    registerToolMethods(server);

    const res = (await invoke("tool.invoke", {
      tool_name: "memory_append",
      args: { category: "test", text: "hello" },
      session_key: "web:test",
    })) as { ok: boolean; result?: any; error?: string };

    expect(res.ok).toBe(true);
    expect(res.result?.type).toBe("text");

    const categoryDir = join(workspaceDir, "memory", "test");
    expect(existsSync(categoryDir)).toBe(true);

    const files = readdirSync(categoryDir).filter((f) => f.endsWith(".jsonl"));
    expect(files.length).toBe(1);

    const content = readFileSync(join(categoryDir, files[0]), "utf-8");
    const line = content.trim().split("\n")[0];
    const entry = JSON.parse(line);
    expect(entry.category).toBe("test");
    expect(entry.text).toBe("hello");
    expect(entry.source_session).toBe("web:test");
    expect(typeof entry.ts_iso).toBe("string");
  });

  test("propagates tool's own validation error as {ok: false}", async () => {
    const { server, invoke } = createMockServer();
    registerToolMethods(server);

    const res = (await invoke("tool.invoke", {
      tool_name: "memory_append",
      args: { text: "no category" }, // missing `category`
    })) as { ok: boolean; error?: string };

    expect(res.ok).toBe(false);
    expect(res.error).toContain("category");
  });
});

describe("tool.invoke — channel_send", () => {
  test("appends message to target session history", async () => {
    const sessions = new MockSessions();
    setChannelSendDeps(sessions as any, null);

    const { server, invoke } = createMockServer();
    registerToolMethods(server);

    const res = (await invoke("tool.invoke", {
      tool_name: "channel_send",
      args: { to: "web:test", text: "hi" },
    })) as { ok: boolean; result?: any };

    expect(res.ok).toBe(true);

    const target = sessions.sessions.get("web:test");
    expect(target).toBeTruthy();
    const history = target!.loop.getHistory();
    expect(history.length).toBe(1);
    expect(history[0].role).toBe("user");
    expect((history[0].content[0] as any).text).toBe("hi");
    expect(target!.sessionManager.appended.length).toBe(1);
  });
});

describe("tool.invoke — validation", () => {
  test("allowed tools are declared by the gateway tool.invoke extension", () => {
    const names = getToolInvokeAllowedToolNames();
    const definitions = [
      memoryAppendToolDefinition,
      channelSendToolDefinition,
      faceIdentifyToolDefinition,
      faceEnrollToolDefinition,
      faceUpdateToolDefinition,
      facePeopleToolDefinition,
      faceClearToolDefinition,
      assessHazardToolDefinition,
      sendPhotoToolDefinition,
      generateChartToolDefinition,
    ];
    expect(names).toEqual([
      "memory_append",
      "channel_send",
      "face_identify",
      "face_enroll",
      "face_update",
      "face_people",
      "face_clear",
      "assess_hazard",
      "send_photo",
      "generate_chart",
    ]);
    expect(gatewayToolInvokeExtensionManifest.surfaces).toContain("tool.invoke");
    expect(gatewayToolInvokeExtensionManifest.tools?.map((tool) => tool.name)).toEqual(names);
    for (const definition of definitions) {
      const descriptor = gatewayToolInvokeExtensionManifest.tools?.find((tool) => tool.name === definition.name);
      expect(descriptor).toBeDefined();
      expect(descriptor?.description).toBe(definition.description);
      expect(descriptor?.input_schema).toEqual(definition.input_schema);
      expect(descriptor?.permission).toBe(definition.permission);
      expect(descriptor?.surfaces).toEqual(["tool.invoke"]);
    }
  });

  test("rejects tools outside the tool.invoke surface with INVALID_REQUEST", async () => {
    const { server, invoke } = createMockServer();
    registerToolMethods(server);

    let caught: unknown;
    try {
      await invoke("tool.invoke", {
        tool_name: "bash",
        args: { command: "echo pwned" },
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(MethodError);
    expect((caught as MethodError).code).toBe("INVALID_REQUEST");
    expect((caught as MethodError).message).toContain("bash");
    expect((caught as MethodError).message).toContain("send_photo");
  });

  test("rejects missing tool_name with INVALID_REQUEST", async () => {
    const { server, invoke } = createMockServer();
    registerToolMethods(server);

    let caught: unknown;
    try {
      await invoke("tool.invoke", { args: { category: "x", text: "y" } });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(MethodError);
    expect((caught as MethodError).code).toBe("INVALID_REQUEST");
    expect((caught as MethodError).message).toContain("tool_name");
  });
});

// Cocktail Party Mode (#627): face_identify/enroll/update/people are directly invocable
// as face-index compatibility tools. They must not expose or write person facts/recaps;
// person.* owns person profiles and facts.
describe("tool.invoke — face recognition (#627)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function mockService(byPath: Record<string, any>) {
    globalThis.fetch = (async (url: any) => {
      const u = String(url);
      const key = Object.keys(byPath).find((p) => u.endsWith(p));
      return { ok: true, status: 200, json: async () => byPath[key ?? ""] ?? { ok: false, error: "no mock" } } as any;
    }) as any;
  }

  test("face_identify is directly invocable and returns a sanitized face profile", async () => {
    mockService({
      "/identify": {
        ok: true,
        found: true,
        person: { id: "p1", name: "Sarah", facts: ["works at Acme"], recaps: [{ summary: "hidden" }] },
        similarity: 0.86,
      },
    });
    const { server, invoke } = createMockServer();
    registerToolMethods(server);
    const res = (await invoke("tool.invoke", {
      tool_name: "face_identify",
      args: { image_base64: "abc" },
    })) as any;
    expect(res.ok).toBe(true);
    expect(res.result.metadata.found).toBe(true);
    expect(res.result.metadata.person.name).toBe("Sarah");
    expect(res.result.metadata.person.facts).toBeUndefined();
    expect(res.result.metadata.person.recaps).toBeUndefined();
    expect(res.result.metadata.face_profile).toEqual(res.result.metadata.person);
    expect(res.result.metadata.similarity).toBe(0.86);
    expect(res.result.metadata.distance).toBeUndefined();
  });

  test("face_identify reports found:false when nobody matches", async () => {
    mockService({ "/identify": { ok: true, found: false } });
    const { server, invoke } = createMockServer();
    registerToolMethods(server);
    const res = (await invoke("tool.invoke", { tool_name: "face_identify", args: { image_base64: "abc" } })) as any;
    expect(res.ok).toBe(true);
    expect(res.result.metadata.found).toBe(false);
  });

  test("face_identify rejects successful responses that omit the matched profile", async () => {
    mockService({ "/identify": { ok: true, found: true, similarity: 0.86 } });
    const { server, invoke } = createMockServer();
    registerToolMethods(server);
    const res = (await invoke("tool.invoke", {
      tool_name: "face_identify",
      args: { image_base64: "abc" },
    })) as any;
    expect(res.ok).toBe(false);
    expect(res.error).toContain("malformed face profile");
    expect(res.error).toContain("/identify person");
  });

  test("face_enroll returns the new sanitized face profile", async () => {
    mockService({ "/enroll": { ok: true, person: { id: "p9", name: "Ben", facts: ["hidden"], recaps: [{ summary: "hidden" }] } } });
    const { server, invoke } = createMockServer();
    registerToolMethods(server);
    const res = (await invoke("tool.invoke", {
      tool_name: "face_enroll",
      args: { image_base64: "abc", name: "Ben" },
    })) as any;
    expect(res.ok).toBe(true);
    expect(res.result.metadata.person.name).toBe("Ben");
    expect(res.result.metadata.person.facts).toBeUndefined();
    expect(res.result.metadata.person.recaps).toBeUndefined();
    expect(res.result.metadata.face_profile).toEqual(res.result.metadata.person);
  });

  test("face_enroll rejects successful responses with an empty profile id", async () => {
    mockService({ "/enroll": { ok: true, person: { name: "Ben" } } });
    const { server, invoke } = createMockServer();
    registerToolMethods(server);
    const res = (await invoke("tool.invoke", {
      tool_name: "face_enroll",
      args: { image_base64: "abc", name: "Ben" },
    })) as any;
    expect(res.ok).toBe(false);
    expect(res.error).toContain("malformed face profile");
    expect(res.error).toContain("missing id");
  });

  test("face_update refuses person facts and recaps", async () => {
    expect(faceUpdateToolDefinition.input_schema.required).toEqual(["person_id", "name"]);

    mockService({ "/update": { ok: true, person: { id: "p1", name: "Sarah", facts: ["works at Acme"], recaps: [] } } });
    const { server, invoke } = createMockServer();
    registerToolMethods(server);
    const res = (await invoke("tool.invoke", {
      tool_name: "face_update",
      args: { person_id: "p1", facts: ["works at Acme"] },
    })) as any;
    expect(res.ok).toBe(false);
    expect(res.error).toContain("person facts or recaps");
  });

  test("face_update only sends a legacy face label", async () => {
    let requestBody: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_url: any, init?: RequestInit) => {
      requestBody = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, person: { id: "p1", name: "Sarah", facts: ["hidden"], recaps: [{ summary: "hidden" }] } }),
      } as any;
    }) as any;
    const { server, invoke } = createMockServer();
    registerToolMethods(server);
    const res = (await invoke("tool.invoke", {
      tool_name: "face_update",
      args: { person_id: "p1", name: "Sarah" },
    })) as any;
    expect(res.ok).toBe(true);
    expect(requestBody).toEqual({ person_id: "p1", name: "Sarah", facts: null, recap: null });
    expect(res.result.metadata.person).toEqual({ id: "p1", name: "Sarah" });
  });

  test("face_people lists sanitized face profiles", async () => {
    mockService({
      "/people": {
        ok: true,
        people: [
          { id: "p1", name: "Sarah", facts: ["hidden"], recaps: [{ summary: "hidden" }] },
          { id: "p2", name: "Ben", facts: [], recaps: [] },
        ],
      },
    });
    const { server, invoke } = createMockServer();
    registerToolMethods(server);
    const res = (await invoke("tool.invoke", {
      tool_name: "face_people",
      args: {},
    })) as any;
    expect(res.ok).toBe(true);
    expect(res.result.content).toBe("2 face profiles.");
    expect(res.result.metadata.people.length).toBe(2);
    expect(res.result.metadata.people[0].name).toBe("Sarah");
    expect(res.result.metadata.people[0].facts).toBeUndefined();
    expect(res.result.metadata.people[0].recaps).toBeUndefined();
    expect(res.result.metadata.face_profiles).toEqual(res.result.metadata.people);
  });

  test("face_people rejects malformed profiles instead of returning empty ids", async () => {
    mockService({
      "/people": {
        ok: true,
        people: [
          { id: "p1", name: "Sarah" },
          { name: "Missing Id" },
        ],
      },
    });
    const { server, invoke } = createMockServer();
    registerToolMethods(server);
    const res = (await invoke("tool.invoke", {
      tool_name: "face_people",
      args: {},
    })) as any;
    expect(res.ok).toBe(false);
    expect(res.error).toContain("malformed face profile");
    expect(res.error).toContain("/people people[1]");
  });

  test("face_people rejects malformed people payloads instead of fabricating an empty list", async () => {
    mockService({ "/people": { ok: true, people: { id: "not-an-array" } } });
    const { server, invoke } = createMockServer();
    registerToolMethods(server);
    const res = (await invoke("tool.invoke", {
      tool_name: "face_people",
      args: {},
    })) as any;
    expect(res.ok).toBe(false);
    expect(res.error).toContain("malformed face profile");
    expect(res.error).toContain("/people people must be an array");
  });

  test("face_clear clears the legacy face index", async () => {
    mockService({ "/clear": { ok: true, removed: 2 } });
    const { server, invoke } = createMockServer();
    registerToolMethods(server);
    const res = (await invoke("tool.invoke", {
      tool_name: "face_clear",
      args: {},
    })) as any;
    expect(res.ok).toBe(true);
    expect(res.result.content).toBe("Cleared 2 face profiles.");
    expect(res.result.metadata.removed).toBe(2);
  });

  test("network failure surfaces an actionable error", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as any;
    const { server, invoke } = createMockServer();
    registerToolMethods(server);
    const res = (await invoke("tool.invoke", { tool_name: "face_identify", args: { image_base64: "abc" } })) as any;
    expect(res.ok).toBe(false);
    expect(res.error).toContain("Could not reach the DeepFace service");
  });
});

// Safety Check (#648): assess_hazard is a silent off-model vision classifier,
// directly invocable on the tool.invoke path. iOS samples frames and reaches it the same
// way as the face tools; the vision service (POST /assess_hazard) is mocked here.
describe("tool.invoke — assess_hazard (#648)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function mockService(body: any) {
    globalThis.fetch = (async (url: any) => {
      const ok = String(url).endsWith("/assess_hazard");
      return { ok: true, status: 200, json: async () => (ok ? body : { ok: false, error: "no mock" }) } as any;
    }) as any;
  }

  test("is directly invocable and returns the hazard assessment", async () => {
    mockService({ ok: true, severity: "high", kind: "fire", warning: "There's a fire — get out." });
    const { server, invoke } = createMockServer();
    registerToolMethods(server);
    const res = (await invoke("tool.invoke", {
      tool_name: "assess_hazard",
      args: { image_base64: "abc" },
    })) as any;
    expect(res.ok).toBe(true);
    expect(res.result.metadata.severity).toBe("high");
    expect(res.result.metadata.kind).toBe("fire");
    expect(res.result.metadata.warning).toContain("fire");
  });

  test("benign frame reports severity:none", async () => {
    mockService({ ok: true, severity: "none", kind: "", warning: "" });
    const { server, invoke } = createMockServer();
    registerToolMethods(server);
    const res = (await invoke("tool.invoke", { tool_name: "assess_hazard", args: { image_base64: "abc" } })) as any;
    expect(res.ok).toBe(true);
    expect(res.result.metadata.severity).toBe("none");
  });

  test("missing image_base64 errors without calling the service", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      throw new Error("should not be reached");
    }) as any;
    const { server, invoke } = createMockServer();
    registerToolMethods(server);
    const res = (await invoke("tool.invoke", { tool_name: "assess_hazard", args: {} })) as any;
    expect(res.ok).toBe(false);
    expect(called).toBe(false);
  });
});