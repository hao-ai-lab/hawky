// =============================================================================
// WebSocket Client
//
// Plain TypeScript class (not a React hook) that manages the WebSocket
// connection to the Hawky gateway. Lives outside React lifecycle to
// avoid stale closures and re-render issues.
//
// Features:
//   - Connect with hello handshake (same protocol as TUI gateway-client)
//   - RPC (request/response with timeout)
//   - Auto-reconnect with exponential backoff + jitter
//   - Visibility API: reconnect when app returns to foreground
//   - Close code awareness (1012 = service restart → reconnect)
//   - Event dispatch to callback (Zustand store wires this)
//
// Pattern: Hawky gateway-client.ts adapted for browser WebSocket API.
// =============================================================================

import type {
  RequestFrame,
  ResponseFrame,
  EventFrame,
  ConnectParams,
  HelloPayload,
} from "@hawky/protocol";

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 15_000;
const BACKOFF_MULTIPLIER = 1.5;
const JITTER_FACTOR = 0.2; // ±20% randomization
const REQUEST_TIMEOUT_MS = 30_000;
// chat.send has no timeout — turns can run indefinitely
const NO_TIMEOUT_METHODS = new Set(["chat.send"]);
const HANDSHAKE_TIMEOUT_MS = 5_000;

// Close codes
const CLOSE_NORMAL = 1000;

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export type ConnectionStatus = "connecting" | "connected" | "disconnected" | "reconnecting";

export interface WebSocketClientOptions {
  /** Gateway WebSocket URL (e.g., "ws://localhost:4242" or relative "/ws") */
  url: string;
  /** Session key to bind to on connect */
  sessionKey: string;
  /** Client platform identifier */
  platform?: string;
  /** Auth token (if gateway requires it) */
  token?: string;
  /**
   * Stable per-client identity. The gateway uses this to exclude
   * every connection of the acting client from broadcasts of the
   * client's own actions (`user.message`, `session.rewound`). The
   * caller mints it once and reuses it across reconnects, so a PWA
   * service worker / page-tab pair, or a transient reconnect that
   * overlaps the old socket, are recognized as the same client. See
   * the gateway's `ConnectParams.clientId` for the protocol contract.
   */
  clientId?: string;
  /** Called when connection status changes */
  onStatusChange?: (status: ConnectionStatus) => void;
  /** Called when an event frame is received from the gateway */
  onEvent?: (frame: EventFrame) => void;
  /** Called on connection error */
  onError?: (error: string) => void;
  /** Called when token is rejected (1008). Should return a new token or null. */
  onAuthFailed?: () => Promise<string | null>;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

// -----------------------------------------------------------------------------
// WebSocket Client
// -----------------------------------------------------------------------------

export class WebSocketClient {
  private ws: WebSocket | null = null;
  private options: WebSocketClientOptions;
  private pendingRequests = new Map<string, PendingRequest>();
  private nextReqId = 1;
  private backoffMs = INITIAL_BACKOFF_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private _connected = false;
  private _status: ConnectionStatus = "disconnected";
  private visibilityHandler: (() => void) | null = null;
  private connecting = false;

  constructor(options: WebSocketClientOptions) {
    this.options = options;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  get connected(): boolean {
    return this._connected;
  }

  get status(): ConnectionStatus {
    return this._status;
  }

  /** Get the connection options (for creating a new client with modified options). */
  getOptions(): WebSocketClientOptions {
    return { ...this.options };
  }

  /**
   * Connect to the gateway. Returns the hello payload on success.
   *
   * Note: iOS Safari silently delays/blocks WebSocket TCP connections to
   * local network IP addresses (ws://192.168.x.x). This is a known iOS 17+
   * WebKit behavior. For iPhone access, the gateway must be behind an HTTPS
   * reverse proxy with a real domain (e.g., Cloudflare Tunnel, nginx + TLS).
   * See: https://bugs.webkit.org/show_bug.cgi?id=298616
   */
  async connect(): Promise<HelloPayload> {
    if (this.connecting) {
      return Promise.reject(new Error("Connection already in progress"));
    }
    this.connecting = true;
    this.closed = false;
    this.setStatus("connecting");

    return new Promise<HelloPayload>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.connecting = false;
        reject(new Error("Connection timeout"));
        this.ws?.close();
      }, HANDSHAKE_TIMEOUT_MS);

      const wsUrl = this.resolveUrl(this.options.url);

      try {
        this.ws = new WebSocket(wsUrl);
      } catch (err) {
        clearTimeout(timer);
        this.connecting = false;
        reject(new Error(`Failed to connect: ${err instanceof Error ? err.message : String(err)}`));
        return;
      }

