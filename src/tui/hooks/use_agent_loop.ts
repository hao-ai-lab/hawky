// =============================================================================
// useAgentLoop Hook
//
// Custom React hook that manages the AgentLoop lifecycle and converts
// StreamEvents into React state for the TUI components.
//
// Responsibilities:
// - Creates and owns the AgentLoop instance
// - Subscribes to StreamEvents → DisplayMessage[] + TuiStatus
// - Implements PermissionResolver (Promise-based, same as COCO)
// - Handles ask_user requests with option selection
// - Tracks tool execution state for tool output rendering
// =============================================================================

import { useState, useCallback, useRef, useEffect } from "react";
import type { AgentEventSource } from "../../gateway/agent-source.js";
import type { PermissionDecision } from "../../agent/tool_executor.js";
import type { StreamEvent, TokenUsage, ChatMessage } from "../../agent/types.js";
import { resolveAskUser } from "../../tools/ask_user.js";
import { formatToolPreview } from "../utils/format_tool_preview.js";
import { historyToDisplayMessages } from "../utils/history_to_display.js";

/** Max messages to show when resuming a session. Older messages are hidden. */
const MAX_RESUME_DISPLAY = 50;

/** Truncate display messages for resume, prepending a "hidden" banner if needed. */
function truncateForResume(messages: DisplayMessage[]): DisplayMessage[] {
  if (messages.length <= MAX_RESUME_DISPLAY) return messages;
  const hidden = messages.length - MAX_RESUME_DISPLAY;
  const banner: DisplayMessage = {
    id: "resume-truncated",
    role: "system",
    text: `⋯ ${hidden} older messages hidden`,
    timestamp: messages[0]?.timestamp ?? new Date().toISOString(),
  };
  return [banner, ...messages.slice(-MAX_RESUME_DISPLAY)];
}
import type {
  DisplayMessage,
  TuiStatus,
  ToolDisplayData,
  ToolOutputLine,
  PendingPermission,
  PendingAskUser,
} from "../types.js";

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
// ID generator
// -----------------------------------------------------------------------------

let messageCounter = 0;

function nextId(): string {
  return `msg_${++messageCounter}`;
}

