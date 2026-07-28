// =============================================================================
// Session Store (Zustand)
//
// Manages the session list, active session, streaming state, and message
// sending. Subscribes to gateway events for real-time streaming.
//
// ALL "stream event → rendered transcript" transition logic lives in the
// shared canonical reducer (@hawky/transcript → src/transcript). This store
// keeps one canonical TranscriptState per session, projects it into the
// SessionMessage view via ./transcript-view, and owns every side effect:
// flush throttling, unread badges, pagination, dialogs, usage bookkeeping.
// =============================================================================

import { create } from "zustand";
import { useSocketStore } from "./socket-store";
import type { EventFrame } from "@hawky/protocol";
import {
  appendUserMessage,
  fromHistory,
  initialState,
  reduce,
  type HistoryMessage,
  type StreamEvent,
  type TranscriptItem,
  type TranscriptState,
} from "@hawky/transcript";
import {
  deriveSessionMessages,
  shouldDisplay,
  syncMessages,
  toSessionMessage,
  type SessionOverlay,
} from "./transcript-view";

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
  /** Absolute message index in the backend session history. Set by the
   *  shared history fold (fromHistory) so the client can pass it directly
   *  to chat.rewind without any counting from the start.
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
   *  as `backendIndex` by the shared history fold. We use the absolute index
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

// -----------------------------------------------------------------------------
// Canonical transcript runtime (per session)
//
// One canonical TranscriptState per session key — the SAME fold serves the
// active session (projected into `messages`) and background sessions
// (projected into their sessionCache entry). The shared reducer owns every
// transition; this block owns projection + throttling only.
// -----------------------------------------------------------------------------

interface SessionTranscript {
  /** Canonical transcript — the single source of truth for rendered rows. */
  state: TranscriptState;
  /** The canonical state the Zustand view currently reflects. */
  projected: TranscriptState;
  /** Web-only per-item presentation (startedAt / live / command chip). */
  overlays: Record<string, SessionOverlay>;
  /** Pending throttled projection for streaming text deltas. */
  flushTimer: ReturnType<typeof setTimeout> | null;
}

const sessionTranscripts = new Map<string, SessionTranscript>();

function getTranscript(sessionKey: string): SessionTranscript {
  let t = sessionTranscripts.get(sessionKey);
  if (!t) {
    const state = initialState();
    t = { state, projected: state, overlays: {}, flushTimer: null };
    sessionTranscripts.set(sessionKey, t);
  }
  return t;
}

/** Swap in a freshly folded canonical state (session switch / history load). */
function resetTranscript(sessionKey: string, state: TranscriptState): SessionTranscript {
  const t = getTranscript(sessionKey);
  if (t.flushTimer) {
    clearTimeout(t.flushTimer);
    t.flushTimer = null;
  }
  t.state = state;
  t.projected = state;
  t.overlays = {};
  return t;
}

const FLUSH_INTERVAL_MS = 50;

/**
 * Mirror the canonical state into the Zustand view: the active session's
 * `messages`, or a background session's cache entry. Incremental (see
 * syncMessages) and idempotent — a redundant call is a no-op.
 */
function projectTranscript(sessionKey: string): void {
  const t = getTranscript(sessionKey);
  if (t.projected === t.state) return;
  const prev = t.projected;
  const next = t.state;
  t.projected = next;
  if (sessionKey === useSessionStore.getState().activeKey) {
    useSessionStore.setState((state) => ({
      messages: syncMessages(state.messages, prev, next, t.overlays),
    }));
  } else {
    useSessionStore.setState((state) => {
      const cached = state.sessionCache[sessionKey] ?? EMPTY_PER_SESSION_CACHE;
      return {
        sessionCache: {
          ...state.sessionCache,
          [sessionKey]: {
            ...cached,
            messages: syncMessages(cached.messages, prev, next, t.overlays),
          },
        },
      };
    });
  }
}

/** Throttled projection for high-frequency text deltas — same 50ms cadence
 *  the old streaming flush used, for both active and background sessions. */
