// =============================================================================
// WebSocket Permission Resolver
//
// When the agent needs tool permission, this resolver:
//   1. Broadcasts a permission.request event to all session clients
//   2. Waits for a permission.resolve RPC from any client
//   3. Returns the decision to unblock the agent
//
// This enables the same permission UX over WebSocket as the TUI had locally.
// Each session gets its own resolver instance.
// =============================================================================

import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { PermissionDecision, PermissionResponse, PermissionResolver } from "../agent/tool_executor.js";
import type { PermissionSuggestion } from "../agent/types.js";
import type { GatewayServer } from "./server.js";
import { createSubsystemLogger } from "../logging/index.js";
import { computeDiffHunks, type DiffHunk } from "../tui/utils/structured_diff.js";
import { isPathInWorkingDirs, isDangerousPath } from "../agent/tool_executor.js";
import { suggestRulePattern } from "../agent/permission-patterns.js";

const EMPTY_DIRS: ReadonlySet<string> = new Set();

const log = createSubsystemLogger("gateway/permission");

/**
 * Cap on the combined size (in chars) of the old + new content fed into
 * the permission-preview diff. Mirrors MAX_DIFF_METADATA_CHARS in
 * src/tools/write_file.ts — we don't want a multi‑MB generated file to
 * stall the WebSocket frame or the React renderer before the user has even
 * decided whether to approve. Above the cap, the preview falls back to
 * "path only" (the dialog still shows the file path).
 */
const MAX_PREVIEW_DIFF_CHARS = 50_000;

/**
 * Snapshot of the dialog payload originally broadcast for a pending
 * permission request. Stored alongside the resolver so that a late-
 * joining client (a second tab opened AFTER the broadcast, an iPhone
 * after a screen-on) can rehydrate its dialog from `session.currentTurn`
 * instead of waiting for the next broadcast that may never come.
 */
interface PendingPermissionDialog {
  toolUseId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  diffPreview: ReturnType<typeof computePermissionDiff>;
  suggestions: PermissionSuggestion[];
  suggestedPattern: string;
}

// Pending permission requests awaiting client response (no timeout — stays pending
// until a client responds, the session is cancelled, or the last client disconnects)
const pendingPermissions = new Map<string, {
  resolve: (response: PermissionResponse) => void;
  sessionKey: string;
  dialog: PendingPermissionDialog;
}>();

/**
 * Look up the pending permission request for a given session, if any.
 * Used by `session.currentTurn` so a late-joining client can hydrate
 * its `pendingPermission` state and render the dialog without having
 * received the original broadcast event.
 */
export function getPendingPermissionForSession(
  sessionKey: string,
): { requestId: string; dialog: PendingPermissionDialog } | null {
  for (const [requestId, p] of pendingPermissions) {
    if (p.sessionKey === sessionKey) {
      return { requestId, dialog: p.dialog };
    }
  }
  return null;
}

// Auto-incrementing request ID
let nextRequestId = 1;

/** Reset state. For testing only. */
export function resetWsPermissions(): void {
  pendingPermissions.clear();
  nextRequestId = 1;
}

/**
 * Compute a diff preview for permission requests that can show one.
 *
 * Exported so it can be unit-tested without spinning up the RPC layer.
 *
 * Supports:
 *  - `edit_file`: diffs `old_string` vs `new_string`, anchored at the matching
 *    line in the existing file so the dialog can show absolute line numbers.
 *  - `write_file`: diffs the existing file contents (or empty, if the file
 *    doesn't exist yet) against `input.content`. For a new file this surfaces
 *    as an all-additions preview; for an overwrite it highlights the actual
 *    changes instead of just the path.
 */
export function computePermissionDiff(
  toolName: string,
  toolInput: Record<string, unknown>,
  workingDirectory: string,
): { hunks: DiffHunk[]; matchLine: number } | null {
  if (toolName === "edit_file") return computeEditFileDiff(toolInput, workingDirectory);
  if (toolName === "write_file") return computeWriteFileDiff(toolInput, workingDirectory);
  return null;
}

