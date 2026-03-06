// =============================================================================
// Session Manager
//
// JSONL-based session persistence. Each session is a single .jsonl file with:
// - Line 1: session header (id, model, working_directory, created_at)
// - Subsequent lines: message entries, permission cache snapshots
//
// Append-only writes (O(1) per save, crash-safe — at most lose last entry).
// Eager load on startup (read full file, parse line by line).
// =============================================================================

import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync, readdirSync, statSync, unlinkSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename, dirname } from "node:path";
import type { ChatMessage } from "../agent/types.js";
import type { PermissionCacheData } from "../agent/tool_executor.js";
import { createSubsystemLogger } from "../logging/index.js";

const log = createSubsystemLogger("session");

// -----------------------------------------------------------------------------
// Image scrubbing for persistence
// -----------------------------------------------------------------------------

/**
 * Replace image and document blocks with text placeholders before writing
 * to JSONL. Prevents large base64 data from accumulating on disk.
 * Returns a shallow clone — does NOT mutate the original message.
 */
function scrubImagesForPersistence(message: ChatMessage): ChatMessage {
  const scrubbed = message.content.map((block: any) => {
    // Direct image block (user-attached images)
    if (block.type === "image") {
      return { type: "text", text: "[image was attached]" };
    }
    // Direct document block (user-attached PDFs)
    if (block.type === "document") {
      const title = typeof block.title === "string" ? block.title : "document";
      return { type: "text", text: `[${title} was attached]` };
    }
    // Tool result with image/document content (screenshots, read_file pdf)
    if (block.type === "tool_result" && Array.isArray(block.content)) {
      const hasBinary = block.content.some((b: any) => b.type === "image" || b.type === "document");
      if (hasBinary) {
        return {
          ...block,
          content: block.content.map((b: any) => {
            if (b.type === "image") return { type: "text", text: "[screenshot was captured]" };
            if (b.type === "document") {
              const title = typeof b.title === "string" ? b.title : "document";
              return { type: "text", text: `[${title} was read]` };
            }
            return b;
          }),
        };
      }
    }
    return block;
  });
  return { ...message, content: scrubbed };
}

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const SESSION_VERSION = 1;

// Default paths (can be overridden for testing via setSessionsDir)
let SESSIONS_DIR = join(homedir(), ".hawky", "sessions");
let migrated = false; // Track whether legacy migration has run
let LAST_SESSION_FILE = join(SESSIONS_DIR, ".last-session");

/** Get the current sessions directory path. */
export function getSessionsDir(): string {
  return SESSIONS_DIR;
}

/** Override the sessions directory (for testing). */
export function setSessionsDir(dir: string): string {
  const prev = SESSIONS_DIR;
  SESSIONS_DIR = dir;
  LAST_SESSION_FILE = join(dir, ".last-session");
  migrated = false; // Reset migration flag for new directory
  return prev;
}

/** Reset to default sessions directory. */
export function resetSessionsDir(): void {
  SESSIONS_DIR = join(homedir(), ".hawky", "sessions");
  LAST_SESSION_FILE = join(SESSIONS_DIR, ".last-session");
  migrated = false;
}

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface SessionHeader {
  type: "session";
  version: number;
  id: string;
  model: string;
  working_directory: string;
  created_at: string;
}

export interface MessageEntry {
  type: "message";
  timestamp: string;
  message: ChatMessage;
}

export interface PermissionCacheEntry {
  type: "permission_cache";
  timestamp: string;
  data: PermissionCacheData;
}

export type SessionEntry = SessionHeader | MessageEntry | PermissionCacheEntry;

export interface SessionData {
  header: SessionHeader;
  messages: ChatMessage[];
  permissionCache: PermissionCacheData | null;
}

