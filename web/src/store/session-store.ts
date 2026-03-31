// =============================================================================
// Session Store (Zustand)
//
// Manages the session list, active session, streaming state, and message
// sending. Subscribes to gateway events for real-time streaming.
// =============================================================================

import { create } from "zustand";
import { useSocketStore } from "./socket-store";
import type { EventFrame } from "@hawky/protocol";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export type RuntimeKind = "native" | "codex" | "hermes" | "claude";

export interface SessionInfo {
  id: string;
  key: string;
  createdAt: string;
  messageCount: number;
  active: boolean;
  isSystem: boolean;
  displayName?: string | null;
  pinned?: boolean;
  archived?: boolean;
  /** Last observed context-window occupancy (0-100). Drives the sidebar ring. */
  contextUsagePercent?: number | null;
  /**
   * Last observed session token totals (for the chat footer on cold load).
   * cacheRead / cacheCreation are optional for back-compat with older
   * server payloads — UI sums all four buckets when displaying total
   * input so prompt-caching engagement doesn't make the conversation
   * appear to have shrunk.
   */
  sessionTokens?: { input: number; output: number; cacheRead?: number; cacheCreation?: number } | null;
  /** Last observed cumulative cost in USD (for the chat footer on cold load). */
  sessionCostUSD?: number | null;
  runtimeKind?: RuntimeKind;
  runtimeCapabilities?: {
    streaming: boolean;
    mcp: boolean;
    attachments: boolean;
    permissions: boolean;
    usage: boolean;
    structuredHistory: boolean;
  };
}

export interface SessionMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  timestamp?: string;
  /** Absolute message index in the backend session history. Set by
   *  parseHistoryMessages from the server's response so the client can
   *  pass it directly to chat.rewind without any counting from the start.
   *  Undefined for optimistic messages (just-typed user bubbles waiting
   *  to be confirmed) — those can't be rewound to until the next history
   *  refresh syncs the index. */
  backendIndex?: number;
  /** Image attachments (for user messages with images) */
  images?: Array<{ base64: string; media_type: string }>;
  /** Document attachments (for user messages with PDFs). Base64 is not
   *  held client-side after send — we only keep lightweight metadata for
   *  the chat-pill rendering, mirroring how persisted history is scrubbed. */
  documents?: Array<{ media_type: string; filename: string; sizeBytes: number }>;
  /** Tool-specific data (only when role === "tool") */
  tool?: {
    toolUseId: string;
    name: string;
    inputPreview: string;
    /** Pre-rendered display string for the expanded row — e.g. a full bash
     *  command or file path. Capped at MAX_FULL_INPUT_CHARS so a single
     *  giant `edit_file` can't push megabytes of old_string/new_string
     *  into the Zustand store / session cache. */
    fullInput?: string;
    status: "running" | "success" | "error";
    output: string;
    isError: boolean;
    metadata?: Record<string, unknown>;
    startedAt?: number;
    batchId?: string;
  };
  /**
   * If set, this `system`-role message is a slash-command output (e.g.
   * "/help", "/cron"). ChatView renders these with body typography + a
   * small command chip + markdown rendering instead of the small italic
   * toast styling used for plain notifications.
   */
  command?: string;
}

export type AgentStatus = "idle" | "thinking" | "streaming" | "compacting" | "error";

/** Pagination state for the active session's message history (cursor-based). */
export interface SessionHistoryMeta {
  /**
   * Absolute backend index of the oldest message we've loaded, or null if
   * no messages have been loaded yet. Used as the `beforeIndex` cursor when
   * fetching older chunks — stable under live message arrivals (no drift).
   */
  oldestLoadedIndex: number | null;
  /** Whether older messages still exist beyond what we've loaded. */
  hasMore: boolean;
  /** True while a loadOlderMessages request is in flight (prevents duplicate fetches). */
  loadingOlder: boolean;
}

/**
 * Snapshot of a session's TaskStore (matches the backend shape at
 * src/agent/task_store.ts::TaskSummary). Populated by the `task.list`
 * RPC on session open and live-updated by `task.update` broadcasts.
 */
export type SessionTaskStatus = "pending" | "in_progress" | "completed";

export interface SessionTask {
  id: string;
  description: string;
  status: SessionTaskStatus;
  created_at: string;
}

export interface TaskSummary {
  tasks: SessionTask[];
  total: number;
  completed: number;
  in_progress: number;
  pending: number;
}

/** Cached state for a background session (saved on switch-away, restored on switch-back). */
export interface PerSessionCache {
  messages: SessionMessage[];
  agentStatus: AgentStatus;
  statusLabel: string;
  contextUsagePercent: number | null;
  sessionTokens: { input: number; output: number; cacheRead?: number; cacheCreation?: number } | null;
  sessionCostUSD: number | null;
  /** Per-session last-turn diagnostics — same shape as the top-level
   *  store fields but scoped here so switching sessions doesn't show
   *  stale data from another chat in the footer. */
  lastTurnUsage: { input: number; output: number; cacheRead: number; cacheCreation: number } | null;
  lastTurnCostUSD: number | null;
  pendingPermission: PendingPermission | null;
  pendingAskUser: PendingAskUser | null;
  /** Per-session task summary. Null until task.list RPC returns or a
   *  task.update event arrives. Empty summary = session has no tasks. */
  taskSummary: TaskSummary | null;
  /** Per-session permission mode. Null until the first
   *  permission.mode fetch returns or a permission.mode.changed event
   *  arrives. The bypass indicator reads from this. */
  permissionMode: "default" | "accept-edits" | "bypass" | null;
  /** True when the current bypass came from the gateway-level
   *  --dangerously-skip-permissions flag. The indicator distinguishes
   *  this case because clicking the pill can't disable it (gateway
   *  must restart). */
  forceBypass: boolean;
}

/** Empty PerSessionCache used as `cached ?? EMPTY_PER_SESSION_CACHE` when
 *  patching a non-existent cache entry. Centralised to keep the field set
 *  in sync with the interface — adding a new field above used to mean
 *  remembering to update 4+ inline `{ messages: [], ... }` literals. */
export const EMPTY_PER_SESSION_CACHE: PerSessionCache = Object.freeze({
  messages: [],
  agentStatus: "idle",
  statusLabel: "",
  contextUsagePercent: null,
  sessionTokens: null,
  sessionCostUSD: null,
  lastTurnUsage: null,
  lastTurnCostUSD: null,
  pendingPermission: null,
  pendingAskUser: null,
  taskSummary: null,
  permissionMode: null,
  forceBypass: false,
}) as PerSessionCache;

export interface PendingPermission {
  requestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  /** Server-computed diff preview for file edit tools */
  diffPreview?: { hunks: Array<{ oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }>; matchLine: number } | null;
  /** Context-aware suggestions (e.g., "switch to acceptEdits", "allow edits in folder") */
  suggestions?: Array<{ type: string; mode?: string; directory?: string }>;
  /**
   * Server-computed allow-rule suggestion (e.g., `Bash(git log *)`).
   * Powers the "Allow `<pattern>` always" button — clicking sends the
   * pattern back so the cache stores it as a rule instead of an
   * exact-match grant. The legacy "Always allow this command" button
   * still works for users who want a literal grant.
   */
  suggestedPattern?: string;
}

export interface PendingAskUser {
  requestId: string;
  question: string;
  options: string[];
}

export interface NotificationItem {
  /** Server-assigned id used for dedup / dismiss. */
  id: string;
  /** Session this notification targets. */
  sessionKey: string;
  /** Source of the notification — "heartbeat", "cron:...", etc. */
  origin: string;
  /** Short label, e.g. "Heartbeat Update". */
  title: string;
  /** Notification body text. */
  body: string;
  /** ISO timestamp — also used to interleave with chat messages by time. */
  timestamp: string;
}

interface SessionState {
  sessions: SessionInfo[];
  activeKey: string;
  messages: SessionMessage[];
  loading: boolean;
  agentStatus: AgentStatus;
  /** Short label describing what the agent is currently doing (e.g., "Reading file...") */
  statusLabel: string;
  contextUsagePercent: number | null;
  /** Session token usage for display */
  sessionTokens: { input: number; output: number; cacheRead?: number; cacheCreation?: number } | null;
  /** Session cost estimate (USD) */
  sessionCostUSD: number | null;
  /** Diagnostics for the most recent agent turn — what THE LAST API call
   *  billed (input split into non-cached / cache_read / cache_creation,
   *  plus output tokens) and what THAT call alone cost. Distinct from
   *  sessionTokens/sessionCostUSD which are cumulative. Useful for
   *  spot-checking prompt-cache effectiveness and per-turn spend. */
  lastTurnUsage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
  } | null;
  lastTurnCostUSD: number | null;
  /** Pending permission request (show dialog) */
  pendingPermission: PendingPermission | null;
  /** Pending ask_user request (show dialog) */
  pendingAskUser: PendingAskUser | null;
  /** Active session's TaskStore snapshot. null until the first
   *  task.list RPC completes or a task.update event is received.
   *  Used by the task chip in ChatView's header. */
  taskSummary: TaskSummary | null;
  /** Active session's permission mode. Null until the first
   *  permission.mode fetch completes or a permission.mode.changed
   *  event arrives. The bypass indicator pill reads from this. */
  permissionMode: "default" | "accept-edits" | "bypass" | null;
  /** True when the active session's bypass is from the gateway-level
   *  --dangerously-skip-permissions flag (clicking the indicator
   *  pill can't disable it; gateway has to restart). */
  forceBypass: boolean;
  /** Per-session unread message counts (key → count) */
  unreadCounts: Record<string, number>;
  /** Sessions with any unread activity — controls bold channel name (Slack-style) */
  hasUnread: Record<string, boolean>;
  /** Per-session state cache for background sessions */
  sessionCache: Record<string, PerSessionCache>;
  /**
   * Ephemeral, display-only notifications delivered via the
   * `notification.received` event (heartbeat summaries today, cron later).
   * These are NOT part of the conversation — they render as a distinct
   * card in the chat area and the model never sees them unless the user
   * manually copies them into the input. Not persisted across reloads.
   */
  notificationsBySession: Record<string, NotificationItem[]>;
  /** Message history pagination state for the active session (null until first load). */
  historyMeta: SessionHistoryMeta | null;
  /**
   * Orphan tool_results collected during history parsing — tool_result blocks
   * whose matching tool_use lives in an older, not-yet-loaded page. Used to
   * retroactively fill tool cards when that older chunk is fetched.
   */
  orphanToolResults: Record<string, { content: string; isError: boolean }>;
  /**
   * Per-tool_use_id input cache accumulated across all loaded history pages.
   * Lets the merged-window re-pass in loadOlderMessages synthesize diff
   * metadata for legacy tool_uses whose continuation lives in a newer page.
   * Keys are toolUseIds; values carry the name + raw input needed for
   * synthesizeMetadataFromInput. Grows monotonically as older pages load.
   */
  historyInputCache: Record<string, { name: string; input: Record<string, unknown> }>;

  // Actions
  fetchSessions: () => Promise<void>;
  switchSession: (key: string) => Promise<void>;
  /** Fetch the next older chunk of messages and prepend to the active session. */
  loadOlderMessages: () => Promise<void>;
  createChannel: (name: string, runtimeKind?: RuntimeKind) => Promise<void>;
  setActiveKey: (key: string) => void;
  sendMessage: (
    text: string,
    attachments?: Array<{ base64: string; media_type: string }>,
    documents?: Array<{ base64: string; media_type: string; filename?: string }>,
  ) => Promise<void>;
  /** Rewind the active session to a specific backend-history index,
   *  discarding everything from that message onward, then send a
   *  replacement. `messageIndex` is the absolute position in the
   *  server's session history — populated on each loaded SessionMessage
   *  as `backendIndex` by parseHistoryMessages. We use the absolute index
   *  rather than a "user-turn count" so the action works correctly even
   *  when the client only has a paginated subset of history loaded. */
  rewindAndSend: (messageIndex: number, newText: string) => Promise<void>;
  handleEvent: (event: EventFrame) => void;
  /** Cancel the running agent turn */
  cancelAgent: () => void;
  /** Resolve a pending permission request */
  resolvePermission: (decision: "allow_once" | "allow_always" | "accept_edits" | "allow_directory" | "deny", feedback?: string, pattern?: string) => void;
  /** Resolve a pending ask_user request */
  resolveAskUser: (answers: string[]) => void;
  /** Rename a session (set display name) */
  renameSession: (key: string, name: string) => Promise<void>;
  /** Archive a session (hide from list) */
  archiveSession: (key: string) => Promise<void>;
  /** Delete a session permanently */
  deleteSession: (key: string) => Promise<void>;
  /** Pin a session to the top */
  pinSession: (key: string) => Promise<void>;
  /** Unpin a session */
  unpinSession: (key: string) => Promise<void>;
  /** Dismiss a single ephemeral notification (by id) from its session's list. */
  dismissNotification: (sessionKey: string, id: string) => void;
  /** Clear all ephemeral notifications for a session (e.g., on "mark read"). */
  clearNotifications: (sessionKey: string) => void;
  /** Append a system-role message to the active session's chat thread.
   *  Used by web slash commands to surface their output inline. If
   *  `command` is provided, the message renders with body typography +
   *  a small `/command` chip; otherwise it uses the small italic
   *  notification styling. */
  addSystemMessage: (text: string, command?: string) => void;
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function idToKey(id: string): string {
  // New format: "web/general" → "web:general"
  if (id.includes("/")) return id.replace("/", ":");
  // Legacy format: "gw-web-general" → "web:general"
  if (id.startsWith("gw-")) {
    const rest = id.slice(3);
    const firstDash = rest.indexOf("-");
    if (firstDash === -1) return rest;
    return rest.slice(0, firstDash) + ":" + rest.slice(firstDash + 1);
  }
  return id;
}

