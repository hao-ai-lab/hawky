// =============================================================================
// TUI App — Root Component
//
// Layout: welcome banner (scrolls up with messages) + status bar + input.
// Permission prompts and ask_user selectors render in the live area.
// Slash commands (/ prefix) are handled before being sent to the agent.
// =============================================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { MessageList } from "./components/message_list.js";
import { StatusBar } from "./components/status_bar.js";
import { InputArea } from "./components/input_area.js";
import { PermissionPrompt } from "./components/permission_prompt.js";
import { AskUserPrompt } from "./components/ask_user_prompt.js";
import { parseImagePaths } from "./image-attach.js";
import { TaskTray } from "./components/task_tray.js";
import { TaskViewer } from "./components/task_viewer.js";
import { StatusPanel } from "./components/status_panel.js";
import { useAgentLoop } from "./hooks/use_agent_loop.js";
import { isCommand, executeCommand, type CommandContext } from "./commands.js";
import { loadConfig } from "../storage/config.js";
import { detectGitInfo } from "../agent/environment.js";
import type { AgentEventSource } from "../gateway/agent-source.js";
import { HeartbeatIndicator, type HeartbeatInfo } from "./components/heartbeat_indicator.js";

// -----------------------------------------------------------------------------
// Props
// -----------------------------------------------------------------------------

/** Flush status for TUI display */
export interface FlushInfo {
  running: boolean;
  completedAt: number | null;
  skippedAt: number | null;
  skipReason: string | null;
}

interface AppProps {
  model: string;
  agentSource: AgentEventSource;
  sessionKey: string;
  /** Heartbeat status (updated externally via gateway client events) */
  heartbeatInfo?: HeartbeatInfo | null;
  /** Flush status (updated externally via gateway client events) */
  flushInfo?: FlushInfo | null;
  /** Whether context compaction is currently running */
  isCompacting?: boolean;
  /** Current permission mode (drives the footer [BYPASS] indicator). */
  permissionMode?: { mode: "default" | "accept-edits" | "bypass" | null; forceBypass: boolean };
}

// -----------------------------------------------------------------------------
// App Component
// -----------------------------------------------------------------------------

