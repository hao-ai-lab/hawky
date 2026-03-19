// =============================================================================
// Gateway Server
//
// Bun.serve() with HTTP health endpoints + WebSocket for client connections.
// Integrates with command queue (7.1) for session-scoped agent execution.
//
// Pattern: a proven server.impl.ts, adapted for Bun.
// =============================================================================

import { createSubsystemLogger } from "../logging/index.js";
import type { PushService, PushSubscriptionJSON } from "./push.js";
import { GatewayConnection, type WSData, resetConnectionCounter } from "./connection.js";
import { broadcast, broadcastToSession, resetBroadcast } from "./broadcast.js";
import { createSubscriptionRegistry, type SubscriptionRegistry } from "./subscriptions.js";
import { parseFrame, serializeFrame, ErrorCodes } from "./protocol.js";
import type { RequestFrame, ResponseFrame, ConnectParams, HelloPayload } from "./protocol.js";
import { markGatewayDraining, waitForActiveTasks, resetCommandQueue } from "./command-queue.js";
import { cancelPendingPermissions } from "./ws-permission.js";
import { serveStatic, resolveWebDistDir } from "./static.js";
import type { MethodHandler, MethodRegistry } from "./methods.js";
import { createMethodRegistry } from "./methods.js";
import { NodeRegistry } from "./node-registry.js";
import { DeviceAuth, callbackRedirectHtml, manualTokenHtml, webAuthRedirectHtml } from "./device-auth.js";
import {
  LiveRealtimeBrokerError,
  mintOpenAIRealtimeClientSecret,
  type LiveRealtimeClientSecretParams,
} from "./live-realtime-broker.js";

const log = createSubsystemLogger("gateway/server");

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const SERVER_VERSION = "0.1.0";
const HANDSHAKE_TIMEOUT_MS = 10_000;

// -----------------------------------------------------------------------------
// Gateway Server
// -----------------------------------------------------------------------------

export class GatewayServer {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private connections = new Map<string, GatewayConnection>();
  private methods: MethodRegistry;
  private deviceAuth: DeviceAuth | null;
  private boundToLoopback = true;
  private started = false;
  private activeSessionCountFn: (() => number) | null = null;
  private webDistDir: string | null = null;
  private pushService: PushService | null = null;
  private _subscriptions = createSubscriptionRegistry();
  private _getSessionKeys: (() => string[]) | null = null;
  private _nodeRegistry = new NodeRegistry();