function isSystemSession(key: string): boolean {
  return key.startsWith("heartbeat:") || key.startsWith("cron:") || key.startsWith("flush:");
}

let nextMsgId = 0;
function msgId(): string {
  return `msg-${++nextMsgId}`;
}

/**
 * Monotonic counter bumped on every switchSession call. Fire-and-forget
 * RPCs that outlive their switch (e.g. task.list) capture their token
 * at launch and drop their result if a newer switch has happened —
 * prevents a slow-network case where a stale task.list response for
 * A → B → A could clobber the second-switch's state.
 */
let switchSessionTokenCounter = 0;

/**
 * Pull image + document attachment metadata out of a sibling `user.message`
 * broadcast and shape it to match the SessionMessage fields the renderer
 * reads (`images` / `documents`). Returns a partial so callers can spread
 * it into a message and omit the fields entirely when no attachments were
 * broadcast.
 *
 * Images carry base64 so the thumbnail renders identically to the sender's
 * optimistic bubble; documents carry metadata only (no base64) because PDF
 * pills only need filename/size — matching how local history stores them.
 */
function extractBroadcastAttachments(payload: unknown): Partial<Pick<SessionMessage, "images" | "documents">> {
  if (!payload || typeof payload !== "object") return {};
  const p = payload as Record<string, unknown>;
  const out: Partial<Pick<SessionMessage, "images" | "documents">> = {};

  if (Array.isArray(p.attachments)) {
    const images = p.attachments
      .filter((a): a is { base64: string; media_type: string } =>
        !!a && typeof a === "object" &&
        typeof (a as any).base64 === "string" &&
        typeof (a as any).media_type === "string")
      .map((a) => ({ base64: a.base64, media_type: a.media_type }));
    if (images.length > 0) out.images = images;
  }

  if (Array.isArray(p.documents)) {
    const docs = p.documents
      .filter((d): d is { media_type: string; filename?: unknown; sizeBytes?: unknown } =>
        !!d && typeof d === "object" && typeof (d as any).media_type === "string")
      .map((d) => ({
        media_type: d.media_type,
        filename: typeof d.filename === "string" ? d.filename : "document",
        sizeBytes: typeof d.sizeBytes === "number" ? d.sizeBytes : 0,
      }));
    if (docs.length > 0) out.documents = docs;
  }

  return out;
}

/** Format tool input as a short preview string */
function formatToolPreview(name: string, input: Record<string, unknown>): string {
  if (name === "bash" && typeof input.command === "string") {
    return input.command.length > 80 ? input.command.slice(0, 80) + "..." : input.command;
  }
  if (name === "read_file" && typeof input.file_path === "string") {
    return input.file_path as string;
  }
  if (name === "edit_file" && typeof input.file_path === "string") {
    return input.file_path as string;
  }
  if (name === "write_file" && typeof input.file_path === "string") {
    return input.file_path as string;
  }
  if (name === "glob" && typeof input.pattern === "string") {
    return input.pattern as string;
  }
  if (name === "grep" && typeof input.pattern === "string") {
    return input.pattern as string;
  }
  return JSON.stringify(input).slice(0, 60);
}

// Bounded display string for the expanded ToolLine row. We deliberately do
// NOT store the raw `block.input` object on every tool message — for
// edit_file/write_file that would keep the full old_string/new_string /
// content text in the Zustand store and per-session cache indefinitely,
// and long sessions with large file operations could eat megabytes of RAM.
// Instead, pre-extract just the field the UI actually renders, apply a
// generous cap, and throw away the rest.
const MAX_FULL_INPUT_CHARS = 10_000;
export function buildFullInput(name: string | undefined, input: unknown): string | undefined {
  if (!name) return undefined;
  if (!input || typeof input !== "object") return undefined;
  const inp = input as Record<string, unknown>;
  let text: string | undefined;
  switch (name) {
    case "bash":
    case "shell":
      if (typeof inp.command === "string") text = inp.command;
      break;
    case "read_file":
    case "read":
    case "edit_file":
    case "edit":
    case "write_file":
    case "write":
      if (typeof inp.file_path === "string") text = inp.file_path as string;
      break;
    case "glob":
      if (typeof inp.pattern === "string") text = inp.pattern as string;
      break;
    case "grep": {
      if (typeof inp.pattern === "string") {
        const p = typeof inp.path === "string" ? `  (in ${inp.path as string})` : "";
        text = `${inp.pattern as string}${p}`;
      }
      break;
    }
    case "web_search":
      if (typeof inp.query === "string") text = inp.query as string;
      break;
    case "web_fetch":
      if (typeof inp.url === "string") text = inp.url as string;
      break;
  }
  if (text === undefined) {
    // Unknown/custom tool — pretty-print so nothing is hidden, but still
    // bounded by the char cap below.
    try {
      text = JSON.stringify(inp, null, 2);
    } catch {
      return undefined;
    }
  }
  return text.length > MAX_FULL_INPUT_CHARS
    ? text.slice(0, MAX_FULL_INPUT_CHARS) + "\n… (truncated)"
    : text;
}

// Mirrors MAX_DIFF_METADATA_CHARS in src/tools/edit_file.ts and write_file.ts:
// the live tool path nulls out diff strings above this cap so structuredPatch
// doesn't lock the UI on a giant edit. Reload synthesis must respect the same
// budget — without it, an edit that streamed safely could freeze the page after
// a refresh because the full input text is still in the JSONL.
const MAX_DIFF_METADATA_CHARS = 50_000;

// Reconstruct enough metadata from a tool_use's input to keep DiffView and
// summary text working after a page reload. Live streaming sets `metadata`
// from the tool's result payload, but the JSONL `tool_result` block (Anthropic
// API format) carries only content/is_error/tool_use_id — `metadata` is lost.
// The assistant's tool_use block, however, still has the input fields, so we
// can resurrect old_string/new_string for edit_file and the new content for
// write_file. Line numbers in the diff start at 1 (no match_line on reload),
// which is cosmetic — colors and content are correct.
export function synthesizeMetadataFromInput(
  name: string | undefined,
  input: unknown,
): Record<string, unknown> | undefined {
  if (!name || !input || typeof input !== "object") return undefined;
  const inp = input as Record<string, unknown>;
  if (name === "edit_file") {
    const oldStr = inp.old_string;
    const newStr = inp.new_string;
    if (typeof oldStr !== "string" || typeof newStr !== "string") return undefined;
    if (oldStr.length > MAX_DIFF_METADATA_CHARS || newStr.length > MAX_DIFF_METADATA_CHARS) {
      return undefined;
    }
    return {
      file_path: typeof inp.file_path === "string" ? inp.file_path : "file",
      old_string: oldStr,
      new_string: newStr,
      lines_added: newStr.split("\n").length,
      lines_removed: oldStr.split("\n").length,
    };
  }
  if (name === "write_file") {
    const content = inp.content;
    if (typeof content !== "string") return undefined;
    if (content.length > MAX_DIFF_METADATA_CHARS) return undefined;
    return {
      file_path: typeof inp.file_path === "string" ? inp.file_path : "file",
      // We can't tell on reload whether the write was an overwrite or a
      // new file. Use `old_content: null` rather than "" — the renderer
      // (computeDiffLines) maps null → "" for the diff so it shows the
      // full content as added (new-file form), AND formatToolSummary
      // checks `old_content === null` specifically to emit the
      // "New file, N lines" summary on reload. With "" neither branch
      // fires and the row loses its summary line on refresh.
      old_content: null,
      new_content: content,
    };
  }
  return undefined;
}

// Per-session streaming state (replaces singleton for multi-session support)
interface StreamingState {
  streamingMsgId: string | null;
  streamingText: string;
  replaceTargetMsgId: string | null;
  toolMsgMap: Map<string, string>;
  flushTimer: ReturnType<typeof setTimeout> | null;
}

const sessionStreaming = new Map<string, StreamingState>();

function getStreaming(sessionKey: string): StreamingState {
  let s = sessionStreaming.get(sessionKey);
  if (!s) {
    s = {
      streamingMsgId: null,
      streamingText: "",
      replaceTargetMsgId: null,
      toolMsgMap: new Map(),
      flushTimer: null,
    };
    sessionStreaming.set(sessionKey, s);
  }
  return s;
}

/**
 * Per-session "recently cancelled" flag. Set on `cancel` event, consumed by
 * the next `error` event — but ONLY if the error content matches a known
 * user-abort sentinel. Cleared aggressively (new send, `done`, non-abort
 * error, session switch) so the flag can't leak into the next turn and
 * suppress a genuine failure.
 */
const recentCancelBySession = new Map<string, boolean>();

/** Does the error content look like the backend's user-abort sentinel? */
function isUserAbortError(content: unknown): boolean {
  if (typeof content !== "string") return false;
  // The current backend sentinel is "Request aborted by user".
  // Accept close variants ("Request aborted by the user", "aborted by user")
  // but intentionally do NOT match "aborted before starting" or other
  // provider-side pre-abort errors — those need to surface to the user.
  return /aborted by (the )?user/i.test(content);
}

// Legacy aliases for active session (used by scheduleFlush and event handlers)
// These are updated to point to the active session's streaming state
let streamingMsgId: string | null = null;
let streamingText = "";
let streamingReplaceTargetMsgId: string | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

const FLUSH_INTERVAL_MS = 50;

function scheduleFlush(set: (fn: (state: SessionState) => Partial<SessionState>) => void) {
  if (flushTimer) return; // Already scheduled
  flushTimer = setTimeout(() => {
    flushTimer = null;
    if (streamingMsgId && streamingText) {
      const id = streamingMsgId;
      const text = streamingText;
      set((state) => ({
        messages: state.messages.map((m) =>
          m.id === id ? { ...m, content: text } : m,
        ),
      }));
    }
  }, FLUSH_INTERVAL_MS);
}

// Tool tracking: map tool_use_id → message ID (supports parallel tool calls)
let toolMsgMap = new Map<string, string>();

/** Generate a human-readable label for what the agent is doing with a tool.
 *  Includes a short preview of the input for context (like Claude.ai's
 *  "Re-crunching the crustacean data" style). */
function toolStatusLabel(toolName: string, input?: Record<string, unknown>): string {
  const preview = input ? getInputSnippet(toolName, input) : "";
  const suffix = preview ? ` — ${preview}` : "";

  switch (toolName) {
    case "bash": return `Running command${suffix}`;
    case "read_file": return `Reading${suffix || " file"}`;
    case "write_file": return `Writing${suffix || " file"}`;
    case "edit_file": return `Editing${suffix || " file"}`;
    case "glob": return `Searching files${suffix}`;
    case "grep": return `Searching code${suffix}`;
    case "web_search": return `Searching the web${suffix}`;
    case "web_fetch": return `Fetching${suffix || " page"}`;
    case "memory_get": return `Reading memory${suffix}`;
    case "memory_search": return `Searching memory${suffix}`;
    case "ask_user": return "Waiting for your input";
    case "cron": return `Managing cron${suffix}`;
    default: return `Using ${toolName}${suffix}`;
  }
}

/**
 * Parse a raw backend `session.history` response into UI-level `SessionMessage`s.
 * Splits each turn's content blocks into text bubbles and tool cards, merges
 * tool_result output into the preceding tool_use card, and collapses empty
 * tool-result turns that would otherwise render as blank user bubbles.
 *
 * Returns `orphanResults` too: a map of tool_use_ids whose `tool_result` block
 * appeared in this chunk but whose matching `tool_use` did NOT (the pair was
 * split across a pagination boundary — the tool_use lives in an older chunk).
 * Callers can apply these when an older chunk later loads.
 */
interface ParsedHistory {
  messages: SessionMessage[];
  orphanResults: Record<string, { content: string; isError: boolean }>;
  /** Per-tool_use_id input cache so the orphan applier (called with a
   *  later page's parse result) can synthesize diff metadata using the
   *  original tool_use input when stitching across pagination. */
  inputCache: Map<string, { name: string; input: Record<string, unknown> }>;
}

