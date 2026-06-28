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
import { parseFrame, ErrorCodes } from "./protocol.js";
import type { RequestFrame, ConnectParams, HelloPayload } from "./protocol.js";
import { markGatewayDraining, waitForActiveTasks, resetCommandQueue } from "./command-queue.js";
import { cancelPendingPermissions } from "./ws-permission.js";
import { serveStatic, resolveWebDistDir } from "./static.js";
import type { MethodHandler, MethodRegistry } from "./methods.js";
import { createMethodRegistry } from "./methods.js";
import { NodeRegistry } from "./node-registry.js";
import { DeviceAuth, callbackRedirectHtml, manualTokenHtml, webAuthRedirectHtml, type DeviceTokenPayload } from "./device-auth.js";
import { AppAuth, sanitizeReturnUrl, type AppAuthUser } from "./app-auth.js";
import {
  LiveRealtimeBrokerError,
  mintOpenAIRealtimeClientSecret,
  type LiveRealtimeClientSecretParams,
} from "./live-realtime-broker.js";
import { handleProviderGatewayRequest, isProviderGatewayPath } from "./provider-gateway.js";
import { provisionWorkspaceForUser } from "./workspace-provisioner.js";
import { isAdminHost, isControlHost, workspaceLocalTargetForUser } from "./workspace-registry.js";
import { isLoopbackHost } from "./loopback.js";

const log = createSubsystemLogger("gateway/server");

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const SERVER_VERSION = "0.1.0";
const HANDSHAKE_TIMEOUT_MS = 10_000;

async function readFormOrJson(req: Request): Promise<Record<string, string>> {
  const contentType = req.headers.get("Content-Type") ?? "";
  if (contentType.includes("application/json")) {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(body).map(([key, value]) => [key, typeof value === "string" ? value : ""]),
    );
  }

  const form = await req.formData();
  const out: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    out[key] = typeof value === "string" ? value : "";
  }
  return out;
}

function redirect(location: string, extraHeaders: Array<[string, string]> = []): Response {
  const headers = new Headers(extraHeaders);
  headers.set("Location", location);
  return new Response(null, { status: 303, headers });
}