  /**
   * @param deviceAuth - Device auth instance for token validation. Null = no auth (testing only).
   */
  constructor(deviceAuth: DeviceAuth | null = null) {
    this.deviceAuth = deviceAuth;
    this.methods = createMethodRegistry();
    // Resolve web frontend dist directory (if built)
    this.webDistDir = resolveWebDistDir();
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Start the gateway server.
   */
  start(port: number, hostname = "127.0.0.1"): void {
    if (this.started) return;
    this.started = true;
    this.boundToLoopback = hostname === "127.0.0.1" || hostname === "::1" || hostname === "localhost";

    const self = this;

    this.server = Bun.serve<WSData>({
      port,
      hostname,

      // HTTP handler — health endpoints + static files
      fetch(req, server) {
        // WebSocket upgrade — check FIRST, before any URL parsing.
        if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
          const upgraded = server.upgrade(req, {
            data: { connId: "" } as WSData,
          });
          if (!upgraded) {
            return new Response("WebSocket upgrade failed", { status: 400 });
          }
          return undefined;
        }

        const url = new URL(req.url);

        // Health endpoints — always unauthenticated (needed for probes/monitoring)
        if (url.pathname === "/health" || url.pathname === "/healthz") {
          return Response.json({ ok: true, status: "live" });
        }
        if (url.pathname === "/ready" || url.pathname === "/readyz") {
          return Response.json({
            ok: true,
            status: "ready",
            connections: self.connections.size,
          });
        }

        // Device auth endpoint — issues signed device tokens.
        // For remote access, Cloudflare Access gates this endpoint (email OTP).
        // For localhost access, the endpoint is open (SSH is the auth layer).
        if (url.pathname === "/auth/device" && req.method === "GET") {
          return self.handleAuthDevice(req, url);
        }

        // Push re-subscribe endpoint (called by service worker when subscription rotates)
        if (url.pathname === "/api/push-resubscribe" && req.method === "POST") {
          return self.handlePushResubscribe(req);
        }

        // Live model broker — mints short-lived OpenAI Realtime client secrets
        // for browser/mobile clients without exposing the gateway API key.
        if (url.pathname === "/api/live/openai/client-secret" && req.method === "POST") {
          return self.handleOpenAIRealtimeClientSecret(req);
        }

        // Serve web frontend static files (production mode)
        if (self.webDistDir) {
          const staticResponse = serveStatic(self.webDistDir, url.pathname);
          if (staticResponse) return staticResponse;
        }

        return new Response("Not found", { status: 404 });
      },

      // WebSocket handlers
      websocket: {
        // Disable compression — iOS Safari has known bugs with perMessageDeflate
        // negotiation that cause silent WebSocket connection failures.
        perMessageDeflate: false,
        // Reap half-open sockets: Bun sends WS pings and closes the conn if
        // no frame (or pong) arrives within idleTimeout seconds. Without
        // this, mobile-suspended tabs and NAT-dropped clients persist as
        // zombies and keep triggering "event dropped" warnings on broadcast.
        // Kept low (Bun pings at ~idleTimeout*0.8) so a Tailscale DERP relay
        // (which idles out TCP after ~25-30s) doesn't drop the WS mid-session.
        idleTimeout: 20,
        sendPings: true,

        open(ws) {
          const remoteAddress = ws.remoteAddress || "unknown";
          const conn = new GatewayConnection(ws, remoteAddress);
          self.connections.set(conn.connId, conn);
          conn.startHandshakeTimer(HANDSHAKE_TIMEOUT_MS);
          log.info("connection opened", { connId: conn.connId });
        },

        message(ws, raw) {
          const connId = ws.data?.connId;
          if (!connId) return;

          const conn = self.connections.get(connId);
          if (!conn) return;

          const message = typeof raw === "string" ? raw : Buffer.from(raw).toString("utf-8");
          self.handleMessage(conn, message);
        },

        close(ws, code, reason) {
          const connId = ws.data?.connId;
          if (!connId) return;

          const conn = self.connections.get(connId);
          if (conn) {
            conn.clearHandshakeTimer();

            // Node host disconnection — unregister from node registry
            if (conn.clientRole === "node") {
              self._nodeRegistry.unregister(connId);
              self.connections.delete(connId);
              log.info("node disconnected", { connId, nodeId: conn.nodeId, code, reason: reason || undefined });
              return;
            }

            // Client disconnection — clean up sessions and permissions
            const watchedSessions = new Set<string>();
            if (conn.sessionKey) watchedSessions.add(conn.sessionKey);
            for (const sk of self._subscriptions.getSubscribedSessions(connId)) {
              watchedSessions.add(sk);
            }

            self.connections.delete(connId);
            self._subscriptions.unsubscribeAll(connId);

            // Cancel pending permissions only if no other client is still
            // connected to this session (avoid denying prompts that another
            // client could answer).
            for (const sessionKey of watchedSessions) {
              const hasOtherClient = Array.from(self.connections.values()).some(
                (c) => c.sessionKey === sessionKey,
              ) || self._subscriptions.getSubscribers(sessionKey).size > 0;
              if (!hasOtherClient) {
                cancelPendingPermissions(sessionKey);
              }
            }

            log.info("connection closed", { connId, code, reason: reason || undefined });
          }
        },
      },
    });

    // Wire node registry broadcast and start tick
    this._nodeRegistry.setBroadcast((event, payload) => this.broadcast(event, payload));
    this._nodeRegistry.setBroadcastSystemMessage((content) => {
      // Broadcast as agent.system_message so all clients (TUI/web) display it
      // and the agent sees it in its conversation context
      this.broadcast("agent.system_message", {
        type: "system_message",
        content,
        subtype: "info",
      });
    });
    this._nodeRegistry.startTick();

    // Register node.invoke.result RPC — called by node hosts returning results
    this.registerMethod("node.invoke.result", (conn, params) => {
      if (conn.clientRole !== "node" || !conn.nodeId) {
        throw Object.assign(new Error("Only node hosts can send invoke results"), { code: ErrorCodes.UNAUTHORIZED });
      }
      // Verify the sender is the node that owns this invoke (prevent result spoofing)
      this._nodeRegistry.handleInvokeResult(params as any, conn.nodeId);
      return { ok: true };
    });

    log.info("gateway started", { port, hostname });
  }

