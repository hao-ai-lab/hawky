// =============================================================================
// Gateway Client
//
// WebSocket client that implements AgentEventSource. TUI uses this to
// communicate with a running gateway server. Handles:
// - Connection + handshake
// - Browser-based device authentication (local callback server)
// - Reconnection with exponential backoff (a proven design pattern)
// - RPC request/response correlation
// - EventFrame → StreamEvent translation
// - Permission request/response flow over WebSocket
// =============================================================================

import type { AgentEventSource, ConnectionStatus } from "./agent-source.js";
import type { StreamEvent, StreamEventCallback, ChatMessage } from "../agent/types.js";
import type { ResponseFrame, EventFrame, HelloPayload } from "./protocol.js";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

interface PendingRequest {
  resolve: (payload: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface GatewayClientOptions {
  url: string;
  sessionKey: string;
  workingDirectory: string;
  platform?: string;
  /** Auth token for non-localhost gateway connections */
  token?: string;
  onConnectionChange?: (status: ConnectionStatus) => void;
  /** Called when gateway sends a permission.request event */
  onPermissionRequest?: (requestId: string, toolName: string, toolInput: unknown) => void;
  /** Called when gateway sends an ask_user.request event */
  onAskUserRequest?: (requestId: string, toolName: string, question: string, options?: string[]) => void;
  /** Called when gateway sends heartbeat status events */
  onHeartbeatEvent?: (event: string, payload: unknown) => void;
  /** Called when token is rejected (1008 close). Should return a new token or null. */
  onAuthFailed?: () => Promise<string | null>;
}

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
const REQUEST_TIMEOUT_MS = 30_000;
// chat.send waits for the entire agent turn — no fixed timeout (turns can chain
// multiple long bash commands and iterate many times)
const NO_TIMEOUT_METHODS = new Set(["chat.send"]);
const HANDSHAKE_TIMEOUT_MS = 5_000;

// -----------------------------------------------------------------------------
// Client
// -----------------------------------------------------------------------------

export class GatewayClient implements AgentEventSource {
  private url: string;
  private sessionKey: string;
  private workingDirectory: string;
  private platform: string;
  private token: string | null;
  /** Stable per-process clientId for broadcast exclusion. Generated once
   *  at construction and reused across reconnects so the gateway can
   *  recognize multiple sockets from this client (e.g. an overlapping
   *  reconnect during network flap) as the same logical client. */
  private clientId: string;
  private onConnectionChange: ((status: ConnectionStatus) => void) | null;
  private onPermissionRequest: ((requestId: string, toolName: string, toolInput: unknown) => void) | null;
  private onAskUserRequest: ((requestId: string, toolName: string, question: string, options?: string[]) => void) | null;
  private onHeartbeatEvent: ((event: string, payload: unknown) => void) | null;
  private onAuthFailed: (() => Promise<string | null>) | null;

  private ws: WebSocket | null = null;
  private subscribers: StreamEventCallback[] = [];
  private pendingRequests = new Map<string, PendingRequest>();
  private nextReqId = 1;
  private running = false;
  private connected = false;
  private closed = false;
  private hasConnectedOnce = false; // True after first successful connect
  private backoffMs = INITIAL_BACKOFF_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reauthInProgress = false;

  // No sendResolve/sendReject needed — the gateway's chat.send RPC
  // blocks until the agent finishes, so awaiting the RPC = awaiting completion.

  constructor(opts: GatewayClientOptions) {
    this.url = ensureWsPath(opts.url);
    this.sessionKey = opts.sessionKey;
    this.workingDirectory = opts.workingDirectory;
    this.platform = opts.platform ?? "tui";
    this.token = opts.token ?? null;
    this.clientId = `c-${this.platform}-${(globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`)}`;
    this.onConnectionChange = opts.onConnectionChange ?? null;
    this.onPermissionRequest = opts.onPermissionRequest ?? null;
    this.onAskUserRequest = opts.onAskUserRequest ?? null;
    this.onHeartbeatEvent = opts.onHeartbeatEvent ?? null;
    this.onAuthFailed = opts.onAuthFailed ?? null;
  }

  /** Update the token (e.g., after re-authentication). */
  setToken(token: string): void {
    this.token = token;
  }

  // ---------------------------------------------------------------------------
  // Connection
  // ---------------------------------------------------------------------------

  /**
   * Connect to the gateway server and perform handshake.
   * Throws if connection or handshake fails.
   */
  async connect(): Promise<HelloPayload> {
    this.closed = false;
    this.setStatus("connecting");

    return new Promise<HelloPayload>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Connection timeout"));
        this.ws?.close();
      }, HANDSHAKE_TIMEOUT_MS);

      try {
        this.ws = new WebSocket(this.url);
      } catch (err) {
        clearTimeout(timer);
        reject(new Error(`Failed to connect to ${this.url}: ${err instanceof Error ? err.message : String(err)}`));
        return;
      }

      this.ws.addEventListener("error", (e) => {
        clearTimeout(timer);
        reject(new Error(`WebSocket connection failed (is the gateway running?)`));
      });

      this.ws.addEventListener("open", () => {
        // Perform handshake (include token if configured)
        const connectParams: Record<string, unknown> = {
          version: "0.1.0",
          platform: this.platform,
          sessionKey: this.sessionKey,
          workingDirectory: this.workingDirectory,
          clientId: this.clientId,
        };
        if (this.token) {
          connectParams.token = this.token;
        }
        this.rpc("connect", connectParams).then((payload) => {
          clearTimeout(timer);
          const isReconnect = this.hasConnectedOnce;
          this.connected = true;
          this.hasConnectedOnce = true;
          this.backoffMs = INITIAL_BACKOFF_MS;
          this.setStatus("connected");
          if (isReconnect) {
            this.emitToSubscribers({
              type: "system_message",
              content: "Reconnected to gateway.",
              subtype: "info",
            } as any);
          }
          resolve(payload as HelloPayload);
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
        const wasRunning = this.running;
        this.connected = false;
        this.running = false;
        // Reject all pending RPC requests
        for (const [id, pending] of this.pendingRequests) {
          if (pending.timer) clearTimeout(pending.timer);
          pending.reject(new Error("Connection closed"));
        }
        this.pendingRequests.clear();

        // If the agent was mid-turn when the connection dropped, emit a
        // synthetic error event so the TUI resets from streaming/thinking
        // to idle. Without this, the TUI hangs forever waiting for a
        // "done" event that will never arrive.
        if (wasRunning) {
          this.emitToSubscribers({
            type: "error",
            content: "Gateway disconnected",
            code: "connection_closed",
          });
        }

        const closeCode = typeof event?.code === "number" ? event.code : 0;

        // 1008 = token rejected. Trigger reauth instead of blind reconnect.
        if (!this.closed && closeCode === 1008 && this.onAuthFailed) {
          this.setStatus("disconnected");
          this.emitToSubscribers({
            type: "system_message",
            content: "Authentication failed. Re-authenticating...",
            subtype: "info",
          } as any);
          this.handleReauth();
          return;
        }

        // Reconnect on ANY abnormal close — whether we were connected
        // (gateway crashed mid-session) or never connected (handshake failed).
        // Only skip reconnect on normal close (code 1000 = user-initiated).
        if (!this.closed && closeCode !== 1000) {
          this.setStatus("disconnected");
          if (wasConnected) {
            this.emitToSubscribers({
              type: "system_message",
              content: "Gateway disconnected. Reconnecting...",
              subtype: "info",
            } as any);
          }
          this.scheduleReconnect();
        } else if (wasConnected && !this.closed) {
          this.setStatus("disconnected");
        }
      });

      this.ws.addEventListener("error", () => {
        // Error events are followed by close events — handle in close
      });
    });
  }

  /** Disconnect and stop reconnecting. */
  close(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.setStatus("disconnected");
  }

  /** Check if currently connected. */
  isConnected(): boolean {
    return this.connected;
  }

  // ---------------------------------------------------------------------------
  // AgentEventSource implementation
  // ---------------------------------------------------------------------------

  subscribe(callback: StreamEventCallback): () => void {
    this.subscribers.push(callback);
    return () => {
      this.subscribers = this.subscribers.filter((cb) => cb !== callback);
    };
  }

  async sendMessage(text: string, attachments?: Array<{ base64: string; media_type: string }>): Promise<void> {
    if (!this.connected) throw new Error("Not connected to gateway");
    if (this.running) throw new Error("Agent is already running");

    this.running = true;

    try {
      // The gateway's chat.send RPC blocks until the agent finishes.
      // Awaiting this RPC = awaiting the full agent turn completion.
      // Stream events (text, tool_use, etc.) arrive via EventFrames during this await.
      const params: Record<string, unknown> = {
        message: text,
        sessionKey: this.sessionKey,
      };
      if (attachments && attachments.length > 0) {
        params.attachments = attachments;
      }
      await this.rpc("chat.send", params);
    } finally {
      this.running = false;
    }
  }

  cancel(): void {
    if (!this.connected) return;
    // Fire-and-forget cancel RPC
    void this.rpc("chat.cancel", { sessionKey: this.sessionKey }).catch(() => {});
  }

  async getHistory(): Promise<ChatMessage[]> {
    if (!this.connected) return [];
    try {
      const result = await this.rpc("session.history", {
        sessionKey: this.sessionKey,
      }) as { messages: ChatMessage[] };
      return result.messages ?? [];
    } catch {
      return [];
    }
  }

  clearHistory(): void {
    if (!this.connected) return;
    // Send session.clear RPC to gateway — gateway clears the agent loop's history
    void this.rpc("session.clear", { sessionKey: this.sessionKey }).catch(() => {});
  }

  /** Trigger memory flush — extract durable memories from conversation to daily logs. */
  flush(): void {
    if (!this.connected) return;
    void this.rpc("session.flush", { sessionKey: this.sessionKey }).catch(() => {});
  }

  /** Trigger context compaction — summarize old messages to free context space. */
  compact(): void {
    if (!this.connected) return;
    void this.rpc("session.compact", { sessionKey: this.sessionKey }).catch(() => {});
  }

  isRunning(): boolean {
    return this.running;
  }

  // ---------------------------------------------------------------------------
  // Session switching
  // ---------------------------------------------------------------------------

  /**
   * Switch to a different session. Resolves the session on the gateway,
   * updates the local session key, and returns the new history.
   */
  async switchSession(newSessionKey: string): Promise<ChatMessage[]> {
    if (!this.connected) throw new Error("Not connected");

    // Resolve session on gateway (creates if needed, loads from disk)
    await this.rpc("session.resolve", { sessionKey: newSessionKey });
    this.sessionKey = newSessionKey;

    // Fetch history for the new session
    return this.getHistory();
  }

  /** Get the current session key. */
  getSessionKey(): string {
    return this.sessionKey;
  }

  // ---------------------------------------------------------------------------
  // Permission flow
  // ---------------------------------------------------------------------------

  /**
   * Resolve a pending permission request from the gateway.
   * Called by the TUI when the user responds to a permission prompt.
   */
  async resolvePermission(requestId: string, decision: string, feedback?: string, pattern?: string): Promise<void> {
    if (!this.connected) return;
    await this.rpc("permission.resolve", { requestId, decision, feedback, pattern });
  }

  /**
   * Resolve a pending ask_user request from the gateway.
   */
  async resolveAskUser(requestId: string, answers: string[]): Promise<void> {
    if (!this.connected) return;
    await this.rpc("ask_user.resolve", { requestId, answers });
  }

  // ---------------------------------------------------------------------------
  // Internal: message handling
  // ---------------------------------------------------------------------------

  private handleMessage(raw: string): void {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }

    if (data.type === "res") {
      this.handleResponse(data as unknown as ResponseFrame);
    } else if (data.type === "event") {
      this.handleEvent(data as unknown as EventFrame);
    }
  }

  private handleResponse(frame: ResponseFrame): void {
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
    const event = frame.event;

    // Permission request from gateway → emit as StreamEvent so TUI hook handles it
    if (event === "permission.request") {
      const p = frame.payload as {
        requestId: string;
        toolUseId: string;
        tool: string;
        input: unknown;
        suggestions?: unknown[];
        suggestedPattern?: string;
      };
      // Also call external callback if set
      this.onPermissionRequest?.(p.requestId, p.tool, p.input);
      // Emit as permission_request StreamEvent for TUI hook
      this.emitToSubscribers({
        type: "permission_request",
        tool_use_id: p.toolUseId ?? p.requestId,
        name: p.tool,
        input: p.input as Record<string, unknown>,
        suggestions: p.suggestions,
        suggestedPattern: p.suggestedPattern,
        _requestId: p.requestId, // Extra field for RPC resolution
      } as any);
      return;
    }

    // ask_user request from gateway → emit as StreamEvent
    if (event === "ask_user.request") {
      const p = frame.payload as { requestId: string; tool: string; question: string; options?: string[] };
      this.onAskUserRequest?.(p.requestId, p.tool, p.question, p.options);
      this.emitToSubscribers({
        type: "ask_user_request",
        tool_use_id: p.requestId,
        name: p.tool,
        question: p.question,
        options: p.options,
        _requestId: p.requestId,
      } as any);
      return;
    }

    // Gateway shutdown
    if (event === "gateway.shutdown") {
      return;
    }

    // Heartbeat events → forward to callback
    if (event === "heartbeat.started" || event === "heartbeat.completed") {
      this.onHeartbeatEvent?.(event, frame.payload);
      return;
    }

    // Flush events → forward to same callback (generic event forwarder)
    if (event === "flush.started" || event === "flush.completed" || event === "flush.skipped") {
      this.onHeartbeatEvent?.(event, frame.payload);
      return;
    }

    // Compaction events → forward to callback
    if (event === "compaction.started" || event === "compaction.completed") {
      this.onHeartbeatEvent?.(event, frame.payload);
      return;
    }

    // Permission mode change → forward via the same callback so the
    // TUI can show a [BYPASS] tag in the statusline.
    if (event === "permission.mode.changed") {
      this.onHeartbeatEvent?.(event, frame.payload);
      return;
    }

    // Agent events: translate to StreamEvent and emit to subscribers
    if (event.startsWith("agent.")) {
      const streamEvent = frame.payload as StreamEvent;
      if (streamEvent) {
        this.emitToSubscribers(streamEvent);
      }
    }
  }

  private emitToSubscribers(event: StreamEvent): void {
    for (const cb of this.subscribers) {
      try {
        cb(event);
      } catch {
        // Subscriber errors are non-fatal
      }
    }
  }

  // ---------------------------------------------------------------------------
  // RPC
  // ---------------------------------------------------------------------------

  rpc(method: string, params?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("Not connected"));
        return;
      }

      const id = `req-${this.nextReqId++}`;
      // chat.send has no timeout — turns can run indefinitely (multiple tools, iterations)
      const timer = NO_TIMEOUT_METHODS.has(method) ? null : setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`RPC timeout: ${method}`));
      }, REQUEST_TIMEOUT_MS);

      this.pendingRequests.set(id, { resolve, reject, timer });

      this.ws.send(JSON.stringify({
        type: "req",
        id,
        method,
        params,
      }));
    });
  }

  // ---------------------------------------------------------------------------
  // Internal: reconnection
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

    this.setStatus("reconnecting");
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connect();
      } catch {
        // Connect failed (gateway still down). The close handler may or may
        // not re-schedule depending on timing. Re-schedule explicitly.
        this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
        if (!this.closed) {
          this.scheduleReconnect();
        }
      }
    }, this.backoffMs);
  }

  private setStatus(status: ConnectionStatus): void {
    this.onConnectionChange?.(status);
  }
}

// =============================================================================
// Device Auth — browser-based login flow for TUI and node host
// =============================================================================

export interface DeviceLoginOptions {
  /** Gateway URL (e.g., "ws://localhost:4242" or "wss://hawky.hawky.live") */
  gatewayUrl: string;
  /** Device label for the token (e.g., "hao-macbook") */
  deviceLabel?: string;
  /** Callback for status messages (e.g., "Opening browser...") */
  onStatus?: (message: string) => void;
}

/**
 * Acquire a device token from the gateway via browser-based authentication.
 *
 * For localhost gateways: fetches /auth/device directly (no browser needed).
 * For remote gateways: starts a local HTTP server, opens a browser to the
 * gateway's /auth/device endpoint, and waits for the callback with the token.
 *
 * Falls back to manual paste if browser can't be opened.
 */
export async function acquireDeviceToken(opts: DeviceLoginOptions): Promise<string> {
  const httpUrl = wsUrlToHttp(opts.gatewayUrl);
  const isLocal = isLocalhostUrl(httpUrl);

  if (isLocal) {
    // Localhost: fetch token directly (no browser needed — SSH is the auth layer)
    return fetchTokenDirect(httpUrl, opts.deviceLabel ?? "tui-local");
  }

  // Remote: browser-based flow
  return browserAuthFlow(httpUrl, opts);
}

/**
 * Fetch a device token directly from the gateway (localhost only).
 */
async function fetchTokenDirect(httpUrl: string, deviceLabel: string): Promise<string> {
  const url = `${httpUrl}/auth/device?mode=json&device=${encodeURIComponent(deviceLabel)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to get device token: HTTP ${res.status}`);
  }
  const body = await res.json() as { ok: boolean; token?: string; error?: string };
  if (!body.ok || !body.token) {
    throw new Error(`Failed to get device token: ${body.error ?? "unknown error"}`);
  }
  return body.token;
}

/**
 * Browser-based auth flow:
 * 1. Start a local HTTP callback server
 * 2. Open browser to gateway /auth/device with callback_port
 * 3. User authenticates via Cloudflare Access (email OTP)
 * 4. Gateway redirects browser to our callback with the token
 * 5. Return the token
 */
async function browserAuthFlow(httpUrl: string, opts: DeviceLoginOptions): Promise<string> {
  const deviceLabel = opts.deviceLabel ?? "tui-remote";

  // Start a local HTTP server on a random port to receive the callback
  const { promise: tokenPromise, port, stop } = startCallbackServer();

  const authUrl = `${httpUrl}/auth/device?callback_port=${port}&device=${encodeURIComponent(deviceLabel)}`;

  // Try to open browser
  const opened = await openBrowser(authUrl);
  if (opened) {
    opts.onStatus?.(`Opened browser for authentication. Waiting for login...`);
  } else {
    // Headless fallback: print URL for manual login
    const manualUrl = `${httpUrl}/auth/device?mode=manual&device=${encodeURIComponent(deviceLabel)}`;
    opts.onStatus?.(`Cannot open browser. Visit this URL to authenticate:\n  ${manualUrl}\n\nThen paste the token here:`);
    stop();
    // Return a rejected promise — caller should handle the paste flow
    throw new ManualAuthRequired(manualUrl);
  }

  try {
    // Wait for the callback (timeout after 5 minutes)
    const token = await Promise.race([
      tokenPromise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Authentication timed out (5 minutes)")), 5 * 60 * 1000),
      ),
    ]);
    return token;
  } finally {
    stop();
  }
}

/**
 * Error thrown when browser can't be opened and manual auth is needed.
 */
export class ManualAuthRequired extends Error {
  readonly manualUrl: string;
  constructor(url: string) {
    super("Manual authentication required");
    this.name = "ManualAuthRequired";
    this.manualUrl = url;
  }
}

/**
 * Start a temporary HTTP server that listens for the auth callback.
 * Returns a promise that resolves with the token when the callback is received.
 */
function startCallbackServer(): { promise: Promise<string>; port: number; stop: () => void } {
  let resolveToken: (token: string) => void;
  let rejectToken: (err: Error) => void;
  const promise = new Promise<string>((resolve, reject) => {
    resolveToken = resolve;
    rejectToken = reject;
  });

  const server = Bun.serve({
    port: 0, // Random available port
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/callback") {
        const token = url.searchParams.get("token");
        if (token) {
          resolveToken!(token);
          return new Response(
            `<!DOCTYPE html><html><body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0a0a0a;color:#e5e5e5;">` +
            `<div style="text-align:center"><h2>Authenticated!</h2><p>You can close this tab and return to your terminal.</p></div></body></html>`,
            { headers: { "Content-Type": "text/html" } },
          );
        }
        return new Response("Missing token", { status: 400 });
      }
      return new Response("Not found", { status: 404 });
    },
  });

  const port = server.port ?? 0;

  return {
    promise,
    port,
    stop: () => {
      try { server.stop(); } catch { /* already stopped */ }
    },
  };
}

