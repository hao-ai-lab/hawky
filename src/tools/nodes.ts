// =============================================================================
// Nodes Tool
//
// Unified agent tool for interacting with connected node hosts. Actions:
// - status: List connected nodes and their capabilities
// - invoke: Execute a command on a specific node
//
// Pattern: a proven agents/tools/nodes-tool.ts — single tool, action-based
// dispatch, lazy discovery (no system prompt injection).
// =============================================================================

import type { ToolDefinition, ToolResult, ToolContext } from "../agent/types.js";
import type { NodeRegistry, InvokeResult } from "../gateway/node-registry.js";

// The NodeRegistry instance is injected at registration time
let registryRef: NodeRegistry | null = null;

export function setNodeRegistryRef(registry: NodeRegistry): void {
  registryRef = registry;
}

// -----------------------------------------------------------------------------
// Tool definition
// -----------------------------------------------------------------------------

export const nodesToolDefinition: ToolDefinition = {
  name: "nodes",
  description:
    "Interact with connected node hosts (user devices like laptops, phones). " +
    "Use action 'status' to discover which nodes are online and what they can do. " +
    "Use action 'invoke' to run a command on a specific node. " +
    "Node hosts provide access to the user's local machine (bash, file access, screenshots). " +
    "IMPORTANT: Device state changes constantly. ALWAYS call this tool for fresh data — " +
    "never rely on previous results. Screenshots, frontmost app, and device info are " +
    "point-in-time snapshots that go stale immediately.",
  input_schema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        description: "The action to perform: 'status' (list nodes) or 'invoke' (run command on node).",
      },
      // For invoke:
      node: {
        type: "string",
        description: "Target node name or ID. Required for invoke when multiple nodes are connected. " +
          "If only one node is connected, it is auto-selected.",
      },
      command: {
        type: "string",
        description: "Command to invoke on the node. E.g., 'system.run', 'system.which'.",
      },
      params: {
        type: "object",
        description: "Command parameters. For system.run: {command: string[], cwd?: string, timeoutMs?: number}. " +
          "For system.which: {bins: string[]}.",
      },
      timeout_ms: {
        type: "number",
        description: "Invoke timeout in milliseconds (default: 30000).",
      },
    },
    required: ["action"],
  },
  permission: "ask_user",
  execute: executeNodes,
} as unknown as ToolDefinition;

// -----------------------------------------------------------------------------
// Execution
// -----------------------------------------------------------------------------

async function executeNodes(
  input: {
    action: string;
    node?: string;
    command?: string;
    params?: Record<string, unknown>;
    timeout_ms?: number;
  },
  context: ToolContext,
): Promise<ToolResult> {
  if (!registryRef) {
    return { type: "text", content: "Node registry not initialized." };
  }

  switch (input.action) {
    case "status":
      return handleStatus();
    case "invoke":
      return handleInvoke(input, context.abort_signal);
    default:
      return { type: "error", content: `Unknown action: ${input.action}. Use 'status' or 'invoke'.` };
  }
}

// -----------------------------------------------------------------------------
// Action handlers
// -----------------------------------------------------------------------------

function handleStatus(): ToolResult {
  const nodes = registryRef!.listConnected();

  if (nodes.length === 0) {
    return {
      type: "text",
      content: "No node hosts connected. Start a node host with: hawky node --connect <gateway-url>",
    };
  }

  const list = nodes.map((n) => ({
    name: n.name,
    nodeId: n.nodeId,
    commands: n.commands,
    platform: n.platform,
    connectedAt: new Date(n.connectedAt).toISOString(),
  }));

  return {
    type: "text",
    content: JSON.stringify({ nodes: list, count: list.length }, null, 2),
  };
}

async function handleInvoke(input: {
  node?: string;
  command?: string;
  params?: Record<string, unknown>;
  timeout_ms?: number;
}, signal?: AbortSignal): Promise<ToolResult> {
  if (!input.command) {
    return { type: "error", content: "Missing 'command' for invoke action." };
  }

  // Resolve target node
  const nodeId = resolveNodeId(input.node);
  if (nodeId === "ambiguous") {
    return {
      type: "error",
      content: `Multiple nodes with name "${input.node}". Use the node ID instead to avoid ambiguity.`,
    };
  }
  if (!nodeId) {
    const nodes = registryRef!.listConnected();
    if (nodes.length === 0) {
      return { type: "error", content: "No node hosts connected." };
    }
    return {
      type: "error",
      content: `Multiple nodes connected. Specify 'node' parameter. Available: ${nodes.map((n) => n.name).join(", ")}`,
    };
  }

  const result: InvokeResult = await registryRef!.invoke(
    nodeId,
    input.command,
    input.params,
    input.timeout_ms,
    signal,
  );

  if (!result.ok) {
    return { type: "error", content: result.error ?? "Invoke failed" };
  }

  // Screenshot returns image(s) for the model to inspect — all displays sent
  const payload = result.payload as Record<string, unknown> | undefined;
  if (input.command === "screenshot" && payload?.images) {
    const images = payload.images as Array<{ base64: string; media_type: string; display?: number }>;
    if (images.length === 0) {
      return { type: "error", content: "No screenshots captured" };
    }
    const first = images[0];
    const totalKB = Math.round(images.reduce((sum, img) => sum + img.base64.length * 0.75, 0) / 1024);
    const desc = images.length > 1
      ? `Screenshots from ${images.length} displays (${totalKB}KB total)`
      : `Screenshot from node (${Math.round(first.base64.length * 0.75 / 1024)}KB)`;
    return {
      type: "image",
      content: desc,
      base64: first.base64,
      media_type: first.media_type,
      extra_images: images.length > 1
        ? images.slice(1).map((img) => ({ base64: img.base64, media_type: img.media_type }))
        : undefined,
    };
  }

  // Add timestamp so the model knows this is a point-in-time snapshot
  const ts = new Date().toLocaleTimeString();
  const payloadStr = typeof result.payload === "string"
    ? result.payload
    : JSON.stringify(result.payload, null, 2);

  return {
    type: "text",
    content: `[Captured at ${ts}]\n${payloadStr}`,
  };
}

/**
 * Resolve a node query (name or ID) to a nodeId.
 * Auto-selects if only one node is connected.
 */
function resolveNodeId(query?: string): string | null {
  const nodes = registryRef!.listConnected();

  if (nodes.length === 0) return null;

  // Auto-select if only one node
  if (!query && nodes.length === 1) return nodes[0].nodeId;

  // No query + multiple nodes = ambiguous
  if (!query) return null;

  // Match by nodeId first (exact, unambiguous)
  const exactId = nodes.find((n) => n.nodeId === query);
  if (exactId) return exactId.nodeId;

  // Match by name (case-insensitive) — reject if ambiguous
  const lower = query.toLowerCase();
  const nameMatches = nodes.filter((n) => n.name.toLowerCase() === lower);
  if (nameMatches.length === 1) return nameMatches[0].nodeId;
  if (nameMatches.length > 1) return "ambiguous";
  return null;
}