export function App({ model: initialModel, agentSource, sessionKey, heartbeatInfo, flushInfo, isCompacting, permissionMode }: AppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [currentModel, setCurrentModel] = useState(initialModel);
  const cwd = process.cwd();

  // Static remount key — incrementing forces <Static> to re-render all items
  // at the new terminal width (COCO pattern: clearAndRemountStatic)
  const [staticRemountKey, setStaticRemountKey] = useState(0);

  // Task viewer overlay (Ctrl+D)
  const [showTaskViewer, setShowTaskViewer] = useState(false);
  const [showStatusPanel, setShowStatusPanel] = useState(false);
  const [statusPanelTab, setStatusPanelTab] = useState<"cost" | "usage" | "errors">("cost");

  // Display mode: compact (default) vs expanded (Ctrl+O)
  const [verbose, setVerbose] = useState(false);

  const {
    messages, allMessages, status, statusDetail, tokenUsage,
    sendMessage, cancel,
    pendingPermission, resolvePermission,
    pendingAskUser, resolveAskUserPrompt,
    sessionId, clearMessages, newSession, flushMemory, triggerCompaction, fetchMcpStatus, forkSession,
    addSystemMessage, resumeSession, staticBaseline,
    streamingMsgId, sessionRemountKey,
  } = useAgentLoop({
    agentSource,
    sessionKey,
  });

  // Memoize git info (stable across renders)
  const gitInfo = useMemo(() => detectGitInfo(cwd), [cwd]);
  const gitBranch = gitInfo?.branch;

  // --- Terminal resize handler (COCO pattern) ---
  // On resize: debounce 150ms, then clear terminal + remount Static.
  // This fixes ghost borders from <Static> content rendered at the old width.
  // Only fires when the terminal width actually changes — spurious resize
  // events from Ink startup or tmux are ignored to prevent flashing.
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastColsRef = useRef<number>(process.stdout.columns ?? 80);
  useEffect(() => {
    const target = stdout ?? process.stdout;
    const onResize = () => {
      const newCols = target.columns ?? 80;
      if (newCols === lastColsRef.current) return; // No actual width change
      lastColsRef.current = newCols;

      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = setTimeout(() => {
        // Clear entire terminal + scrollback + move cursor home
        target.write("\x1b[2J\x1b[3J\x1b[H");
        // Remount Static with a new key — forces re-render of all frozen items
        setStaticRemountKey((k) => k + 1);
        resizeTimerRef.current = null;
      }, 150);
    };
    target.on("resize", onResize);
    return () => {
      target.off("resize", onResize);
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
    };
  }, [stdout]);

  // --- Global Ctrl+O handler (display mode toggle) ---
  // Lives at App level so it works even when InputArea is unmounted
  // (e.g., during permission prompts or ask_user dialogs)
  useInput((_input, key) => {
    if (key.ctrl && _input === "o") {
      const target = stdout ?? process.stdout;
      target.write("\x1b[2J\x1b[3J\x1b[H");
      setVerbose((v) => !v);
      setStaticRemountKey((k) => k + 1);
    }
  });

  // Session info for welcome screen
  const sessionInfoText = "New session started";

  // Find the streaming message by explicit ID from the hook
  const streamingMessage = useMemo(() => {
    if (!streamingMsgId) return null;
    return messages.find((m) => m.id === streamingMsgId) ?? null;
  }, [streamingMsgId, messages]);

  // Per-instance previous session tracking (for /heartbeat → /back)
  const [previousSessionKey, setPreviousSessionKey] = useState<string | null>(null);

  const handleSubmit = useCallback((text: string) => {
    // Block messages on system sessions FIRST (before image or command parsing)
    const isBgSession = sessionId.startsWith("heartbeat:") || sessionId.startsWith("cron:");

    // Check for image paths — file paths start with / and would be
    // misdetected as slash commands. If the input contains an image path
    // that exists on disk, treat it as a message with attachment, not a command.
    const imagePeek = parseImagePaths(text);
    if (imagePeek.attachments.length > 0) {
      if (isBgSession) {
        addSystemMessage("Cannot send messages to a background session. Use /back to return.");
        return;
      }
      if (imagePeek.errors.length > 0) {
        for (const err of imagePeek.errors) {
          addSystemMessage(`Image error: ${err}`);
        }
      }
      const messageText = imagePeek.text || "(image attached)";
      sendMessage(messageText, imagePeek.attachments);
      return;
    }

    // Check for slash commands
    if (isCommand(text)) {
      const ctx: CommandContext = {
        model: currentModel,
        workingDirectory: cwd,
        sessionId,
        tokenUsage,
        messageCount: messages.length,
        gitBranch,
        previousSessionKey,
        setPreviousSessionKey,
        exit,
        clearMessages,
        newSession,
        flushMemory,
        triggerCompaction,
        fetchMcpStatus,
        forkSession,
        switchModel: (m) => {
          setCurrentModel(m);
        },
        resumeSession,
        showStatusPanel: (tab) => { setStatusPanelTab(tab ?? "cost"); setShowStatusPanel(true); },
        toggleBypass: (enable) => {
          if (!agentSource.rpc) return "Not connected to gateway.";
          agentSource.rpc("permission.bypass", { enable, sessionKey: sessionId })
            .then((result: any) => {
              addSystemMessage(result?.message ?? (enable ? "Bypass mode ON" : "Bypass mode OFF"));
            })
            .catch((err: Error) => {
              addSystemMessage(`Error: ${err.message}`);
            });
          return null;
        },
        setPermissionMode: (mode) => {
          if (!agentSource.rpc) return "Not connected to gateway.";
          agentSource.rpc("permission.mode", { mode, sessionKey: sessionId })
            .then((result: any) => {
              addSystemMessage(result?.message ?? `Permission mode: ${mode}`);
            })
            .catch((err: Error) => {
              addSystemMessage(`Error: ${err.message}`);
            });
          return null;
        },
        getPermissionMode: () => {
          if (!agentSource.rpc) return "default";
          agentSource.rpc("permission.mode", { sessionKey: sessionId })
            .then((result: any) => {
              const mode = result?.mode ?? "default";
              const labels: Record<string, string> = {
                "default": "default — always prompt for edits and bash",
                "accept-edits": "accept-edits — auto-approve edits in project dir + filesystem bash",
                "bypass": "bypass — all tools auto-approved (⚠ dangerous)",
              };
              addSystemMessage(`Permission mode: ${labels[mode] ?? mode}`);
            })
            .catch((err: Error) => {
              addSystemMessage(`Error: ${err.message}`);
            });
          return "";
        },
        setEffort: (effort) => {
          if (!agentSource.rpc) return "Not connected to gateway.";
          agentSource.rpc("config.effort", { effort, sessionKey: sessionId })
            .then((result: any) => addSystemMessage(result?.message ?? `Effort: ${effort}`))
            .catch((err: Error) => addSystemMessage(`Error: ${err.message}`));
          return null;
        },
        getEffort: () => {
          if (!agentSource.rpc) return;
          agentSource.rpc("config.effort", { sessionKey: sessionId })
            .then((result: any) => addSystemMessage(result?.message ?? "Effort: medium"))
            .catch((err: Error) => addSystemMessage(`Error: ${err.message}`));
        },
        renameSession: (key, displayName) => {
          if (!agentSource.rpc) return;
          agentSource.rpc("session.rename", { sessionKey: key, displayName })
            .catch((err: Error) => addSystemMessage(`Error: ${err.message}`));
        },
        archiveSession: (key) => {
          if (!agentSource.rpc) return;
          agentSource.rpc("session.archive", { sessionKey: key })
            .catch((err: Error) => addSystemMessage(`Error: ${err.message}`));
        },
        deleteSession: (key) => {
          if (!agentSource.rpc) return;
          agentSource.rpc("session.delete", { sessionKey: key })
            .catch((err: Error) => addSystemMessage(`Error: ${err.message}`));
        },
        pinSession: (key) => {
          if (!agentSource.rpc) return;
          agentSource.rpc("session.pin", { sessionKey: key })
            .catch((err: Error) => addSystemMessage(`Error: ${err.message}`));
        },
        unpinSession: (key) => {
          if (!agentSource.rpc) return;
          agentSource.rpc("session.unpin", { sessionKey: key })
            .catch((err: Error) => addSystemMessage(`Error: ${err.message}`));
        },
        swapProvider: (spec) => {
          if (!agentSource.rpc) { addSystemMessage("Not connected to gateway."); return; }
          agentSource.rpc("gateway.swapProvider", spec)
            .then((result: any) => {
              if (result?.ok) {
                addSystemMessage(`Provider switched to: ${spec.provider}${spec.active_profile ? `:${spec.active_profile}` : ""}`);
              } else {
                addSystemMessage(`Error: ${result?.error ?? "swap failed"}`);
              }
            })
            .catch((err: Error) => addSystemMessage(`Error: ${err.message}`));
        },
        addProfile: (params) => {
          if (!agentSource.rpc) { addSystemMessage("Not connected to gateway."); return; }
          agentSource.rpc("gateway.addProfile", params)
            .then((result: any) => {
              if (result?.ok) {
                addSystemMessage(`Profile "${params.name}" added.`);
              } else {
                addSystemMessage(`Error: ${result?.error ?? "add failed"}`);
              }
            })
            .catch((err: Error) => addSystemMessage(`Error: ${err.message}`));
        },
        removeProfile: (name) => {
          if (!agentSource.rpc) { addSystemMessage("Not connected to gateway."); return; }
          agentSource.rpc("gateway.removeProfile", { name })
            .then((result: any) => {
              if (result?.ok) {
                addSystemMessage(`Profile "${name}" removed.`);
              } else {
                addSystemMessage(`Error: ${result?.error ?? "remove failed"}`);
              }
            })
            .catch((err: Error) => addSystemMessage(`Error: ${err.message}`));
        },
        renameProfile: (oldName, newName) => {
          if (!agentSource.rpc) { addSystemMessage("Not connected to gateway."); return; }
          agentSource.rpc("gateway.renameProfile", { old: oldName, new: newName })
            .then((result: any) => {
              if (result?.ok) {
                addSystemMessage(`Profile renamed: "${oldName}" → "${newName}".`);
              } else {
                addSystemMessage(`Error: ${result?.error ?? "rename failed"}`);
              }
            })
            .catch((err: Error) => addSystemMessage(`Error: ${err.message}`));
        },
        getProviderConfig: () => {
          try {
            const cfg = loadConfig();
            return {
              provider: cfg.provider ?? "anthropic",
              active_profile: cfg.openai_compatible?.active_profile,
              profiles: cfg.openai_compatible?.profiles as Record<string, unknown> | undefined,
            };
          } catch {
            return { provider: "anthropic" };
          }
        },
      };

      const result = executeCommand(text, ctx);
      if (result.skillMessage) {
        // Block skill-backed commands on background sessions (e.g., /cron run)
        // — these call sendMessage which would start an agent turn in the system session.
        const isBg = sessionId.startsWith("heartbeat:") || sessionId.startsWith("cron:");
        if (isBg) {
          addSystemMessage("Cannot run commands in a background session. Use /back to return.");
          return;
        }
        sendMessage(result.skillMessage);
        return;
      }
      if (result.text) {
        addSystemMessage(result.text);
      }
      return;
    }

    // Block regular messages on system sessions (already checked for images above)
    if (isBgSession) {
      addSystemMessage("Cannot send messages to a background session. Use /back to return.");
      return;
    }

    // Image paths already handled above (before command check).
    // If we reach here, no images were detected — send as plain text.
    sendMessage(text);
  }, [
    currentModel, cwd, sessionId, tokenUsage, messages.length, gitBranch,
    previousSessionKey, exit, clearMessages, newSession, flushMemory, triggerCompaction, fetchMcpStatus, forkSession,
    sendMessage, addSystemMessage, resumeSession,
  ]);

  const handleExit = useCallback(() => {
    exit();
  }, [exit]);

  const handleCancel = useCallback(() => {
    cancel();
  }, [cancel]);

  // Input is disabled when agent is working, UNLESS:
  // - There's an interactive prompt (permission/ask_user)
  // - We're viewing a system session (cron/heartbeat) — the agent was started
  //   by the headless system, not by us. Input must stay enabled so the user
  //   can type /back or /resume to leave.
  const hasInteractivePrompt = !!(pendingPermission || pendingAskUser);
  const isSystemSession = sessionId.startsWith("heartbeat:") || sessionId.startsWith("cron:");
  const isAgentBusy = status === "thinking" || status === "streaming";
  const isDisabled = (isAgentBusy || isCompacting) && !hasInteractivePrompt && !isSystemSession;
  const hideInput = hasInteractivePrompt;
  const canCancel = isAgentBusy && !isSystemSession;

  return (
    <Box flexDirection="column">
      {!showStatusPanel && <Box flexGrow={1}>
        <MessageList
          messages={messages}
          model={currentModel}
          streamingMessage={streamingMessage}
          staticBaseline={staticBaseline}
          staticRemountKey={staticRemountKey + sessionRemountKey}
          gitBranch={gitBranch}
          gitClean={true}
          sessionInfo={sessionInfoText}
          workingDirectory={cwd}
          verbose={verbose}
        />
      </Box>}

      {pendingPermission && (
        <PermissionPrompt
          permission={pendingPermission}
          onRespond={resolvePermission}
          onCancel={handleCancel}
        />
      )}

      {pendingAskUser && (
        <AskUserPrompt
          askUser={pendingAskUser}
          onRespond={resolveAskUserPrompt}
          onCancel={handleCancel}
        />
      )}

      <StatusBar
        status={isCompacting ? "compacting" : status}
        model={currentModel}
        statusDetail={statusDetail}
        tokenUsage={tokenUsage}
        isSystemSession={isSystemSession}
      />

      {/* Bypass indicator — rendered OUTSIDE the idle footer so it
          stays visible during streaming / waiting / compacting (the
          exact moments tools auto-approve without prompts). Bypass-
          flag form means --dangerously-skip-permissions; gateway has
          to restart to clear it. */}
      {permissionMode?.mode === "bypass" && (
        <Box paddingX={1}>
          <Text color="yellow">
            {permissionMode.forceBypass ? "[BYPASS-FLAG]" : "[BYPASS]"}
          </Text>
        </Box>
      )}

      {status === "idle" && (
        <Box paddingX={1} gap={2}>
          <Text color="#949494">session: {sessionId}</Text>
          {verbose && <Text color="cyan">expanded</Text>}
          {tokenUsage?.context_usage_percent != null && (
            <Text color={
              tokenUsage.context_usage_percent >= 95 ? "red" :
              tokenUsage.context_usage_percent >= 85 ? "yellow" :
              "gray"
            }>
              {tokenUsage.context_usage_percent >= 85 ? "⚠ " : ""}{tokenUsage.context_usage_percent}% ctx
            </Text>
          )}
          {flushInfo?.running && (
            <Text color="yellow">⟳ flushing...</Text>
          )}
          {!flushInfo?.running && flushInfo?.completedAt != null && (Date.now() - flushInfo.completedAt < 60_000) && (
            <Text color="green">✓ flushed {Math.round((Date.now() - flushInfo.completedAt) / 1000)}s ago</Text>
          )}
          {!flushInfo?.running && flushInfo?.skippedAt != null && (Date.now() - flushInfo.skippedAt < 15_000) && (
            <Text color="#949494">⊘ flush skipped: {flushInfo.skipReason}</Text>
          )}
          {heartbeatInfo && <HeartbeatIndicator info={heartbeatInfo} />}
        </Box>
      )}

      {showStatusPanel && (
        <StatusPanel
          onClose={() => setShowStatusPanel(false)}
          initialTab={statusPanelTab}
          rpc={(method: string, params?: unknown) => {
            if (agentSource.rpc) return agentSource.rpc(method, params);
            return Promise.reject(new Error("Not connected to gateway"));
          }}
        />
      )}

      {showTaskViewer && !showStatusPanel && (
        <TaskViewer onClose={() => setShowTaskViewer(false)} sessionKey={sessionId} />
      )}

      {!showTaskViewer && !showStatusPanel && <TaskTray sessionKey={sessionId} />}

      {!hideInput && !showTaskViewer && !showStatusPanel && (
        <InputArea
          onSubmit={handleSubmit}
          onExit={handleExit}
          onCancel={handleCancel}
          onToggleTaskViewer={() => setShowTaskViewer((v) => !v)}
          disabled={isDisabled}
          canCancel={canCancel}
          previousMessages={allMessages.length > 0 ? allMessages : messages}
        />
      )}
    </Box>
  );
}
