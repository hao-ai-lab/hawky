// =============================================================================
// Hawky MCP Server
//
// Exposes a small read-only MCP surface for external coding agents.
// Keep this layer side-effect free except for reading persisted session data:
// write tools need the gateway permission model, so they should not live here
// until that bridge exists.
// =============================================================================

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { ChatMessage, ContentBlock, ToolResultContent } from "../agent/types.js";
import { listSessions, SessionManager, sessionKeyToId } from "../storage/session.js";

export const HAWKY_MCP_SERVER_NAME = "hawky";
export const HAWKY_MCP_SERVER_VERSION = "0.1.0";

export type HawkyMcpToolName =
  | "hawky_echo"
  | "hawky_session_list"
  | "hawky_session_read";

export interface HawkyMcpTranscriptMessage {
  index: number;
  role: ChatMessage["role"];
  timestamp?: string;
  text: string;
}

export interface HawkyMcpSessionReadOptions {
  sessionKey: string;
  limit?: number;
  beforeIndex?: number;
}

export interface HawkyMcpSessionReadResult {
  sessionKey: string;
  total: number;
  startIndex: number;
  endIndex: number;
  hasMore: boolean;
  messages: HawkyMcpTranscriptMessage[];
  transcript: string;
}

export interface HawkyMcpSessionListOptions {
  limit?: number;
  includeArchived?: boolean;
}

export interface HawkyMcpSessionListResult {
  sessions: Array<{
    sessionKey: string;
    id: string;
    displayName?: string;
    createdAt: string;
    lastModified: number;
    messageCount: number;
    runtimeKind?: string;
    archived?: boolean;
    pinned?: boolean;
  }>;
}

export interface HawkyMcpContext {
  listSessions?: (
    opts: HawkyMcpSessionListOptions,
  ) => Promise<HawkyMcpSessionListResult> | HawkyMcpSessionListResult;
  readSession?: (
    opts: HawkyMcpSessionReadOptions,
  ) => Promise<HawkyMcpSessionReadResult | null> | HawkyMcpSessionReadResult | null;
}

const MAX_SESSION_LIST_LIMIT = 100;
const DEFAULT_SESSION_LIST_LIMIT = 20;
const MAX_SESSION_READ_LIMIT = 100;
const DEFAULT_SESSION_READ_LIMIT = 20;
const MAX_MESSAGE_TEXT_CHARS = 4_000;
const CLAUDE_MCP_TOOL_META = {
  "anthropic/alwaysLoad": true,
  "anthropic/maxResultSizeChars": 200_000,
};

// Every Hawky MCP tool is a read-only inspector (echo, session list/read).
const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

type HawkyTool = Tool & { _meta?: Record<string, unknown> };

const HAWKY_MCP_TOOLS: HawkyTool[] = [
  {
    name: "hawky_echo",
    title: "Echo",
    description: "Connectivity check for the Hawky MCP server. Returns the provided text.",
    _meta: CLAUDE_MCP_TOOL_META,
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to echo back." },
      },
      required: ["text"],
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: "hawky_session_list",
    title: "List Hawky sessions",
    description: "List recent persisted Hawky sessions so an external agent can choose one to read.",
    _meta: CLAUDE_MCP_TOOL_META,
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: `Maximum sessions to return. Defaults to ${DEFAULT_SESSION_LIST_LIMIT}, max ${MAX_SESSION_LIST_LIMIT}.`,
        },
        includeArchived: {
          type: "boolean",
          description: "Whether to include archived sessions. Defaults to false.",
        },
      },
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: "hawky_session_read",
    title: "Read Hawky session",
    description: "Read recent persisted messages from a Hawky session by sessionKey.",
    _meta: CLAUDE_MCP_TOOL_META,
    inputSchema: {
      type: "object",
      properties: {
        sessionKey: {
          type: "string",
          description: "Session key such as web:general, tui:main, realtime:device.",
        },
        limit: {
          type: "number",
          description: `Maximum messages to return. Defaults to ${DEFAULT_SESSION_READ_LIMIT}, max ${MAX_SESSION_READ_LIMIT}.`,
        },
        beforeIndex: {
          type: "number",
          description: "Optional cursor. Return messages with absolute index lower than this value.",
        },
      },
      required: ["sessionKey"],
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
];

export function listHawkyMcpTools(): Tool[] {
  return HAWKY_MCP_TOOLS.map((tool) => ({ ...tool }));
}

export async function callHawkyMcpTool(
  name: string,
  rawArgs: unknown,
  context: HawkyMcpContext = {},
): Promise<CallToolResult> {
  const args = isRecord(rawArgs) ? rawArgs : {};

  switch (name as HawkyMcpToolName) {
    case "hawky_echo": {
      const text = args.text;
      if (typeof text !== "string") {
        return mcpError("hawky_echo requires a string text argument.");
      }
      return mcpText(text);
    }

    case "hawky_session_list": {
      const limit = clampInteger(args.limit, DEFAULT_SESSION_LIST_LIMIT, 1, MAX_SESSION_LIST_LIMIT);
      const includeArchived = args.includeArchived === true;
      const result = context.listSessions
        ? await context.listSessions({ limit, includeArchived })
        : await listPersistedHawkySessions({ limit, includeArchived });
      return mcpJson(result);
    }

    case "hawky_session_read": {
      const sessionKey = args.sessionKey;
      if (typeof sessionKey !== "string" || sessionKey.trim().length === 0) {
        return mcpError("hawky_session_read requires a non-empty sessionKey argument.");
      }
      const limit = clampInteger(args.limit, DEFAULT_SESSION_READ_LIMIT, 1, MAX_SESSION_READ_LIMIT);
      const beforeIndex = args.beforeIndex === undefined
        ? undefined
        : clampInteger(args.beforeIndex, 0, 0, Number.MAX_SAFE_INTEGER);
      const readOpts = { sessionKey: sessionKey.trim(), limit, beforeIndex };
      const result = context.readSession
        ? await context.readSession(readOpts)
        : await readPersistedHawkySession(readOpts);
      if (!result) {
        return mcpError(`Session not found: ${readOpts.sessionKey}`);
      }
      return mcpJson(result);
    }

    default:
      return mcpError(`Unknown Hawky MCP tool: ${name}`);
  }
}