      this.ws.addEventListener("open", () => {
        const params: ConnectParams = {
          version: "0.1.0",
          platform: this.options.platform ?? "web",
          sessionKey: this.options.sessionKey,
          ...(this.options.token ? { token: this.options.token } : {}),
          ...(this.options.clientId ? { clientId: this.options.clientId } : {}),
        };

        this.rpc("connect", params)
          .then((payload) => {
            clearTimeout(timer);
            this.connecting = false;
            this._connected = true;
            this.backoffMs = INITIAL_BACKOFF_MS;
            this.setStatus("connected");
            this.installVisibilityHandler();
            resolve(payload as HelloPayload);
          })
          .catch((err) => {
            clearTimeout(timer);
            this.connecting = false;
            reject(err);
          });
      });

      this.ws.addEventListener("message", (event) => {
        this.handleMessage(event.data as string);
      });

      this.ws.addEventListener("close", (event) => {
        const wasConnected = this._connected;
        this._connected = false;
        this.connecting = false;

        for (const [, pending] of this.pendingRequests) {
          if (pending.timer) clearTimeout(pending.timer);
          pending.reject(new Error("Connection closed"));
        }
        this.pendingRequests.clear();

        // 1008 = token rejected. Trigger reauth callback.
        if (!this.closed && event.code === 1008 && this.options.onAuthFailed) {
          this.setStatus("disconnected");
          this.doReauth();
          return;
        }

        if (!this.closed && event.code !== CLOSE_NORMAL) {
          this.setStatus("disconnected");
          if (wasConnected) {
            this.options.onError?.("Gateway disconnected");
          }
          this.scheduleReconnect();
        } else if (wasConnected && !this.closed) {
          this.setStatus("disconnected");
        }
      });

      this.ws.addEventListener("error", () => {
        // Error events are followed by close events — handle reconnect there
      });
    });
  }

  /**
   * Send an RPC request and wait for the response.
   */
  rpc(method: string, params?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("Not connected"));
        return;
      }

      const id = `req-${this.nextReqId++}`;
      const timer = NO_TIMEOUT_METHODS.has(method) ? null : setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`RPC timeout: ${method}`));
      }, REQUEST_TIMEOUT_MS);

      this.pendingRequests.set(id, { resolve, reject, timer });

      const frame: RequestFrame = { type: "req", id, method, params };
      this.ws.send(JSON.stringify(frame));
    });
  }

  /**
   * Close the connection and stop reconnecting.
   */
  close(): void {
    this.closed = true;
    this.removeVisibilityHandler();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      this.ws.close(CLOSE_NORMAL);
      this.ws = null;
    }

    this._connected = false;
    this.setStatus("disconnected");
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
      this.options.onEvent?.(data as unknown as EventFrame);
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

  // ---------------------------------------------------------------------------
  // Internal: reconnection
  // ---------------------------------------------------------------------------

  private async doReauth(): Promise<void> {
    if (!this.options.onAuthFailed) { this.scheduleReconnect(); return; }
    try {
      const newToken = await this.options.onAuthFailed();
      if (newToken) {
        this.options.token = newToken;
        this.backoffMs = INITIAL_BACKOFF_MS;
        await this.connect();
        return;
      }
    } catch { /* fall through */ }
    this.options.token = undefined;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;

    this.setStatus("reconnecting");

    const jitter = 1 + (Math.random() * 2 - 1) * JITTER_FACTOR;
    const delay = Math.min(this.backoffMs * jitter, MAX_BACKOFF_MS);

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connect();
      } catch {
        this.backoffMs = Math.min(this.backoffMs * BACKOFF_MULTIPLIER, MAX_BACKOFF_MS);
        if (!this.closed) {
          this.scheduleReconnect();
        }
      }
    }, delay);
  }

  // ---------------------------------------------------------------------------
  // Internal: visibility change (reconnect on foreground resume)
  //
  // Installed ONLY after first successful connection. This avoids interfering
  // with the initial connection attempt during page load.
  // ---------------------------------------------------------------------------

  private installVisibilityHandler(): void {
    if (this.visibilityHandler) return;

    this.visibilityHandler = () => {
      if (document.visibilityState === "visible" && !this._connected && !this.closed && !this.connecting) {
        // App returned to foreground and we're not connected — reconnect
        // immediately instead of waiting for the backoff timer.
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
        this.backoffMs = INITIAL_BACKOFF_MS;
        void this.connect().catch(() => {
          if (!this.closed) {
            this.scheduleReconnect();
          }
        });
      }
    };

    document.addEventListener("visibilitychange", this.visibilityHandler);
  }

  private removeVisibilityHandler(): void {
    if (this.visibilityHandler) {
      document.removeEventListener("visibilitychange", this.visibilityHandler);
      this.visibilityHandler = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Internal: helpers
  // ---------------------------------------------------------------------------

  private setStatus(status: ConnectionStatus): void {
    this._status = status;
    this.options.onStatusChange?.(status);
  }

  /**
   * Resolve a WebSocket URL. Handles relative paths ("/ws") by deriving
   * from the current page location (works in both dev proxy and production).
   */
  private resolveUrl(url: string): string {
    if (url.startsWith("ws://") || url.startsWith("wss://")) {
      return url;
    }
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${window.location.host}${url}`;
  }
}