export interface SessionInfo {
  id: string;
  filePath: string;
  createdAt: string;
  lastModified: number;
  messageCount: number;
  /** From meta.json — user-assigned display name */
  displayName?: string;
  /** From meta.json — pinned to top of list */
  pinned?: boolean;
  /** From meta.json — hidden from default list */
  archived?: boolean;
  /** Last observed context-window occupancy (0-100), from the most recent agent.done. */
  contextUsagePercent?: number;
  /** Last observed session token totals. */
  sessionTokens?: { input: number; output: number };
  /** Last observed cumulative cost in USD. */
  sessionCostUSD?: number;
  /** Experimental runtime binding. Defaults to native when absent. */
  runtimeKind?: SessionRuntimeKind;
}

export type SessionRuntimeKind = "native" | "codex" | "hermes" | "claude";

// -----------------------------------------------------------------------------
// Session ID generation
// -----------------------------------------------------------------------------

export function generateSessionId(): string {
  // Simple UUID v4-like ID
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// -----------------------------------------------------------------------------
// File system helpers
// -----------------------------------------------------------------------------

function ensureSessionsDir(): void {
  if (!existsSync(SESSIONS_DIR)) {
    mkdirSync(SESSIONS_DIR, { recursive: true });
  }
}

function sessionPath(sessionId: string): string {
  // Ensure legacy files are migrated before any path resolution
  migrateOldSessions();
  return join(SESSIONS_DIR, `${sessionId}.jsonl`);
}

// -----------------------------------------------------------------------------
// SessionManager
// -----------------------------------------------------------------------------

export class SessionManager {
  private sessionId: string;
  private filePath: string;
  private initialized = false;
  private customDir: boolean;

  constructor(sessionId: string, customDir?: string) {
    this.sessionId = sessionId;
    this.customDir = !!customDir;
    this.filePath = customDir
      ? join(customDir, `${sessionId}.jsonl`)
      : sessionPath(sessionId);
  }

  /** Ensure the parent directory of the session file exists. */
  private ensureDir(): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getFilePath(): string {
    return this.filePath;
  }

  // ---------------------------------------------------------------------------
  // Write operations
  // ---------------------------------------------------------------------------

  /** Initialize a new session file with header */
  initSession(model: string, workingDirectory: string): void {
    this.ensureDir();
    const header: SessionHeader = {
      type: "session",
      version: SESSION_VERSION,
      id: this.sessionId,
      model,
      working_directory: workingDirectory,
      created_at: new Date().toISOString(),
    };
    writeFileSync(this.filePath, JSON.stringify(header) + "\n", "utf-8");
    this.initialized = true;
    log.info("session created", { sessionId: this.sessionId, model });
    // Don't write .last-session here — wait until messages are actually persisted.
    // Otherwise every startup (even with immediate exit) overwrites the marker.
  }

  /** Append a message to the session file.
   *  Image blocks are replaced with placeholders before persistence
   *  to avoid storing large base64 data on disk. */
  appendMessage(message: ChatMessage): void {
    if (!this.initialized && !existsSync(this.filePath)) return;
    const entry: MessageEntry = {
      type: "message",
      timestamp: new Date().toISOString(),
      message: scrubImagesForPersistence(message),
    };
    appendFileSync(this.filePath, JSON.stringify(entry) + "\n", "utf-8");
    // Write .last-session marker on first message (not on init, to avoid
    // empty sessions overwriting the marker). Skip for custom dirs (tests).
    if (!this.customDir) {
      writeLastSession(this.sessionId);
    }
  }

  /**
   * Rewrite the session file with only the given messages.
   * Used by heartbeat session trimming to persist bounded history to disk.
   */
  rewriteMessages(messages: ChatMessage[], model?: string): void {
    this.ensureDir();
    const header: SessionHeader = {
      type: "session",
      version: SESSION_VERSION,
      id: this.sessionId,
      model: model ?? "unknown",
      working_directory: "/",
      created_at: new Date().toISOString(),
    };
    let content = JSON.stringify(header) + "\n";
    for (const msg of messages) {
      const entry: MessageEntry = {
        type: "message",
        timestamp: new Date().toISOString(),
        message: scrubImagesForPersistence(msg),
      };
      content += JSON.stringify(entry) + "\n";
    }
    writeFileSync(this.filePath, content, "utf-8");
    this.initialized = true;
  }

  /** Append permission cache snapshot */
  appendPermissionCache(data: PermissionCacheData): void {
    if (!this.initialized && !existsSync(this.filePath)) return;
    const entry: PermissionCacheEntry = {
      type: "permission_cache",
      timestamp: new Date().toISOString(),
      data,
    };
    appendFileSync(this.filePath, JSON.stringify(entry) + "\n", "utf-8");
  }

  // ---------------------------------------------------------------------------
  // Read operations
  // ---------------------------------------------------------------------------

  /** Load a session from disk. Returns null if file doesn't exist. */
  loadSession(): SessionData | null {
    if (!existsSync(this.filePath)) return null;

    const content = readFileSync(this.filePath, "utf-8");
    const lines = content.split("\n").filter((line) => line.trim().length > 0);

    if (lines.length === 0) return null;

    let header: SessionHeader | null = null;
    const messages: ChatMessage[] = [];
    let permissionCache: PermissionCacheData | null = null;
    let parseErrors = 0;

    for (let i = 0; i < lines.length; i++) {
      try {
        const entry = JSON.parse(lines[i]) as SessionEntry;

        switch (entry.type) {
          case "session":
            header = entry;
            break;
          case "message":
            messages.push(entry.message);
            break;
          case "permission_cache":
            // Latest permission_cache entry wins (overrides previous)
            permissionCache = entry.data;
            break;
        }
      } catch {
        parseErrors++;
        // Skip corrupted lines — JSONL resilience: only lose the bad entry
        continue;
      }
    }

    if (!header) return null;

    this.initialized = true;
    if (parseErrors > 0) {
      log.warn("session has corrupted entries", {
        sessionId: this.sessionId,
        parseErrors,
      });
    }

    // Load-time safety net: repair any orphaned tool_use blocks left over
    // from process crashes that slipped past the in-loop try/catch. We
    // mutate the in-memory messages array only; the JSONL stays untouched
    // (next appendMessage will tack on correct entries). The next API call
    // would otherwise 400 with "tool_use ids without tool_result".
    const repaired = repairOrphanedToolUses(messages, this.sessionId);
    return { header, messages: repaired, permissionCache };
  }

  /** Check if the session file exists */
  exists(): boolean {
    return existsSync(this.filePath);
  }
}

// -----------------------------------------------------------------------------
// History invariant repair (load-time only, in-memory)
//
// Guarantees that every `tool_use` block in an assistant message is
// followed by a matching `tool_result` block in the next user message.
// Applied when loading a session from disk — covers the rare case of
// the gateway process crashing between the assistant push and the
// tool_result push that the runtime try/catch in loop.ts cannot
// protect (SIGKILL, OOM, hard crash).
// -----------------------------------------------------------------------------

/**
 * Scan `messages` and append synthetic `tool_result` blocks for any
 * orphaned `tool_use` ids. Returns a new array — does not mutate input.
 *
 * Exported for testing. Safe to call on an already-valid history (it's
 * a no-op when no orphans exist).
 */
export function repairOrphanedToolUses(
  messages: ChatMessage[],
  sessionId?: string,
): ChatMessage[] {
  // Defensive accessor: historically loadSession has been tolerant of
  // structurally bad-but-parseable JSONL entries (e.g. a `content` field
  // that is an object or string rather than the expected array). This pass
  // must stay tolerant — a single malformed message shouldn't brick the
  // whole load. Returns [] for anything that isn't a clean array so the
  // downstream checks become no-ops.
  const blocksOf = (m: ChatMessage): any[] =>
    Array.isArray(m?.content) ? (m.content as any[]) : [];

  // First pass: figure out which ids are missing at each assistant turn,
  // and whether the immediately-following user message exists and can be
  // extended vs. needs to be inserted after the assistant.
  interface Repair {
    assistantIdx: number;
    missing: string[];
    /** If set, merge the synthetic tool_results into this existing user
     *  message (which is partially fulfilled). Otherwise insert a new
     *  user message immediately after the assistant. */
    mergeIntoIdx: number | null;
  }
  const plan: Repair[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg?.role !== "assistant") continue;
    const toolUseIds: string[] = [];
    for (const block of blocksOf(msg)) {
      if (block && block.type === "tool_use" && typeof block.id === "string") {
        toolUseIds.push(block.id);
      }
    }
    if (toolUseIds.length === 0) continue;

    // Scan every consecutive user message that looks like a tool_result
    // container. tool_results for a given assistant turn all travel
    // together without prose mixed in — so we stop at the first user
    // message containing a `text` block (indicating the next human turn).
    const fulfilled = new Set<string>();
    let mergeIntoIdx: number | null = null;
    for (let j = i + 1; j < messages.length; j++) {
      const next = messages[j];
      if (next?.role !== "user") break;
      const nextBlocks = blocksOf(next);
      const hasResults = nextBlocks.some(
        (b) => b && b.type === "tool_result",
      );
      if (hasResults && mergeIntoIdx === null) {
        // Prefer merging into the first existing tool_result-bearing user
        // message — preserves ordering and avoids introducing a new
        // consecutive-user-message block.
        mergeIntoIdx = j;
      }
      for (const block of nextBlocks) {
        if (block && block.type === "tool_result" && typeof block.tool_use_id === "string") {
          fulfilled.add(block.tool_use_id);
        }
      }
      if (nextBlocks.some((b) => b && b.type === "text")) break;
    }

    const missing = toolUseIds.filter((id) => !fulfilled.has(id));
    if (missing.length === 0) continue;

    log.warn("repairing orphaned tool_use at session load", {
      sessionId,
      missing,
    });
    plan.push({ assistantIdx: i, missing, mergeIntoIdx });
  }

  if (plan.length === 0) return messages.slice();

  // Second pass: emit the repaired array. For `mergeInto` repairs we
  // clone the target message and append the synthetic blocks to its
  // content; for standalone repairs we insert a new user message right
  // after the assistant.
  const out: ChatMessage[] = [];
  // Index plan by the position at which a standalone repair should be inserted.
  const insertAfter = new Map<number, Repair>();
  const mergeAt = new Map<number, Repair>();
  for (const r of plan) {
    if (r.mergeIntoIdx !== null) mergeAt.set(r.mergeIntoIdx, r);
    else insertAfter.set(r.assistantIdx, r);
  }

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const merge = mergeAt.get(i);
    if (merge) {
      // Clone the partial user message and append synthetic tool_results
      // for the missing ids to its content. `blocksOf` tolerates a
      // malformed non-array content (the merge plan would not have been
      // issued for such a message, but this keeps the code defensive).
      const syntheticBlocks = merge.missing.map((id) => ({
        type: "tool_result" as const,
        tool_use_id: id,
        content:
          "[session recovery: tool execution did not complete before a prior crash; result unavailable]",
        is_error: true,
      }));
      out.push({
        ...msg,
        content: [...blocksOf(msg), ...syntheticBlocks] as any,
      });
    } else {
      out.push(msg);
    }

    const standalone = insertAfter.get(i);
    if (standalone) {
      out.push({
        role: "user",
        content: standalone.missing.map((id) => ({
          type: "tool_result" as const,
          tool_use_id: id,
          content:
            "[session recovery: tool execution did not complete before a prior crash; result unavailable]",
          is_error: true,
        })) as any,
        timestamp: new Date().toISOString(),
      });
    }
  }
  return out;
}

