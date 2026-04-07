// =============================================================================
// Node Host Runner
//
// Connects to the gateway as a node host (role="node"), listens for invoke
// requests, dispatches to local command handlers, and returns results.
//
// Pattern: a proven node-host/runner.ts — GatewayClient reuse, event-driven
// dispatch, exponential backoff reconnection, tick-based liveness.
// =============================================================================

import { createSubsystemLogger, initLogger, resolveLoggerSettings, redactString } from "../logging/index.js";
import { loadNodeConfig, type NodeConfig } from "./config.js";
import { dispatchCommand, SUPPORTED_COMMANDS, reapOldScreenshots, setScreenshotRetentionDays } from "./commands.js";
import type { HelloPayload, EventFrame } from "../gateway/protocol.js";
import { getConfigDir, loadConfig } from "../storage/config.js";
import { join } from "node:path";

const log = createSubsystemLogger("node/runner");

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
const TICK_TIMEOUT_FACTOR = 2; // Close if no tick in 2x tick interval
const DEFAULT_TICK_INTERVAL_MS = 30_000;
const HANDSHAKE_TIMEOUT_MS = 5_000;

// -----------------------------------------------------------------------------
// Node Runner
// -----------------------------------------------------------------------------

export class NodeRunner {
  private config: NodeConfig;
  private token: string | null;
  private ws: WebSocket | null = null;
  private connected = false;
  private closed = false;
  private backoffMs = INITIAL_BACKOFF_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private lastTick = Date.now();
  private tickWatchTimer: ReturnType<typeof setInterval> | null = null;
  private tickIntervalMs = DEFAULT_TICK_INTERVAL_MS;
  private nextReqId = 1;
  private pendingRequests = new Map<string, {
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout> | null;
  }>();
  /** Active invoke AbortControllers — keyed by invoke ID, used for cancellation. */
  private activeInvokes = new Map<string, AbortController>();
  /** Called when this node is evicted by another process with the same nodeId. */
  onEvicted: (() => void) | null = null;
  /** Called when token is rejected — should acquire a new token or return null. */
  onAuthFailed: (() => Promise<string | null>) | null = null;
  private reauthInProgress = false;

  constructor(config: NodeConfig, token: string | null = null) {
    this.config = config;
    this.token = token;
  }

  // ---------------------------------------------------------------------------
  // Connection
  // ---------------------------------------------------------------------------