export async function listPersistedHawkySessions(
  opts: HawkyMcpSessionListOptions = {},
): Promise<HawkyMcpSessionListResult> {
  const limit = clampInteger(opts.limit, DEFAULT_SESSION_LIST_LIMIT, 1, MAX_SESSION_LIST_LIMIT);
  const sessions = listSessions(limit, { includeArchived: opts.includeArchived === true })
    .map((session) => ({
      sessionKey: sessionIdToKey(session.id),
      id: session.id,
      displayName: session.displayName,
      createdAt: session.createdAt,
      lastModified: session.lastModified,
      messageCount: session.messageCount,
      runtimeKind: session.runtimeKind,
      archived: session.archived,
      pinned: session.pinned,
    }));

  return { sessions };
}

export async function readPersistedHawkySession(
  opts: HawkyMcpSessionReadOptions,
): Promise<HawkyMcpSessionReadResult | null> {
  const sessionKey = opts.sessionKey.trim();
  if (!sessionKey) return null;

  const sessionId = resolvePersistedSessionId(sessionKey);
  if (!sessionId) return null;
  const manager = new SessionManager(sessionId);
  const data = manager.loadSession();
  if (!data) return null;

  const total = data.messages.length;
  const limit = clampInteger(opts.limit, DEFAULT_SESSION_READ_LIMIT, 1, MAX_SESSION_READ_LIMIT);
  const endIndex = opts.beforeIndex !== undefined
    ? Math.max(0, Math.min(Math.floor(opts.beforeIndex), total))
    : total;
  const startIndex = Math.max(0, endIndex - limit);
  const messages = data.messages
    .slice(startIndex, endIndex)
    .map((msg, offset) => toTranscriptMessage(msg, startIndex + offset));
  const transcript = messages
    .map((msg) => `[${msg.index}] ${msg.role}${msg.timestamp ? ` ${msg.timestamp}` : ""}: ${msg.text}`)
    .join("\n\n");

  return {
    sessionKey,
    total,
    startIndex,
    endIndex,
    hasMore: startIndex > 0,
    messages,
    transcript,
  };
}

function resolvePersistedSessionId(sessionKey: string): string | null {
  const requestedId = sessionKeyToId(sessionKey);
  const sessions = listSessions(Number.MAX_SAFE_INTEGER, { includeArchived: true });
  const match = sessions.find((session) =>
    session.id === requestedId || sessionIdToKey(session.id) === sessionKey,
  );
  return match?.id ?? null;
}

export function createHawkyMcpServer(context: HawkyMcpContext = {}): Server {
  const server = new Server(
    { name: HAWKY_MCP_SERVER_NAME, version: HAWKY_MCP_SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        "Read-only Hawky tools. Use hawky_session_list to discover sessions, " +
        "hawky_session_read to inspect persisted session transcript, and hawky_echo for connectivity checks.",
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: listHawkyMcpTools(),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => (
    callHawkyMcpTool(
      request.params.name,
      request.params.arguments ?? {},
      context,
    )
  ));

  return server;
}

export async function runHawkyMcpStdioServer(context: HawkyMcpContext = {}): Promise<void> {
  const server = createHawkyMcpServer(context);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function toTranscriptMessage(message: ChatMessage, index: number): HawkyMcpTranscriptMessage {
  const text = message.content
    .filter((block) => !(block as { internal_only?: boolean }).internal_only)
    .map(contentBlockToText)
    .filter((part) => part.length > 0)
    .join("\n");
  return {
    index,
    role: message.role,
    timestamp: message.timestamp,
    text: clipText(text || "(empty message)", MAX_MESSAGE_TEXT_CHARS),
  };
}

function contentBlockToText(block: ContentBlock): string {
  switch (block.type) {
    case "text":
      return block.display_text ?? block.text;
    case "thinking":
      return "";
    case "tool_use":
      return `[tool_use ${block.name}: ${safeJson(block.input)}]`;
    case "tool_result":
      return `[tool_result ${block.tool_use_id}${block.is_error ? " error" : ""}: ${toolResultContentToText(block.content)}]`;
    case "image":
      return "[image attached]";
    case "document":
      return `[document attached: ${block.title ?? "document"}]`;
  }
}

function toolResultContentToText(content: ToolResultContent): string {
  if (typeof content === "string") return content;
  return content.map((block) => {
    if (block.type === "text") return block.text;
    if (block.type === "image") return "[image result]";
    return `[document result: ${block.title ?? "document"}]`;
  }).join("\n");
}

function sessionIdToKey(id: string): string {
  if (id.includes("/")) return id.replace("/", ":");
  if (!id.startsWith("gw-")) return id;
  const rest = id.slice(3);
  const firstDash = rest.indexOf("-");
  if (firstDash === -1) return rest;
  return `${rest.slice(0, firstDash)}:${rest.slice(firstDash + 1)}`;
}

function mcpText(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function mcpJson(value: unknown): CallToolResult {
  return mcpText(JSON.stringify(value, null, 2));
}

function mcpError(message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}

function clipText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[truncated]`;
}
