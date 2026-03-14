// =============================================================================
// TUI Entry Point
//
// Renders the Ink app. Called from the CLI entry point (src/index.ts).
// TUI is always a gateway client — receives an AgentEventSource.
// =============================================================================

import React from "react";
import { render } from "ink";
import { App } from "./app.js";
import type { FlushInfo } from "./app.js";
import type { AgentEventSource } from "../gateway/agent-source.js";
import type { HeartbeatInfo } from "./components/heartbeat_indicator.js";

/**
 * Snapshot of the current session's permission mode. Drives the
 * footer [BYPASS] indicator. Updates via the
 * `permission.mode.changed` broadcast (live) or a one-shot
 * `permission.mode` RPC (initial fetch).
 */
export interface PermissionModeInfo {
  mode: "default" | "accept-edits" | "bypass" | null;
  /** True when bypass came from --dangerously-skip-permissions
   *  (clicking the indicator can't disable it). */
  forceBypass: boolean;
}

export interface TuiOptions {
  model: string;
  /** Agent event source — either GatewayClient (production) or mock (testing) */
  agentSource: AgentEventSource;
  /** Session key bound to this TUI instance */
  sessionKey: string;
  /** Optional heartbeat info getter (updated by gateway client events) */
  getHeartbeatInfo?: () => HeartbeatInfo | null;
  /** Subscribe to heartbeat/flush changes (event-driven) */
  onHeartbeatChange?: (listener: () => void) => () => void;
  /** Subscribe to flush events for status display */
  onFlushEvent?: (listener: (event: string, payload?: unknown) => void) => () => void;
  /** Subscribe to compaction events for status display */
  onCompactionEvent?: (listener: (event: string, payload?: unknown) => void) => () => void;
  /** Optional getter for the current permission mode (drives [BYPASS] indicator) */
  getPermissionMode?: () => PermissionModeInfo;
  /** Subscribe to permission.mode.changed events */
  onPermissionModeChange?: (listener: (info: PermissionModeInfo) => void) => () => void;
}

export function startTui(options: TuiOptions): void {
  if (!process.stdin.isTTY) {
    console.error("Error: Hawky TUI requires an interactive terminal (TTY).");
    console.error("Run this command directly in a terminal, not piped.");
    process.exit(1);
  }

  // Wrap in a component that subscribes to heartbeat + flush events
  function TuiWrapper() {
    const [hbInfo, setHbInfo] = React.useState<HeartbeatInfo | null>(
      options.getHeartbeatInfo?.() ?? null,
    );
    const [flushInfo, setFlushInfo] = React.useState<FlushInfo | null>(null);
    const [isCompacting, setIsCompacting] = React.useState(false);

    React.useEffect(() => {
      if (!options.getHeartbeatInfo) return;

      // Event-driven: update immediately on heartbeat events
      const unsub = options.onHeartbeatChange?.(() => {
        setHbInfo(options.getHeartbeatInfo!());
      });

      // Also poll every 30s to keep "Xm ago" / "next: Xm" timers fresh
      const timer = setInterval(() => {
        setHbInfo(options.getHeartbeatInfo!());
        // Also refresh flush "Xs ago" display
        setFlushInfo((prev) => prev ? { ...prev } : null);
      }, 10_000);

      return () => {
        unsub?.();
        clearInterval(timer);
      };
    }, []);

    // Subscribe to flush events
    React.useEffect(() => {
      const unsub = options.onFlushEvent?.((event: string, payload?: any) => {
        if (event === "flush.started") {
          setFlushInfo({ running: true, completedAt: null, skippedAt: null, skipReason: null });
        } else if (event === "flush.completed") {
          setFlushInfo({ running: false, completedAt: Date.now(), skippedAt: null, skipReason: null });
        } else if (event === "flush.skipped") {
          setFlushInfo({ running: false, completedAt: null, skippedAt: Date.now(), skipReason: payload?.reason ?? "unknown" });
        }
      });
      return () => { unsub?.(); };
    }, []);

    // Subscribe to compaction events
    React.useEffect(() => {
      const unsub = options.onCompactionEvent?.((event: string) => {
        if (event === "compaction.started") {
          setIsCompacting(true);
        } else if (event === "compaction.completed") {
          setIsCompacting(false);
        }
      });
      return () => { unsub?.(); };
    }, []);

    // Track permission mode (drives the footer [BYPASS] indicator)
    const [permMode, setPermMode] = React.useState<PermissionModeInfo>(
      options.getPermissionMode?.() ?? { mode: null, forceBypass: false },
    );
    React.useEffect(() => {
      const unsub = options.onPermissionModeChange?.((info) => setPermMode(info));
      return () => { unsub?.(); };
    }, []);

    return (
      <App
        model={options.model}
        agentSource={options.agentSource}
        sessionKey={options.sessionKey}
        heartbeatInfo={hbInfo}
        flushInfo={flushInfo}
        isCompacting={isCompacting}
        permissionMode={permMode}
      />
    );
  }

  const { waitUntilExit } = render(
    <TuiWrapper />,
    { exitOnCtrlC: false },
  );

  waitUntilExit().then(() => {
    process.exit(0);
  });
}