// -----------------------------------------------------------------------------
// Session listing and discovery
// -----------------------------------------------------------------------------

/** List all sessions, sorted by last modified (newest first).
 *  Merges metadata from meta.json. Filters out archived sessions by default. */
// -----------------------------------------------------------------------------
// Legacy migration: flat gw-*.jsonl → folder-based type/name.jsonl
// -----------------------------------------------------------------------------

function migrateOldSessions(): void {
  if (migrated) return;
  migrated = true;

  if (!existsSync(SESSIONS_DIR)) return;
  let count = 0;

  for (const file of readdirSync(SESSIONS_DIR)) {
    if (!file.startsWith("gw-") || !file.endsWith(".jsonl")) continue;

    // Parse: gw-web-general.jsonl → web/general.jsonl
    const stem = file.slice(3, -6); // Remove "gw-" and ".jsonl"
    const firstDash = stem.indexOf("-");
    if (firstDash === -1) continue;

    const prefix = stem.slice(0, firstDash);
    const rest = stem.slice(firstDash + 1);
    const newDir = join(SESSIONS_DIR, prefix);
    const newPath = join(newDir, `${rest}.jsonl`);

    if (existsSync(newPath)) {
      // Target already exists — rename old file to .bak (don't delete, may have unique messages)
      try { renameSync(join(SESSIONS_DIR, file), join(SESSIONS_DIR, `${file}.bak`)); count++; } catch {}
      continue;
    }

    try {
      mkdirSync(newDir, { recursive: true });
      renameSync(join(SESSIONS_DIR, file), newPath);
      count++;
    } catch {
      // Skip files we can't move (permissions, etc.)
    }
  }

  if (count > 0) {
    log.info("migrated legacy session files to folders", { count });
  }
}