function parseHistoryMessages(raw: Array<any>): ParsedHistory {
  const messages: SessionMessage[] = [];
  const orphanResults: Record<string, { content: string; isError: boolean }> = {};
  const inputCache = new Map<string, { name: string; input: Record<string, unknown> }>();
  for (const msg of raw) {
    if (typeof msg.content === "string") {
      messages.push({
        id: msgId(),
        role: msg.role ?? "system",
        content: msg.content,
        timestamp: msg.timestamp,
        backendIndex: typeof msg.index === "number" ? msg.index : undefined,
      });
      continue;
    }
    if (!Array.isArray(msg.content)) continue;

    let textContent = "";
    const imageBlocks: Array<{ base64: string; media_type: string }> = [];
    const documentBlocks: Array<{ media_type: string; filename: string; sizeBytes: number }> = [];
    const hasToolResult = msg.content.some((b: any) => b.type === "tool_result");
    // Synthesize batchIds for *adjacent* runs of 2+ tool_use blocks only.
    // A run of tool_uses with no text between them is what the model emits
    // for a parallel call, and what the live pipeline tags with a real
    // batchId. Interleaved text between tool_uses is a sequential turn
    // with narration — those should stay as separate steps so ChatView
    // doesn't reorder the prose around them.
    const blocks: any[] = msg.content;
    const blockBatchIds: Array<string | undefined> = new Array(blocks.length).fill(undefined);
    let runStart = -1;
    for (let bi = 0; bi <= blocks.length; bi++) {
      const isToolUse = bi < blocks.length && blocks[bi]?.type === "tool_use";
      if (isToolUse) {
        if (runStart < 0) runStart = bi;
      } else if (runStart >= 0) {
        const runLen = bi - runStart;
        if (runLen >= 2) {
          const bid = `hist-${msgId()}`;
          for (let k = runStart; k < bi; k++) blockBatchIds[k] = bid;
        }
        runStart = -1;
      }
    }
    for (let bi = 0; bi < blocks.length; bi++) {
      const block = blocks[bi];
      const syntheticBatchId = blockBatchIds[bi];
      if (block.type === "image" && block.source?.type === "base64") {
        imageBlocks.push({ base64: block.source.data, media_type: block.source.media_type });
        continue;
      }
      if (block.type === "document" && block.source?.type === "base64") {
        const dataLen = typeof block.source.data === "string" ? block.source.data.length : 0;
        documentBlocks.push({
          media_type: block.source.media_type ?? "application/pdf",
          filename: typeof block.title === "string" && block.title ? block.title : "document",
          // Estimate raw bytes from base64 length so the pill can show size.
          sizeBytes: Math.ceil(dataLen * 3 / 4),
        });
        continue;
      }
      if (block.type === "text" && !hasToolResult) {
        textContent += block.text ?? "";
      } else if (block.type === "tool_use") {
        if (textContent.trim()) {
          messages.push({
            id: msgId(),
            role: msg.role ?? "assistant",
            content: textContent,
            timestamp: msg.timestamp,
          });
          textContent = "";
        }
        // Cache the input so a later tool_result (in this chunk OR a
        // newer chunk via the orphan stitcher) can synthesize diff
        // metadata. Do NOT synthesize here: a page reload that lands
        // mid-tool would otherwise show a fake completed diff for an
        // edit/write that hasn't finished and may still fail. (Codex P2.)
        const toolUseId = block.id ?? "";
        if (toolUseId) {
          inputCache.set(toolUseId, {
            name: block.name ?? "tool",
            input: (block.input ?? {}) as Record<string, unknown>,
          });
        }
        messages.push({
          id: msgId(),
          role: "tool",
          content: "",
          timestamp: msg.timestamp,
          tool: {
            toolUseId,
            name: block.name ?? "tool",
            inputPreview: formatToolPreview(block.name ?? "", block.input ?? {}),
            fullInput: buildFullInput(block.name, block.input),
            // Default to "running" — flips to success/error when the
            // matching tool_result is matched (this chunk or later).
            status: "running",
            output: "",
            isError: false,
            batchId: syntheticBatchId,
          },
        });
      } else if (block.type === "tool_result") {
        const content = typeof block.content === "string"
          ? block.content
          : Array.isArray(block.content)
            ? block.content.map((b: any) => b.text ?? "").join("")
            : "";
        const isError = block.is_error ?? false;
        let toolMsg: SessionMessage | undefined;
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].tool?.toolUseId === block.tool_use_id) {
            toolMsg = messages[i];
            break;
          }
        }
        if (toolMsg?.tool) {
          toolMsg.tool.output = content;
          toolMsg.tool.isError = isError;
          toolMsg.tool.status = isError ? "error" : "success";
          // Only synthesize the diff metadata once we know the tool
          // succeeded. The cached input from the matching tool_use lets
          // us reconstruct old_string/new_string for edit_file or the
          // new content for write_file. On error we leave metadata
          // undefined — DiffView won't render a fake hunk for a change
          // that never landed.
          if (!isError) {
            const cached = inputCache.get(block.tool_use_id);
            if (cached) {
              const meta = synthesizeMetadataFromInput(cached.name, cached.input);
              if (meta) toolMsg.tool.metadata = meta;
            }
          }
        } else if (block.tool_use_id) {
          // Orphan: tool_use must be in a chunk not yet loaded (older page).
          // Stash for cross-chunk linking when that chunk arrives.
          orphanResults[block.tool_use_id] = { content, isError };
        }
      }
    }
    if (textContent.trim() || imageBlocks.length > 0 || documentBlocks.length > 0) {
      const fallbackText = imageBlocks.length > 0
        ? "(image attached)"
        : documentBlocks.length > 0 ? "(PDF attached)" : "";
      messages.push({
        id: msgId(),
        role: msg.role ?? "assistant",
        content: textContent.trim() || fallbackText,
        timestamp: msg.timestamp,
        images: imageBlocks.length > 0 ? imageBlocks : undefined,
        documents: documentBlocks.length > 0 ? documentBlocks : undefined,
        backendIndex: typeof msg.index === "number" ? msg.index : undefined,
      });
    }
    if (!hasToolResult && (messages.length === 0 || messages[messages.length - 1].timestamp !== msg.timestamp)) {
      const fallback = msg.content.map((b: any) => b.text ?? b.content ?? "").join("");
      if (fallback.trim()) {
        messages.push({
          id: msgId(),
          role: msg.role ?? "system",
          content: fallback,
          timestamp: msg.timestamp,
        });
      }
    }
  }

  reclassifyLegacyRunningTools(messages, inputCache);

  return { messages, orphanResults, inputCache };
}

/**
 * Classify every "running" tool message as either still-in-flight or a
 * legacy tool whose result was never persisted. The unit of grouping
 * is the SOURCE ASSISTANT TURN: messages produced from one source msg
 * share its `timestamp`, and the trailing turn — defined by the
 * timestamp of the last message in the window — is the only turn that
 * can contain in-flight tools, because the agent cannot start a new
 * turn until the previous one's tools resolve.
 *
 * A tool in an earlier turn with status "running" must therefore be
 * legacy: flip it to "success" and synthesize diff metadata from the
 * cached input so a refreshed row doesn't spin forever. A tool in the
 * trailing turn stays "running" so the spinner keeps showing.
 *
 * Called in TWO places:
 *   1. End of parseHistoryMessages, on the single-page parse result.
 *   2. After loadOlderMessages merges an older page with the
 *      already-loaded window — otherwise a tool at the end of the
 *      older page (whose continuation lives in the newer page) stays
 *      "running" even though the newer page already proves it finished.
 *
 * **Only acts on tools that have a timestamp.** Live-streamed tool
 * messages (created from `agent.tool_use_start` WebSocket events) have
 * no timestamp; historical tool messages always do. Without this
 * guard, a mid-turn parallel batch that the user scrolls back through
 * would get its earlier tools wrongly flipped to "success" by the
 * merged-window re-pass — a real in-session regression (Codex P1 on
 * the principled-redesign pass). Leaving timestamp-less tools alone
 * preserves the live streaming state; historical reclassification
 * still works because historical messages carry timestamps.
 *
 * Why earlier rules (now retired) failed:
 *   - "any later message → completed": broke parallel in-flight
 *     batches (each tool_use had another tool_use after it).
 *   - "contiguous trailing tools only": broke interleaved
 *     tool_use → text → tool_use (same turn, same timestamp).
 *   - "fallback: only the last message is in-flight": broke paginated
 *     active sessions where live streaming messages have no timestamp.
 *
 * Mutates `messages` in place.
 */
function reclassifyLegacyRunningTools(
  messages: SessionMessage[],
  inputCache: Map<string, { name: string; input: Record<string, unknown> }>,
): void {
  if (messages.length === 0) return;
  // The trailing historical turn — walk backwards past any
  // timestamp-less (live-streaming) tail to find the last timestamped
  // message. This is what lets paginated active sessions still
  // reclassify their historical tools correctly: earlier historical
  // tools whose continuation is already loaded (but whose tool_result
  // is missing) flip to "success"; live tools on the tail are
  // untouched because they have no timestamp.
  let trailingHistoricalTs: string | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].timestamp !== undefined) {
      trailingHistoricalTs = messages[i].timestamp;
      break;
    }
  }
  // No timestamped messages at all (degenerate / test-only shape):
  // conservative default — leave everything alone.
  if (trailingHistoricalTs === undefined) return;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "tool" || !m.tool || m.tool.status !== "running") continue;
    // Skip timestamp-less tools — they're from live streaming, not
    // history parsing. Only historical messages carry timestamps.
    if (m.timestamp === undefined) continue;
    // In the trailing historical turn → in-flight.
    if (m.timestamp === trailingHistoricalTs) continue;
    // Earlier historical turn → must have completed.
    m.tool.status = "success";
    const cached = inputCache.get(m.tool.toolUseId);
    if (cached) {
      const meta = synthesizeMetadataFromInput(cached.name, cached.input);
      if (meta) m.tool.metadata = meta;
    }
  }
}

/**
 * Fill empty tool_use cards in a freshly parsed older chunk using the
 * orphan tool_results we collected from previously-loaded newer chunks.
 * Mutates `olderMessages` in place and deletes matched keys from `orphans`.
 *
 * `inputCache` comes from the SAME parse pass that produced `olderMessages`
 * — it lets us synthesize diff metadata for matched orphans using the
 * original tool_use input. Without this, an edit_file that completed
 * successfully would not get its diff back when stitched across pages.
 */
function applyOrphanResultsToOlder(
  olderMessages: SessionMessage[],
  orphans: Record<string, { content: string; isError: boolean }>,
  inputCache: Map<string, { name: string; input: Record<string, unknown> }>,
): void {
  for (const m of olderMessages) {
    if (m.role !== "tool" || !m.tool || m.tool.output) continue;
    const orphan = orphans[m.tool.toolUseId];
    if (!orphan) continue;
    m.tool.output = orphan.content;
    m.tool.isError = orphan.isError;
    m.tool.status = orphan.isError ? "error" : "success";
    // Always reset metadata to the truth dictated by the orphan result.
    // Important: the post-pass in parseHistoryMessages may have already
    // synthesized speculative metadata for this tool (assuming success).
    // If the orphan reveals an error, that speculative metadata MUST be
    // cleared, otherwise DiffView would render a fake green/red diff
    // for a failed edit. On success, re-synthesize so the metadata is
    // consistent with what actually shipped.
    if (orphan.isError) {
      m.tool.metadata = undefined;
    } else {
      const cached = inputCache.get(m.tool.toolUseId);
      if (cached) {
        const meta = synthesizeMetadataFromInput(cached.name, cached.input);
        m.tool.metadata = meta; // may be undefined for non-diffable tools
      }
    }
    delete orphans[m.tool.toolUseId];
  }
}

/** Extract a short snippet from tool input for the status label. */
function getInputSnippet(toolName: string, input: Record<string, unknown>): string {
  try {
    if (toolName === "bash" && typeof input.command === "string") {
      return input.command.length > 40 ? input.command.slice(0, 40) + "…" : input.command;
    }
    if ((toolName === "read_file" || toolName === "write_file" || toolName === "edit_file") && typeof input.file_path === "string") {
      const parts = (input.file_path as string).split("/");
      return parts[parts.length - 1]; // Just the filename
    }
    if (toolName === "glob" && typeof input.pattern === "string") {
      return input.pattern as string;
    }
    if (toolName === "grep" && typeof input.pattern === "string") {
      return `"${(input.pattern as string).slice(0, 30)}"`;
    }
    if (toolName === "web_search" && typeof input.query === "string") {
      return `"${(input.query as string).slice(0, 35)}"`;
    }
    if (toolName === "web_fetch" && typeof input.url === "string") {
      return (input.url as string).slice(0, 40);
    }
    if (toolName === "memory_get" && typeof input.path === "string") {
      return input.path as string;
    }
    if (toolName === "memory_search" && typeof input.query === "string") {
      return `"${(input.query as string).slice(0, 30)}"`;
    }
  } catch {}
  return "";
}