/**
 * Try to open a URL in the system browser.
 * Returns true if the browser was opened, false if not possible (headless/SSH).
 */
async function openBrowser(url: string): Promise<boolean> {
  // Check for common indicators of headless environment
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY && process.platform !== "darwin" && process.platform !== "win32") {
    return false;
  }

  const commands: Record<string, string[]> = {
    darwin: ["open", url],
    linux: ["xdg-open", url],
    win32: ["cmd", "/c", "start", url],
  };

  const cmd = commands[process.platform];
  if (!cmd) return false;

  try {
    const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
    await proc.exited;
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}

// -----------------------------------------------------------------------------
// URL helpers
// -----------------------------------------------------------------------------

/**
 * Ensure WebSocket URL ends with /ws path.
 * Remote gateways behind Cloudflare need the /ws path to bypass CF Access
 * (CF Access protects the root but the /ws path is configured as bypass,
 * with device tokens providing the actual auth layer).
 * Localhost URLs are left as-is (no CF Access in the path).
 */
function ensureWsPath(url: string): string {
  if (url.endsWith("/ws") || url.endsWith("/ws/")) return url;
  // Only append for ws:// or wss:// URLs (not relative paths like "/ws")
  if (url.startsWith("ws://") || url.startsWith("wss://")) {
    return url.replace(/\/+$/, "") + "/ws";
  }
  return url;
}

/** Convert ws:// or wss:// URL to http:// or https:// */
function wsUrlToHttp(url: string): string {
  return url.replace(/^ws(s?):\/\//, "http$1://").replace(/\/ws$/, "");
}

/** Check if a URL points to localhost */
function isLocalhostUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1";
  } catch {
    return false;
  }
}