/** Recursively find all .jsonl files in a directory. */
function findJsonlFiles(dir: string): Array<{ filePath: string; lastModified: number }> {
  const results: Array<{ filePath: string; lastModified: number }> = [];
  if (!existsSync(dir)) return results;

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findJsonlFiles(fullPath));
    } else if (entry.name.endsWith(".jsonl")) {
      try {
        const stat = statSync(fullPath);
        results.push({ filePath: fullPath, lastModified: stat.mtimeMs });
      } catch {}
    }
  }
  return results;
}

export function listSessions(limit = 20, opts?: { includeArchived?: boolean }): SessionInfo[] {
  if (!existsSync(SESSIONS_DIR)) return [];

  // Migrate legacy flat files on first scan
  migrateOldSessions();

  const meta = loadSessionMeta();

  const files = findJsonlFiles(SESSIONS_DIR)
    .sort((a, b) => b.lastModified - a.lastModified);

  const results: SessionInfo[] = [];
  for (const { filePath, lastModified } of files) {
    // Derive session ID from path relative to sessions dir (authoritative)
    const relPath = filePath.slice(SESSIONS_DIR.length + 1); // e.g., "web/general.jsonl"
    const id = relPath.endsWith(".jsonl") ? relPath.slice(0, -6) : relPath;
    let createdAt = "";
    let messageCount = 0;

    try {
      const content = readFileSync(filePath, "utf-8");
      const lines = content.split("\n").filter((l) => l.trim().length > 0);

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.type === "session") {
            // ID comes from file path, not header (header may have legacy gw- format)
            createdAt = entry.created_at;
          } else if (entry.type === "message") {
            messageCount++;
          }
        } catch {
          // Skip corrupted lines
        }
      }
    } catch {
      // Can't read file
    }

    // Derive session key from ID for meta lookup
    const sessionKey = sessionIdToKey(id);
    const metaEntry = meta[sessionKey];

    // Filter archived unless explicitly requested
    if (metaEntry?.archived && !opts?.includeArchived) continue;

    results.push({
      id,
      filePath,
      createdAt,
      lastModified,
      messageCount,
      displayName: metaEntry?.displayName,
      pinned: metaEntry?.pinned,
      archived: metaEntry?.archived,
      contextUsagePercent: metaEntry?.lastContextUsagePercent,
      sessionTokens: metaEntry?.lastSessionTokens,
      sessionCostUSD: metaEntry?.lastSessionCostUSD,
      runtimeKind: metaEntry?.runtimeKind ?? "native",
    });

    if (results.length >= limit) break;
  }

  return results;
}