// -----------------------------------------------------------------------------
// Store
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// Unread state persistence
//
// Unread counts and hasUnread flags live only in-memory by default, so a page
// reload or opening a second tab loses every badge even though the user hasn't
// actually read those messages. Persist to localStorage per-device (the same
// pattern activeKey uses) so refresh/open-in-new-tab preserves the signal.
// Per-device is intentional: unread is a "needs my attention here" marker;
// reading on phone doesn't mean you've processed it on laptop.
// -----------------------------------------------------------------------------

const UNREAD_STORAGE_KEY = "hawky:unread";

interface PersistedUnread {
  counts: Record<string, number>;
  hasUnread: Record<string, boolean>;
}

function loadUnread(): PersistedUnread {
  try {
    const raw = localStorage.getItem(UNREAD_STORAGE_KEY);
    if (!raw) return { counts: {}, hasUnread: {} };
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { counts: {}, hasUnread: {} };
    }
    const counts =
      parsed.counts && typeof parsed.counts === "object" && !Array.isArray(parsed.counts)
        ? (parsed.counts as Record<string, number>)
        : {};
    const hasUnread =
      parsed.hasUnread && typeof parsed.hasUnread === "object" && !Array.isArray(parsed.hasUnread)
        ? (parsed.hasUnread as Record<string, boolean>)
        : {};
    return { counts, hasUnread };
  } catch {
    return { counts: {}, hasUnread: {} };
  }
}

function persistUnread(state: Pick<SessionState, "unreadCounts" | "hasUnread">): void {
  try {
    localStorage.setItem(
      UNREAD_STORAGE_KEY,
      JSON.stringify({ counts: state.unreadCounts, hasUnread: state.hasUnread }),
    );
  } catch {
    // Ignore quota / disabled storage — badges just stop surviving reloads in
    // this environment, no user-visible error is worth the noise.
  }
}

/**
 * Push the total unread count to the OS / PWA app badge. Negative "attention"
 * sentinels (-1) aren't meaningful counts, so filter them out before summing.
 */
function applyAppBadge(counts: Record<string, number>): void {
  try {
    const total = Object.values(counts).reduce(
      (a, b) => a + (b > 0 ? b : 0),
      0,
    );
    if (total > 0) navigator.setAppBadge?.(total);
    else navigator.clearAppBadge?.();
  } catch {
    // setAppBadge is optional API; silently ignore unsupported environments.
  }
}

const __initialUnread = loadUnread();
// On fresh module load (page refresh, new tab), reapply the OS badge from the
// persisted unread counts. Without this the sidebar would show unread channels
// while the installed PWA icon badge stayed cleared until some later mutation
// — a visible mismatch after every refresh.
applyAppBadge(__initialUnread.counts);

