// =============================================================================
// Tool Invocation RPC
//
// Exposes a manifest-declared subset of tools (memory_append, channel_send,
// face recognition, hazard assessment, send_photo) as standalone RPCs callable from any
// authenticated WS client, without going through an agent loop.
//
// Motivation: the iOS Gemini Live client receives tool-call requests from
// Gemini and needs to execute them against the gateway's workspace/session
// state. The existing tool handlers were only reachable via
// `loop.sendMessage` → model → tool_executor. This RPC surfaces them directly.
//
// Contract:
//   method: "tool.invoke"
//   params: {
//     tool_name: one of the extension-declared tool.invoke surface names,
//     args:      Record<string, unknown>,
//     session_key?: string,   // used as `source_session` when the tool records one
//   }
//   result: { ok: true,  result: <tool output> }
//         | { ok: false, error: string }
//
// The invocable surface is strict — all other tool names return INVALID_REQUEST.
// Missing or malformed `tool_name` also returns INVALID_REQUEST. Errors produced by the
// tool handler itself (e.g. missing `category`) are reflected as
// `{ok: false, error: ...}` rather than RPC errors — they belong to the tool
// contract, not the RPC contract.
//
// Logging: one INFO line per invocation with {tool_name, session_key,
// duration_ms}. Args are NEVER logged (may contain memo text).
// =============================================================================

import type { GatewayServer } from "./server.js";
import { MethodError } from "./methods.js";
import type { ToolContext, ToolDefinition } from "../agent/types.js";
import type { ExtensionManifest } from "../extensions/types.js";
import { ToolRegistry } from "../tools/registry.js";
import { memoryAppendToolDefinition } from "../tools/memory_append.js";
import { channelSendToolDefinition } from "../tools/channel_send.js";
import {
  faceIdentifyToolDefinition,
  faceEnrollToolDefinition,
  faceUpdateToolDefinition,
  facePeopleToolDefinition,
  faceClearToolDefinition,
  assessHazardToolDefinition,
} from "../tools/face_recognize.js";
import { sendPhotoToolDefinition } from "../tools/send_photo.js";
import { generateChartToolDefinition } from "../tools/generate_chart.js";
import { createSubsystemLogger } from "../logging/index.js";

const log = createSubsystemLogger("gateway/tool-methods");

// -----------------------------------------------------------------------------
// Direct-invocation extension
// -----------------------------------------------------------------------------

// ToolDefinition<SpecificInput> -> ToolDefinition<Record<string, unknown>> needs
// a cast because the generic parameter is contravariant on execute.
const toolInvokeTools = [
  memoryAppendToolDefinition,
  channelSendToolDefinition,
  // Cocktail Party Mode (#627): face-index compatibility only. Person profiles,
  // facts, recaps, and candidates belong behind person.* RPCs.
  faceIdentifyToolDefinition,
  faceEnrollToolDefinition,
  faceUpdateToolDefinition,
  facePeopleToolDefinition,
  faceClearToolDefinition,
  // Safety Check (#648): silent off-model hazard classifier for camera frames.
  assessHazardToolDefinition,
  // Share a camera frame to Slack. Frontend attaches image_base64 (the current
  // video frame); the tool uploads it via the Slack adapter (files.uploadV2).
  sendPhotoToolDefinition,
  // Render a chart (PNG) from agent-supplied data — returns type:"image".
  generateChartToolDefinition,
] as unknown as ToolDefinition[];

export const gatewayToolInvokeExtensionManifest: ExtensionManifest = {
  id: "gateway.tool-invoke",
  version: "0.1.0",
  displayName: "Gateway Direct Tool Invocation",
  description: "Tools callable through the authenticated gateway tool.invoke RPC.",
  capabilities: ["gateway.tool.invoke"],
  surfaces: ["tool.invoke"],
  tools: toolInvokeTools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.input_schema,
    permission: tool.permission,
    surfaces: ["tool.invoke"],
  })),
};

const toolInvokeRegistry = new ToolRegistry();
toolInvokeRegistry.registerExtension(gatewayToolInvokeExtensionManifest, toolInvokeTools);

const TOOL_INVOKE_ALLOWED_NAMES = toolInvokeRegistry
  .getToolsBySurface("tool.invoke")
  .map((tool) => tool.name);
const TOOL_INVOKE_ALLOWED = new Set(TOOL_INVOKE_ALLOWED_NAMES);

export function getToolInvokeAllowedToolNames(): string[] {
  return [...TOOL_INVOKE_ALLOWED_NAMES];
}

// -----------------------------------------------------------------------------
// Adapter: build a minimal ToolContext for the direct-invocation path.
//
// The agent-loop passes a rich ToolContext with abort_signal + emit hooks that
// only make sense mid-turn. For standalone invocation we synthesize a stub:
// - session_id: from caller's `session_key` (falls back to "tool-invoke" so
//   memory_append has a non-empty `source_session` field).
// - working_directory: process cwd (tools that care about workspace use
//   WorkspaceManager / HAWKY_WORKSPACE, not this field).
// - abort_signal: a never-aborted controller so handlers that read it don't NPE.
// - emit: no-op (no stream to deliver to).
// -----------------------------------------------------------------------------

function buildContext(sessionKey: string | undefined): ToolContext {
  return {
    session_id: sessionKey && sessionKey.trim() ? sessionKey.trim() : "tool-invoke",
    working_directory: process.cwd(),
    abort_signal: new AbortController().signal,
    emit: () => { /* no-op */ },
    headless: true,
  };
}

// -----------------------------------------------------------------------------
// Register
// -----------------------------------------------------------------------------

export function registerToolMethods(server: GatewayServer): void {
  server.registerMethod("tool.invoke", async (_conn, params) => {
    const p = params as
      | { tool_name?: unknown; args?: unknown; session_key?: unknown }
      | undefined;

    const toolName =
      p && typeof p.tool_name === "string" ? p.tool_name.trim() : "";
    if (!toolName) {
      throw new MethodError("INVALID_REQUEST", "tool_name is required");
    }

    const tool = TOOL_INVOKE_ALLOWED.has(toolName)
      ? toolInvokeRegistry.get(toolName)
      : undefined;
    if (!tool) {
      throw new MethodError(
        "INVALID_REQUEST",
        `tool "${toolName}" is not invocable via tool.invoke. ` +
          `Allowed: ${TOOL_INVOKE_ALLOWED_NAMES.join(", ")}`,
      );
    }

    const args =
      p && p.args && typeof p.args === "object" && !Array.isArray(p.args)
        ? (p.args as Record<string, unknown>)
        : {};
    const sessionKey =
      p && typeof p.session_key === "string" ? p.session_key : undefined;

    const ctx = buildContext(sessionKey);
    const start = Date.now();

    try {
      const result = await tool.execute(args, ctx);
      const durationMs = Date.now() - start;
      log.info("tool.invoke", {
        tool_name: toolName,
        session_key: sessionKey ?? null,
        duration_ms: durationMs,
        ok: result.type !== "error",
      });
      if (result.type === "error") {
        return { ok: false, error: result.content };
      }
      return { ok: true, result };
    } catch (err) {
      const durationMs = Date.now() - start;
      log.info("tool.invoke", {
        tool_name: toolName,
        session_key: sessionKey ?? null,
        duration_ms: durationMs,
        ok: false,
      });
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });
}