/** Convert a session ID (gw-web-general) to a session key (web:general). */
function sessionIdToKey(id: string): string {
  // New format: "web/general" → "web:general"
  if (id.includes("/")) return id.replace("/", ":");
  // Legacy format: "gw-web-general" → "web:general"
  if (!id.startsWith("gw-")) return id;
  const rest = id.slice(3);
  const firstDash = rest.indexOf("-");
  if (firstDash === -1) return rest;
  return rest.slice(0, firstDash) + ":" + rest.slice(firstDash + 1);
}

/** Convert a session key (web:general) to a session ID (web/general).
 *  Mirrors AgentSessionManager.sessionIdFromKey — kept in sync. */
export function sessionKeyToId(sessionKey: string): string {
  return sessionKey.replace(":", "/").replace(/[^a-zA-Z0-9_/.-]/g, "-");
}

// -----------------------------------------------------------------------------
// Last session tracking
// -----------------------------------------------------------------------------

/** Write the last-used session ID to a marker file */
export function writeLastSession(sessionId: string): void {
  ensureSessionsDir();
  writeFileSync(LAST_SESSION_FILE, sessionId, "utf-8");
}

/** Read the last-used session ID. Returns null if not found. */
export function readLastSession(): string | null {
  try {
    if (!existsSync(LAST_SESSION_FILE)) return null;
    const id = readFileSync(LAST_SESSION_FILE, "utf-8").trim();
    if (!id) return null;
    // Verify the session file actually exists
    if (!existsSync(sessionPath(id))) return null;
    return id;
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------------
// Session metadata (display name, pinned, archived)
// Stored in a separate meta.json file — UI state, not conversation data.
// -----------------------------------------------------------------------------

export interface SessionMetaEntry {
  displayName?: string;
  pinned?: boolean;
  archived?: boolean;
  /** Per-session reasoning effort override. Persists across restarts. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Ambient mode for this session. Survives reconnects (M8 §3.6/§9). */
  ambientMode?: "quiet" | "ambient" | "directive";
  /** Last agent.done context usage (0-100). Drives sidebar ring + footer on cold load. */
  lastContextUsagePercent?: number;
  /**
   * Last agent.done token totals. Split into all four buckets Anthropic
   * bills separately:
   *   - input         — fresh (uncached) input tokens
   *   - output        — assistant tokens generated
   *   - cacheRead     — input tokens served from a prompt-cache hit
   *   - cacheCreation — input tokens written into the cache (one-time)
   *
   * Once prompt caching engages, the bulk of input shifts from `input` to
   * `cacheRead`; tracking only the first two would make a long
   * conversation look like it shrank. Total context = sum of all three
   * input buckets. Cache fields are optional for backward-compat with
   * meta.json files written before this change.
   */
  lastSessionTokens?: { input: number; output: number; cacheRead?: number; cacheCreation?: number };
  /** Last agent.done cumulative cost in USD. */
  lastSessionCostUSD?: number;
  /** Experimental runtime binding. Sticky once a session is created. */
  runtimeKind?: SessionRuntimeKind;
}

export type SessionMetaStore = Record<string, SessionMetaEntry>;

function metaPath(): string {
  return join(SESSIONS_DIR, "meta.json");
}

/** Load session metadata from meta.json. Returns empty store if missing/corrupt. */
export function loadSessionMeta(): SessionMetaStore {
  try {
    const p = metaPath();
    if (!existsSync(p)) return {};
    const raw = readFileSync(p, "utf-8");
    const data = JSON.parse(raw);
    if (typeof data !== "object" || data === null || Array.isArray(data)) return {};
    return data as SessionMetaStore;
  } catch {
    return {};
  }
}

/** Save session metadata to meta.json. */
export function saveSessionMeta(meta: SessionMetaStore): void {
  ensureSessionsDir();
  writeFileSync(metaPath(), JSON.stringify(meta, null, 2) + "\n", "utf-8");
}

/** Update metadata for a single session key. Merges with existing entry. */
export function updateSessionMeta(sessionKey: string, patch: Partial<SessionMetaEntry>): void {
  const meta = loadSessionMeta();
  const existing = meta[sessionKey] ?? {};
  meta[sessionKey] = { ...existing, ...patch };
  // Clean up empty entries (no meaningful fields set)
  const entry = meta[sessionKey];
  if (
    !entry.displayName &&
    !entry.pinned &&
    !entry.archived &&
    !entry.effort &&
    !entry.ambientMode &&
    !entry.runtimeKind &&
    entry.lastContextUsagePercent == null &&
    !entry.lastSessionTokens &&
    entry.lastSessionCostUSD == null
  ) {
    delete meta[sessionKey];
  }
  saveSessionMeta(meta);
}

/**
 * Persist the last completed turn's usage onto the session meta so the
 * sidebar ring and chat footer can populate on cold load. Shared by
 * `chat.send` (web-initiated turns) and `triggerAgentTurn` (heartbeat,
 * cron, Slack-initiated turns) — drop new turn entry points in here
 * to keep all of them consistent.
 *
 * Zero is a valid observation (short turns on 1M-context models round
 * to 0%, fresh sessions cost $0). We persist any field the caller
 * explicitly provides. The caller is responsible for only invoking
 * this when a `done` event was actually observed, so a failed turn
 * that never emitted usage doesn't clobber the previous value.
 * Fields left undefined on the input object are not written.
 */
export function persistLastTurnUsage(
  sessionKey: string,
  usage: {
    contextUsagePercent?: number;
    inputTokens?: number | null;
    outputTokens?: number | null;
    cacheReadTokens?: number | null;
    cacheCreationTokens?: number | null;
    sessionCostUSD?: number | null;
  },
): void {
  const patch: Partial<SessionMetaEntry> = {};
  if (usage.contextUsagePercent != null) {
    patch.lastContextUsagePercent = usage.contextUsagePercent;
  }
  if (
    usage.inputTokens != null
    || usage.outputTokens != null
    || usage.cacheReadTokens != null
    || usage.cacheCreationTokens != null
  ) {
    patch.lastSessionTokens = {
      input: usage.inputTokens ?? 0,
      output: usage.outputTokens ?? 0,
      cacheRead: usage.cacheReadTokens ?? 0,
      cacheCreation: usage.cacheCreationTokens ?? 0,
    };
  }
  if (usage.sessionCostUSD != null) {
    patch.lastSessionCostUSD = usage.sessionCostUSD;
  }
  if (Object.keys(patch).length === 0) return;
  try {
    updateSessionMeta(sessionKey, patch);
  } catch (err) {
    log.warn("failed to persist session usage meta (non-fatal)", {
      sessionKey,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Remove metadata entry for a session key. */
export function deleteSessionMeta(sessionKey: string): void {
  const meta = loadSessionMeta();
  if (!(sessionKey in meta)) return;
  delete meta[sessionKey];
  saveSessionMeta(meta);
}

/**
 * Rename a session's persistent storage from `oldKey` to `newKey`.
 * - Renames the JSONL file (same prefix dir)
 * - Re-keys meta.json, clearing any displayName (the new key is the name)
 * - Updates .last-session marker if it points to the old session
 *
 * Throws on: missing source file, target already exists, cross-prefix rename.
 * Callers are responsible for evicting in-memory state and notifying clients.
 */
export function renameSessionStorage(oldKey: string, newKey: string): void {
  if (oldKey === newKey) return;

  const oldPrefix = oldKey.includes(":") ? oldKey.split(":")[0] : "";
  const newPrefix = newKey.includes(":") ? newKey.split(":")[0] : "";
  if (oldPrefix !== newPrefix) {
    throw new Error(`cross-prefix rename not allowed: ${oldKey} → ${newKey}`);
  }

  ensureSessionsDir();
  migrateOldSessions();

  const oldId = sessionKeyToId(oldKey);
  const newId = sessionKeyToId(newKey);
  const oldPath = join(SESSIONS_DIR, `${oldId}.jsonl`);
  const newPath = join(SESSIONS_DIR, `${newId}.jsonl`);

  if (!existsSync(oldPath)) {
    throw new Error(`session file not found: ${oldPath}`);
  }
  if (existsSync(newPath)) {
    throw new Error(`session already exists: ${newKey}`);
  }

  const newDir = dirname(newPath);
  if (!existsSync(newDir)) mkdirSync(newDir, { recursive: true });
  renameSync(oldPath, newPath);

  // Post-rename work must be atomic with the file move. If meta.json persistence
  // throws (disk full, EACCES, …), the file is already at newPath but meta
  // still keys the session under oldKey — the caller would report failure
  // while the on-disk state has silently committed. Roll the file move back
  // so the thrown error reflects the actual disk state.
  try {
    const meta = loadSessionMeta();
    const existing = meta[oldKey];
    if (existing) {
      // Drop displayName — the key is now the authoritative name.
      const { displayName: _drop, ...rest } = existing;
      if (Object.keys(rest).length > 0) {
        meta[newKey] = { ...meta[newKey], ...rest };
      }
      delete meta[oldKey];
      saveSessionMeta(meta);
    }

    // Update .last-session if it pointed at the renamed session. Wrapped in
    // its own try so a broken marker does not roll back an otherwise
    // successful rename — the app tolerates a stale marker on startup.
    try {
      if (existsSync(LAST_SESSION_FILE)) {
        const current = readFileSync(LAST_SESSION_FILE, "utf-8").trim();
        if (current === oldId) writeFileSync(LAST_SESSION_FILE, newId, "utf-8");
      }
    } catch {
      // Marker update is best-effort.
    }
  } catch (err) {
    try {
      renameSync(newPath, oldPath);
    } catch (rollbackErr) {
      // Rollback failed — disk is now inconsistent (file at newPath, meta at
      // oldKey). Surface both errors so operators can recover manually.
      log.error("rename rollback failed — storage is inconsistent", {
        oldKey, newKey,
        originalError: err instanceof Error ? err.message : String(err),
        rollbackError: rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
      });
    }
    throw err;
  }

  log.info("session storage renamed", { oldKey, newKey });
}

/** Delete a session JSONL file from disk. Returns true if file was deleted. */
export function deleteSessionFile(sessionId: string): boolean {
  const filePath = sessionPath(sessionId);
  try {
    if (!existsSync(filePath)) return false;
    unlinkSync(filePath);
    log.info("session file deleted", { sessionId, filePath });
    return true;
  } catch (err) {
    log.warn("failed to delete session file", {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

// -----------------------------------------------------------------------------
// Validation
// -----------------------------------------------------------------------------

/**
 * Validate conversation structure:
 * - Messages should alternate user/assistant (with tool_result as user role)
 * - First real message should be from user
 * - No empty content arrays
 *
 * Returns the messages up to the first invalid point.
 */
export function validateMessages(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length === 0) return [];

  const valid: ChatMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    // Basic checks
    if (!msg.role || !msg.content || !Array.isArray(msg.content)) break;
    if (msg.content.length === 0) break;

    // Role alternation check (relaxed: user can follow user for tool_result)
    if (valid.length > 0) {
      const prev = valid[valid.length - 1];
      // assistant must follow user (or another assistant is wrong)
      if (msg.role === "assistant" && prev.role === "assistant") break;
    }

    valid.push(msg);
  }

  return valid;
}
