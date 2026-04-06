// =============================================================================
// MCP Types
//
// Configuration and state types for MCP server management.
// =============================================================================

import type { PermissionLevel } from "../agent/types.js";

// -----------------------------------------------------------------------------
// Configuration (from config.json)
// -----------------------------------------------------------------------------

export interface McpServerConfig {
  /** Transport type (default: "stdio"). */
  transport: "stdio" | "sse";
  /** Command to spawn (stdio transport). */
  command?: string;
  /** Arguments for the command (stdio transport). */
  args?: string[];
  /** Environment variables passed to the spawned process (stdio transport). */
  env?: Record<string, string>;
  /** URL to connect to (sse transport). */
  url?: string;
  /** Permission level for all tools from this server (default: "ask_user"). */
  permission: PermissionLevel;
}

// -----------------------------------------------------------------------------
// Runtime state
// -----------------------------------------------------------------------------

export type McpServerStatus = "starting" | "connected" | "error" | "stopped";

export interface McpServerState {
  name: string;
  config: McpServerConfig;
  status: McpServerStatus;
  error?: string;
  /** Names of tools discovered from this server (prefixed with mcp_{server}_). */
  toolNames: string[];
}

export interface McpToolInfo {
  /** The MCP server this tool belongs to. */
  serverName: string;
  /** Original tool name from the MCP server (before prefixing). */
  originalName: string;
  /** Prefixed name used in our tool registry. */
  registeredName: string;
}