function scheduleProjection(sessionKey: string): void {
  const t = getTranscript(sessionKey);
  if (t.flushTimer) return; // Already scheduled
  t.flushTimer = setTimeout(() => {
    t.flushTimer = null;
    projectTranscript(sessionKey);
  }, FLUSH_INTERVAL_MS);
}

/**
 * Reconstruct the typed StreamEvent from a gateway `agent.*` broadcast (the
 * gateway emits each StreamEvent as "agent." + event.type, so the payload IS
 * the event — this just coerces loosely-typed WS data). Returns null for
 * agent events that are not transcript transitions: the permission/ask_user
 * dialog traffic stays entirely in this adapter.
 */
function toStreamEvent(type: string, payload: any): StreamEvent | null {
  switch (type) {
    case "text":
      return { type, content: String(payload?.content ?? ""), replace: payload?.replace === true };
    case "thinking":
      return { type, content: String(payload?.content ?? "") };
    case "tool_use_start":
      return {
        type,
        tool_use_id: String(payload?.tool_use_id ?? ""),
        name: String(payload?.name ?? "tool"),
        input: (typeof payload?.input === "object" && payload.input !== null
          ? payload.input
          : {}) as Record<string, unknown>,
        approvalReason: payload?.approvalReason,
        batchId: payload?.batchId,
        batchSize: payload?.batchSize,
      };
    case "tool_streaming":
      return {
        type,
        tool_use_id: String(payload?.tool_use_id ?? ""),
        stream_type: payload?.stream_type === "stderr" ? "stderr" : "stdout",
        content: String(payload?.content ?? ""),
      };
    case "tool_result":
      return {
        type,
        tool_use_id: String(payload?.tool_use_id ?? ""),
        name: String(payload?.name ?? "tool"),
        content: typeof payload?.content === "string" ? payload.content : "",
        display_content:
          typeof payload?.display_content === "string" ? payload.display_content : undefined,
        is_error: payload?.is_error === true,
        metadata: payload?.metadata,
      };
    case "done":
      return { type };
    case "error":
      // The reducer renders `Error: ${content}` — coerce a missing content
      // to the old handler's "Unknown error" wording.
      return {
        type,
        content: typeof payload?.content === "string" ? payload.content : "Unknown error",
        code: payload?.code,
      };
    case "cancel":
      return { type, content: String(payload?.content ?? "") };
    case "queue_message":
      return {
        type,
        content: String(payload?.content ?? ""),
        position: typeof payload?.position === "number" ? payload.position : 0,
      };
    case "system_message":
      return { type, content: String(payload?.content ?? ""), subtype: payload?.subtype };
    case "user_committed":
      return typeof payload?.message_index === "number"
        ? { type, message_index: payload.message_index }
        : null;
    default:
      return null;
  }
}

/**
 * Apply one live stream event to a session's canonical transcript and
 * project the result into the view.
 */