function logoutRedirectHtml(returnUrl: string): string {
  const safeReturn = JSON.stringify(returnUrl);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Signing out</title>
</head>
<body>
  <script>
    for (const key of ["hawky_device_token", "hawky-device-token", "hawky-auth-token", "gateway-token"]) {
      try { localStorage.removeItem(key); } catch {}
    }
    window.location.replace(${safeReturn});
  </script>
  <noscript><a href="${returnUrl}">Continue</a></noscript>
</body>
</html>`;
}

function requestIp(req: Request): string {
  return req.headers.get("CF-Connecting-IP")
    ?? req.headers.get("X-Forwarded-For")?.split(",")[0]?.trim()
    ?? "";
}

function loginThrottleKey(req: Request): string {
  return requestIp(req) || "unknown";
}

function proxyHeaders(headers: Headers): Headers {
  const out = new Headers(headers);
  out.delete("host");
  out.delete("connection");
  out.delete("upgrade");
  return out;
}

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
  private appAuth: AppAuth | null = null;
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
    this.appAuth = AppAuth.fromEnv();
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
    this.boundToLoopback = isLoopbackHost(hostname);

    const self = this;

    this.server = Bun.serve<WSData>({
      port,
      hostname,

      // HTTP handler — health endpoints + static files
      fetch(req, server) {
        // WebSocket upgrade — check FIRST, before any URL parsing.
        if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
          const proxyTarget = self.workspaceProxyTarget(req, new URL(req.url));
          if (proxyTarget) {
            const url = new URL(req.url);
            const upgraded = server.upgrade(req, {
              data: {
                connId: "",
                proxyTarget: `ws://${proxyTarget}${url.pathname}${url.search}`,
              } as WSData,
            });
            return upgraded ? undefined : new Response("WebSocket upgrade failed", { status: 400 });
          }
          const upgraded = server.upgrade(req, {
            data: { connId: "" } as WSData,
          });
          if (!upgraded) {
            return new Response("WebSocket upgrade failed", { status: 400 });
          }
          return undefined;
        }

        const url = new URL(req.url);

        // Internal provider gateway — used by per-user gateway processes so
        // they never need raw OpenAI/Anthropic provider keys in their env.
        if (isProviderGatewayPath(url.pathname)) {
          return handleProviderGatewayRequest(req, url);
        }

        // Health endpoints — always unauthenticated (needed for probes/monitoring)
        if (url.pathname === "/health" || url.pathname === "/healthz") {
          if (self.appAuth && !self.isAuthorizedHealthRequest(req)) {
            return new Response(self.appAuth.loginPage(url.pathname), {
              status: 401,
              headers: { "Content-Type": "text/html; charset=utf-8" },
            });
          }
          return Response.json({ ok: true, status: "live" });
        }
        if (url.pathname === "/ready" || url.pathname === "/readyz") {
          if (self.appAuth && !self.isAuthorizedHealthRequest(req)) {
            return new Response(self.appAuth.loginPage(url.pathname), {
              status: 401,
              headers: { "Content-Type": "text/html; charset=utf-8" },
            });
          }
          return Response.json({
            ok: true,
            status: "ready",
            connections: self.connections.size,
          });
        }

        // App auth endpoints — optional email/password login wall before
        // issuing device tokens. Cloudflare Access can still sit in front.
        if (self.appAuth && url.pathname === "/auth/login") {
          return self.handleAppLogin(req, url);
        }
        if (self.appAuth && url.pathname === "/auth/register") {
          return self.handleAppRegister(req, url);
        }
        if (self.appAuth && url.pathname === "/auth/logout") {
          return self.handleAppLogout(url);
        }
        if (self.appAuth && url.pathname === "/auth/me" && req.method === "GET") {
          return self.handleAppMe(req);
        }
        if (self.appAuth && url.pathname === "/" && isAdminHost(req.headers.get("Host") ?? "")) {
          return redirect("/admin");
        }
        if (self.appAuth && url.pathname === "/admin") {
          return self.handleAdmin(req, url);
        }
        if (self.appAuth && url.pathname.startsWith("/admin/users/")) {
          return self.handleAdminUserAction(req, url);
        }
        if (self.appAuth && self.shouldRequireAppLogin(req, url)) {
          if (req.method !== "GET" && req.method !== "HEAD") {
            return Response.json({ ok: false, error: "Login required" }, { status: 401 });
          }
          const returnUrl = sanitizeReturnUrl(url.pathname + url.search);
          return new Response(self.appAuth.loginPage(returnUrl), {
            status: 401,
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }
        const workspaceProxy = self.proxyWorkspaceRequest(req, url);
        if (workspaceProxy) return workspaceProxy;

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
          if (ws.data?.proxyTarget) {
            const pending: Array<string | Buffer> = [];
            const upstream = new WebSocket(ws.data.proxyTarget);
            ws.data.proxyUpstream = upstream;
            ws.data.proxyPending = pending;
            upstream.addEventListener("open", () => {
              for (const message of pending.splice(0)) upstream.send(message);
            });
            upstream.addEventListener("message", (event) => {
              ws.send(event.data);
            });
            upstream.addEventListener("close", (event) => {
              ws.close(event.code || 1000, event.reason || "");
            });
            upstream.addEventListener("error", () => {
              ws.close(1011, "upstream websocket error");
            });
            return;
          }
          const remoteAddress = ws.remoteAddress || "unknown";
          const conn = new GatewayConnection(ws, remoteAddress);
          self.connections.set(conn.connId, conn);
          conn.startHandshakeTimer(HANDSHAKE_TIMEOUT_MS);
          log.info("connection opened", { connId: conn.connId });
        },

        message(ws, raw) {
          const upstream = ws.data?.proxyUpstream;
          if (upstream) {
            if (upstream.readyState === WebSocket.OPEN) {
              upstream.send(raw);
            } else {
              ws.data?.proxyPending?.push(typeof raw === "string" ? raw : Buffer.from(raw));
            }
            return;
          }
          const connId = ws.data?.connId;
          if (!connId) return;

          const conn = self.connections.get(connId);
          if (!conn) return;

          const message = typeof raw === "string" ? raw : Buffer.from(raw).toString("utf-8");
          self.handleMessage(conn, message);
        },

        close(ws, code, reason) {
          const upstream = ws.data?.proxyUpstream;
          if (upstream) {
            if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
              upstream.close(code || 1000, reason || "");
            }
            return;
          }
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

  private handleAuthDevice(req: Request, url: URL): Response {
    if (!this.deviceAuth) {
      return Response.json({ ok: false, error: "Device auth not configured" }, { status: 500 });
    }

    const callbackPort = url.searchParams.get("callback_port");
    const mode = url.searchParams.get("mode") ?? (callbackPort ? "callback" : "json");
    const deviceLabel = url.searchParams.get("device") ?? "unknown";

    if (this.appAuth && !this.appAuth.userFromRequest(req)) {
      if (mode === "json") {
        return Response.json({ ok: false, error: "Login required" }, { status: 401 });
      }
      const returnUrl = sanitizeReturnUrl(url.searchParams.get("return_url") ?? "/");
      return new Response(this.appAuth.loginPage(returnUrl), {
        status: 401,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

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

  private async handleAppLogin(req: Request, url: URL): Promise<Response> {
    if (!this.appAuth) return new Response("Not found", { status: 404 });
    if (req.method === "GET") {
      return new Response(this.appAuth.loginPage(url.searchParams.get("return_url") ?? "/"), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

    const body = await readFormOrJson(req);
    const returnUrl = sanitizeReturnUrl(body.return_url ?? "/");
    try {
      const { user, token } = this.appAuth.login(body.email ?? "", body.password ?? "", loginThrottleKey(req));
      return redirect(this.postLoginRedirect(req, user, returnUrl), [["Set-Cookie", this.appAuth.createSessionCookie(token)]]);
    } catch (err) {
      return new Response(this.appAuth.loginPage(returnUrl, err instanceof Error ? err.message : "Login failed."), {
        status: 401,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
  }

  private async handleAppRegister(req: Request, _url: URL): Promise<Response> {
    if (!this.appAuth) return new Response("Not found", { status: 404 });
    const url = new URL(req.url);
    if (req.method === "GET") {
      return new Response(this.appAuth.registerPage(url.searchParams.get("return_url") ?? "/"), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

    const body = await readFormOrJson(req);
    const returnUrl = sanitizeReturnUrl(body.return_url ?? "/");
    try {
      const result = this.appAuth.register(body.email ?? "", body.password ?? "", body.registration_code ?? "");
      if (result.approvalRequired) {
        return new Response(this.appAuth.loginPage(returnUrl, "", "Sign-up received. An admin will review it before you can sign in."), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      const { token } = this.appAuth.login(body.email ?? "", body.password ?? "", loginThrottleKey(req));
      return redirect(result.user.role === "admin" ? "/admin" : this.postLoginRedirect(req, result.user, returnUrl), [["Set-Cookie", this.appAuth.createSessionCookie(token)]]);
    } catch (err) {
      return new Response(this.appAuth.registerPage(returnUrl, "", err instanceof Error ? err.message : "Registration failed."), {
        status: 400,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
  }

  private handleAppLogout(url: URL): Response {
    if (!this.appAuth) return new Response("Not found", { status: 404 });
    const returnUrl = sanitizeReturnUrl(url.searchParams.get("return_url") ?? "/auth/login");
    const headers = new Headers({ "Content-Type": "text/html; charset=utf-8" });
    for (const cookie of this.appAuth.clearSessionCookies()) {
      headers.append("Set-Cookie", cookie);
    }
    return new Response(logoutRedirectHtml(returnUrl), {
      status: 200,
      headers,
    });
  }

  private handleAppMe(req: Request): Response {
    if (!this.appAuth) return new Response("Not found", { status: 404 });
    const user = this.appAuth.userFromRequest(req);
    if (!user) return Response.json({ ok: false, error: "Login required" }, { status: 401 });
    return Response.json({ ok: true, user });
  }

  private postLoginRedirect(req: Request, user: AppAuthUser, returnUrl: string): string {
    if (isAdminHost(req.headers.get("Host") ?? "") && returnUrl === "/") return "/admin";
    if (user.role === "admin" && returnUrl === "/") return "/admin";
    return returnUrl;
  }

  private async handleAdmin(req: Request, url: URL): Promise<Response> {
    if (!this.appAuth) return new Response("Not found", { status: 404 });
    const user = this.appAuth.userFromRequest(req);
    if (!user) {
      return new Response(this.appAuth.loginPage(`/admin${url.search}`), {
        status: 401,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    if (!this.appAuth.isAdmin(user)) {
      return new Response("Forbidden", { status: 403 });
    }
    return new Response(this.appAuth.adminPage(user, url.searchParams.get("message") ?? "", url.searchParams.get("error") ?? ""), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  private async handleAdminUserAction(req: Request, url: URL): Promise<Response> {
    if (!this.appAuth) return new Response("Not found", { status: 404 });
    if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const admin = this.appAuth.userFromRequest(req);
    if (!admin || !this.appAuth.isAdmin(admin)) return Response.json({ ok: false, error: "Admin access required" }, { status: 403 });

    const match = /^\/admin\/users\/([^/]+)\/(approve|disable)$/.exec(url.pathname);
    if (!match) return new Response("Not found", { status: 404 });
    const [, userIdRaw, action] = match;
    const userId = decodeURIComponent(userIdRaw);
    try {
      if (action === "approve") {
        const body = await readFormOrJson(req);
        const role = body.role === "admin" ? "admin" : "user";
        const approved = this.appAuth.approveUser(admin, userId, role);
        const provision = await provisionWorkspaceForUser({ user: approved, role, admin });
        const message = provision.ok
          ? provision.skipped
            ? "User approved"
            : "User approved and workspace provisioned"
          : `User approved, but workspace provisioning failed: ${provision.message}`;
        return redirect(`/admin?message=${encodeURIComponent(message)}`);
      }
      this.appAuth.disableUser(admin, userId);
      return redirect("/admin?message=User%20disabled");
    } catch (err) {
      const error = encodeURIComponent(err instanceof Error ? err.message : "Admin action failed.");
      return redirect(`/admin?error=${error}`);
    }
  }

  private shouldRequireAppLogin(req: Request, url: URL): boolean {
    if (!this.appAuth) return false;
    if (this.appAuth.userFromRequest(req)) return false;
    if (url.pathname.startsWith("/auth/")) return false;
    if (url.pathname === "/ws") return false;
    return true;
  }

  private workspaceProxyTarget(req: Request, url: URL): string | null {
    if (!this.appAuth) return null;
    if (!isControlHost(req.headers.get("Host") ?? "")) return null;
    if (isAdminHost(req.headers.get("Host") ?? "")) return null;
    if (url.pathname === "/health" || url.pathname === "/healthz") return null;
    if (url.pathname === "/ready" || url.pathname === "/readyz") return null;
    if (url.pathname === "/auth/login") return null;
    if (url.pathname === "/auth/register") return null;
    if (url.pathname === "/auth/logout") return null;
    if (url.pathname === "/auth/me") return null;
    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) return null;
    if (isProviderGatewayPath(url.pathname)) return null;
    const user = this.appAuth.userFromRequest(req);
    if (!user) return null;
    return workspaceLocalTargetForUser(user);
  }

  private proxyWorkspaceRequest(req: Request, url: URL): Promise<Response> | null {
    const target = this.workspaceProxyTarget(req, url);
    if (!target) return null;
    const upstreamUrl = `http://${target}${url.pathname}${url.search}`;
    return fetch(upstreamUrl, {
      method: req.method,
      headers: proxyHeaders(req.headers),
      body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
      signal: req.signal,
    }).then((upstream) => new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: upstream.headers,
    }));
  }

  private isAuthorizedHealthRequest(req: Request): boolean {
    const token = process.env.HAWKY_HEALTH_TOKEN ?? "";
    if (!token) return false;
    return req.headers.get("X-Hawky-Health-Token") === token;
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
  private requireDeviceToken(req: Request): Response | DeviceTokenPayload | null {
    if (!this.deviceAuth) return null;
    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    const payload = token ? this.deviceAuth.verifyToken(token) : null;
    if (!payload) {
      return Response.json({ ok: false, error: "Invalid or missing device token" }, { status: 401 });
    }
    return payload;
  }

  private async handleOpenAIRealtimeClientSecret(req: Request): Promise<Response> {
    const device = this.requireDeviceToken(req);
    if (device instanceof Response) return device;

    try {
      const body = (await req.json().catch(() => ({}))) as LiveRealtimeClientSecretParams;
      const appUser = this.appAuth?.userFromRequest(req);
      const quotaKey = appUser
        ? `user:${appUser.id}`
        : device
          ? `device:${device.jti}`
          : `ip:${requestIp(req) || "unknown"}`;
      return Response.json(await mintOpenAIRealtimeClientSecret(body, { quotaKey }));
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
    const parseStartedAt = Date.now();
    const frame = parseFrame(raw);
    const parseDurationMs = Date.now() - parseStartedAt;
    const rawBytes = Buffer.byteLength(raw, "utf8");
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
      if (conn.authenticated) {
        conn.sendResponse({
          type: "res",
          id: frame.id,
          ok: false,
          error: { code: ErrorCodes.INVALID_REQUEST, message: "Connection is already authenticated" },
        });
        return;
      }
      this.handleConnect(conn, frame);
      return;
    }

    // Dispatch to method handler
    this.dispatchMethod(conn, frame, { rawBytes, parseDurationMs });
  }

  private handleConnect(conn: GatewayConnection, frame: RequestFrame): void {
    const params = (frame.params ?? {}) as ConnectParams;

    // Auth check: when device auth is configured, every connection must present
    // a valid device token — including localhost. This ensures defense in depth
    // when the gateway is behind a Cloudflare Tunnel (which makes all connections
    // appear as localhost).
    if (this.deviceAuth) {
      const token = params.token;
      const payload = token ? this.deviceAuth.verifyToken(token) : null;
      if (!payload) {
        conn.sendResponse({
          type: "res",
          id: frame.id,
          ok: false,
          error: { code: ErrorCodes.UNAUTHORIZED, message: "Invalid or missing device token" },
        });
        conn.close(1008, "unauthorized");
        return;
      }
      conn.deviceTokenId = payload.jti;
      conn.deviceLabel = payload.device;
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

  private async dispatchMethod(
    conn: GatewayConnection,
    frame: RequestFrame,
    ingress?: { rawBytes: number; parseDurationMs: number },
  ): Promise<void> {
    const startedAt = Date.now();
    const handler = this.methods.get(frame.method);
    if (!handler) {
      conn.sendResponse({
        type: "res",
        id: frame.id,
        ok: false,
        error: { code: ErrorCodes.METHOD_NOT_FOUND, message: `Unknown method: ${frame.method}` },
      });
      log.info("rpc completed", {
        connId: conn.connId,
        platform: conn.clientPlatform || "unknown",
        sessionKey: conn.sessionKey || undefined,
        method: frame.method,
        ok: false,
        code: ErrorCodes.METHOD_NOT_FOUND,
        durationMs: Date.now() - startedAt,
        ...(ingress ? { rawBytes: ingress.rawBytes, parseMs: ingress.parseDurationMs } : {}),
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
      log.info("rpc completed", {
        connId: conn.connId,
        platform: conn.clientPlatform || "unknown",
        sessionKey: conn.sessionKey || undefined,
        method: frame.method,
        ok: true,
        durationMs: Date.now() - startedAt,
        ...(ingress ? { rawBytes: ingress.rawBytes, parseMs: ingress.parseDurationMs } : {}),
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
      log.info("rpc completed", {
        connId: conn.connId,
        platform: conn.clientPlatform || "unknown",
        sessionKey: conn.sessionKey || undefined,
        method: frame.method,
        ok: false,
        code,
        durationMs: Date.now() - startedAt,
        ...(ingress ? { rawBytes: ingress.rawBytes, parseMs: ingress.parseDurationMs } : {}),
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
