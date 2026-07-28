// =============================================================================
// useAgentLoop Hook
//
// Custom React hook that manages the AgentLoop lifecycle and binds the TUI to
// the shared canonical transcript reducer (src/transcript). Every transcript
// transition — live StreamEvents, optimistic user bubbles, and history
// restore — goes through the pure core (reduce / appendUserMessage /
// fromHistory); this hook only owns SIDE EFFECTS:
// - AgentLoop lifecycle (send/cancel/session switching)
// - status bar state, token usage, pending permission/ask_user prompts
// - TUI-only per-item overlays (wall-clock timestamps, elapsed-timer start,
//   the " [cancelled]" suffix) — the core never touches Date.now()
// - terminal redraw + Ink <Static> remount when replace=true lands on
//   committed text (cursor.replacedCommitted) and on clear/resume
// The canonical items are projected to DisplayMessage[] via the
// transcript_display selector.
// =============================================================================

import { useState, useCallback, useRef, useEffect } from "react";
import type { AgentEventSource } from "../../gateway/agent-source.js";
import type { PermissionDecision } from "../../agent/tool_executor.js";
import type { StreamEvent, TokenUsage } from "../../agent/types.js";
import {
  appendUserMessage,
  fromHistory,
  initialState,
  reduce,
  type TranscriptState,
} from "../../transcript/index.js";
import {
  deriveDisplayMessages,
  type DisplayOverlay,
} from "../utils/transcript_display.js";
import type {
  DisplayMessage,
  TuiStatus,
  PendingPermission,
  PendingAskUser,
} from "../types.js";

/** Max messages to show when resuming a session. Older messages are hidden. */
const MAX_RESUME_DISPLAY = 50;

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface UseAgentLoopOptions {
  /** Agent event source — GatewayClient in production, mock in tests */
  agentSource: AgentEventSource;
  /** Session key for this TUI instance */
  sessionKey: string;
}

export interface UseAgentLoopReturn {
  messages: DisplayMessage[];
  /** Full untruncated messages for input history seeding (includes hidden older messages) */
  allMessages: DisplayMessage[];
  status: TuiStatus;
  statusDetail: string | null;
  tokenUsage: TokenUsage | null;
  sendMessage: (text: string, attachments?: Array<{ base64: string; media_type: string }>) => void;
  cancel: () => void;
  /** Pending permission request (show PermissionPrompt) */
  pendingPermission: PendingPermission | null;
  /** Respond to a pending permission */
  resolvePermission: (decision: PermissionDecision, feedback?: string, pattern?: string) => void;
  /** Pending ask_user request (show AskUserPrompt) */
  pendingAskUser: PendingAskUser | null;
  /** Respond to a pending ask_user */
  resolveAskUserPrompt: (answers: string[]) => void;
  /** Current session ID */
  sessionId: string;
  /** Clear visual messages (for /clear) */
  clearMessages: () => void;
  /** Start new session (for /new) */
  newSession: () => void;
  /** Trigger memory flush (for /flush) */
  flushMemory: () => void;
  /** Trigger context compaction (for /compact) */
  triggerCompaction: () => void;
  /** Fetch MCP status from gateway (for /mcp) */
  fetchMcpStatus: () => void;
  /** Fork current system session into interactive chat (for /fork) */
  forkSession: () => void;
  /** Add a system message to the display (for slash command output) */
  addSystemMessage: (text: string) => void;
  /** Resume a different session (for /resume) */
  resumeSession: (sessionId: string) => void;
  /** Number of messages prepainted to stdout (skip in Static) */
  staticBaseline: number;
  /** ID of the currently streaming assistant message (null when not streaming text) */
  streamingMsgId: string | null;
  /** Incremented on session switch to force Static remount */
  sessionRemountKey: number;
}

// -----------------------------------------------------------------------------
// Hook
// -----------------------------------------------------------------------------