function applyStreamEvent(sessionKey: string, ev: StreamEvent): { createdStreaming: boolean } {
  const t = getTranscript(sessionKey);
  const prev = t.state;
  t.state = reduce(prev, ev);

  // Stamp web-only overlays for the tool item this event just created —
  // the wall clock lives in the adapter (the core is deliberately pure).
  if (ev.type === "tool_use_start") {
    const created = t.state.items[t.state.items.length - 1];
    if (created && created.kind === "tool") {
      t.overlays[created.id] = { ...t.overlays[created.id], startedAt: Date.now(), live: true };
    }
  }

  if (ev.type === "user_committed") {
    // Deliberately not projected here: the store keeps its message-level
    // stamp (see handleEvent) so optimistic bubbles that exist only in the
    // view still get their backendIndex; the canonical stamp lands on the
    // next natural projection.
    return { createdStreaming: false };
  }

  // Pure text appends are throttled exactly like the old streaming flush;
  // everything structural (new bubble, replace, tool cards, finalize)
  // projects immediately.
  const appendOnly = ev.type === "text" && ev.replace !== true && prev.cursor.streamingItemId !== null;
  if (appendOnly) scheduleProjection(sessionKey);
  else projectTranscript(sessionKey);

  return { createdStreaming: ev.type === "text" && prev.cursor.streamingItemId === null };
}

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
      // No streaming state to hand off: the previous session's canonical
      // transcript lives in sessionTranscripts and keeps folding background
      // events; projections target its cache entry once activeKey changes.
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
    // (The target session's canonical transcript is rebuilt below from the
    // fetched history via resetTranscript.)

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
      // Fold the persisted history through the shared canonical reducer —
      // this replaces the old parseHistoryMessages (tool matching, batch
      // synthesis, legacy running-tool reclassification, orphan collection
      // all live in the core now).
      let transcript = fromHistory(rawMessages as HistoryMessage[]);
      const initialOrphans = transcript.cursor.orphanToolResults;
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
          // Feed the in-progress text through the reducer as a synthetic
          // text event: it opens a streaming item, so incoming agent.text
          // deltas APPEND to it instead of creating a new bubble.
          transcript = reduce(transcript, { type: "text", content: String(currentTurn.text) });
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

      // Install the freshly folded canonical transcript for this session
      // and project it wholesale (fresh load replaces the message list).
      const t = resetTranscript(key, transcript);
      const messages = deriveSessionMessages(transcript, t.overlays);

      // Persist to localStorage only after history loaded successfully
      try { localStorage.setItem("hawky:activeKey", key); } catch {}

      // Ensure active session is in sidebar + restore cached permission/ask_user
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
        resetTranscript(key, initialState());
        set({ loading: false, messages: [], historyMeta: null, orphanToolResults: {}, taskSummary: null });
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
      // Fold the older page through the shared reducer. Its cursor carries
      // any NEW orphan tool_results (pairs split across an even-older page).
      // The namespace (this page's beforeIndex cursor) keeps ids of LEGACY
      // index-less rows unique across folds — the ordinal fallback is only
      // page-unique, and this page is prepended into the same items array
      // as the initial window (duplicate ids = duplicate React keys).
      const olderState = fromHistory(rawOlder as HistoryMessage[], {
        idNamespace: `p${meta.oldestLoadedIndex}`,
      });
      // New cursor = index of the oldest message we just received
      // (rawOlder[0] since the backend returns older→newer order within a page)
      const newOldestIndex =
        rawOlder.length > 0 ? rawOlder[0].index ?? meta.oldestLoadedIndex : meta.oldestLoadedIndex;

      // Cross-link: fill unresolved tool cards in this older chunk using
      // tool_results we stashed earlier as orphans when parsing newer chunks.
      // Matched keys are consumed so they don't linger in state. Diff
      // metadata needs no explicit re-synthesis here — the selector derives
      // it from the preserved input whenever a history tool shows success,
      // and derives NONE on error (so a failed edit never keeps a fake diff).
      const remainingOrphans = { ...get().orphanToolResults };
      let olderItems: TranscriptItem[] = olderState.items.map((item) => {
        if (item.kind !== "tool") return item;
        if (item.meta?.resultContent !== undefined || item.output.length > 0) return item;
        const orphan = remainingOrphans[item.toolUseId];
        if (!orphan) return item;
        delete remainingOrphans[item.toolUseId];
        return {
          ...item,
          status: orphan.isError ? ("error" as const) : ("ok" as const),
          meta: { ...item.meta, resultContent: orphan.content, isError: orphan.isError },
        };
      });
      // Merge any new orphans from this chunk for future (even-older) loads.
      const mergedOrphans = { ...remainingOrphans, ...olderState.cursor.orphanToolResults };

      // Re-run the legacy-running-tool reclassification on the FULL merged
      // window. Without this pass, a legacy tool_use at the end of the older
      // page (whose continuation lives in the already-loaded newer page)
      // stays "running" forever — the page-local fold saw it as trailing in
      // isolation, but the combined transcript proves otherwise. Same rules
      // as the core's fromHistory pass: only timestamped (historical) tools
      // are touched — live-streamed tools have no timestamp and keep their
      // spinner (Codex P1 guard).
      const t = getTranscript(key);
      const prevState = t.state;
      let trailingTs: string | undefined;
      const currentMsgs = get().messages;
      for (let i = currentMsgs.length - 1; i >= 0 && trailingTs === undefined; i--) {
        trailingTs = currentMsgs[i].timestamp;
      }
      for (let i = olderItems.length - 1; i >= 0 && trailingTs === undefined; i--) {
        trailingTs = olderItems[i].timestamp;
      }
      const reclassify = (item: TranscriptItem): TranscriptItem =>
        item.kind === "tool" &&
        item.status === "running" &&
        item.timestamp !== undefined &&
        item.timestamp !== trailingTs
          ? { ...item, status: "ok" as const }
          : item;
      let currentItems = prevState.items;
      if (trailingTs !== undefined) {
        olderItems = olderItems.map(reclassify);
        // reclassify preserves object identity for untouched items, which is
        // exactly what syncMessages needs to update only the flipped rows.
        currentItems = currentItems.map(reclassify);
      }

      // Install the merged canonical state, then project: current-window
      // rows changed by the reclassify pass update in place; the older page
      // is prepended wholesale.
      const projectedBase = t.projected;
      t.state = {
        items: [...olderItems, ...currentItems],
        cursor: { ...prevState.cursor, orphanToolResults: mergedOrphans },
      };
      t.projected = t.state;
      const updatedCurrent = syncMessages(
        currentMsgs,
        projectedBase,
        { items: currentItems, cursor: prevState.cursor },
        t.overlays,
      );
      const olderMessages = olderItems
        .filter(shouldDisplay)
        .map((item) => toSessionMessage(item, t.overlays[item.id]));
      const mergedMessages = [...olderMessages, ...updatedCurrent];

      set((state) => ({
        messages: mergedMessages,
        orphanToolResults: mergedOrphans,
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

    // A new turn is starting — clear any stale cancel flag in the canonical
    // cursor so this turn's first error (if any) is never suppressed.
    const t = getTranscript(activeKey);
    if (t.state.cursor.cancelPending) {
      t.state = { items: t.state.items, cursor: { ...t.state.cursor, cancelPending: false } };
    }

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
    const meta: Record<string, unknown> = {};
    if (attachments) meta.images = attachments;
    if (documents) {
      meta.documents = documents.map((d) => ({
        media_type: d.media_type,
        filename: d.filename ?? "document",
        sizeBytes: Math.ceil(d.base64.length * 3 / 4),
      }));
    }
    t.state = appendUserMessage(t.state, text, {
      timestamp: new Date().toISOString(),
      meta: Object.keys(meta).length > 0 ? meta : undefined,
    });
    projectTranscript(activeKey);
    set({ agentStatus: "thinking", statusLabel: "Thinking..." });

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
        const tc = getTranscript(activeKey);
        tc.state = reduce(tc.state, {
          type: "system_message",
          content: `Error: ${err instanceof Error ? err.message : String(err)}`,
        });
        projectTranscript(activeKey);
        set({ agentStatus: "idle" });
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
    // Mirror the truncation into the canonical transcript so future events
    // and projections stay consistent with the view.
    {
      const t = getTranscript(activeKey);
      const cutAt = t.state.items.findIndex(
        (it) => it.kind === "message" && typeof it.backendIndex === "number" && it.backendIndex >= messageIndex,
      );
      if (cutAt >= 0) {
        const items = t.state.items.slice(0, cutAt);
        const keptIds = new Set(items.map((it) => it.id));
        const toolUseIdToItem: Record<string, string> = {};
        for (const [tuId, itemId] of Object.entries(t.state.cursor.toolUseIdToItem)) {
          if (keptIds.has(itemId)) toolUseIdToItem[tuId] = itemId;
        }
        const { streamingItemId, replaceTargetItemId } = t.state.cursor;
        t.state = {
          items,
          cursor: {
            ...t.state.cursor,
            toolUseIdToItem,
            streamingItemId: streamingItemId && keptIds.has(streamingItemId) ? streamingItemId : null,
            replaceTargetItemId:
              replaceTargetItemId && keptIds.has(replaceTargetItemId) ? replaceTargetItemId : null,
          },
        };
        t.projected = t.state; // the view was truncated in the same step
      }
    }

    // 2. Ask the gateway to do the authoritative rewind. The backend
    //    broadcasts session.rewound to sibling clients (excluding us,
    //    via connId match on the gateway side) so they refresh too.
    try {
      await rpc("chat.rewind", { sessionKey: activeKey, messageIndex });
    } catch (err) {
      // Rewind failed server-side — re-hydrate local view from the
      // authoritative history so we're not out of sync.
      await get().switchSession(activeKey);
      const t = getTranscript(activeKey);
      t.state = reduce(t.state, {
        type: "system_message",
        content: `Rewind failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      projectTranscript(activeKey);
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

      // Module-level canonical transcript map (outside React state)
      const prevTranscript = sessionTranscripts.get(oldKey);
      if (prevTranscript) {
        sessionTranscripts.set(newKey, prevTranscript);
        sessionTranscripts.delete(oldKey);
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

      // Fold the stream event into the background session's canonical
      // transcript and project into its cache entry. The SAME reducer serves
      // active and background sessions — only the projection target differs.
      const bgType = event.startsWith("agent.") ? event.slice(6) : null;
      const bgStreamEv = bgType ? toStreamEvent(bgType, payload) : null;
      if (bgStreamEv) {
        const { createdStreaming } = applyStreamEvent(eventSessionKey, bgStreamEv);

        // Status side effects mirror the old background handlers.
        if (createdStreaming) {
          set((state) => ({
            sessionCache: {
              ...state.sessionCache,
              [eventSessionKey]: {
                ...(state.sessionCache[eventSessionKey] ?? EMPTY_PER_SESSION_CACHE),
                agentStatus: "streaming",
              },
            },
          }));
        }
        if (bgStreamEv.type === "tool_use_start") {
          set((state) => ({
            sessionCache: {
              ...state.sessionCache,
              [eventSessionKey]: {
                ...(state.sessionCache[eventSessionKey] ?? EMPTY_PER_SESSION_CACHE),
                agentStatus: "thinking",
                statusLabel: toolStatusLabel(bgStreamEv.name, bgStreamEv.input),
              },
            },
          }));
        }
      }

      if (event === "agent.done") {
        set((state) => ({
          sessionCache: {
            ...state.sessionCache,
            [eventSessionKey]: {
              ...(state.sessionCache[eventSessionKey] ?? EMPTY_PER_SESSION_CACHE),
              agentStatus: "idle",
            },
          },
        }));

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

      // Background user.message → append as user bubble in that session's
      // canonical transcript (projected into its cache entry). The gateway
      // excludes the sender from this broadcast, so anything we receive here
      // comes from a sibling client (other tab / iPhone / TUI). Append
      // unconditionally — no dedup needed.
      if (event === "user.message" && typeof payload?.text === "string") {
        const t = getTranscript(eventSessionKey);
        const att = extractBroadcastAttachments(payload);
        const meta: Record<string, unknown> = {};
        if (att.images) meta.images = att.images;
        if (att.documents) meta.documents = att.documents;
        t.state = appendUserMessage(t.state, payload.text, {
          timestamp: payload.timestamp ?? new Date().toISOString(),
          meta: Object.keys(meta).length > 0 ? meta : undefined,
        });
        const newCounts = { ...get().unreadCounts, [eventSessionKey]: (get().unreadCounts[eventSessionKey] ?? 0) + 1 };
        set({ unreadCounts: newCounts });
        projectTranscript(eventSessionKey);
        persistUnread(get());
        applyAppBadge(newCounts);
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
      const t = getTranscript(activeKey);
      const att = extractBroadcastAttachments(payload);
      const meta: Record<string, unknown> = {};
      if (att.images) meta.images = att.images;
      if (att.documents) meta.documents = att.documents;
      t.state = appendUserMessage(t.state, payload.text, {
        timestamp: payload.timestamp ?? new Date().toISOString(),
        meta: Object.keys(meta).length > 0 ? meta : undefined,
      });
      projectTranscript(activeKey);
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

    // Fold the stream event into the active session's canonical transcript.
    // ALL message-list transitions (streaming text, replace, tool cards,
    // results, finalize-on-done, cancel/error wording, abort-after-cancel
    // suppression, user_committed stamping) live in the shared reducer —
    // the switch below keeps only the web side effects: status labels,
    // usage bookkeeping, dialogs, unread badges.
    const streamEv = toStreamEvent(type, payload);
    if (streamEv) applyStreamEvent(activeKey, streamEv);

    switch (type) {
      case "user_committed": {
        // The canonical state was stamped by the reducer, but the visible
        // bubble can exist only in the view (optimistic sends after a test
        // or cache restore) — keep the old message-level stamp so the edit
        // pencil appears either way, without a session.history refetch.
        // MUST mirror the reducer's scan exactly (FIFO, skipping
        // history-derived `msg-h*` rows): commits arrive in send order, and
        // a diverging view-level stamp would hand edit/rewindAndSend the
        // wrong backendIndex until the next projection overwrites it.
        const idx = payload?.message_index;
        if (typeof idx !== "number") break;
        set((state) => {
          const msgs = [...state.messages];
          for (let i = 0; i < msgs.length; i++) {
            if (
              msgs[i].role === "user" &&
              msgs[i].backendIndex === undefined &&
              !msgs[i].id.startsWith("msg-h")
            ) {
              msgs[i] = { ...msgs[i], backendIndex: idx };
              break;
            }
          }
          return { messages: msgs };
        });
        break;
      }

      case "text": {
        // Set the status only on the transition INTO streaming — the old
        // handler routed append deltas exclusively through the throttled
        // flush, and an unconditional set() here would create a new store
        // state (and notify every subscriber) on EVERY delta.
        const st = get();
        if (st.agentStatus !== "streaming" || st.statusLabel !== "Generating...") {
          set({ agentStatus: "streaming", statusLabel: "Generating..." });
        }
        break;
      }

      case "tool_use_start": {
        const input = (typeof payload.input === "object" && payload.input !== null
          ? payload.input
          : {}) as Record<string, unknown>;
        const tName = payload.name ?? "tool";
        set({ agentStatus: "thinking", statusLabel: toolStatusLabel(tName, input) });
        break;
      }

      case "done": {
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
        // The reducer already handled the transcript side, including the
        // sentinel-gated suppression of the follow-on abort error the
        // backend emits right after a user-initiated cancel (cancelPending
        // in the canonical cursor replaces the old recent-cancel flag).
        set({ agentStatus: "idle", pendingPermission: null, pendingAskUser: null });
        break;
      }

      case "cancel": {
        // Reducer: finalizes streaming text (no "[cancelled]" suffix) and
        // emits the marker item the selector renders as "■ Generation
        // stopped."; it also arms cancelPending for the error suppression.
        set({ agentStatus: "idle", pendingPermission: null, pendingAskUser: null });
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
      sessionTranscripts.delete(key);
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
      sessionTranscripts.delete(key);
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
    const key = get().activeKey;
    const t = getTranscript(key);
    t.state = reduce(t.state, { type: "system_message", content: text });
    if (command) {
      // The slash-command chip is web-only presentation — overlay, not core.
      const created = t.state.items[t.state.items.length - 1];
      if (created) t.overlays[created.id] = { ...t.overlays[created.id], command };
    }
    projectTranscript(key);
  },
}));