  async connect(): Promise<void> {
    this.closed = false;

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Connection timeout"));
        this.ws?.close();
      }, HANDSHAKE_TIMEOUT_MS);

      try {
        // Append /ws path for remote gateways (CF Access bypass is on /ws)
        const gwUrl = this.config.gateway.endsWith("/ws") || this.config.gateway.endsWith("/ws/")
          ? this.config.gateway
          : this.config.gateway.replace(/\/+$/, "") + "/ws";
        this.ws = new WebSocket(gwUrl);
      } catch (err) {
        clearTimeout(timer);
        reject(new Error(`Failed to connect to ${this.config.gateway}: ${err instanceof Error ? err.message : String(err)}`));
        return;
      }

      this.ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("WebSocket connection failed (is the gateway running?)"));
      });

      this.ws.addEventListener("open", () => {
        // Handshake with role="node"
        const connectParams = {
          version: "0.1.0",
          platform: process.platform, // "darwin", "linux", "win32"
          role: "node" as const,
          node: {
            nodeId: this.config.nodeId,
            name: this.config.displayName,
            commands: SUPPORTED_COMMANDS,
          },
          ...(this.token ? { token: this.token } : {}),
        };

        this.rpc("connect", connectParams).then((payload) => {
          clearTimeout(timer);
          const hello = payload as HelloPayload;
          this.connected = true;
          this.backoffMs = INITIAL_BACKOFF_MS;
          this.lastTick = Date.now();
          this.startTickWatch();
          log.info("connected to gateway", {
            connId: hello.connId,
            name: this.config.displayName,
            nodeId: this.config.nodeId,
          });
          resolve();
        }).catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
      });

      this.ws.addEventListener("message", (event) => {
        this.handleMessage(event.data as string);
      });

      this.ws.addEventListener("close", (event: any) => {
        const wasConnected = this.connected;
        this.connected = false;
        this.stopTickWatch();
        this.abortActiveInvokes();

        // Reject pending RPCs
        for (const [, pending] of this.pendingRequests) {
          if (pending.timer) clearTimeout(pending.timer);
          pending.reject(new Error("Connection closed"));
        }
        this.pendingRequests.clear();

        const closeCode = typeof event?.code === "number" ? event.code : 0;

        // Code 4001 = "replaced by new connection" — another process with the
        // same nodeId connected. Do NOT reconnect (would cause an infinite loop
        // where two processes keep evicting each other).
        if (closeCode === 4001) {
          log.warn("evicted by another node host with the same nodeId — stopping");
          this.closed = true;
          this.onEvicted?.();
          return;
        }

        // 1008 = token rejected. Trigger reauth.
        if (!this.closed && closeCode === 1008 && this.onAuthFailed) {
          log.warn("token rejected, re-authenticating...");
          this.handleReauth();
          return;
        }

        if (!this.closed) {
          if (wasConnected) {
            log.warn("disconnected from gateway, reconnecting...");
          }
          this.scheduleReconnect();
        }
      });
    });
  }

  /** Disconnect and stop reconnecting. */
  close(): void {
    this.closed = true;
    this.stopTickWatch();
    this.abortActiveInvokes();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }

  /** Abort all active invocations (e.g., on disconnect or shutdown). */
  private abortActiveInvokes(): void {
    for (const [id, ac] of this.activeInvokes) {
      log.info("aborting active invoke on close", { id });
      ac.abort();
    }
    this.activeInvokes.clear();
  }

  isConnected(): boolean {
    return this.connected;
  }

  // ---------------------------------------------------------------------------
  // Tick watch — detect stale gateway connections
  // ---------------------------------------------------------------------------

  private startTickWatch(): void {
    this.stopTickWatch();
    const checkInterval = Math.max(1000, this.tickIntervalMs);
    this.tickWatchTimer = setInterval(() => {
      const elapsed = Date.now() - this.lastTick;
      if (elapsed > this.tickIntervalMs * TICK_TIMEOUT_FACTOR) {
        log.warn("tick timeout — gateway silent, closing connection", {
          elapsed,
          threshold: this.tickIntervalMs * TICK_TIMEOUT_FACTOR,
        });
        this.ws?.close(4000, "tick timeout");
      }
    }, checkInterval);
  }

  private stopTickWatch(): void {
    if (this.tickWatchTimer) {
      clearInterval(this.tickWatchTimer);
      this.tickWatchTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Message handling
  // ---------------------------------------------------------------------------

  private handleMessage(raw: string): void {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }

    if (data.type === "res") {
      this.handleResponse(data as any);
    } else if (data.type === "event") {
      this.handleEvent(data as unknown as EventFrame);
    }
  }

  private handleResponse(frame: { id: string; ok: boolean; payload?: unknown; error?: { message: string } }): void {
    const pending = this.pendingRequests.get(frame.id);
    if (!pending) return;
    this.pendingRequests.delete(frame.id);
    if (pending.timer) clearTimeout(pending.timer);
    if (frame.ok) {
      pending.resolve(frame.payload);
    } else {
      pending.reject(new Error(frame.error?.message ?? "RPC error"));
    }
  }

  private handleEvent(frame: EventFrame): void {
    // Tick — reset liveness timer
    if (frame.event === "tick") {
      this.lastTick = Date.now();
      // Update tick interval if gateway sends it
      const payload = frame.payload as { intervalMs?: number } | undefined;
      if (payload?.intervalMs) {
        this.tickIntervalMs = payload.intervalMs;
      }
      return;
    }

    // Invoke request — gateway wants us to execute a command
    if (frame.event === "node.invoke.request") {
      const payload = frame.payload as {
        id: string;
        command: string;
        paramsJSON?: string;
        timeoutMs?: number;
      };
      void this.handleInvoke(payload);
      return;
    }

    // Invoke cancel — gateway wants us to kill a running command
    if (frame.event === "node.invoke.cancel") {
      const payload = frame.payload as { id: string };
      const ac = this.activeInvokes.get(payload.id);
      if (ac) {
        log.info("cancelling invoke", { id: payload.id });
        ac.abort();
      }
      return;
    }

    // Gateway shutdown
    if (frame.event === "gateway.shutdown") {
      log.info("gateway shutting down");
      return;
    }
  }

  // ---------------------------------------------------------------------------
  // Invoke dispatch
  // ---------------------------------------------------------------------------

  private async handleInvoke(request: {
    id: string;
    command: string;
    paramsJSON?: string;
    timeoutMs?: number;
  }): Promise<void> {
    const { id, command, paramsJSON, timeoutMs } = request;

    let params: unknown;
    try {
      params = paramsJSON ? JSON.parse(paramsJSON) : {};
    } catch {
      await this.sendInvokeResult(id, false, undefined, "Invalid paramsJSON");
      return;
    }

    const summary = summarizeParams(command, params);
    log.info("invoke start", { id, command, summary });

    // Propagate gateway-requested timeout to the command execution
    // so stray processes don't outlive the gateway-side timeout.
    if (timeoutMs && typeof params === "object" && params !== null) {
      const p = params as Record<string, unknown>;
      if (p.timeoutMs === undefined) {
        p.timeoutMs = timeoutMs;
      }
    }

    // Track this invocation so the gateway can cancel it
    const ac = new AbortController();
    this.activeInvokes.set(id, ac);
    const startMs = Date.now();

    try {
      const result = await dispatchCommand(command, params, ac.signal);
      const durationMs = Date.now() - startMs;
      if (ac.signal.aborted) {
        log.info("invoke complete", { id, command, ok: false, error: "Cancelled", durationMs });
        await this.sendInvokeResult(id, false, undefined, "Cancelled");
        return;
      }
      const payloadBytes = result ? JSON.stringify(result).length : 0;
      const exitCode = (result as any)?.exitCode;
      log.info("invoke complete", {
        id, command, ok: true, durationMs, payloadBytes,
        ...(exitCode != null && exitCode !== 0 ? { exitCode } : {}),
      });
      await this.sendInvokeResult(id, true, result);
    } catch (err) {
      const durationMs = Date.now() - startMs;
      const message = err instanceof Error ? err.message : String(err);
      log.error("invoke complete", { id, command, ok: false, error: message, durationMs });
      await this.sendInvokeResult(id, false, undefined, message);
    } finally {
      this.activeInvokes.delete(id);
    }
  }

  private async sendInvokeResult(
    id: string,
    ok: boolean,
    payload?: unknown,
    error?: string,
  ): Promise<void> {
    try {
      await this.rpc("node.invoke.result", {
        id,
        nodeId: this.config.nodeId,
        ok,
        ...(payload !== undefined ? { payloadJSON: JSON.stringify(payload) } : {}),
        ...(error ? { error } : {}),
      });
    } catch (err) {
      log.error("failed to send invoke result", { id, error: String(err) });
    }
  }

  // ---------------------------------------------------------------------------
  // RPC
  // ---------------------------------------------------------------------------

  private rpc(method: string, params?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("Not connected"));
        return;
      }

      const id = `node-req-${this.nextReqId++}`;
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`RPC timeout: ${method}`));
      }, 30_000);

      this.pendingRequests.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ type: "req", id, method, params }));
    });
  }

  // ---------------------------------------------------------------------------
  // Reconnection
  // ---------------------------------------------------------------------------

  private async handleReauth(): Promise<void> {
    if (!this.onAuthFailed || this.reauthInProgress) return;
    this.reauthInProgress = true;
    try {
      const newToken = await this.onAuthFailed();
      if (newToken) {
        this.token = newToken;
        this.backoffMs = INITIAL_BACKOFF_MS;
        this.reauthInProgress = false;
        await this.connect();
        return;
      }
    } catch { /* fall through */ }
    this.reauthInProgress = false;
    this.token = null;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connect();
      } catch {
        this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
        if (!this.closed) {
          this.scheduleReconnect();
        }
      }
    }, this.backoffMs);
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/** Short human-readable summary of invoke params for logging. Redacts secrets. */
function summarizeParams(command: string, params: unknown): string {
  if (!params || typeof params !== "object") return "";
  const p = params as Record<string, unknown>;
  if (command === "system.run" && Array.isArray(p.command)) {
    const cmd = (p.command as string[]).join(" ");
    const truncated = cmd.length > 120 ? cmd.slice(0, 117) + "..." : cmd;
    return redactString(truncated);
  }
  if (command === "system.which" && Array.isArray(p.bins)) {
    return (p.bins as string[]).join(", ");
  }
  if (command === "screenshot") {
    return p.display ? `display ${p.display}` : "all displays";
  }
  return "";
}