export function useAgentLoop(options: UseAgentLoopOptions): UseAgentLoopReturn {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  /** Full untruncated messages — used for input history seeding (not affected by resume truncation) */
  const allMessagesRef = useRef<DisplayMessage[]>([]);
  const [status, setStatus] = useState<TuiStatus>("idle");
  const [statusDetail, setStatusDetail] = useState<string | null>(null);
  const [tokenUsage, setTokenUsage] = useState<TokenUsage | null>(null);
  const [pendingPermission, setPendingPermission] = useState<PendingPermission | null>(null);
  const [pendingAskUser, setPendingAskUser] = useState<PendingAskUser | null>(null);
  const [staticBaseline, setStaticBaseline] = useState(0);
  const [streamingMsgId, setStreamingMsgId] = useState<string | null>(null);
  const [sessionRemountKey, setSessionRemountKey] = useState(0);

  // Canonical transcript state (the shared reducer's fold) + TUI-only
  // per-item overlays (timestamps / startedAt / cancelled suffix / order).
  const transcriptRef = useRef<TranscriptState>(initialState());
  const overlaysRef = useRef<Map<string, DisplayOverlay>>(new Map());
  /** Number of leading items hidden by resume truncation. */
  const hiddenPrefixRef = useRef(0);

  // Cancel flow flag (TUI rule: swallow the first error after a local cancel
  // entirely — the in-process loop rethrows the provider abort as a generic
  // "aborted" error that the core's sentinel gate would let through)
  const cancelledRef = useRef<boolean>(false);
  // Track whether we consider the agent busy (independent of loop.isRunning(),
  // because the loop's finally block runs after our cancel handler)
  const busyRef = useRef<boolean>(false);
  // Store the current sendMessage Promise so we can await it before sending again
  const sendPromiseRef = useRef<Promise<void> | null>(null);
  // Permission resolver callback (for gateway permission.request events)
  const permissionResolverRef = useRef<((decision: PermissionDecision) => void) | null>(null);

  // Agent source ref (stable across renders)
  const sourceRef = useRef<AgentEventSource>(options.agentSource);
  const sessionKeyRef = useRef<string>(options.sessionKey);
  const initializedRef = useRef<boolean>(false);

  /** Get-or-create the overlay record for an item id. */
  const overlayFor = useCallback((id: string): DisplayOverlay => {
    let overlay = overlaysRef.current.get(id);
    if (!overlay) {
      overlay = {};
      overlaysRef.current.set(id, overlay);
    }
    return overlay;
  }, []);

  /** Project canonical state → DisplayMessage[] and push it into React,
   *  applying resume truncation (banner + slice) when active. */
  const publish = useCallback(() => {
    const all = deriveDisplayMessages(transcriptRef.current, overlaysRef.current);
    const hidden = hiddenPrefixRef.current;
    if (hidden > 0 && all.length > hidden) {
      const banner: DisplayMessage = {
        id: "resume-truncated",
        role: "system",
        text: `⋯ ${hidden} older messages hidden`,
        timestamp: all[0]?.timestamp ?? new Date().toISOString(),
      };
      setMessages([banner, ...all.slice(hidden)]);
    } else {
      setMessages(all);
    }
  }, []);

  /** Stamp TUI-only clock fields on items the last transition appended.
   *  (The pure core never calls Date.now() — ids/ordering are canonical,
   *  wall-clock presentation is ours.) */
  const stampNewItems = useCallback((prev: TranscriptState, next: TranscriptState) => {
    for (let i = prev.items.length; i < next.items.length; i++) {
      const item = next.items[i];
      const overlay = overlayFor(item.id);
      if (overlay.timestamp === undefined) overlay.timestamp = new Date().toISOString();
      if (item.kind === "tool" && overlay.startedAt === undefined) overlay.startedAt = Date.now();
    }
  }, [overlayFor]);

  /** Fold one StreamEvent through the canonical reducer + refresh React state. */
  const applyEvent = useCallback((event: StreamEvent) => {
    const prev = transcriptRef.current;
    const next = reduce(prev, event);
    transcriptRef.current = next;
    stampNewItems(prev, next);

    // replace=true landed on ALREADY-COMMITTED text: the core replaces it in
    // place and reports the transition; reproduce the TUI's old Ink <Static>
    // filter+re-append+redraw so the final message renders after the tool
    // cards. Static items were already painted to stdout, so we clear the
    // terminal and remount Static to repaint the updated text.
    if (next.cursor.replacedCommitted) {
      const movedId = next.cursor.streamingItemId;
      if (movedId) {
        // Fractional key: after every current item, before any future one.
        overlayFor(movedId).sortKey = next.items.length - 0.5;
      }
      process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
      setSessionRemountKey((k) => k + 1);
    }

    setStreamingMsgId(next.cursor.streamingItemId);
    if (next.items !== prev.items) publish();
  }, [overlayFor, publish, stampNewItems]);

  /** Apply a local (non-event) canonical mutation, e.g. the optimistic user bubble. */
  const applyLocal = useCallback((mutate: (s: TranscriptState) => TranscriptState) => {
    const prev = transcriptRef.current;
    const next = mutate(prev);
    transcriptRef.current = next;
    stampNewItems(prev, next);
    publish();
  }, [publish, stampNewItems]);

  /** Reset the canonical transcript + overlays (for /clear, /new, resume). */
  const resetTranscript = useCallback((state?: TranscriptState) => {
    transcriptRef.current = state ?? initialState();
    overlaysRef.current = new Map();
    hiddenPrefixRef.current = 0;
  }, []);

  // Load session history on first render (async — gateway client needs RPC).
  // History is loaded into React state and rendered by <Static> — no prepaint.
  // a proven design pattern: populate chat log, let UI render normally.
  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;

    void (async () => {
      try {
        const history = await sourceRef.current.getHistory();
        if (history.length > 0) {
          const state = fromHistory(history);
          const displayMsgs = deriveDisplayMessages(state);
          resetTranscript(state);
          allMessagesRef.current = displayMsgs; // Keep full list for input history
          if (displayMsgs.length > 0) {
            hiddenPrefixRef.current = Math.max(0, displayMsgs.length - MAX_RESUME_DISPLAY);
            publish();
          }
        }
      } catch {
        // History load failure is non-fatal (new session or gateway just started)
      }
    })();
  }, [publish, resetTranscript]);

  // In client mode, gateway handles session persistence.
  // This is a no-op placeholder for compatibility with event handlers that call it.
  const persistSession = useCallback(() => {
    // Gateway persists sessions automatically in agent-methods.ts
  }, []);

  // Subscribe to stream events. Transitions go through the shared reducer;
  // this handler keeps ONLY the TUI side effects.
  useEffect(() => {
    const source = sourceRef.current;

    const unsub = source.subscribe((event: StreamEvent) => {
      // --- Pre-reduce adapter concerns -------------------------------------
      if (event.type === "error" && cancelledRef.current) {
        // First error after a local cancel is the loop rethrowing the abort —
        // swallow it entirely (stricter than the core's sentinel gate).
        cancelledRef.current = false;
        return;
      }
      if (event.type === "cancel") {
        // The " [cancelled]" suffix is TUI presentation: mark the message
        // that was streaming when the cancel hit (the reducer finalizes it
        // unsuffixed, per the canonical rule).
        const sid = transcriptRef.current.cursor.streamingItemId;
        if (sid) overlayFor(sid).cancelled = true;
      }

      // --- Canonical transition ---------------------------------------------
      applyEvent(event);

      // --- Post-reduce side effects (status bar, prompts, usage, busy) ------
      switch (event.type) {
        case "text": {
          setStatus("streaming");
          setStatusDetail(null);
          break;
        }

        case "tool_use_start": {
          setStatus("thinking");
          setStatusDetail(event.name);
          break;
        }

        case "tool_result": {
          setStatusDetail(null);
          break;
        }

        case "done": {
          busyRef.current = false;
          setStatus("idle");
          setStatusDetail(null);
          if (event.usage) {
            setTokenUsage(event.usage);
          }
          // Persist session: append new messages since last save
          persistSession();
          break;
        }

        case "error": {
          busyRef.current = false;
          setStatus("error");
          setStatusDetail(null);
          // Clear any pending prompts (permission/ask_user) — the gateway
          // is gone so these can never be answered. Without this, the modal
          // stays mounted and hides input after a disconnect.
          setPendingPermission(null);
          setPendingAskUser(null);
          break;
        }

        case "cancel": {
          cancelledRef.current = true;
          busyRef.current = false;
          // Resolve pending permission as "deny" so tool_executor unblocks.
          // Without this, the await in tool_executor.ts line 146 blocks forever
          // and the loop's sendMessage() Promise never resolves.
          if (permissionResolverRef.current) {
            permissionResolverRef.current("deny");
          }
          permissionResolverRef.current = null;
          // Clear pending prompts
          setPendingPermission(null);
          setPendingAskUser(null);
          setStatus("idle");
          setStatusDetail(null);
          break;
        }

        // Permission request from gateway — show permission prompt
        case "permission_request": {
          const e = event as any;
          setPendingPermission({
            id: e.tool_use_id ?? e._requestId,
            toolUseId: e.tool_use_id ?? e._requestId,
            toolName: e.name,
            toolInput: e.input,
            _requestId: e._requestId, // For RPC resolution
            suggestions: e.suggestions, // Context-aware suggestions
            suggestedPattern: typeof e.suggestedPattern === "string" && e.suggestedPattern.trim()
              ? e.suggestedPattern
              : undefined,
          });
          break;
        }

        // ask_user request from gateway — show ask_user prompt
        // The event may arrive via two paths:
        //   1. Dedicated: ask_user.request → _requestId is set by gateway-client
        //   2. Generic: agent.ask_user_request → raw StreamEvent has `id` (not _requestId)
        // We check both to get the correct request ID for RPC resolution.
        case "ask_user_request": {
          const e = event as any;
          const reqId = e._requestId ?? e.id ?? e.tool_use_id;
          setPendingAskUser({
            id: reqId,
            toolName: e.name,
            question: e.question,
            options: e.options ?? [],
            _requestId: reqId,
          });
          break;
        }

        // thinking / queue_message / system_message / user_committed /
        // permission_result / ask_user_response: fully handled by the
        // reducer (or deliberate no-ops) — no TUI side effects.
        default:
          break;
      }
    });

    return unsub;
  }, [applyEvent, overlayFor, persistSession]);

  // sendMessage
  const sendMessage = useCallback((text: string, attachments?: Array<{ base64: string; media_type: string }>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    cancelledRef.current = false; // Reset stale cancel flag from previous turn

    // Show image indicators in TUI display (agent receives clean text + image blocks)
    let displayText = text;
    if (attachments && attachments.length > 0) {
      const labels = attachments.map((_, i) => `[Image ${i + 1}]`).join(" ");
      displayText = text ? `${text}\n${labels}` : labels;
    }

    applyLocal((s) => {
      // A new turn is starting — clear any stale cancelPending in the
      // canonical cursor (mirrors web's sendMessage). The subscribe
      // handler's pre-reduce swallow consumes the first post-cancel error
      // BEFORE the reducer sees it, so the reducer's flag would otherwise
      // stay armed across turns and silently suppress an unrelated
      // abort-worded error next turn.
      const cleared = s.cursor.cancelPending
        ? { items: s.items, cursor: { ...s.cursor, cancelPending: false } }
        : s;
      return appendUserMessage(cleared, displayText);
    });
    setStatus("thinking");
    setStatusDetail(null);

    // Wait for any previous sendMessage to fully finish (its finally block),
    // then send the new message. This prevents the loop from seeing isRunning=true
    // from a previous cancelled turn.
    const prevPromise = sendPromiseRef.current ?? Promise.resolve();
    const source = sourceRef.current;

    // Safety: if the previous Promise doesn't resolve within 5s, proceed anyway
    const withTimeout = Promise.race([
      prevPromise.catch(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, 5000)),
    ]);

    sendPromiseRef.current = withTimeout
      .then(() => source.sendMessage(text, attachments))
      .catch((err) => {
        setStatus("error");
        setStatusDetail(null);
        busyRef.current = false;
        applyEvent({
          type: "system_message",
          content: `Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
        });
      });
  }, [applyEvent, applyLocal]);

  const cancel = useCallback(() => {
    sourceRef.current.cancel();
  }, []);

  // Permission resolution — sends decision back to gateway via RPC
  const resolvePermission = useCallback((decision: PermissionDecision, feedback?: string, pattern?: string) => {
    const pending = pendingPermission;
    if (pending) {
      const requestId = (pending as any)._requestId ?? pending.id;
      void sourceRef.current.resolvePermission?.(requestId, decision, feedback, pattern);
    }
    setPendingPermission(null);
  }, [pendingPermission]);

  // ask_user resolution — sends answer back to gateway via RPC
  const resolveAskUserPrompt = useCallback((answers: string[]) => {
    const pending = pendingAskUser;
    if (!pending) return;

    // Show user's answer as a message
    applyLocal((s) => appendUserMessage(s, answers.join(", ")));

    const requestId = (pending as any)._requestId ?? pending.id;
    void sourceRef.current.resolveAskUser?.(requestId, answers);
    setPendingAskUser(null);
  }, [applyLocal, pendingAskUser]);

  // Clear terminal + reset display (for /clear command)
  // Uses ANSI escape codes like COCO: clear screen + scrollback + cursor home
  const clearMessages = useCallback(() => {
    process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
    resetTranscript();
    setMessages([]);
    setStaticBaseline(0);
    setSessionRemountKey((k) => k + 1);
    setStreamingMsgId(null);
  }, [resetTranscript]);

  // Start new session (for /new command)
  const newSession = useCallback(() => {
    sourceRef.current.clearHistory();
    process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
    resetTranscript();
    setMessages([]);
    setTokenUsage(null);
    setStatus("idle");
    setStatusDetail(null);
    busyRef.current = false;
    setStreamingMsgId(null);
  }, [resetTranscript]);

  // Trigger memory flush (for /flush command)
  const flushMemory = useCallback(() => {
    sourceRef.current.flush?.();
  }, []);

  // Trigger context compaction (for /compact command)
  const triggerCompaction = useCallback(() => {
    sourceRef.current.compact?.();
  }, []);

  // Add a system message (for slash command output)
  const addSystemMessage = useCallback((text: string) => {
    applyEvent({ type: "system_message", content: text });
  }, [applyEvent]);

  // Fetch MCP status from gateway and display as system message (for /mcp command)
  const fetchMcpStatus = useCallback(() => {
    const source = sourceRef.current;
    if (!source.rpc) {
      addSystemMessage("MCP status not available (no gateway connection).");
      return;
    }
    source.rpc("mcp.status").then((result: any) => {
      const servers = result?.servers ?? [];
      if (servers.length === 0) {
        addSystemMessage("No MCP servers configured. Add servers to mcp_servers in ~/.hawky/config.json.");
        return;
      }
      const lines: string[] = ["MCP Servers:", ""];
      for (const s of servers) {
        const icon = s.status === "connected" ? "✓" : s.status === "error" ? "✗" : "⠋";
        lines.push(`  ${icon} ${s.name} (${s.status}) — ${s.toolCount} tool${s.toolCount !== 1 ? "s" : ""}`);
        if (s.error) lines.push(`    Error: ${s.error}`);
        for (const t of s.tools ?? []) {
          lines.push(`    · ${t}`);
        }
      }
      addSystemMessage(lines.join("\n"));
    }).catch(() => {
      addSystemMessage("Failed to fetch MCP status from gateway.");
    });
  }, [addSystemMessage]);

  // Fork current system session's last run into a new interactive session
  const forkSession = useCallback(() => {
    const source = sourceRef.current;
    if (!source.rpc) {
      addSystemMessage("Fork not available (no gateway connection).");
      return;
    }
    source.rpc("session.fork", { sourceKey: sessionKeyRef.current, platform: "tui" }).then((result: any) => {
      if (result?.sessionKey) {
        addSystemMessage(`Forked to ${result.sessionKey}. Switching...`);
        if (source.switchSession) {
          source.switchSession(result.sessionKey);
        }
      }
    }).catch((err: Error) => {
      addSystemMessage(`Fork failed: ${err.message}`);
    });
  }, [addSystemMessage]);

  // Resume / switch to a different session
  const resumeSession = useCallback((targetSessionKey: string) => {
    const source = sourceRef.current;
    if (!source.switchSession) {
      addSystemMessage("Session switching not available.");
      return;
    }

    // Strip "gw-" prefix if user copied from /sessions output
    let key = targetSessionKey;
    if (key.startsWith("gw-")) {
      key = key.slice(3).replace(/-/g, ":");
    }

    void (async () => {
      try {
        // Check if session exists before switching (avoid creating empty sessions)
        const isSystemSession = key.startsWith("heartbeat:") || key.startsWith("cron:");
        if (!isSystemSession && source.rpc) {
          try {
            const check = await source.rpc("session.exists", { sessionKey: key }) as any;
            if (check && !check.exists) {
              addSystemMessage(`Session "${key}" does not exist. Use /sessions to list available sessions, or /new to start a new session.`);
              return;
            }
          } catch {
            // session.exists RPC not available — proceed with switchSession
          }
        }

        const history = await source.switchSession!(key);
        sessionKeyRef.current = key;

        // Clear display and reload history
        process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
        setStaticBaseline(0);
        setSessionRemountKey((k) => k + 1);
        if (history.length > 0) {
          const state = fromHistory(history);
          const displayMsgs = deriveDisplayMessages(state);
          resetTranscript(state);
          allMessagesRef.current = displayMsgs; // Keep full list for input history
          hiddenPrefixRef.current = Math.max(0, displayMsgs.length - MAX_RESUME_DISPLAY);
          publish();
        } else {
          resetTranscript();
          allMessagesRef.current = [];
          setMessages([]);
        }
        setTokenUsage(null);
        setStatus("idle");
        setStatusDetail(null);
        busyRef.current = false;
        setStreamingMsgId(null);
        addSystemMessage(`Switched to session: ${key}`);
      } catch (err) {
        addSystemMessage(`Failed to switch session: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
  }, [addSystemMessage, publish, resetTranscript]);

  const sessionId = sourceRef.current.getSessionKey?.() ?? sessionKeyRef.current;

  return {
    messages,
    allMessages: allMessagesRef.current,
    status,
    statusDetail,
    tokenUsage,
    sendMessage,
    cancel,
    pendingPermission,
    resolvePermission,
    pendingAskUser,
    resolveAskUserPrompt,
    sessionId,
    clearMessages,
    newSession,
    flushMemory,
    triggerCompaction,
    fetchMcpStatus,
    forkSession,
    addSystemMessage,
    resumeSession,
    staticBaseline,
    streamingMsgId,
    sessionRemountKey,
  };
}
