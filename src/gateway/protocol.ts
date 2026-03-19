// =============================================================================
// Gateway WebSocket Protocol
//
// JSON-RPC-style wire format with 3 frame types:
//   RequestFrame  (client → server): RPC calls with correlation ID
//   ResponseFrame (server → client): Responses to requests
//   EventFrame    (server → client): Broadcast events (streaming, state changes)
//
// Pattern: a proven protocol/schema/frames.ts, simplified for single-user.
// =============================================================================

// -----------------------------------------------------------------------------
// Wire frames
// -----------------------------------------------------------------------------

/** Client → Server: RPC request with correlation ID */
export interface RequestFrame {
  type: "req";
  id: string;
  method: string;
  params?: unknown;
}

/** Server → Client: Response to a specific request */
export interface ResponseFrame {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { code: string; message: string };
}

/** Server → Client: Broadcast event (streaming, state changes) */
export interface EventFrame {
  type: "event";
  event: string;
  payload?: unknown;
  seq?: number;
}

export type Frame = RequestFrame | ResponseFrame | EventFrame;

// -----------------------------------------------------------------------------
// Connect params (sent with method="connect")
// -----------------------------------------------------------------------------

export interface ConnectParams {
  /** Client version string */
  version?: string;
  /** Client platform (e.g., "web", "tui", "mobile", "node-host") */
  platform?: string;
  /** Auth token (required for non-localhost connections) */
  token?: string;
  /** Initial session key to bind to */
  sessionKey?: string;
  /** Client's working directory (project context for tool execution) */
  workingDirectory?: string;
  /**
   * Stable per-client identifier. Multiple WS connections from the same
   * logical client (e.g. a browser opening a second socket via the PWA
   * service worker, or a transient reconnect that overlaps the old one)
   * should send the same clientId so the gateway can correctly exclude
   * ALL of them — not just the originating socket — when broadcasting
   * "echoes" of an action that client just performed (`user.message`,
   * `session.rewound`). Web mints this once into localStorage; TUI mints
   * one per process. If absent the gateway falls back to the per-conn
   * connId, which preserves legacy behavior for older clients.
   */
  clientId?: string;
  /** Connection role: "client" (default, UI) or "node" (tool execution host) */
  role?: "client" | "node";
  /** Node host metadata (only when role="node") */
  node?: {
    nodeId: string;
    name: string;
    commands: string[];
  };
  /** Ambient mode for this connection (default "quiet"). */
  mode?: "quiet" | "ambient" | "directive";
}

export interface HelloPayload {
  connId: string;
  serverVersion: string;
  methods: string[];
}

// -----------------------------------------------------------------------------
// Chat params
// -----------------------------------------------------------------------------

export interface ChatSendParams {
  message: string;
  sessionKey?: string;
}

// Broadcast events emitted on chat.send:
//   "user.message"  — emitted once, immediately, to SIBLING clients on the
//                     session (the sender is excluded by connId). Lets other
//                     tabs / devices render the user bubble without refreshing.
//                     Payload: { type, sessionKey, text, attachments?, timestamp, messageId }.
//                     `text` is the raw user input (never the system-reminder-wrapped form).
//                     `attachments` carries metadata only (media_type); base64 bytes are never broadcast.
//                     Because the sender never receives its own event, clients append unconditionally.
//   "agent.*"       — agent streaming events (text_delta, tool_use, done, ...).
//   "compaction.*" / "flush.*" — context management lifecycle events.
//   "task.update"   — emitted whenever the session's TaskStore changes
//                     (task_create / task_update / clearHistory). Payload:
//                     { type, sessionKey, summary: TaskSummary }. Lets the
//                     web task chip stay in sync without polling. The
//                     server-side bridge lives in AgentLoop's constructor
//                     (src/agent/loop.ts); the matching RPC `task.list`
//                     seeds the initial state on session open.

export interface ChatCancelParams {
  sessionKey?: string;
}

// -----------------------------------------------------------------------------
// Session params
// -----------------------------------------------------------------------------

export interface SessionResolveParams {
  sessionKey: string;
}

export interface SessionHistoryParams {
  sessionKey: string;
  limit?: number;
}

// -----------------------------------------------------------------------------
// Error codes
// -----------------------------------------------------------------------------

export const ErrorCodes = {
  INVALID_REQUEST: "INVALID_REQUEST",
  UNAUTHORIZED: "UNAUTHORIZED",
  NOT_FOUND: "NOT_FOUND",
  NO_SESSION: "NO_SESSION",
  GATEWAY_DRAINING: "GATEWAY_DRAINING",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  METHOD_NOT_FOUND: "METHOD_NOT_FOUND",
  HANDSHAKE_REQUIRED: "HANDSHAKE_REQUIRED",
} as const;

// -----------------------------------------------------------------------------
// Parsing
// -----------------------------------------------------------------------------

/**
 * Parse a raw WebSocket message into a RequestFrame.
 * Returns null if the message is not a valid request frame.
 */
export function parseFrame(raw: string | Buffer): RequestFrame | null {
  try {
    const data = typeof raw === "string" ? raw : raw.toString("utf-8");
    const parsed = JSON.parse(data);
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.type !== "req") return null;
    if (typeof parsed.id !== "string" || !parsed.id) return null;
    if (typeof parsed.method !== "string" || !parsed.method) return null;
    return parsed as RequestFrame;
  } catch {
    return null;
  }
}

/**
 * Serialize a frame to a JSON string for sending over WebSocket.
 */
export function serializeFrame(frame: ResponseFrame | EventFrame): string {
  return JSON.stringify(frame);
}
