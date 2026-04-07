// =============================================================================
// Node Registry
//
// Gateway-side tracking of connected node hosts. Manages node lifecycle
// (register/unregister), invoke dispatch with timeout, and tick broadcasting.
//
// Pattern: a proven gateway/node-registry.ts.
// =============================================================================

import { randomUUID } from "node:crypto";
import { createSubsystemLogger } from "../logging/index.js";
import type { GatewayConnection } from "./connection.js";

const log = createSubsystemLogger("gateway/nodes");

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface NodeEntry {
  /** Stable node identifier (from node host config). */
  nodeId: string;
  /** Gateway connection ID. */
  connId: string;
  /** Connection reference (for sending events). */
  conn: GatewayConnection;
  /** Human-readable name (e.g., "work-mac"). */
  name: string;
  /** Supported commands (e.g., ["system.run", "system.which"]). */
  commands: string[];
  /** Client platform string. */
  platform: string;
  /** Connection timestamp. */
  connectedAt: number;
}

interface PendingInvoke {
  id: string;
  nodeId: string;
  command: string;
  resolve: (result: InvokeResult) => void;
  timer: ReturnType<typeof setTimeout>;
  /** Timestamp when the invoke was dispatched, for duration tracking. */
  startedAt: number;
  /** Remove the AbortSignal listener (if one was attached). */
  detachSignal?: () => void;
}

export interface InvokeResult {
  ok: boolean;
  payload?: unknown;
  error?: string;
}

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const DEFAULT_INVOKE_TIMEOUT_MS = 30_000;
const TICK_INTERVAL_MS = 30_000;

// -----------------------------------------------------------------------------
// Registry
// -----------------------------------------------------------------------------

export class NodeRegistry {
  private nodesById = new Map<string, NodeEntry>();
  private nodesByConn = new Map<string, string>(); // connId → nodeId
  private pendingInvokes = new Map<string, PendingInvoke>();
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private broadcastFn: ((event: string, payload?: unknown) => void) | null = null;
  private broadcastSystemMessageFn: ((content: string) => void) | null = null;

  /**
   * Set the broadcast function (called from server setup).
   * Used for tick broadcasting to all connections.
   */
  setBroadcast(fn: (event: string, payload?: unknown) => void): void {
    this.broadcastFn = fn;
  }

  /**
   * Set a function that broadcasts a system message to all active sessions.
   * Used to notify the agent when nodes connect/disconnect.
   */
  setBroadcastSystemMessage(fn: (content: string) => void): void {
    this.broadcastSystemMessageFn = fn;
  }

  // ---------------------------------------------------------------------------
  // Tick broadcast
  // ---------------------------------------------------------------------------

  /** Start broadcasting tick events to all connections. */
  startTick(): void {
    this.stopTick();
    this.tickTimer = setInterval(() => {
      this.broadcastFn?.("tick", {
        ts: Date.now(),
        intervalMs: TICK_INTERVAL_MS,
      });
    }, TICK_INTERVAL_MS);
    // Don't prevent process exit
    if (this.tickTimer && typeof this.tickTimer === "object" && "unref" in this.tickTimer) {
      (this.tickTimer as any).unref();
    }
  }