// -----------------------------------------------------------------------------
// CLI entry point
// -----------------------------------------------------------------------------

export async function runNodeHost(opts: {
  name?: string;
  connect?: string;
  token?: string;
}): Promise<void> {
  // Initialize logger — node logs go to ~/.hawky/logs/node/ to stay
  // separate from gateway logs (important when both run on the same machine).
  const logDir = join(getConfigDir(), "logs", "node");
  const logSettings = resolveLoggerSettings(undefined, logDir, false);
  initLogger(logSettings);

  // Load config
  const config = loadNodeConfig();
  if (opts.name) config.displayName = opts.name;
  if (opts.connect) config.gateway = opts.connect;

  console.log(`\n  Node Host: ${config.displayName}`);
  console.log(`  Node ID:   ${config.nodeId}`);
  console.log(`  Gateway:   ${config.gateway}`);
  console.log(`  Commands:  ${SUPPORTED_COMMANDS.join(", ")}`);
  console.log(`  Logs:      ${logDir}`);
  console.log();

  // Acquire device token: check persisted file, then config fallback, then browser flow
  const { loadDeviceToken, saveDeviceToken, clearDeviceToken } = await import("../gateway/device-auth.js");

  async function doAcquireNodeToken(): Promise<string | null> {
    try {
      const { acquireDeviceToken } = await import("../gateway/gateway-client.js");
      const newToken = await acquireDeviceToken({
        gatewayUrl: config.gateway,
        deviceLabel: `node-${config.displayName}`,
        onStatus: (msg) => console.log(`  ${msg}`),
      });
      saveDeviceToken(newToken, config.gateway);
      console.log("  Authenticated with gateway.\n");
      return newToken;
    } catch (err) {
      if ((err as any)?.name === "ManualAuthRequired") {
        console.error("  Cannot authenticate: no browser available.");
        console.error(`  Visit: ${(err as any).manualUrl}`);
        console.error("  Then restart with: --token YOUR_TOKEN\n");
        process.exit(1);
      }
      log.debug("device token acquisition failed, continuing without token", {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  let token = opts.token ?? loadDeviceToken(config.gateway) ?? null;
  if (!token) {
    token = await doAcquireNodeToken();
  }

  const runner = new NodeRunner(config, token);

  // Handle auth rejection — clear stale token and re-acquire
  runner.onAuthFailed = async () => {
    log.info("device token rejected, re-authenticating");
    clearDeviceToken(config.gateway);
    return doAcquireNodeToken();
  };

  // Handle eviction — another process with the same nodeId took over
  runner.onEvicted = () => {
    console.error("\n  Another node host with the same node ID connected.");
    console.error("  This instance has been evicted. Exiting.\n");
    process.exit(1);
  };

  // Graceful shutdown
  const shutdown = () => {
    console.log("\nShutting down node host...");
    runner.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Apply screenshot retention config
  const mainConfig = loadConfig();
  if (mainConfig.screenshots?.retention_days) {
    setScreenshotRetentionDays(mainConfig.screenshots.retention_days);
  }

  // Reap old screenshots on startup + daily
  reapOldScreenshots();
  const REAP_INTERVAL_MS = 24 * 60 * 60 * 1000;
  setInterval(() => reapOldScreenshots(), REAP_INTERVAL_MS);

  // Initial connect — the runner handles reconnection internally via
  // exponential backoff. No outer retry loop to avoid overlapping attempts.
  try {
    await runner.connect();
    console.log("  Connected to gateway. Waiting for commands...\n");
  } catch (err) {
    console.error(`  Initial connection failed: ${err instanceof Error ? err.message : String(err)}`);
    console.error("  The node host will keep retrying in the background...\n");
  }

  // Stay alive — reconnection is handled by the runner's close handler
  await new Promise(() => {});
}
