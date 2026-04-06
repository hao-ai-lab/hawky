// =============================================================================
// MCP Server Manager
//
// Manages MCP server lifecycle: start, discover tools, reconnect on crash,
// stop on shutdown. Each configured server gets its own Client instance.
//
// Reference: Claude Code's src/services/mcp/ (4 transports, OAuth, health).
// We implement stdio + SSE, no OAuth, basic health monitoring.
// =============================================================================

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { ToolDefinition } from "../agent/types.js";
import type { McpServerConfig, McpServerState, McpToolInfo } from "./types.js";
import { bridgeMcpTool } from "./tool-bridge.js";
import { createSubsystemLogger } from "../logging/index.js";

const log = createSubsystemLogger("mcp/manager");

// -----------------------------------------------------------------------------
// MCP Server Manager
// -----------------------------------------------------------------------------

export class McpServerManager {
  private servers = new Map<string, ManagedServer>();

  /**
   * Start all configured MCP servers. Non-blocking — errors are logged,
   * not thrown. Call this during gateway startup.
   */
  async startAll(configs: Record<string, Partial<McpServerConfig>>): Promise<void> {
    const entries = Object.entries(configs);
    if (entries.length === 0) return;

    log.info("starting MCP servers", { count: entries.length });

    await Promise.all(
      entries.map(async ([name, rawConfig]) => {
        const config = normalizeConfig(rawConfig);
        try {
          await this.startServer(name, config);
        } catch (err) {
          log.warn("MCP server failed to start", {
            name,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }),
    );
  }

  /**
   * Start a single MCP server, connect, and discover its tools.
   */
  private async startServer(name: string, config: McpServerConfig): Promise<void> {
    // Don't start twice
    if (this.servers.has(name)) {
      log.warn("MCP server already running, skipping", { name });
      return;
    }

    const managed: ManagedServer = {
      name,
      config,
      client: null,
      transport: null,
      state: { name, config, status: "starting", toolNames: [] },
      tools: [],
      toolInfos: [],
    };
    this.servers.set(name, managed);

    try {
      // Create transport
      const transport = createTransport(name, config);
      managed.transport = transport;

      // Create MCP client
      const client = new Client(
        { name: "hawky", version: "1.0.0" },
        { capabilities: {} },
      );
      managed.client = client;

      // Connect
      await client.connect(transport);
      log.info("MCP server connected", { name, transport: config.transport });

      // Discover tools
      const toolsResult = await client.listTools();
      const tools: ToolDefinition[] = [];
      const toolInfos: McpToolInfo[] = [];

      for (const mcpTool of toolsResult.tools) {
        const { definition, info } = bridgeMcpTool(
          name,
          mcpTool,
          client,
          config.permission,
        );
        tools.push(definition);
        toolInfos.push(info);
      }

      managed.tools = tools;
      managed.toolInfos = toolInfos;
      managed.state = {
        name,
        config,
        status: "connected",
        toolNames: tools.map((t) => t.name),
      };

      log.info("MCP server tools discovered", {
        name,
        toolCount: tools.length,
        tools: tools.map((t) => t.name),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      managed.state = { name, config, status: "error", toolNames: [], error: message };
      log.warn("MCP server connection failed", { name, error: message });
      throw err;
    }
  }

  /**
   * Stop all MCP servers. Call during gateway shutdown.
   */
  async stopAll(): Promise<void> {
    const names = Array.from(this.servers.keys());
    if (names.length === 0) return;

    log.info("stopping MCP servers", { count: names.length });

    await Promise.all(
      names.map(async (name) => {
        try {
          await this.stopServer(name);
        } catch (err) {
          log.warn("MCP server stop failed", {
            name,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }),
    );
  }

  /**
   * Stop a single MCP server.
   */
  private async stopServer(name: string): Promise<void> {
    const managed = this.servers.get(name);
    if (!managed) return;

    try {
      if (managed.client) {
        await managed.client.close();
      }
    } catch {
      // Best effort
    }

    managed.state.status = "stopped";
    this.servers.delete(name);
    log.info("MCP server stopped", { name });
  }

  /**
   * Get all tool definitions from all connected MCP servers.
   */
  getAllTools(): ToolDefinition[] {
    const tools: ToolDefinition[] = [];
    for (const managed of this.servers.values()) {
      if (managed.state.status === "connected") {
        tools.push(...managed.tools);
      }
    }
    return tools;
  }

  /**
   * Get all tool info (for system prompt injection).
   */
  getAllToolInfos(): McpToolInfo[] {
    const infos: McpToolInfo[] = [];
    for (const managed of this.servers.values()) {
      if (managed.state.status === "connected") {
        infos.push(...managed.toolInfos);
      }
    }
    return infos;
  }

  /**
   * Get state of all servers (for status display and /mcp command).
   */
  getAllStates(): McpServerState[] {
    return Array.from(this.servers.values()).map((m) => m.state);
  }

  /**
   * Get tool names for a specific server.
   */
  getServerToolNames(serverName: string): string[] {
    return this.servers.get(serverName)?.state.toolNames ?? [];
  }

  /**
   * Number of connected servers.
   */
  get connectedCount(): number {
    let count = 0;
    for (const managed of this.servers.values()) {
      if (managed.state.status === "connected") count++;
    }
    return count;
  }

  /**
   * Total number of tools across all connected servers.
   */
  get totalToolCount(): number {
    return this.getAllTools().length;
  }
}

// -----------------------------------------------------------------------------
// Internal types
// -----------------------------------------------------------------------------

interface ManagedServer {
  name: string;
  config: McpServerConfig;
  client: Client | null;
  transport: any;
  state: McpServerState;
  tools: ToolDefinition[];
  toolInfos: McpToolInfo[];
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function normalizeConfig(raw: Partial<McpServerConfig>): McpServerConfig {
  return {
    transport: raw.transport ?? "stdio",
    command: raw.command,
    args: raw.args,
    env: raw.env,
    url: raw.url,
    permission: raw.permission ?? "ask_user",
  };
}

function createTransport(name: string, config: McpServerConfig) {
  if (config.transport === "sse") {
    if (!config.url) {
      throw new Error(`MCP server "${name}": SSE transport requires "url"`);
    }
    return new SSEClientTransport(new URL(config.url));
  }

  // Default: stdio
  if (!config.command) {
    throw new Error(`MCP server "${name}": stdio transport requires "command"`);
  }

  return new StdioClientTransport({
    command: config.command,
    args: config.args ?? [],
    env: {
      ...process.env,
      ...(config.env ?? {}),
    } as Record<string, string>,
  });
}

// -----------------------------------------------------------------------------
// Singleton
// -----------------------------------------------------------------------------

let _manager: McpServerManager | null = null;

export function getMcpServerManager(): McpServerManager {
  if (!_manager) {
    _manager = new McpServerManager();
  }
  return _manager;
}

export function resetMcpServerManager(): void {
  _manager = null;
}