  /** Stop tick broadcasting. */
  stopTick(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Node lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Register a node host connection.
   */
  register(conn: GatewayConnection, info: {
    nodeId: string;
    name: string;
    commands: string[];
    platform: string;
  }): void {
    // If this nodeId is already registered (reconnect or duplicate), close the
    // old connection so it doesn't linger as an orphan consuming resources.
    // The old terminal/process will see a clean disconnect and can reconnect.
    const existing = this.nodesById.get(info.nodeId);
    if (existing) {
      log.info("node reconnected, replacing old connection", {
        nodeId: info.nodeId,
        oldConnId: existing.connId,
        newConnId: conn.connId,
      });
      this.nodesByConn.delete(existing.connId);

      // Reject pending invokes for the old connection — they'll never complete
      for (const [id, pending] of this.pendingInvokes) {
        if (pending.nodeId !== info.nodeId) continue;
        this.resolvePendingInvoke(id, { ok: false, error: `Node reconnected (${pending.command})` });
      }

      // Close the old WebSocket — triggers the close handler which calls
      // unregister(), but that's a no-op since we already removed the mapping.
      existing.conn.close(4001, "replaced by new connection");
    }

    const entry: NodeEntry = {
      nodeId: info.nodeId,
      connId: conn.connId,
      conn,
      name: info.name,
      commands: info.commands,
      platform: info.platform,
      connectedAt: Date.now(),
    };

    this.nodesById.set(info.nodeId, entry);
    this.nodesByConn.set(conn.connId, info.nodeId);

    log.info("node registered", {
      nodeId: info.nodeId,
      name: info.name,
      connId: conn.connId,
      commands: info.commands,
    });

    // Notify active sessions so the agent knows a node is available
    this.broadcastSystemMessageFn?.(
      `Node "${info.name}" connected (commands: ${info.commands.join(", ")})`,
    );
  }

  /**
   * Unregister a node by connection ID (called on WebSocket close).
   * Rejects all pending invokes for this node.
   */
  unregister(connId: string): string | null {
    const nodeId = this.nodesByConn.get(connId);
    if (!nodeId) return null;

    const nodeName = this.nodesById.get(nodeId)?.name ?? nodeId;

    this.nodesByConn.delete(connId);
    this.nodesById.delete(nodeId);

    // Reject pending invokes for this node
    for (const [id, pending] of this.pendingInvokes) {
      if (pending.nodeId !== nodeId) continue;
      this.resolvePendingInvoke(id, { ok: false, error: `Node disconnected (${pending.command})` });
    }

    log.info("node unregistered", { nodeId, connId });

    // Notify active sessions so the agent knows the node is gone
    this.broadcastSystemMessageFn?.(`Node "${nodeName}" disconnected`);

    return nodeId;
  }

  // ---------------------------------------------------------------------------
  // Query
  // ---------------------------------------------------------------------------

  /** Get a node by its ID. */
  get(nodeId: string): NodeEntry | undefined {
    return this.nodesById.get(nodeId);
  }

  /** Get a node by connection ID. */
  getByConn(connId: string): NodeEntry | undefined {
    const nodeId = this.nodesByConn.get(connId);
    return nodeId ? this.nodesById.get(nodeId) : undefined;
  }

  /** List all connected nodes. */
  listConnected(): NodeEntry[] {
    return Array.from(this.nodesById.values());
  }

  /** Number of connected nodes. */
  get size(): number {
    return this.nodesById.size;
  }

  // ---------------------------------------------------------------------------
  // Invoke
  // ---------------------------------------------------------------------------

  /**
   * Send a command to a node and wait for the result.
   * Returns a promise that resolves when the node responds or times out.
   */
  invoke(
    nodeId: string,
    command: string,
    params?: unknown,
    timeoutMs = DEFAULT_INVOKE_TIMEOUT_MS,
    signal?: AbortSignal,
  ): Promise<InvokeResult> {
    const node = this.nodesById.get(nodeId);
    if (!node) {
      return Promise.resolve({ ok: false, error: `Node not connected: ${nodeId}` });
    }

    // Check if node supports this command
    if (!node.commands.includes(command)) {
      return Promise.resolve({
        ok: false,
        error: `Node "${node.name}" does not support command: ${command}`,
      });
    }

    // Already cancelled before we even start
    if (signal?.aborted) {
      return Promise.resolve({ ok: false, error: "Cancelled" });
    }

    const id = randomUUID();

    return new Promise<InvokeResult>((resolve) => {
      const timer = setTimeout(() => {
        this.resolvePendingInvoke(id, { ok: false, error: `Invoke timeout after ${timeoutMs}ms (${command})` });
      }, timeoutMs);

      const pending: PendingInvoke = { id, nodeId, command, resolve, timer, startedAt: Date.now() };

      // Wire up abort signal — cancel the invoke if the agent turn is cancelled
      if (signal) {
        const onAbort = () => this.cancelInvoke(id);
        signal.addEventListener("abort", onAbort);
        pending.detachSignal = () => signal.removeEventListener("abort", onAbort);
      }

      this.pendingInvokes.set(id, pending);

      // Send invoke request as event to the node
      const sent = node.conn.sendEvent({
        type: "event",
        event: "node.invoke.request",
        payload: {
          id,
          command,
          paramsJSON: params !== undefined ? JSON.stringify(params) : undefined,
          timeoutMs,
        },
      });

      if (sent) {
        log.info("invoke dispatched", { id, nodeId, node: node.name, command });
      } else {
        this.resolvePendingInvoke(id, { ok: false, error: "Failed to send invoke request (connection backpressure)" });
      }
    });
  }

  /**
   * Cancel an in-flight invoke. Resolves the pending promise with a cancellation
   * error and sends a cancel event to the node so it can kill the child process.
   */
  cancelInvoke(invokeId: string): void {
    const pending = this.pendingInvokes.get(invokeId);
    if (!pending) return; // Already completed or timed out

    this.resolvePendingInvoke(invokeId, { ok: false, error: "Cancelled" });

    // Tell the node to kill the running process
    const node = this.nodesById.get(pending.nodeId);
    if (node) {
      node.conn.sendEvent({
        type: "event",
        event: "node.invoke.cancel",
        payload: { id: invokeId },
      });
    }
  }

  /**
   * Resolve a pending invoke, cleaning up timer and signal listener.
   * Central cleanup point — all terminal paths go through here.
   */
  private resolvePendingInvoke(invokeId: string, result: InvokeResult): void {
    const pending = this.pendingInvokes.get(invokeId);
    if (!pending) return;

    const durationMs = Date.now() - pending.startedAt;
    log.info("invoke resolved", {
      id: invokeId,
      command: pending.command,
      ok: result.ok,
      durationMs,
      ...(result.error ? { error: result.error } : {}),
    });

    this.pendingInvokes.delete(invokeId);
    clearTimeout(pending.timer);
    pending.detachSignal?.();
    pending.resolve(result);
  }

  /**
   * Handle an invoke result from a node.
   * Called when the node sends node.invoke.result RPC.
   * @param senderNodeId — verified nodeId from the connection (prevents spoofing)
   */
  handleInvokeResult(params: {
    id: string;
    nodeId: string;
    ok: boolean;
    payloadJSON?: string;
    error?: string;
  }, senderNodeId?: string): void {
    const pending = this.pendingInvokes.get(params.id);
    if (!pending) {
      // Late result — invoke already timed out or was cancelled
      log.debug("ignoring late invoke result", { id: params.id });
      return;
    }

    // Verify sender matches the node that was assigned the invoke
    if (senderNodeId && pending.nodeId !== senderNodeId) {
      log.warn("rejecting invoke result from wrong node", {
        id: params.id,
        expected: pending.nodeId,
        sender: senderNodeId,
      });
      return;
    }

    let payload: unknown;
    if (params.payloadJSON) {
      try {
        payload = JSON.parse(params.payloadJSON);
      } catch {
        this.resolvePendingInvoke(params.id, { ok: false, error: "Invalid payloadJSON from node" });
        return;
      }
    }

    this.resolvePendingInvoke(params.id, {
      ok: params.ok,
      payload,
      error: params.error,
    });
  }

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  /** Stop tick and reject all pending invokes. For shutdown/testing. */
  destroy(): void {
    this.stopTick();
    for (const id of [...this.pendingInvokes.keys()]) {
      this.resolvePendingInvoke(id, { ok: false, error: "Registry shutting down" });
    }
    this.nodesById.clear();
    this.nodesByConn.clear();
  }
}