function computeEditFileDiff(
  toolInput: Record<string, unknown>,
  workingDirectory: string,
): { hunks: DiffHunk[]; matchLine: number } | null {
  const oldStr = toolInput.old_string;
  const newStr = toolInput.new_string;
  const filePath = toolInput.file_path;
  if (typeof oldStr !== "string" || typeof newStr !== "string" || typeof filePath !== "string") return null;

  try {
    const resolved = filePath.startsWith("/") ? filePath : resolve(workingDirectory, filePath);
    const content = readFileSync(resolved, "utf-8");

    // Try exact match first
    let index = content.indexOf(oldStr);

    // Fallback: try with normalized whitespace (handles indent changes)
    if (index < 0) {
      const normalizedContent = content.replace(/\r\n/g, "\n");
      const normalizedOld = oldStr.replace(/\r\n/g, "\n");
      index = normalizedContent.indexOf(normalizedOld);
    }

    // Fallback: try trimmed line-by-line match (handles leading/trailing whitespace)
    if (index < 0) {
      const contentLines = content.split("\n");
      const oldLines = oldStr.split("\n");
      if (oldLines.length > 0) {
        const firstTrimmed = oldLines[0].trim();
        for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
          if (contentLines[i].trim() === firstTrimmed) {
            index = content.split("\n").slice(0, i).join("\n").length + (i > 0 ? 1 : 0);
            break;
          }
        }
      }
    }

    const matchLine = index >= 0 ? content.substring(0, index).split("\n").length : 1;
    const hunks = computeDiffHunks(oldStr, newStr, filePath);
    return { hunks, matchLine };
  } catch {
    // File not readable — compute diff without line offset
    const hunks = computeDiffHunks(oldStr, newStr, filePath);
    return { hunks, matchLine: 1 };
  }
}

function computeWriteFileDiff(
  toolInput: Record<string, unknown>,
  workingDirectory: string,
): { hunks: DiffHunk[]; matchLine: number } | null {
  const filePath = toolInput.file_path;
  const newContent = toolInput.content;
  if (typeof filePath !== "string" || typeof newContent !== "string") return null;

  // Skip the diff entirely for oversized writes rather than ship multi‑MB
  // hunks over the WS. Cheap early-exit on the new content alone — if it's
  // already past the cap there's no point looking at the old file.
  if (newContent.length > MAX_PREVIEW_DIFF_CHARS) return null;

  const resolved = filePath.startsWith("/") ? filePath : resolve(workingDirectory, filePath);

  // Three states for the existing path:
  //   - ENOENT → new file, diff against empty so content appears as all '+'
  //   - exists and is a readable regular file within the cap → diff against it
  //   - anything else (FIFO, device, unreadable, oversized, EACCES on parent,
  //     non-UTF8, etc.) → null. Rendering `oldContent = ""` for an existing
  //     file would misleadingly display the preview as fresh creation.
  let oldContent: string;
  let stat: ReturnType<typeof statSync> | null = null;
  try {
    stat = statSync(resolved);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return null;
    // ENOENT → fall through with stat === null, treated as new file below.
  }
  if (stat === null) {
    oldContent = "";
  } else {
    if (!stat.isFile()) return null;
    // Pre-approval disclosure guard: reading the existing file here would
    // include its contents in the `permission.request` broadcast to every
    // subscribed client, so a model requesting `write_file` on a sensitive
    // path (SSH key, .env, anything outside the session) could exfiltrate
    // that file before the user even decides. Only read existing contents
    // when the path is inside the session's working directory AND not
    // flagged as a dangerous/sensitive file. For a new file (`stat === null`)
    // there is nothing to disclose, so that branch is unaffected.
    if (!isPathInWorkingDirs(resolved, workingDirectory, EMPTY_DIRS)) return null;
    if (isDangerousPath(resolved)) return null;
    if (stat.size + newContent.length > MAX_PREVIEW_DIFF_CHARS) return null;
    try {
      oldContent = readFileSync(resolved, "utf-8");
    } catch {
      return null;
    }
  }

  const hunks = computeDiffHunks(oldContent, newContent, filePath);
  // The diff IS the full file, so hunks are anchored at line 1.
  return { hunks, matchLine: 1 };
}

