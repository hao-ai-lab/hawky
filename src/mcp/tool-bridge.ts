// =============================================================================
// MCP Tool Bridge
//
// Converts MCP server tools into Hawky ToolDefinition format and routes
// tool execution calls back to the MCP server.
// =============================================================================

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ToolDefinition, ToolInputSchema, PermissionLevel } from "../agent/types.js";
import type { McpToolInfo } from "./types.js";
import { createSubsystemLogger } from "../logging/index.js";

const log = createSubsystemLogger("mcp/bridge");

/**
 * Prefix for MCP tool names in our registry.
 * Format: mcp_{serverName}_{originalToolName}
 */
export function mcpToolName(serverName: string, toolName: string): string {
  // Sanitize server name: lowercase, replace non-alphanumeric with underscore
  const safeName = serverName.toLowerCase().replace(/[^a-z0-9]/g, "_");
  const safeToolName = toolName.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `mcp_${safeName}_${safeToolName}`;
}

/**
 * Convert an MCP tool definition to our ToolDefinition format.
 *
 * @param serverName - Name of the MCP server (for prefixing)
 * @param mcpTool - Tool definition from MCP tools/list response
 * @param client - MCP client instance for routing execution calls
 * @param permission - Default permission level for this server's tools
 * @returns Hawky ToolDefinition + MCP tool info
 */
export function bridgeMcpTool(
  serverName: string,
  mcpTool: { name: string; description?: string; inputSchema?: Record<string, unknown> },
  client: Client,
  permission: PermissionLevel,
): { definition: ToolDefinition; info: McpToolInfo } {
  const registeredName = mcpToolName(serverName, mcpTool.name);

  // Convert MCP input schema to our format.
  // MCP uses JSON Schema; our ToolInputSchema is a subset.
  const inputSchema: ToolInputSchema = {
    type: "object",
    properties: {},
    required: [],
  };

  if (mcpTool.inputSchema && typeof mcpTool.inputSchema === "object") {
    const schema = mcpTool.inputSchema as Record<string, unknown>;
    if (schema.properties && typeof schema.properties === "object") {
      // Map each property, keeping only the fields our schema supports
      for (const [key, value] of Object.entries(schema.properties as Record<string, unknown>)) {
        const prop = value as Record<string, unknown>;
        inputSchema.properties[key] = {
          type: (prop.type as any) ?? "string",
          description: (prop.description as string) ?? "",
          ...(prop.default !== undefined ? { default: prop.default } : {}),
          ...(prop.enum ? { enum: prop.enum as unknown[] } : {}),
        };
      }
    }
    if (Array.isArray(schema.required)) {
      inputSchema.required = schema.required as string[];
    }
  }

  const definition: ToolDefinition = {
    name: registeredName,
    description: `[MCP: ${serverName}] ${mcpTool.description ?? mcpTool.name}`,
    input_schema: inputSchema,
    permission,
    execute: async (input, context) => {
      if (context.abort_signal.aborted) {
        return { type: "error", content: "Tool execution was interrupted" };
      }

      try {
        const result = await client.callTool(
          { name: mcpTool.name, arguments: input },
          undefined,
          { signal: context.abort_signal },
        );

        // MCP returns content as an array of content blocks.
        // Some servers use structuredContent instead of content, or omit content entirely.
        const rawContent = result.content ?? result.structuredContent;
        const content = Array.isArray(rawContent)
          ? rawContent
              .map((block: any) => {
                if (block.type === "text") return block.text;
                if (block.type === "image") return `[image: ${block.mimeType}]`;
                if (block.type === "resource") return `[resource: ${block.uri}]`;
                return JSON.stringify(block);
              })
              .join("\n")
          : typeof rawContent === "string"
            ? rawContent
            : rawContent != null
              ? JSON.stringify(rawContent)
              : "(no output)";

        return {
          type: result.isError ? "error" : "text",
          content,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn("MCP tool execution failed", {
          server: serverName,
          tool: mcpTool.name,
          error: message,
        });
        return { type: "error", content: `MCP tool error: ${message}` };
      }
    },
  };

  const info: McpToolInfo = {
    serverName,
    originalName: mcpTool.name,
    registeredName,
  };

  return { definition, info };
}