/** Reset counter (for testing) */
export function resetMessageCounter(): void {
  messageCounter = 0;
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

  // Track current streaming assistant message ID
  const streamingMsgIdRef = useRef<string | null>(null);
  const streamingTextRef = useRef<string>("");
  const replaceTargetMsgIdRef = useRef<string | null>(null);
  const replacingCommittedTextRef = useRef<boolean>(false);
  // Cancel flow flag
  const cancelledRef = useRef<boolean>(false);
  // Track whether we consider the agent busy (independent of loop.isRunning(),
  // because the loop's finally block runs after our cancel handler)
  const busyRef = useRef<boolean>(false);
  // Store the current sendMessage Promise so we can await it before sending again
  const sendPromiseRef = useRef<Promise<void> | null>(null);
  // Permission resolver callback (for gateway permission.request events)
  const permissionResolverRef = useRef<((decision: PermissionDecision) => void) | null>(null);
  // Map tool_use_id → message id for updating tool output entries
  const toolMsgMapRef = useRef<Map<string, string>>(new Map());

  // Agent source ref (stable across renders)
  const sourceRef = useRef<AgentEventSource>(options.agentSource);
  const sessionKeyRef = useRef<string>(options.sessionKey);
  const initializedRef = useRef<boolean>(false);

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
          const displayMsgs = historyToDisplayMessages(history);
          allMessagesRef.current = displayMsgs; // Keep full list for input history
          if (displayMsgs.length > 0) {
            setMessages(truncateForResume(displayMsgs));
          }
        }
      } catch {
        // History load failure is non-fatal (new session or gateway just started)
      }
    })();
  }, []);

  // In client mode, gateway handles session persistence.
  // This is a no-op placeholder for compatibility with event handlers that call it.
  const persistSession = useCallback(() => {
    // Gateway persists sessions automatically in agent-methods.ts
  }, []);

  // Subscribe to stream events
  useEffect(() => {
    const source = sourceRef.current;

    const unsub = source.subscribe((event: StreamEvent) => {
      switch (event.type) {
        case "text": {
          if (event.replace) {
            const targetId = streamingMsgIdRef.current ?? replaceTargetMsgIdRef.current;
            if (targetId) {
              const replacingCommittedText =
                !streamingMsgIdRef.current && replaceTargetMsgIdRef.current === targetId;
              streamingMsgIdRef.current = targetId;
              replaceTargetMsgIdRef.current = null;
              replacingCommittedTextRef.current = replacingCommittedText;
              streamingTextRef.current = event.content;
              setStatus("streaming");
              setStatusDetail(null);
              setStreamingMsgId(targetId);
              setMessages((prev) => {
                const target = prev.find((m) => m.id === targetId);
                if (!target) {
                  return [
                    ...prev,
                    {
                      id: targetId,
                      role: "assistant",
                      text: event.content,
                      timestamp: new Date().toISOString(),
                    },
                  ];
                }
                const updatedTarget = { ...target, text: event.content };
                if (replacingCommittedText) {
                  return [...prev.filter((m) => m.id !== targetId), updatedTarget];
                }
                return prev.map((m) =>
                  m.id === targetId ? updatedTarget : m,
                );
              });
              if (replacingCommittedText) {
                process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
                setSessionRemountKey((k) => k + 1);
              }
              break;
            }
          }

          if (!streamingMsgIdRef.current) {
            const id = nextId();
            streamingMsgIdRef.current = id;
            replaceTargetMsgIdRef.current = null;
            replacingCommittedTextRef.current = false;
            streamingTextRef.current = event.content;
            setStatus("streaming");
            setStatusDetail(null);
            setStreamingMsgId(id);
            setMessages((prev) => [
              ...prev,
              {
                id,
                role: "assistant",
                text: event.content,
                timestamp: new Date().toISOString(),
              },
            ]);
          } else {
            streamingTextRef.current += event.content;
            const currentText = streamingTextRef.current;
            const currentId = streamingMsgIdRef.current;
            setMessages((prev) =>
              prev.map((m) =>
                m.id === currentId ? { ...m, text: currentText } : m,
              ),
            );
          }
          break;
        }

        case "tool_use_start": {
          // Commit any in-progress streaming text so it enters <Static> before
          // tool entries.  Ink's <Static> tracks items by position — if the
          // assistant message were inserted in the middle later, it would be
          // silently dropped.
          if (streamingMsgIdRef.current) {
            replaceTargetMsgIdRef.current = streamingMsgIdRef.current;
            streamingMsgIdRef.current = null;
            streamingTextRef.current = "";
            setStreamingMsgId(null);
          }

          // Create a tool output entry in messages
          const msgId = nextId();
          toolMsgMapRef.current.set(event.tool_use_id, msgId);
          const preview = formatToolPreview(event.name, event.input);

          setStatus("thinking");
          setStatusDetail(event.name);
          setMessages((prev) => [
            ...prev,
            {
              id: msgId,
              role: "tool",
              text: "",
              timestamp: new Date().toISOString(),
              toolData: {
                toolUseId: event.tool_use_id,
                toolName: event.name,
                inputPreview: preview,
                status: "executing",
                outputLines: [],
                isError: false,
                startedAt: Date.now(),
                approvalReason: (event as any).approvalReason,
                batchId: (event as any).batchId,
                batchSize: (event as any).batchSize,
              },
            },
          ]);
          break;
        }

        case "tool_streaming": {
          // Append streaming line to the tool's output
          const msgId = toolMsgMapRef.current.get(event.tool_use_id);
          if (msgId) {
            const newLine: ToolOutputLine = {
              type: event.stream_type,
              content: event.content,
            };
            setMessages((prev) =>
              prev.map((m) => {
                if (m.id !== msgId || !m.toolData) return m;
                return {
                  ...m,
                  toolData: {
                    ...m.toolData,
                    outputLines: [...m.toolData.outputLines, newLine],
                  },
                };
              }),
            );
          }
          break;
        }

        case "tool_result": {
          setStatusDetail(null);
          const msgId = toolMsgMapRef.current.get(event.tool_use_id);
          if (msgId) {
            // Use display_content for TUI if available (richer formatting),
            // otherwise fall back to content (what the LLM sees)
            const displayText = event.display_content || event.content;
            const resultLines: ToolOutputLine[] = displayText
              ? displayText
                  .split("\n")
                  .filter((line) => line.length > 0)
                  .map((line) => ({
                    type: (event.is_error ? "stderr" : "stdout") as "stdout" | "stderr",
                    content: line,
                  }))
              : [];

            setMessages((prev) =>
              prev.map((m) => {
                if (m.id !== msgId || !m.toolData) return m;
                // If there were streaming lines, keep them; otherwise use result content
                const outputLines = m.toolData.outputLines.length > 0
                  ? m.toolData.outputLines
                  : resultLines;
                return {
                  ...m,
                  toolData: {
                    ...m.toolData,
                    status: event.is_error ? "error" : "success",
                    outputLines,
                    isError: event.is_error,
                    metadata: event.metadata,
                  },
                };
              }),
            );
            toolMsgMapRef.current.delete(event.tool_use_id);
          } else {
            // No matching tool_use_start (shouldn't happen, but safety net)
            if (event.is_error) {
              setMessages((prev) => [
                ...prev,
                {
                  id: nextId(),
                  role: "system",
                  text: `Tool ${event.name} failed: ${event.content.slice(0, 200)}`,
                  timestamp: new Date().toISOString(),
                },
              ]);
            }
          }
          break;
        }

        // ask_user_request handled in the gateway-compatible handler below (line ~432)

        case "done": {
          busyRef.current = false;
          streamingMsgIdRef.current = null;
          replaceTargetMsgIdRef.current = null;
          replacingCommittedTextRef.current = false;
          streamingTextRef.current = "";
          setStreamingMsgId(null);
          toolMsgMapRef.current.clear();
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
          if (cancelledRef.current) {
            cancelledRef.current = false;
            break;
          }
          busyRef.current = false;
          streamingMsgIdRef.current = null;
          replaceTargetMsgIdRef.current = null;
          replacingCommittedTextRef.current = false;
          streamingTextRef.current = "";
          setStreamingMsgId(null);
          setStatus("error");
          setStatusDetail(null);
          // Clear any pending prompts (permission/ask_user) — the gateway
          // is gone so these can never be answered. Without this, the modal
          // stays mounted and hides input after a disconnect.
          setPendingPermission(null);
          setPendingAskUser(null);
          setMessages((prev) => [
            ...prev,
            {
              id: nextId(),
              role: "system",
              text: `Error: ${event.content}`,
              timestamp: new Date().toISOString(),
            },
          ]);
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
          // Mark in-flight tools as canceled
          if (toolMsgMapRef.current.size > 0) {
            const canceledIds = new Set(toolMsgMapRef.current.values());
            setMessages((prev) =>
              prev.map((m) => {
                if (!canceledIds.has(m.id) || !m.toolData) return m;
                return {
                  ...m,
                  toolData: { ...m.toolData, status: "canceled" },
                };
              }),
            );
            toolMsgMapRef.current.clear();
          }
          // Handle streaming text
          if (streamingMsgIdRef.current) {
            const cancelledText = streamingTextRef.current + " [cancelled]";
            const cancelledId = streamingMsgIdRef.current;
            setMessages((prev) =>
              prev.map((m) =>
                m.id === cancelledId ? { ...m, text: cancelledText } : m,
              ),
            );
          }
          streamingMsgIdRef.current = null;
          replaceTargetMsgIdRef.current = null;
          replacingCommittedTextRef.current = false;
          streamingTextRef.current = "";
          setStreamingMsgId(null);
          setStatus("idle");
          setStatusDetail(null);
          // Show cancel hint (COCO pattern)
          setMessages((prev) => [
            ...prev,
            {
              id: nextId(),
              role: "system",
              text: "■ Interrupted — tell Hawky what to do next.",
              timestamp: new Date().toISOString(),
            },
          ]);
          break;
        }

        case "system_message": {
          setMessages((prev) => [
            ...prev,
            {
              id: nextId(),
              role: "system",
              text: event.content,
              timestamp: new Date().toISOString(),
            },
          ]);
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

        // Extended thinking (display in message if desired)
        case "thinking": {
          // Currently not displayed in TUI — could add a "thinking" indicator
          break;
        }

        // Queue message (agent busy)
        case "queue_message": {
          setMessages((prev) => [
            ...prev,
            {
              id: nextId(),
              role: "system",
              text: "Message queued — agent is busy.",
              timestamp: new Date().toISOString(),
            },
          ]);
          break;
        }
      }
    });

    return unsub;
  }, []);

  // sendMessage
  const sendMessage = useCallback((text: string, attachments?: Array<{ base64: string; media_type: string }>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    cancelledRef.current = false; // Reset stale cancel flag from previous turn
    replaceTargetMsgIdRef.current = null;
    replacingCommittedTextRef.current = false;

    // Show image indicators in TUI display (agent receives clean text + image blocks)
    let displayText = text;
    if (attachments && attachments.length > 0) {
      const labels = attachments.map((_, i) => `[Image ${i + 1}]`).join(" ");
      displayText = text ? `${text}\n${labels}` : labels;
    }

    setMessages((prev) => [
      ...prev,
      { id: nextId(), role: "user", text: displayText, timestamp: new Date().toISOString() },
    ]);
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
        setMessages((prev) => [
          ...prev,
          {
            id: nextId(),
            role: "system",
            text: `Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
            timestamp: new Date().toISOString(),
          },
        ]);
      });
  }, []);

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
    setMessages((prev) => [
      ...prev,
      {
        id: nextId(),
        role: "user",
        text: answers.join(", "),
        timestamp: new Date().toISOString(),
      },
    ]);

    const requestId = (pending as any)._requestId ?? pending.id;
    void sourceRef.current.resolveAskUser?.(requestId, answers);
    setPendingAskUser(null);
  }, [pendingAskUser]);

  // Clear terminal + reset display (for /clear command)
  // Uses ANSI escape codes like COCO: clear screen + scrollback + cursor home
  const clearMessages = useCallback(() => {
    process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
    setMessages([]);
    setStaticBaseline(0);
    setSessionRemountKey((k) => k + 1);
    streamingMsgIdRef.current = null;
    replaceTargetMsgIdRef.current = null;
    replacingCommittedTextRef.current = false;
    streamingTextRef.current = "";
    setStreamingMsgId(null);
  }, []);

  // Start new session (for /new command)
  const newSession = useCallback(() => {
    sourceRef.current.clearHistory();
    process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
    setMessages([]);
    setTokenUsage(null);
    setStatus("idle");
    setStatusDetail(null);
    busyRef.current = false;
    streamingMsgIdRef.current = null;
    replaceTargetMsgIdRef.current = null;
    replacingCommittedTextRef.current = false;
    streamingTextRef.current = "";
    setStreamingMsgId(null);
  }, []);

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
    setMessages((prev) => [
      ...prev,
      { id: nextId(), role: "system", text, timestamp: new Date().toISOString() },
    ]);
  }, []);

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
          const displayMsgs = historyToDisplayMessages(history);
          allMessagesRef.current = displayMsgs; // Keep full list for input history
          setMessages(truncateForResume(displayMsgs));
        } else {
          allMessagesRef.current = [];
          setMessages([]);
        }
        setTokenUsage(null);
        setStatus("idle");
        setStatusDetail(null);
        busyRef.current = false;
        streamingMsgIdRef.current = null;
        replaceTargetMsgIdRef.current = null;
        replacingCommittedTextRef.current = false;
        streamingTextRef.current = "";
        setStreamingMsgId(null);
        addSystemMessage(`Switched to session: ${key}`);
      } catch (err) {
        addSystemMessage(`Failed to switch session: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
  }, [addSystemMessage]);

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