export const useSessionStore = create<SessionState>((set, get) => ({
  sessions: [],
  activeKey: (() => { try { return localStorage.getItem("hawky:activeKey") ?? "web:general"; } catch { return "web:general"; } })(),
  messages: [],
  loading: false,
  agentStatus: "idle",
  statusLabel: "",
  contextUsagePercent: null,
  sessionTokens: null,
  sessionCostUSD: null,
  lastTurnUsage: null,
  lastTurnCostUSD: null,
  pendingPermission: null,
  pendingAskUser: null,
  taskSummary: null,
  permissionMode: null,
  forceBypass: false,
  unreadCounts: __initialUnread.counts,
  hasUnread: __initialUnread.hasUnread,
  sessionCache: {},
  notificationsBySession: {},
  historyMeta: null,
  orphanToolResults: {},
  historyInputCache: {},

  cancelAgent: () => {
    const { rpc } = useSocketStore.getState();
    const activeKey = get().activeKey;
    rpc("chat.cancel", { sessionKey: activeKey }).catch(() => {});
    // Clear pending prompts locally (gateway also cancels them)
    set({ pendingPermission: null, pendingAskUser: null });
  },

  resolvePermission: (decision, feedback?, pattern?) => {
    const pending = get().pendingPermission;
    if (!pending) return;
    const { rpc } = useSocketStore.getState();
    rpc("permission.resolve", { requestId: pending.requestId, decision, feedback, pattern }).catch(() => {});
    set({ pendingPermission: null });
  },

  resolveAskUser: (answers) => {
    const pending = get().pendingAskUser;
    if (!pending) return;
    const { rpc } = useSocketStore.getState();
    rpc("ask_user.resolve", { requestId: pending.requestId, answers }).catch(() => {});
    set({ pendingAskUser: null });
  },

  fetchSessions: async () => {
    const { rpc } = useSocketStore.getState();
    try {
      const result = await rpc("session.list", { limit: 100 }) as any;
      if (!result?.sessions) return;

      const sessions: SessionInfo[] = result.sessions.map((s: any) => {
        const key = idToKey(s.id);
        return {
          id: s.id,
          key,
          createdAt: s.createdAt ?? "",
          messageCount: s.messageCount ?? 0,
          active: s.active ?? false,
          isSystem: isSystemSession(key),
          displayName: s.displayName ?? null,
          pinned: s.pinned ?? false,
          archived: s.archived ?? false,
          contextUsagePercent: s.contextUsagePercent ?? null,
          sessionTokens: s.sessionTokens ?? null,
          sessionCostUSD: s.sessionCostUSD ?? null,
          runtimeKind: s.runtimeKind ?? "native",
          runtimeCapabilities: s.runtimeCapabilities,
        };
      });

      sessions.sort((a, b) => {
        // System sessions always last
        if (a.isSystem !== b.isSystem) return a.isSystem ? 1 : -1;
        // Pinned sessions first (within non-system)
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        if (a.active !== b.active) return a.active ? -1 : 1;
        const knownPrefixes = ["web:", "tui:", "dev"];
        const aKnown = knownPrefixes.some((p) => a.key.startsWith(p));
        const bKnown = knownPrefixes.some((p) => b.key.startsWith(p));
        if (aKnown !== bKnown) return aKnown ? -1 : 1;
        if (a.messageCount !== b.messageCount) return b.messageCount - a.messageCount;
        return a.key.localeCompare(b.key);
      });

      // Do NOT prune unread state here. `session.list` is paginated (limit:
      // 100) and respects sidebar filters, so a session not in this response
      // may still be alive — just on a later page. Pruning based on absence
      // would silently drop legitimate unread badges for workspaces with
      // more than ~100 sessions. Stale entries for deleted sessions are
      // cleaned up in deleteSession (where we know the key is really gone)
      // and by the session.renamed handler below.
      set({ sessions });
    } catch {
      // Keep existing list
    }
  },

  switchSession: async (key: string) => {
    const { rpc } = useSocketStore.getState();
    const prevKey = get().activeKey;
    // Bump the token so any fire-and-forget from prior switches can
    // recognize itself as stale and drop its result.
    const myToken = ++switchSessionTokenCounter;

    // Save current session state + streaming state to cache before switching
    //
    // Skip when `prevKey` is no longer in the sidebar list — that
    // means it was just deleted or archived and we're being called
    // as the fallback-switch. Writing a cache entry for a
    // just-removed session would resurrect its stale
    // taskSummary/messages if the user later recreates a session
    // with the same key. (Codex P2.)
    const prevStillPresent =
      !!prevKey && get().sessions.some((s) => s.key === prevKey);
    if (prevKey && prevKey !== key && prevStillPresent) {
      const cache: PerSessionCache = {
        messages: get().messages,
        agentStatus: get().agentStatus,
        statusLabel: get().statusLabel,
        contextUsagePercent: get().contextUsagePercent,
        sessionTokens: get().sessionTokens,
        sessionCostUSD: get().sessionCostUSD,
        lastTurnUsage: get().lastTurnUsage,
        lastTurnCostUSD: get().lastTurnCostUSD,
        pendingPermission: get().pendingPermission,
        pendingAskUser: get().pendingAskUser,
        taskSummary: get().taskSummary,
        permissionMode: get().permissionMode,
        forceBypass: get().forceBypass,
      };
      // Save streaming state for the previous session
      const prevStreaming = getStreaming(prevKey);
      prevStreaming.streamingMsgId = streamingMsgId;
      prevStreaming.streamingText = streamingText;
      prevStreaming.replaceTargetMsgId = streamingReplaceTargetMsgId;
      prevStreaming.flushTimer = flushTimer;
      prevStreaming.toolMsgMap = toolMsgMap;

      set((state) => ({
        sessionCache: { ...state.sessionCache, [prevKey]: cache },
      }));
    }

    // Clear unread for the session being switched to
    const clearedUnread = { ...get().unreadCounts };
    delete clearedUnread[key];
    const clearedHasUnread = { ...get().hasUnread };
    delete clearedHasUnread[key];
    const totalUnread = Object.values(clearedUnread).reduce((a, b) => a + b, 0);
    try { if (totalUnread > 0) navigator.setAppBadge?.(totalUnread); else navigator.clearAppBadge?.(); } catch {}
    // Persist the cleared state so a refresh right after switching doesn't
    // resurrect the badge from localStorage.
    persistUnread({ unreadCounts: clearedUnread, hasUnread: clearedHasUnread });

    // Extract cached permission/ask_user data before deleting cache entry.
    // These will be restored after history hydration if still pending.
    const cachedEntry = get().sessionCache[key];
    const cachedPermission = cachedEntry?.pendingPermission ?? null;
    const cachedAskUser = cachedEntry?.pendingAskUser ?? null;

    // Remove session from cache (will be re-cached on next switch-away)
    const newCache = { ...get().sessionCache };
    delete newCache[key];

    // Always fetch fresh state from gateway — it's the source of truth.
    // Background event accumulation is only used for badges, not for content.
    // This guarantees no missing text, no stale state, no streaming gaps.

    // Fetch history from gateway. Don't block events — with multi-session
    // subscriptions, events are tagged with _sessionKey and routed correctly.
    streamingMsgId = null;
    streamingText = "";
    streamingReplaceTargetMsgId = null;
    toolMsgMap = new Map();
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }

    // Seed usage fields from the sidebar entry (backend-persisted) so the
    // footer renders immediately on cold load without waiting for a turn.
    const seed = get().sessions.find((s) => s.key === key);
    const seededContext = seed?.contextUsagePercent ?? null;
    const seededTokens = seed?.sessionTokens ?? null;
    const seededCost = seed?.sessionCostUSD ?? null;

    // Don't clear messages yet — keep old channel visible until new messages load.
    // Seed taskSummary from the target session's cache if we have one;
    // otherwise clear (the upcoming task.list RPC + task.update events
    // will populate it). Same for last-turn diagnostics — restore from
    // cache if we've previously seen a turn complete in this session, or
    // null on cold load (the next turn's done event will populate them).
    const targetCachedTaskSummary = cachedEntry?.taskSummary ?? null;
    const targetCachedLastTurnUsage = cachedEntry?.lastTurnUsage ?? null;
    const targetCachedLastTurnCostUSD = cachedEntry?.lastTurnCostUSD ?? null;
    const targetCachedPermissionMode = cachedEntry?.permissionMode ?? null;
    const targetCachedForceBypass = cachedEntry?.forceBypass ?? false;
    set({ loading: true, activeKey: key, agentStatus: "idle", contextUsagePercent: seededContext, sessionTokens: seededTokens, sessionCostUSD: seededCost, lastTurnUsage: targetCachedLastTurnUsage, lastTurnCostUSD: targetCachedLastTurnCostUSD, pendingPermission: null, pendingAskUser: null, taskSummary: targetCachedTaskSummary, permissionMode: targetCachedPermissionMode, forceBypass: targetCachedForceBypass, unreadCounts: clearedUnread, hasUnread: clearedHasUnread, sessionCache: newCache });

    try {
      // Web clients don't need session.resolve — subscription registry handles event routing.
      // Skipping it avoids WS rebinding which can cause event loss during the handshake.
      if (get().activeKey !== key) return;

      // Kick off task.list in PARALLEL with session.history. task.list
      // is a non-critical seed for the chip; blocking the main render
      // on it means a slow/unavailable task RPC stalls opening any
      // session. Fire-and-forget: apply whenever it resolves, under a
      // race guard (activeKey matches + current summary still the
      // seed so we don't regress a live task.update event).
      void rpc("task.list", { sessionKey: key }).then((taskResult) => {
        // Drop the result if a newer switch has happened — even if
        // activeKey still matches (user went A → B → A and this is
        // the response from the first A → ?, which is now stale).
        if (myToken !== switchSessionTokenCounter) return;
        if (get().activeKey !== key) return;
        const summary = (taskResult as any)?.summary as TaskSummary | undefined;
        if (!summary) return;
        set((state) => {
          const liveSummary = state.taskSummary;
          if (liveSummary !== targetCachedTaskSummary) return state; // event beat us
          return { ...state, taskSummary: summary };
        });
      }).catch(() => {
        // RPC not available — chip stays on whatever task.update events populate.
      });

      // Same shape: fetch the active session's permission mode so
      // the bypass indicator renders immediately on session-switch.
      // Subsequent permission.mode.changed broadcasts keep it live.
      void rpc("permission.mode", { sessionKey: key }).then((modeResult) => {
        if (myToken !== switchSessionTokenCounter) return;
        if (get().activeKey !== key) return;
        const mode = (modeResult as any)?.mode as "default" | "accept-edits" | "bypass" | undefined;
        const force = !!(modeResult as any)?.forceBypass;
        if (!mode) return;
        set((state) => {
          // Don't clobber a more-recent change broadcast.
          if (state.permissionMode !== targetCachedPermissionMode) return state;
          return { ...state, permissionMode: mode, forceBypass: force };
        });
      }).catch(() => {
        // RPC not available — pill stays hidden until a broadcast arrives.
      });

      const historyResult = await rpc("session.history", {
        sessionKey: key,
        limit: 100,
      }) as any;

      if (get().activeKey !== key) return;

      const rawMessages = historyResult?.messages ?? [];
      const { messages, orphanResults: initialOrphans, inputCache: initialInputCache } =
        parseHistoryMessages(rawMessages);
      const historyMeta: SessionHistoryMeta = {
        oldestLoadedIndex: rawMessages.length > 0 ? rawMessages[0].index ?? null : null,
        hasMore: historyResult?.hasMore ?? false,
        loadingOlder: false,
      };

      // Fetch in-progress streaming text + any pending dialog (permission /
      // ask_user) the agent is blocked on. The pending-dialog payload is
      // what enables LATE-JOIN — a tab opened AFTER the original broadcast,
      // a second browser, or the iPhone after a screen-on. Without it, the
      // newly-attached client sees a busy agent but no UI to unblock it.
      let currentAgentStatus: AgentStatus = "idle";
      let currentTurnMsgId: string | null = null;
      let currentTurnText = "";
      let hydratedPermission: PendingPermission | null = null;
      let hydratedAskUser: PendingAskUser | null = null;
      // Discriminator for "server returned authoritative pending info"
      // vs "server doesn't expose pending info / RPC failed". Only when
      // the new fields are present in the response do we treat the
      // hydrated value (including null) as truth and override the cache.
      // Otherwise we fall back to the cached snapshot for back-compat
      // with older gateway builds.
      let pendingFieldsAuthoritative = false;
      try {
        const currentTurn = await rpc("session.currentTurn", { sessionKey: key }) as any;
        if (currentTurn?.streaming && currentTurn.text) {
          currentTurnMsgId = msgId();
          currentTurnText = currentTurn.text;
          messages.push({
            id: currentTurnMsgId,
            role: "assistant",
            content: currentTurnText,
          });
          currentAgentStatus = "streaming";
        } else if (currentTurn?.busy) {
          // Agent is in an active turn (e.g., executing tools) but not streaming
          // text right now. Show "thinking" so the user knows it's still working.
          currentAgentStatus = "thinking";
        }
        // The new gateway always returns BOTH pending fields (null when
        // nothing is pending). Presence of either key means we're talking
        // to a server that will give us the authoritative answer.
        if (currentTurn && typeof currentTurn === "object"
            && ("pendingPermission" in currentTurn || "pendingAskUser" in currentTurn)) {
          pendingFieldsAuthoritative = true;
        }
        if (currentTurn?.pendingPermission) {
          const p = currentTurn.pendingPermission;
          hydratedPermission = {
            requestId: p.requestId,
            toolName: p.tool ?? p.name ?? "tool",
            toolInput: typeof p.input === "object" && p.input !== null ? p.input : {},
            diffPreview: p.diffPreview ?? null,
            suggestions: Array.isArray(p.suggestions) ? p.suggestions : undefined,
            suggestedPattern: typeof p.suggestedPattern === "string" && p.suggestedPattern.trim()
              ? p.suggestedPattern
              : undefined,
          };
        }
        if (currentTurn?.pendingAskUser) {
          const a = currentTurn.pendingAskUser;
          hydratedAskUser = {
            requestId: a.requestId,
            question: a.question ?? "",
            options: Array.isArray(a.options) ? a.options : [],
          };
        }
      } catch {
        // RPC not available — no in-progress text
      }

      if (get().activeKey !== key) return;

      // Set up streaming state so incoming events APPEND to the currentTurn
      // message instead of creating a new one
      if (currentTurnMsgId) {
        streamingMsgId = currentTurnMsgId;
        streamingText = currentTurnText;
      }

      // Persist to localStorage only after history loaded successfully
      try { localStorage.setItem("hawky:activeKey", key); } catch {}

      // Ensure active session is in sidebar + restore cached permission/ask_user
      // Seed historyInputCache from this page's parse so a later
      // loadOlderMessages can still re-synthesize metadata for legacy
      // tool_uses that don't have a matching result in any loaded page.
      const seededInputCache: SessionState["historyInputCache"] = {};
      for (const [id, v] of initialInputCache) seededInputCache[id] = v;
      set((state) => {
        // task.list resolves via a fire-and-forget at the top of
        // switchSession (in parallel with session.history), so we
        // preserve whatever taskSummary is currently in state —
        // either the cached seed we set earlier, or a live value
        // from a task.update event that arrived during hydration.
        // Server-fresh pending state wins over the cached snapshot — the
        // server is authoritative about what the agent is currently
        // blocked on. When the server explicitly returns null (the
        // request was already resolved by another client), that null
        // must win too — otherwise we'd resurrect a stale dialog from
        // cache. The cache only fills the gap when the RPC is
        // unavailable / returns no pending fields at all (legacy
        // gateway, network failure).
        const base = {
          messages,
          loading: false,
          agentStatus: currentAgentStatus,
          pendingPermission: pendingFieldsAuthoritative ? hydratedPermission : cachedPermission,
          pendingAskUser: pendingFieldsAuthoritative ? hydratedAskUser : cachedAskUser,
          taskSummary: state.taskSummary,
          historyMeta,
          orphanToolResults: initialOrphans,
          historyInputCache: seededInputCache,
        };
        const exists = state.sessions.some((s) => s.key === key);
        if (exists) return base;
        return {
          ...base,
          sessions: [
            ...state.sessions,
            {
              id: key.replace(":", "/"),
              key,
              createdAt: new Date().toISOString(),
              messageCount: messages.length,
              active: true,
              isSystem: isSystemSession(key),
              runtimeKind: seed?.runtimeKind ?? "native",
            },
          ],
        };
      });

    } catch {
      // Clear persisted key on failure so refresh falls back to web:general
      try { localStorage.removeItem("hawky:activeKey"); } catch {}
      if (get().activeKey === key) {
        set({ loading: false, messages: [], historyMeta: null, orphanToolResults: {}, historyInputCache: {}, taskSummary: null });
      }
    }
  },

  loadOlderMessages: async () => {
    const { rpc } = useSocketStore.getState();
    const key = get().activeKey;
    const meta = get().historyMeta;
    if (!key || !meta || meta.loadingOlder || !meta.hasMore) return;
    if (meta.oldestLoadedIndex === null) return;

    // Mark as loading to prevent duplicate fetches from rapid scroll events
    set((state) => ({
      historyMeta: state.historyMeta ? { ...state.historyMeta, loadingOlder: true } : null,
    }));

    try {
      const result = await rpc("session.history", {
        sessionKey: key,
        limit: 100,
        beforeIndex: meta.oldestLoadedIndex,
      }) as any;

      // Bail if user switched sessions while fetch was in flight
      if (get().activeKey !== key) return;

      const rawOlder = result?.messages ?? [];
      const { messages: olderMessages, orphanResults: olderOrphans, inputCache: olderInputCache } =
        parseHistoryMessages(rawOlder);
      // New cursor = index of the oldest message we just received
      // (rawOlder[0] since the backend returns older→newer order within a page)
      const newOldestIndex =
        rawOlder.length > 0 ? rawOlder[0].index ?? meta.oldestLoadedIndex : meta.oldestLoadedIndex;

      // Cross-link: fill any empty tool cards in this older chunk using
      // tool_results we stashed earlier as orphans when parsing newer chunks.
      // The inputCache from the same parse pass lets us synthesize diff
      // metadata for successfully-stitched orphan results.
      // Matched keys are consumed so they don't linger in state.
      const remainingOrphans = { ...get().orphanToolResults };
      applyOrphanResultsToOlder(olderMessages, remainingOrphans, olderInputCache);
      // Merge any new orphans from this chunk for future (even-older) loads.
      const mergedOrphans = { ...remainingOrphans, ...olderOrphans };

      // Merge inputCaches across all loaded pages, then re-run the
      // reclassifier on the FULL merged window. Without this pass, a
      // legacy tool_use at the end of the older page (whose
      // continuation lives in the already-loaded newer page) stays
      // "running" forever — parseHistoryMessages saw it as trailing
      // in isolation, but the combined transcript proves otherwise.
      const mergedInputCacheMap = new Map<string, { name: string; input: Record<string, unknown> }>();
      for (const [id, v] of Object.entries(get().historyInputCache)) mergedInputCacheMap.set(id, v);
      for (const [id, v] of olderInputCache) mergedInputCacheMap.set(id, v);
      const mergedMessages = [...olderMessages, ...get().messages];
      reclassifyLegacyRunningTools(mergedMessages, mergedInputCacheMap);
      const mergedInputCache: SessionState["historyInputCache"] = {};
      for (const [id, v] of mergedInputCacheMap) mergedInputCache[id] = v;

      set((state) => ({
        messages: mergedMessages,
        orphanToolResults: mergedOrphans,
        historyInputCache: mergedInputCache,
        historyMeta: state.historyMeta
          ? {
              oldestLoadedIndex: newOldestIndex,
              hasMore: result?.hasMore ?? false,
              loadingOlder: false,
            }
          : null,
      }));
    } catch {
      // Reset loading flag on error so user can retry on next scroll
      set((state) => ({
        historyMeta: state.historyMeta ? { ...state.historyMeta, loadingOlder: false } : null,
      }));
    }
  },

  createChannel: async (name: string, runtimeKind = "native") => {
    const key = `web:${name.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;
    const { rpc } = useSocketStore.getState();

    try {
      const resolved = await rpc("session.resolve", { sessionKey: key, runtimeKind }) as
        | { runtimeKind?: RuntimeKind; runtimeCapabilities?: SessionInfo["runtimeCapabilities"] }
        | undefined;

      set((state) => ({
        sessions: [
          ...state.sessions.filter((s) => s.key !== key),
          {
            id: key.replace(":", "/"),
            key,
            createdAt: new Date().toISOString(),
            messageCount: 0,
            active: true,
            isSystem: false,
            runtimeKind: resolved?.runtimeKind ?? runtimeKind,
            runtimeCapabilities: resolved?.runtimeCapabilities,
          },
        ],
      }));

      await get().switchSession(key);
    } catch {
      // Creation failed
    }
  },

  setActiveKey: (key: string) => set({ activeKey: key }),

  sendMessage: async (
    text: string,
    attachments?: Array<{ base64: string; media_type: string }>,
    documents?: Array<{ base64: string; media_type: string; filename?: string }>,
  ) => {
    const { rpc } = useSocketStore.getState();
    const activeKey = get().activeKey;

    // A new turn is starting — clear any stale cancel flag so this turn's
    // first error (if any) is never accidentally suppressed.
    recentCancelBySession.delete(activeKey);

    // Clear unread for this session (user is actively engaged)
    const clearedUnread = { ...get().unreadCounts };
    delete clearedUnread[activeKey];
    const clearedHasUnread = { ...get().hasUnread };
    delete clearedHasUnread[activeKey];
    set({ unreadCounts: clearedUnread, hasUnread: clearedHasUnread });
    persistUnread(get());

    // Add user message optimistically (with image and document previews).
    // Note: no echo dedup needed — the gateway excludes this connection's
    // connId from the `user.message` broadcast, so only sibling clients
    // receive it. See src/gateway/agent-methods.ts (chat.send).
    const userMsgId = msgId();
    set((state) => ({
      messages: [...state.messages, {
        id: userMsgId,
        role: "user" as const,
        content: text,
        timestamp: new Date().toISOString(),
        images: attachments,
        documents: documents?.map((d) => ({
          media_type: d.media_type,
          filename: d.filename ?? "document",
          sizeBytes: Math.ceil(d.base64.length * 3 / 4),
        })),
      }],
      agentStatus: "thinking" as const,
      statusLabel: "Thinking...",
    }));

    // Fire-and-forget: don't await the RPC response. The chat.send RPC blocks
    // until the agent finishes, which can exceed the 30s RPC timeout for long
    // responses. Stream events (text, tool_use, done) arrive separately and
    // handle status transitions. The RPC response is just a confirmation.
    const rpcParams: Record<string, unknown> = { message: text, sessionKey: activeKey };
    if (attachments && attachments.length > 0) {
      rpcParams.attachments = attachments;
    }
    if (documents && documents.length > 0) {
      rpcParams.documents = documents;
    }
    rpc("chat.send", rpcParams).catch((err) => {
      // Only show error if agent hasn't started streaming yet.
      // If we're already streaming, the error is just the RPC timeout —
      // the actual response is arriving via events.
      if (get().activeKey === activeKey && get().agentStatus === "thinking") {
        set((state) => ({
          agentStatus: "idle" as const,
          messages: [...state.messages, {
            id: msgId(),
            role: "system" as const,
            content: `Error: ${err instanceof Error ? err.message : String(err)}`,
          }],
        }));
      }
    });
  },

  rewindAndSend: async (messageIndex: number, newText: string) => {
    const { rpc } = useSocketStore.getState();
    const activeKey = get().activeKey;
    if (!activeKey) return;

    // 1. Truncate the local view optimistically so the edit feels instant.
    //    Drop every message at-or-after the given backend index. If the
    //    server fails the rewind, switchSession will re-hydrate.
    set((state) => {
      const cutAt = state.messages.findIndex(
        (m) => typeof m.backendIndex === "number" && m.backendIndex >= messageIndex,
      );
      if (cutAt < 0) return {};
      return { messages: state.messages.slice(0, cutAt) };
    });

    // 2. Ask the gateway to do the authoritative rewind. The backend
    //    broadcasts session.rewound to sibling clients (excluding us,
    //    via connId match on the gateway side) so they refresh too.
    try {
      await rpc("chat.rewind", { sessionKey: activeKey, messageIndex });
    } catch (err) {
      // Rewind failed server-side — re-hydrate local view from the
      // authoritative history so we're not out of sync.
      await get().switchSession(activeKey);
      set((state) => ({
        messages: [...state.messages, {
          id: msgId(),
          role: "system" as const,
          content: `Rewind failed: ${err instanceof Error ? err.message : String(err)}`,
        }],
      }));
      return;
    }

    // 3. Fire the replacement message through the regular sendMessage
    //    path — reuses attachments / lane / broadcast logic, and the
    //    optimistic user bubble appears immediately. The backend will
    //    emit a `user_committed` event right after appending the new
    //    user message to history; our handleEvent picks that up and
    //    stamps `backendIndex` on the optimistic bubble.
    await get().sendMessage(newText);
  },

  handleEvent: (frame: EventFrame) => {
    const event = frame.event;
    const payload = frame.payload as any;
    const eventSessionKey = payload?._sessionKey as string | undefined;
    const activeKey = get().activeKey;

    // Session list changed — handle even during switching (must not be dropped)
    if (event === "session.updated") {
      void get().fetchSessions();
      return;
    }

    // Display-only notification (heartbeat today; cron later). Appended to
    // the target session's ephemeral notification list and rendered as a
    // distinct card — NOT added to messages and NOT counted toward the
    // normal unread badge (heartbeats shouldn't make channels "loud").
    if (event === "notification.received") {
      const n = payload as NotificationItem | undefined;
      if (!n?.id || !n.sessionKey) return;
      const MAX_NOTIFICATIONS_PER_SESSION = 50;
      set((state) => {
        const existing = state.notificationsBySession[n.sessionKey] ?? [];
        // Dedup by id (handles reconnect replays if we ever add them).
        if (existing.some((x) => x.id === n.id)) return state;
        const nextList = [...existing, n].slice(-MAX_NOTIFICATIONS_PER_SESSION);
        return {
          notificationsBySession: {
            ...state.notificationsBySession,
            [n.sessionKey]: nextList,
          },
        };
      });
      return;
    }

    // Session identity changed — remap all key-indexed state and refetch list.
    if (event === "session.renamed") {
      const oldKey = payload?.oldKey as string | undefined;
      const newKey = payload?.newKey as string | undefined;
      if (!oldKey || !newKey || oldKey === newKey) return;

      // Module-level streaming map (outside React state)
      const prevStream = sessionStreaming.get(oldKey);
      if (prevStream) {
        sessionStreaming.set(newKey, prevStream);
        sessionStreaming.delete(oldKey);
      }
      const prevCancelled = recentCancelBySession.get(oldKey);
      if (prevCancelled !== undefined) {
        recentCancelBySession.set(newKey, prevCancelled);
        recentCancelBySession.delete(oldKey);
      }

      set((state) => {
        const nextCache = { ...state.sessionCache };
        if (oldKey in nextCache) {
          nextCache[newKey] = nextCache[oldKey];
          delete nextCache[oldKey];
        }
        const nextHasUnread = { ...state.hasUnread };
        if (oldKey in nextHasUnread) {
          nextHasUnread[newKey] = nextHasUnread[oldKey];
          delete nextHasUnread[oldKey];
        }
        const nextUnreadCounts = { ...state.unreadCounts };
        if (oldKey in nextUnreadCounts) {
          nextUnreadCounts[newKey] = nextUnreadCounts[oldKey];
          delete nextUnreadCounts[oldKey];
        }
        const nextNotifications = { ...state.notificationsBySession };
        if (oldKey in nextNotifications) {
          nextNotifications[newKey] = nextNotifications[oldKey];
          delete nextNotifications[oldKey];
        }
        const nextActive = state.activeKey === oldKey ? newKey : state.activeKey;
        if (nextActive !== state.activeKey) {
          try { localStorage.setItem("hawky:activeKey", nextActive); } catch {}
        }
        return {
          sessionCache: nextCache,
          hasUnread: nextHasUnread,
          unreadCounts: nextUnreadCounts,
          notificationsBySession: nextNotifications,
          activeKey: nextActive,
        };
      });
      // Persist the remapped unread state so a refresh after rename finds
      // the badge on the new key, not the old one.
      persistUnread(get());

      void get().fetchSessions();
      return;
    }

    // Session history was truncated by chat.rewind — drop everything
    // beyond keptCount from whichever session's view we're holding (active
    // session's `messages` OR the background cache). Semantically it's
    // simpler than trying to compute the drop set from the local message
    // list: the backend tells us how many messages survived, so we just
    // trust that number.
    if (event === "session.rewound") {
      const targetKey = payload?.sessionKey as string | undefined;
      if (!targetKey) return;
      // Count of user-text + assistant-text messages the backend kept.
      // We translate that back to the UI message array by counting only
      // the user-role bubbles and the assistant-text rows — the frontend
      // may have expanded each assistant tool_use into its own row, so
      // the UI array is longer. Simplest correct behavior: refetch the
      // authoritative history from the backend after truncation.
      if (targetKey === activeKey) {
        void get().switchSession(activeKey);
      } else {
        // For background sessions, drop the cached view so next switch re-fetches
        set((state) => {
          if (!(targetKey in state.sessionCache)) return {};
          const next = { ...state.sessionCache };
          delete next[targetKey];
          return { sessionCache: next };
        });
      }
      return;
    }

    // Route background session events to cache (multi-session subscription)
    if (eventSessionKey && eventSessionKey !== activeKey) {
      // task.update is a silent state-sync event — it doesn't count
      // as unread activity and shouldn't bold the sidebar channel
      // name. Handle it before the unread-marking below; short-circuit
      // so the rest of the background flow (which assumes a
      // user-facing event) doesn't fire.
      if (event === "task.update" && payload?.summary) {
        const cached = get().sessionCache[eventSessionKey];
        set((state) => ({
          sessionCache: {
            ...state.sessionCache,
            [eventSessionKey]: {
              ...(cached ?? EMPTY_PER_SESSION_CACHE),
              taskSummary: payload.summary as TaskSummary,
            },
          },
        }));
        return;
      }

      // Background permission.mode.changed — silent state-sync,
      // store in cache so the indicator is correct when the user
      // switches in. Doesn't mark the session as unread.
      if (event === "permission.mode.changed" && typeof payload?.mode === "string") {
        const cached = get().sessionCache[eventSessionKey];
        set((state) => ({
          sessionCache: {
            ...state.sessionCache,
            [eventSessionKey]: {
              ...(cached ?? EMPTY_PER_SESSION_CACHE),
              permissionMode: payload.mode as "default" | "accept-edits" | "bypass",
              forceBypass: !!payload.forceBypass,
            },
          },
        }));
        return;
      }

      // Mark session as having unread activity (bold channel name)
      if (!get().hasUnread[eventSessionKey]) {
        set((state) => ({ hasUnread: { ...state.hasUnread, [eventSessionKey]: true } }));
        persistUnread(get());
      }

      const bgStreaming = getStreaming(eventSessionKey);

      if (event === "agent.text" && payload?.content) {
        const content = payload.content as string;
        const isReplacement = payload.replace === true;
        const replacementTargetId = isReplacement && !bgStreaming.streamingMsgId
          ? bgStreaming.replaceTargetMsgId
          : null;

        if (replacementTargetId) {
          bgStreaming.streamingMsgId = replacementTargetId;
          bgStreaming.replaceTargetMsgId = null;
        }

        // Accumulate in memory (not React state) — no deltas lost
        bgStreaming.streamingText = isReplacement
          ? content
          : bgStreaming.streamingText + content;

        // Create streaming message ID if first delta
        if (!bgStreaming.streamingMsgId) {
          bgStreaming.replaceTargetMsgId = null;
          bgStreaming.streamingMsgId = msgId();
          const cached = get().sessionCache[eventSessionKey];
          if (cached) {
            set((state) => ({
              sessionCache: {
                ...state.sessionCache,
                [eventSessionKey]: {
                  ...cached,
                  agentStatus: "streaming",
                  messages: [...cached.messages, {
                    id: bgStreaming.streamingMsgId!,
                    role: "assistant" as const,
                    content: bgStreaming.streamingText,
                  }],
                },
              },
            }));
          }
        }

        if (isReplacement) {
          if (bgStreaming.flushTimer) {
            clearTimeout(bgStreaming.flushTimer);
            bgStreaming.flushTimer = null;
          }
          const id = bgStreaming.streamingMsgId;
          const text = bgStreaming.streamingText;
          set((state) => {
            const cached = state.sessionCache[eventSessionKey];
            if (!cached || !id) return {};
            return {
              sessionCache: {
                ...state.sessionCache,
                [eventSessionKey]: {
                  ...cached,
                  messages: cached.messages.map((m) =>
                    m.id === id ? { ...m, content: text } : m,
                  ),
                },
              },
            };
          });
          return;
        }

        // Throttled flush to cache (same 50ms interval as active session)
        if (!bgStreaming.flushTimer) {
          bgStreaming.flushTimer = setTimeout(() => {
            bgStreaming.flushTimer = null;
            const cached = get().sessionCache[eventSessionKey];
            if (cached && bgStreaming.streamingMsgId) {
              const id = bgStreaming.streamingMsgId;
              const text = bgStreaming.streamingText;
              set((state) => ({
                sessionCache: {
                  ...state.sessionCache,
                  [eventSessionKey]: {
                    ...cached,
                    messages: cached.messages.map((m) =>
                      m.id === id ? { ...m, content: text } : m,
                    ),
                  },
                },
              }));
            }
          }, FLUSH_INTERVAL_MS);
        }
      }

      if (event === "agent.tool_use_start") {
        const cached = get().sessionCache[eventSessionKey];
        const baseMessages = cached?.messages ?? [];
        let messages = baseMessages;

        if (bgStreaming.streamingMsgId) {
          const id = bgStreaming.streamingMsgId;
          const text = bgStreaming.streamingText;
          if (bgStreaming.flushTimer) {
            clearTimeout(bgStreaming.flushTimer);
            bgStreaming.flushTimer = null;
          }
          messages = messages.map((m) => m.id === id ? { ...m, content: text } : m);
          bgStreaming.replaceTargetMsgId = id;
          bgStreaming.streamingMsgId = null;
          bgStreaming.streamingText = "";
        }

        const toolUseId = payload.tool_use_id ?? "";
        const toolId = msgId();
        bgStreaming.toolMsgMap.set(toolUseId, toolId);
        const input = payload.input ?? {};
        const tName = payload.name ?? "tool";
        set((state) => ({
          sessionCache: {
            ...state.sessionCache,
            [eventSessionKey]: {
              ...(cached ?? EMPTY_PER_SESSION_CACHE),
              agentStatus: "thinking",
              statusLabel: toolStatusLabel(tName, input as Record<string, unknown>),
              messages: [...messages, {
                id: toolId,
                role: "tool" as const,
                content: "",
                tool: {
                  toolUseId,
                  name: tName,
                  inputPreview: formatToolPreview(tName, input),
                  fullInput: buildFullInput(tName, input),
                  status: "running",
                  output: "",
                  isError: false,
                  startedAt: Date.now(),
                  batchId: payload.batchId,
                },
              }],
            },
          },
        }));
      }

      if (event === "agent.tool_streaming") {
        const streamToolId = bgStreaming.toolMsgMap.get(payload.tool_use_id ?? "");
        if (streamToolId) {
          const cached = get().sessionCache[eventSessionKey];
          const line = payload.content ?? "";
          set((state) => ({
            sessionCache: {
              ...state.sessionCache,
              [eventSessionKey]: {
                ...(cached ?? EMPTY_PER_SESSION_CACHE),
                messages: (cached?.messages ?? []).map((m) =>
                  m.id === streamToolId && m.tool
                    ? { ...m, tool: { ...m.tool, output: m.tool.output + line + "\n" } }
                    : m,
                ),
              },
            },
          }));
        }
      }

      if (event === "agent.tool_result") {
        const resultToolUseId = payload.tool_use_id ?? "";
        const resultMsgId = bgStreaming.toolMsgMap.get(resultToolUseId);
        if (resultMsgId) {
          bgStreaming.toolMsgMap.delete(resultToolUseId);
          const cached = get().sessionCache[eventSessionKey];
          set((state) => ({
            sessionCache: {
              ...state.sessionCache,
              [eventSessionKey]: {
                ...(cached ?? EMPTY_PER_SESSION_CACHE),
                messages: (cached?.messages ?? []).map((m) =>
                  m.id === resultMsgId && m.tool
                    ? {
                        ...m,
                        tool: {
                          ...m.tool,
                          status: payload.is_error ? "error" : "success",
                          output: payload.content ?? m.tool.output,
                          isError: payload.is_error ?? false,
                          metadata: payload.metadata,
                        },
                      }
                    : m,
                ),
              },
            },
          }));
        }
      }

      if (event === "agent.done") {
        // Final flush of any remaining text
        const cached = get().sessionCache[eventSessionKey];
        if (cached && bgStreaming.streamingMsgId) {
          const id = bgStreaming.streamingMsgId;
          const text = bgStreaming.streamingText;
          if (bgStreaming.flushTimer) {
            clearTimeout(bgStreaming.flushTimer);
            bgStreaming.flushTimer = null;
          }
          set((state) => ({
            sessionCache: {
              ...state.sessionCache,
              [eventSessionKey]: {
                ...cached,
                agentStatus: "idle",
                messages: cached.messages.map((m) =>
                  m.id === id ? { ...m, content: text } : m,
                ),
              },
            },
          }));
        } else if (cached) {
          set((state) => ({
            sessionCache: {
              ...state.sessionCache,
              [eventSessionKey]: { ...cached, agentStatus: "idle" },
            },
          }));
        }
        bgStreaming.streamingMsgId = null;
        bgStreaming.streamingText = "";
        bgStreaming.replaceTargetMsgId = null;
        bgStreaming.toolMsgMap.clear();

        // Mirror usage onto the sidebar entry so the context ring updates
        // live even when the user is looking at a different channel.
        const bgUsage = payload?.usage;
        const bgCtxPercent = bgUsage?.context_usage_percent ?? null;
        const bgTokens = bgUsage
          ? {
              input: bgUsage.input_tokens ?? 0,
              output: bgUsage.output_tokens ?? 0,
              cacheRead: bgUsage.cache_read_input_tokens ?? 0,
              cacheCreation: bgUsage.cache_creation_input_tokens ?? 0,
            }
          : null;
        const bgCostUSD = payload?.sessionCostUSD ?? null;
        if (bgCtxPercent !== null || bgTokens !== null || bgCostUSD !== null) {
          set((state) => ({
            sessions: state.sessions.map((s) =>
              s.key === eventSessionKey
                ? { ...s, contextUsagePercent: bgCtxPercent, sessionTokens: bgTokens, sessionCostUSD: bgCostUSD }
                : s,
            ),
          }));
        }

        // Unread badge
        const prev = get().unreadCounts[eventSessionKey] ?? 0;
        const newCounts = { ...get().unreadCounts, [eventSessionKey]: prev + 1 };
        set({ unreadCounts: newCounts });
        persistUnread(get());
        try {
          const total = Object.values(newCounts).reduce((a, b) => a + b, 0);
          navigator.setAppBadge?.(total);
        } catch {}
      }

      // Background user.message → append as user bubble in that session's cache.
      // The gateway excludes the sender from this broadcast, so anything we
      // receive here comes from a sibling client (other tab / iPhone / TUI).
      // Append unconditionally — no dedup needed.
      if (event === "user.message" && typeof payload?.text === "string") {
        const cached = get().sessionCache[eventSessionKey];
        const baseMessages = cached?.messages ?? [];
        const newMsg: SessionMessage = {
          id: msgId(),
          role: "user",
          content: payload.text,
          timestamp: payload.timestamp ?? new Date().toISOString(),
          ...extractBroadcastAttachments(payload),
        };
        const newCounts = { ...get().unreadCounts, [eventSessionKey]: (get().unreadCounts[eventSessionKey] ?? 0) + 1 };
        set((state) => ({
          unreadCounts: newCounts,
          sessionCache: {
            ...state.sessionCache,
            [eventSessionKey]: {
              ...(cached ?? EMPTY_PER_SESSION_CACHE),
              messages: [...baseMessages, newMsg],
            },
          },
        }));
        return;
      }

      // Background permission request → store payload in cache + show attention badge
      if (event === "permission.request") {
        const reqId = payload.requestId ?? payload._requestId ?? payload.id ?? "";
        const toolName = payload.tool ?? payload.name ?? payload.tool_name ?? "tool";
        const toolInput = payload.input ?? payload.tool_input ?? {};
        const permData: PendingPermission = {
          requestId: reqId,
          toolName,
          toolInput: typeof toolInput === "object" ? toolInput : {},
          diffPreview: payload.diffPreview ?? null,
          suggestions: Array.isArray(payload.suggestions) ? payload.suggestions : undefined,
          suggestedPattern: typeof payload.suggestedPattern === "string" && payload.suggestedPattern.trim()
            ? payload.suggestedPattern
            : undefined,
        };
        const cached = get().sessionCache[eventSessionKey];
        const newCounts = { ...get().unreadCounts, [eventSessionKey]: -1 };
        set((state) => ({
          unreadCounts: newCounts,
          sessionCache: {
            ...state.sessionCache,
            [eventSessionKey]: {
              ...(cached ?? EMPTY_PER_SESSION_CACHE),
              pendingPermission: permData,
            },
          },
        }));
        persistUnread(get());
      }

      // Background ask_user request → store payload in cache + show attention badge.
      // The gateway broadcasts the agent stream event as `agent.ask_user_request`
      // (via `agent.${event.type}`). The previous check for `ask_user.request`
      // — note the dot — never matched, so background ask_user prompts were
      // silently dropped: when the user later switched to that session no
      // dialog appeared. Permission requests don't have this bug because
      // ws-permission.ts broadcasts a literal `permission.request` event.
      if (event === "agent.ask_user_request") {
        const reqId = payload.requestId ?? payload._requestId ?? payload.id ?? "";
        const cached = get().sessionCache[eventSessionKey];
        const askData: PendingAskUser = {
          requestId: reqId,
          question: payload.question ?? "",
          options: payload.options ?? [],
        };
        const newCounts = { ...get().unreadCounts, [eventSessionKey]: -1 };
        set((state) => ({
          unreadCounts: newCounts,
          sessionCache: {
            ...state.sessionCache,
            [eventSessionKey]: {
              ...(cached ?? EMPTY_PER_SESSION_CACHE),
              pendingAskUser: askData,
            },
          },
        }));
        persistUnread(get());
      }
      return;
    }

    // Active-session task.update broadcast — refresh the chip state.
    if (event === "task.update" && payload?.summary) {
      set({ taskSummary: payload.summary as TaskSummary });
      return;
    }

    // Active-session permission.mode.changed broadcast — refresh
    // the bypass indicator state. Other clients (other tabs / TUI)
    // also see this and update in step.
    if (event === "permission.mode.changed" && typeof payload?.mode === "string") {
      set({
        permissionMode: payload.mode as "default" | "accept-edits" | "bypass",
        forceBypass: !!payload.forceBypass,
      });
      return;
    }

    // Active-session user.message broadcast — always from a sibling client
    // (gateway excludes the sender's connId), so append unconditionally.
    if (event === "user.message" && typeof payload?.text === "string") {
      set((state) => ({
        messages: [...state.messages, {
          id: msgId(),
          role: "user" as const,
          content: payload.text,
          timestamp: payload.timestamp ?? new Date().toISOString(),
          ...extractBroadcastAttachments(payload),
        }],
      }));
      return;
    }

    // Handle non-agent events (permission.request, ask_user.request)
    // These are broadcast by the gateway WITHOUT the "agent." prefix.
    if (event === "permission.request") {
      const reqId = payload.requestId ?? payload._requestId ?? payload.id ?? "";
      const toolName = payload.tool ?? payload.name ?? payload.tool_name ?? "tool";
      const toolInput = payload.input ?? payload.tool_input ?? {};
      set({
        pendingPermission: {
          requestId: reqId,
          toolName,
          toolInput: typeof toolInput === "object" ? toolInput : {},
          diffPreview: payload.diffPreview ?? null,
          suggestions: Array.isArray(payload.suggestions) ? payload.suggestions : undefined,
          suggestedPattern: typeof payload.suggestedPattern === "string" && payload.suggestedPattern.trim()
            ? payload.suggestedPattern
            : undefined,
        },
      });
      return;
    }
    if (event === "ask_user.request") {
      const reqId = payload.requestId ?? payload._requestId ?? payload.id ?? "";
      set({
        pendingAskUser: {
          requestId: reqId,
          question: payload.question ?? "",
          options: payload.options ?? [],
        },
      });
      return;
    }

    // Compaction events — lock/unlock input
    if (event === "compaction.started") {
      set({ agentStatus: "compacting", statusLabel: "Compacting context..." });
      return;
    }
    if (event === "compaction.completed") {
      set({ agentStatus: "idle", statusLabel: "" });
      return;
    }

    if (!event?.startsWith("agent.")) return;

    const type = event.slice(6); // Remove "agent." prefix

    switch (type) {
      case "user_committed": {
        // Backend just appended the user message to history at this index.
        // Find the optimistic user bubble we added in sendMessage (last
        // user-role message without backendIndex) and stamp it. This is
        // what makes the edit pencil appear on the just-sent message
        // without needing a session.history refetch.
        const idx = payload?.message_index;
        if (typeof idx !== "number") break;
        set((state) => {
          const msgs = [...state.messages];
          for (let i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i].role === "user" && msgs[i].backendIndex === undefined) {
              msgs[i] = { ...msgs[i], backendIndex: idx };
              break;
            }
          }
          return { messages: msgs };
        });
        break;
      }

      case "text": {
        const content = payload.content ?? "";
        const isReplacement = payload.replace === true;
        const replacementTargetId = isReplacement && !streamingMsgId
          ? streamingReplaceTargetMsgId
          : null;

        if (replacementTargetId) {
          streamingMsgId = replacementTargetId;
          streamingReplaceTargetMsgId = null;
        }

        if (!streamingMsgId) {
          streamingReplaceTargetMsgId = null;
          // First text chunk — create a new assistant message
          const id = msgId();
          streamingMsgId = id;
          streamingText = content;
          set((state) => ({
            agentStatus: "streaming",
            statusLabel: "Generating...",
            messages: [...state.messages, {
              id,
              role: "assistant",
              content: streamingText,
            }],
          }));
        } else if (isReplacement) {
          streamingText = content;
          const id = streamingMsgId;
          set((state) => ({
            agentStatus: "streaming",
            statusLabel: "Generating...",
            messages: state.messages.map((m) =>
              m.id === id ? { ...m, content: streamingText } : m,
            ),
          }));
        } else {
          // Append to existing streaming message (throttled)
          streamingText += content;
          scheduleFlush(set);
        }
        break;
      }

      case "tool_use_start": {
        // Commit any in-flight streaming text
        if (streamingMsgId) {
          const id = streamingMsgId;
          const text = streamingText;
          set((state) => ({
            messages: state.messages.map((m) =>
              m.id === id ? { ...m, content: text } : m,
            ),
          }));
          streamingReplaceTargetMsgId = id;
          streamingMsgId = null;
          streamingText = "";
        }

        // Add tool card (tracked by tool_use_id for parallel tool support)
        const toolId = msgId();
        const toolUseId = payload.tool_use_id ?? "";
        toolMsgMap.set(toolUseId, toolId);
        const input = payload.input ?? {};
        const tName = payload.name ?? "tool";
        set((state) => ({
          agentStatus: "thinking",
          statusLabel: toolStatusLabel(tName, input as Record<string, unknown>),
          messages: [...state.messages, {
            id: toolId,
            role: "tool",
            content: "",
            tool: {
              toolUseId,
              name: tName,
              inputPreview: formatToolPreview(tName, input),
              fullInput: buildFullInput(tName, input),
              status: "running",
              output: "",
              isError: false,
              startedAt: Date.now(),
              batchId: payload.batchId,
            },
          }],
        }));
        break;
      }

      case "tool_streaming": {
        const streamToolId = toolMsgMap.get(payload.tool_use_id ?? "");
        if (!streamToolId) break;
        const line = payload.content ?? "";
        set((state) => ({
          messages: state.messages.map((m) =>
            m.id === streamToolId && m.tool
              ? { ...m, tool: { ...m.tool, output: m.tool.output + line + "\n" } }
              : m,
          ),
        }));
        break;
      }

      case "tool_result": {
        const resultToolUseId = payload.tool_use_id ?? "";
        const resultMsgId = toolMsgMap.get(resultToolUseId);
        if (!resultMsgId) break;
        toolMsgMap.delete(resultToolUseId);
        set((state) => ({
          messages: state.messages.map((m) =>
            m.id === resultMsgId && m.tool
              ? {
                  ...m,
                  tool: {
                    ...m.tool,
                    status: payload.is_error ? "error" : "success",
                    output: payload.content ?? m.tool.output,
                    isError: payload.is_error ?? false,
                    metadata: payload.metadata,
                  },
                }
              : m,
          ),
        }));
        break;
      }

      case "done": {
        // Normal turn completion — clear any stale cancel flag so the
        // next turn's errors aren't accidentally suppressed.
        recentCancelBySession.delete(eventSessionKey ?? activeKey);
        toolMsgMap.clear();
        streamingReplaceTargetMsgId = null;
        // Finalize any remaining streaming text
        if (streamingMsgId) {
          const id = streamingMsgId;
          const text = streamingText;
          set((state) => ({
            messages: state.messages.map((m) =>
              m.id === id ? { ...m, content: text } : m,
            ),
          }));
          streamingMsgId = null;
          streamingText = "";
        }
        if (flushTimer) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }

        const usage = payload?.usage;
        const doneCtxPercent = usage?.context_usage_percent ?? null;
        // Preserve all four billed buckets so the footer can show total
        // input the model actually processed (input + cacheRead +
        // cacheCreation) instead of just the fresh-input slice — without
        // this, a long conversation looks like it shrank back to ~5K
        // the moment prompt caching engages.
        const doneTokens = usage ? {
          input: usage.input_tokens ?? 0,
          output: usage.output_tokens ?? 0,
          cacheRead: usage.cache_read_input_tokens ?? 0,
          cacheCreation: usage.cache_creation_input_tokens ?? 0,
        } : null;
        const doneCostUSD = payload?.sessionCostUSD ?? null;
        // Per-call diagnostics (debug footer). Distinct from the cumulative
        // sessionTokens/sessionCostUSD — these reflect ONLY the most recent
        // API call, useful for spot-checking prompt-cache effectiveness.
        const lastTurnUsageRaw = payload?.lastTurnUsage;
        const doneLastTurnUsage = lastTurnUsageRaw
          ? {
              input: lastTurnUsageRaw.input_tokens ?? 0,
              output: lastTurnUsageRaw.output_tokens ?? 0,
              cacheRead: lastTurnUsageRaw.cache_read_input_tokens ?? 0,
              cacheCreation: lastTurnUsageRaw.cache_creation_input_tokens ?? 0,
            }
          : null;
        const doneLastTurnCostUSD = payload?.lastTurnCostUSD ?? null;
        const updates: Partial<SessionState> = {
          agentStatus: "idle",
          contextUsagePercent: doneCtxPercent,
          sessionTokens: doneTokens,
          sessionCostUSD: doneCostUSD,
          lastTurnUsage: doneLastTurnUsage,
          lastTurnCostUSD: doneLastTurnCostUSD,
          pendingPermission: null,
          pendingAskUser: null,
        };

        // Mirror onto the sidebar entry so the context ring updates live
        // (not just the active session's footer).
        const sidebarKey = eventSessionKey ?? activeKey;
        if (sidebarKey) {
          updates.sessions = get().sessions.map((s) =>
            s.key === sidebarKey
              ? { ...s, contextUsagePercent: doneCtxPercent, sessionTokens: doneTokens, sessionCostUSD: doneCostUSD }
              : s,
          );
        }

        // Track unread when tab is hidden
        let persistAfterSet = false;
        if (typeof document !== "undefined" && document.hidden) {
          const key = get().activeKey;
          const prev = get().unreadCounts[key] ?? 0;
          updates.unreadCounts = { ...get().unreadCounts, [key]: prev + 1 };
          updates.hasUnread = { ...get().hasUnread, [key]: true };
          persistAfterSet = true;
          // PWA app badge
          try { navigator.setAppBadge?.(Object.values(updates.unreadCounts).reduce((a, b) => a + b, 0)); } catch {}
        }

        set(updates);
        if (persistAfterSet) persistUnread(get());
        break;
      }

      case "error": {
        streamingMsgId = null;
        streamingText = "";
        streamingReplaceTargetMsgId = null;
        // Suppress the follow-on abort error that the backend emits right
        // after a user-initiated cancel (otherwise the user sees "Generation
        // stopped" + "Error: Request aborted by user" together). Two gates:
        //   1. We just saw a cancel for this session (recent-cancel flag).
        //   2. The error content matches the known abort sentinel.
        // Either way, clear the flag — so a non-abort error after cancel
        // still surfaces, and a stale flag can't leak into the next turn.
        const cancelKey = eventSessionKey ?? activeKey;
        const hadRecentCancel = recentCancelBySession.get(cancelKey) === true;
        recentCancelBySession.delete(cancelKey);
        const suppress = hadRecentCancel && isUserAbortError(payload.content);
        set((state) => ({
          agentStatus: "idle",
          pendingPermission: null,
          pendingAskUser: null,
          messages: suppress
            ? state.messages
            : [...state.messages, {
                id: msgId(),
                role: "system",
                content: `Error: ${payload.content ?? "Unknown error"}`,
              }],
        }));
        break;
      }

      case "cancel": {
        // Mark this session as having just cancelled so the follow-on
        // abort-error from the backend (if any) can be suppressed by the
        // error handler. Consumed on next error event, so unrelated errors
        // later still surface.
        recentCancelBySession.set(eventSessionKey ?? activeKey, true);
        // Finalize streaming text (without appending "[cancelled]" — status indicator handles it)
        if (streamingMsgId) {
          const id = streamingMsgId;
          const text = streamingText;
          set((state) => ({
            messages: state.messages.map((m) =>
              m.id === id ? { ...m, content: text } : m,
            ),
          }));
        }
        streamingMsgId = null;
        streamingText = "";
        streamingReplaceTargetMsgId = null;
        // Add a system-level cancelled indicator
        set((state) => ({
          agentStatus: "idle",
          pendingPermission: null,
          pendingAskUser: null,
          messages: [...state.messages, {
            id: msgId(),
            role: "system",
            content: "■ Generation stopped.",
          }],
        }));
        break;
      }

      case "system_message": {
        set((state) => ({
          messages: [...state.messages, {
            id: msgId(),
            role: "system",
            content: payload.content ?? "",
          }],
        }));
        break;
      }

      case "permission_request": {
        // Field names vary by event path:
        // - Gateway broadcast: { requestId, tool, input, toolUseId }
        // - Generic agent.*: { _requestId, name, input, tool_use_id }
        const reqId = payload.requestId ?? payload._requestId ?? payload.id ?? "";
        const toolName = payload.tool ?? payload.name ?? payload.tool_name ?? "tool";
        const toolInput = payload.input ?? payload.tool_input ?? {};
        set({
          pendingPermission: {
            requestId: reqId,
            toolName,
            toolInput: typeof toolInput === "object" ? toolInput : {},
            diffPreview: payload.diffPreview ?? null,
          },
        });
        break;
      }

      case "ask_user_request": {
        const reqId = payload._requestId ?? payload.id ?? payload.tool_use_id ?? "";
        set({
          pendingAskUser: {
            requestId: reqId,
            question: payload.question ?? "",
            options: payload.options ?? [],
          },
        });
        break;
      }
    }
  },

  renameSession: async (key: string, name: string) => {
    const { rpc } = useSocketStore.getState();
    const trimmed = name.trim();
    const prefix = key.includes(":") ? key.split(":")[0] : "";
    // Deep rename for user sessions — the key IS the name. Singleton
    // sessions (heartbeat:, cron:) keep displayName as a label because
    // their keys are tied to external identities.
    const deepRenameable = trimmed.length > 0 && prefix !== "" && prefix !== "heartbeat" && prefix !== "cron";
    try {
      if (deepRenameable) {
        const newKey = `${prefix}:${trimmed}`;
        await rpc("session.rename", { sessionKey: key, newKey });
        // Server broadcasts session.renamed → handleEvent reconciles state.
      } else {
        // System session, or clearing the displayName (empty name).
        await rpc("session.rename", { sessionKey: key, displayName: trimmed });
        set((state) => ({
          sessions: state.sessions.map((s) =>
            s.key === key ? { ...s, displayName: trimmed || null } : s,
          ),
        }));
      }
    } catch {}
  },

  archiveSession: async (key: string) => {
    const { rpc } = useSocketStore.getState();
    try {
      await rpc("session.archive", { sessionKey: key });
      // Remove from visible list. Drop the cache entry too so a later
      // reactivation doesn't seed its chip from stale state (same
      // reasoning as deleteSession).
      const nextCache = { ...get().sessionCache };
      delete nextCache[key];
      set((state) => ({
        sessions: state.sessions.filter((s) => s.key !== key),
        sessionCache: nextCache,
      }));
      // If we archived the active session, switch to another
      if (get().activeKey === key) {
        const remaining = get().sessions.filter((s) => !s.isSystem && s.key !== key);
        if (remaining.length > 0) {
          void get().switchSession(remaining[0].key);
        } else {
          // No other sessions — create a fresh one (avoid re-opening the same key)
          void get().createChannel("new-chat");
        }
      }
    } catch {}
  },

  deleteSession: async (key: string) => {
    const { rpc } = useSocketStore.getState();
    try {
      await rpc("session.delete", { sessionKey: key });
      // Drop the session AND any unread state it had. fetchSessions can't
      // do this safely (pagination), so the explicit-delete path is where
      // we prune with confidence. Also recompute the OS badge so it
      // doesn't stay inflated by the just-removed entry.
      const nextUnread = { ...get().unreadCounts };
      const nextHasUnread = { ...get().hasUnread };
      delete nextUnread[key];
      delete nextHasUnread[key];
      // Also drop the cache entry so a future session with the same
      // key can't inherit the deleted session's taskSummary / state
      // during the switchSession seed-from-cache step.
      const nextCache = { ...get().sessionCache };
      delete nextCache[key];
      set((state) => ({
        sessions: state.sessions.filter((s) => s.key !== key),
        unreadCounts: nextUnread,
        hasUnread: nextHasUnread,
        sessionCache: nextCache,
      }));
      persistUnread(get());
      applyAppBadge(nextUnread);
      // If we deleted the active session, switch to another
      if (get().activeKey === key) {
        const remaining = get().sessions.filter((s) => !s.isSystem && s.key !== key);
        if (remaining.length > 0) {
          void get().switchSession(remaining[0].key);
        } else {
          // No other sessions — create a fresh one (avoid recreating the deleted key)
          void get().createChannel("new-chat");
        }
      }
    } catch {}
  },

  pinSession: async (key: string) => {
    const { rpc } = useSocketStore.getState();
    try {
      await rpc("session.pin", { sessionKey: key });
      set((state) => ({
        sessions: state.sessions.map((s) =>
          s.key === key ? { ...s, pinned: true } : s,
        ),
      }));
      // Re-sort after pinning
      void get().fetchSessions();
    } catch {}
  },

  unpinSession: async (key: string) => {
    const { rpc } = useSocketStore.getState();
    try {
      await rpc("session.unpin", { sessionKey: key });
      set((state) => ({
        sessions: state.sessions.map((s) =>
          s.key === key ? { ...s, pinned: false } : s,
        ),
      }));
      void get().fetchSessions();
    } catch {}
  },

  dismissNotification: (sessionKey: string, id: string) => {
    set((state) => {
      const list = state.notificationsBySession[sessionKey];
      if (!list) return state;
      const next = list.filter((n) => n.id !== id);
      if (next.length === list.length) return state;
      const map = { ...state.notificationsBySession };
      if (next.length === 0) delete map[sessionKey];
      else map[sessionKey] = next;
      return { notificationsBySession: map };
    });
  },

  clearNotifications: (sessionKey: string) => {
    set((state) => {
      if (!(sessionKey in state.notificationsBySession)) return state;
      const map = { ...state.notificationsBySession };
      delete map[sessionKey];
      return { notificationsBySession: map };
    });
  },

  addSystemMessage: (text: string, command?: string) => {
    set((state) => ({
      messages: [...state.messages, {
        id: msgId(),
        role: "system" as const,
        content: text,
        ...(command ? { command } : {}),
      }],
    }));
  },
}));