  /**
   * Stop the gateway server gracefully.
   */
  async stop(timeoutMs = 5000): Promise<void> {
    if (!this.started) return;
    this.started = false;

    // Stop node registry tick and clean up
    this._nodeRegistry.destroy();

    // Notify clients
    markGatewayDraining();
    broadcast(this.connections, "gateway.shutdown");

    // Wait for active work
    const { drained } = await waitForActiveTasks(timeoutMs);
    if (!drained) {
      log.warn("shutdown timeout, some tasks still active");
    }

    // Close all connections
    for (const conn of this.connections.values()) {
      conn.close(1012, "service restart");
    }
    this.connections.clear();

    // Stop HTTP server
    if (this.server) {
      this.server.stop();
      this.server = null;
    }

    log.info("gateway stopped");
  }

  // ---------------------------------------------------------------------------
  // Public API for method handlers
  // ---------------------------------------------------------------------------

  /** Register an RPC method handler. */
  registerMethod(method: string, handler: MethodHandler): void {
    this.methods.register(method, handler);
  }

  /** Get all connections (for broadcast). */
  getConnections(): Map<string, GatewayConnection> {
    return this.connections;
  }

  /** Broadcast event to all authenticated connections. */
  broadcast(event: string, payload?: unknown): void {
    broadcast(this.connections, event, payload);
  }

  /** Get the subscription registry. */
  get subscriptions(): SubscriptionRegistry { return this._subscriptions; }

  /** Get the node registry. */
  get nodeRegistry(): NodeRegistry { return this._nodeRegistry; }

  /** Set the function to get all session keys (for auto-subscribe on web connect). */
  setGetSessionKeys(fn: () => string[]): void { this._getSessionKeys = fn; }

  /** Broadcast event to connections subscribed to a specific session. */

  broadcastToSession(sessionKey: string, event: string, payload?: unknown, excludeClientId?: string): number {
    return broadcastToSession(this.connections, sessionKey, event, payload, this._subscriptions, excludeClientId);
  }

  /** Get the server port (for testing). */
  getPort(): number {
    return this.server?.port ?? 0;
  }

  /** Get connection count. */
  getConnectionCount(): number {
    return this.connections.size;
  }

  /** Get active session count (set via setActiveSessionCounter). */
  getActiveSessionCount(): number {
    return this.activeSessionCountFn?.() ?? 0;
  }

  /** Get details of all connected clients. */
  getConnectionDetails(): Array<{ connId: string; platform: string; sessionKey: string | null }> {
    const details: Array<{ connId: string; platform: string; sessionKey: string | null }> = [];
    for (const conn of this.connections.values()) {
      details.push({
        connId: conn.connId,
        platform: conn.clientPlatform ?? "unknown",
        sessionKey: conn.sessionKey ?? null,
      });
    }
    return details;
  }

  /** Set a function that returns the active session count. */
  setActiveSessionCounter(fn: () => number): void {
    this.activeSessionCountFn = fn;
  }

  /** Set the push service reference (for SW push-resubscribe endpoint). */
  setPushService(service: PushService): void {
    this.pushService = service;
  }

  /** Get the device auth instance (for external access, e.g., testing). */
  getDeviceAuth(): DeviceAuth | null {
    return this.deviceAuth;
  }

  // ---------------------------------------------------------------------------
  // Internal: device auth endpoint (HTTP GET /auth/device)
  // ---------------------------------------------------------------------------