/**
 * Create a WebSocket-based permission resolver for a session.
 * When the agent calls `ask()`, a `permission.request` event is sent
 * to all clients on the session. The resolver waits for a
 * `permission.resolve` RPC call from any client.
 */
export function createWsPermissionResolver(
  sessionKey: string,
  server: GatewayServer,
  workingDirectory = process.cwd(),
): PermissionResolver {
  return {
    ask: (
      toolUseId: string,
      toolName: string,
      toolInput: Record<string, unknown>,
      suggestions?: PermissionSuggestion[],
    ): Promise<PermissionResponse> => {
      return new Promise<PermissionResponse>((resolve) => {
        const requestId = `perm-${nextRequestId++}`;

        // Compute diff preview server-side for file edit tools
        const diffPreview = computePermissionDiff(toolName, toolInput, workingDirectory);

        // Pre-compute the suggested allow-pattern so the dialog can
        // power its "Allow `<pattern>` always" button without
        // re-implementing the heuristic on every frontend.
        const suggestedPattern = suggestRulePattern(toolName, toolInput);

        // Store pending request along with the dialog payload — no timeout,
        // stays pending until resolved. The payload snapshot lets a late-
        // joining client (a 2nd browser tab opened AFTER this broadcast,
        // an iPhone after a screen-on) hydrate its dialog from
        // session.currentTurn instead of waiting for the next broadcast
        // that may never come.
        pendingPermissions.set(requestId, {
          resolve,
          sessionKey,
          dialog: {
            toolUseId,
            toolName,
            toolInput,
            diffPreview,
            suggestions: suggestions ?? [],
            suggestedPattern,
          },
        });

        // Broadcast to all clients on this session
        server.broadcastToSession(sessionKey, "permission.request", {
          requestId,
          toolUseId,
          tool: toolName,
          input: toolInput,
          diffPreview,
          suggestions,
          suggestedPattern,
        });

        log.debug("permission requested", { requestId, toolName, sessionKey });
      });
    },
  };
}

/**
 * Resolve a pending permission request. Called from the `permission.resolve` RPC handler.
 * Returns true if the request was found and resolved, false otherwise.
 * Safe against double-resolution (timeout + resolve race): delete-then-resolve pattern.
 */
export function resolveWsPermission(
  requestId: string,
  decision: PermissionDecision,
  feedback?: string,
  pattern?: string,
): boolean {
  const pending = pendingPermissions.get(requestId);
  if (!pending) return false;

  // Delete first to prevent double-resolution
  pendingPermissions.delete(requestId);
  pending.resolve({ decision, feedback, pattern });

  log.debug("permission resolved", {
    requestId,
    decision,
    feedback: feedback ? "(provided)" : undefined,
    pattern: pattern ? "(provided)" : undefined,
  });
  return true;
}

/**
 * Cancel all pending permissions for a session (e.g., when client disconnects).
 * Auto-denies all pending requests for the session.
 */
export function cancelPendingPermissions(sessionKey: string): number {
  let cancelled = 0;
  for (const [requestId, pending] of pendingPermissions) {
    if (pending.sessionKey === sessionKey) {
      pendingPermissions.delete(requestId);
      pending.resolve({ decision: "deny" });
      cancelled++;
    }
  }
  if (cancelled > 0) {
    log.debug("cancelled pending permissions", { sessionKey, count: cancelled });
  }
  return cancelled;
}

/**
 * Check if there's a pending permission for a session.
 */
export function hasPendingPermission(sessionKey: string): boolean {
  for (const pending of pendingPermissions.values()) {
    if (pending.sessionKey === sessionKey) return true;
  }
  return false;
}