  private handleAuthDevice(_req: Request, url: URL): Response {
    if (!this.deviceAuth) {
      return Response.json({ ok: false, error: "Device auth not configured" }, { status: 500 });
    }

    const callbackPort = url.searchParams.get("callback_port");
    const mode = url.searchParams.get("mode") ?? (callbackPort ? "callback" : "json");
    const deviceLabel = url.searchParams.get("device") ?? "unknown";

    const token = this.deviceAuth.createToken(deviceLabel);
    log.info("device token issued", { device: deviceLabel, mode });

    if (mode === "callback" && callbackPort) {
      const port = parseInt(callbackPort, 10);
      if (isNaN(port) || port < 1 || port > 65535) {
        return Response.json({ ok: false, error: "Invalid callback_port" }, { status: 400 });
      }
      return new Response(callbackRedirectHtml(port, token), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    if (mode === "manual") {
      return new Response(manualTokenHtml(token), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // Web mode: store token in localStorage and redirect back to the app.
    // Used when the browser's CF Access cookie expired (page loaded from
    // service worker cache). Full-page navigation triggers CF Access login.
    if (mode === "web") {
      // Validate return_url as a relative path to prevent open redirect
      const raw = url.searchParams.get("return_url") ?? "/";
      const returnUrl = raw.startsWith("/") && !raw.startsWith("//") ? raw : "/";
      return new Response(webAuthRedirectHtml(token, returnUrl), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // Default: JSON mode (for web frontend and programmatic access)
    return Response.json({ ok: true, token });
  }

  // ---------------------------------------------------------------------------
  // Internal: push re-subscribe (HTTP POST from service worker)
  // ---------------------------------------------------------------------------

  private async handlePushResubscribe(req: Request): Promise<Response> {
    if (!this.pushService?.enabled) {
      return Response.json({ ok: false, error: "push not configured" }, { status: 400 });
    }
    try {
      const body = (await req.json()) as {
        newSubscription?: PushSubscriptionJSON;
        oldEndpoint?: string;
      };
      if (body.oldEndpoint) {
        this.pushService.removeSubscription(body.oldEndpoint);
      }
      if (body.newSubscription?.endpoint && body.newSubscription.keys) {
        this.pushService.addSubscription(body.newSubscription);
      }
      return Response.json({ ok: true });
    } catch {
      return Response.json({ ok: false, error: "invalid request" }, { status: 400 });
    }
  }

  // ---------------------------------------------------------------------------
  // Internal: OpenAI Realtime client secret broker
  // ---------------------------------------------------------------------------

  /**
   * Validate the device token from the request's Authorization header.
   * Returns a 401 Response if missing/invalid, null if the check passes.
   * No-ops when deviceAuth is not configured (localhost dev mode).
   */
  private requireDeviceToken(req: Request): Response | null {
    if (!this.deviceAuth) return null;
    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!token || !this.deviceAuth.isValid(token)) {
      return Response.json({ ok: false, error: "Invalid or missing device token" }, { status: 401 });
    }
    return null;
  }

  private async handleOpenAIRealtimeClientSecret(req: Request): Promise<Response> {
    const authError = this.requireDeviceToken(req);
    if (authError) return authError;

    try {
      const body = (await req.json().catch(() => ({}))) as LiveRealtimeClientSecretParams;
      return Response.json(await mintOpenAIRealtimeClientSecret(body));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = err instanceof LiveRealtimeBrokerError ? err.status : 500;
      return Response.json({ ok: false, error: message }, { status });
    }
  }

  // ---------------------------------------------------------------------------
  // Internal: message handling
  // ---------------------------------------------------------------------------

  private handleMessage(conn: GatewayConnection, raw: string): void {
    const frame = parseFrame(raw);
    if (!frame) {
      conn.sendResponse({
        type: "res",
        id: "unknown",
        ok: false,
        error: { code: ErrorCodes.INVALID_REQUEST, message: "Invalid frame format" },
      });
      return;
    }

    // Before handshake, only "connect" is allowed
    if (!conn.authenticated && frame.method !== "connect") {
      conn.sendResponse({
        type: "res",
        id: frame.id,
        ok: false,
        error: { code: ErrorCodes.HANDSHAKE_REQUIRED, message: "Must send connect first" },
      });
      return;
    }

    // Handle "connect" specially (auth + handshake)
    if (frame.method === "connect") {
      this.handleConnect(conn, frame);
      return;
    }

    // Dispatch to method handler
    this.dispatchMethod(conn, frame);
  }

  private handleConnect(conn: GatewayConnection, frame: RequestFrame): void {
    const params = (frame.params ?? {}) as ConnectParams;

    // Auth check: when device auth is configured, every connection must present
    // a valid device token — including localhost. This ensures defense in depth
    // when the gateway is behind a Cloudflare Tunnel (which makes all connections
    // appear as localhost).
    if (this.deviceAuth) {
      const token = params.token;
      if (!token || !this.deviceAuth.isValid(token)) {
        conn.sendResponse({
          type: "res",
          id: frame.id,
          ok: false,
          error: { code: ErrorCodes.UNAUTHORIZED, message: "Invalid or missing device token" },
        });
        conn.close(1008, "unauthorized");
        return;
      }
    }

    // Complete handshake (with role + nodeId for node hosts)
    const role = params.role ?? "client";
    const nodeId = role === "node" ? params.node?.nodeId : undefined;
    conn.completeHandshake(params.version ?? "", params.platform ?? "", params.workingDirectory, role, nodeId, params.clientId, params.mode);

    // Reject role="node" without valid metadata
    if (role === "node" && (!params.node?.nodeId || !params.node?.name)) {
      conn.sendResponse({
        type: "res",
        id: frame.id,
        ok: false,
        error: { code: ErrorCodes.INVALID_REQUEST, message: "Node hosts must provide node.nodeId and node.name" },
      });
      conn.close(1008, "invalid node metadata");
      return;
    }

    // Node host connections: register in node registry, skip session binding
    if (role === "node" && params.node) {
      this._nodeRegistry.register(conn, {
        nodeId: params.node.nodeId,
        name: params.node.name,
        commands: params.node.commands,
        platform: params.platform ?? "unknown",
      });
    } else {
      // Client connection: bind to initial session if provided
      if (params.sessionKey) {
        conn.bindSession(params.sessionKey);
      }
    }

    // Send hello-ok
    const payload: HelloPayload = {
      connId: conn.connId,
      serverVersion: SERVER_VERSION,
      methods: this.methods.list(),
    };

    conn.sendResponse({
      type: "res",
      id: frame.id,
      ok: true,
      payload,
    });

    // Auto-subscribe web clients to all existing sessions (Slack model).
    // TUI clients use single-session binding via session.resolve.
    if (params.platform === "web" && this.activeSessionCountFn) {
      const allKeys = this._getSessionKeys?.() ?? [];
      if (allKeys.length > 0) {
        this._subscriptions.subscribeAll(conn.connId, allKeys);
        log.debug("auto-subscribed web client", { connId: conn.connId, sessions: allKeys.length });
      }
    }

    log.info(role === "node" ? "node connected" : "client connected", {
      connId: conn.connId,
      platform: params.platform,
      ...(role === "node" ? { nodeId, nodeName: params.node?.name } : { sessionKey: params.sessionKey }),
    });
  }

  private async dispatchMethod(conn: GatewayConnection, frame: RequestFrame): Promise<void> {
    const handler = this.methods.get(frame.method);
    if (!handler) {
      conn.sendResponse({
        type: "res",
        id: frame.id,
        ok: false,
        error: { code: ErrorCodes.METHOD_NOT_FOUND, message: `Unknown method: ${frame.method}` },
      });
      return;
    }

    try {
      const result = await handler(conn, frame.params, this);
      conn.sendResponse({
        type: "res",
        id: frame.id,
        ok: true,
        payload: result,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = (err as any)?.code ?? ErrorCodes.INTERNAL_ERROR;
      conn.sendResponse({
        type: "res",
        id: frame.id,
        ok: false,
        error: { code, message },
      });
    }
  }
}

/**
 * Reset all gateway state. For testing only.
 */
export function resetGatewayState(): void {
  resetCommandQueue();
  resetBroadcast();
  resetConnectionCounter();
}
