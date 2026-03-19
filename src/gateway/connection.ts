// =============================================================================
// Gateway Connection
//
// Represents a single WebSocket client connection. Manages handshake state,
// session binding, and message sending.
//
// Pattern: a proven GatewayWsClient, simplified.
// =============================================================================

import type { ServerWebSocket } from "bun";
import { createSubsystemLogger } from "../logging/index.js";
import type { ResponseFrame, EventFrame } from "./protocol.js";
import { serializeFrame } from "./protocol.js";

const log = createSubsystemLogger("gateway/conn");

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/** Data attached to each Bun WebSocket via ws.data */
export interface WSData {
  connId: string;
}

// -----------------------------------------------------------------------------
// Connection class
// -----------------------------------------------------------------------------

let nextConnId = 1;

export class GatewayConnection {
  readonly connId: string;
  readonly socket: ServerWebSocket<WSData>;
  readonly connectedAt: number;
  readonly remoteAddress: string;

  // Client info (set during handshake)
  clientVersion: string = "";
  clientPlatform: string = "";
  workingDirectory: string = "";
  /**
   * Stable per-client identity. Defaults to this connection's own connId
   * (i.e. legacy 1-conn-per-client behavior) until the handshake supplies
   * a real clientId. See `ConnectParams.clientId` for the rationale —
   * broadcast exclusion uses this to skip every conn that belongs to the
   * acting client, not just the originating socket.
   */
  clientId: string = "";
  /** Connection role: "client" for UI connections, "node" for node hosts. */
  clientRole: "client" | "node" = "client";
  /** Node host ID (set when clientRole is "node"). */
  nodeId: string | null = null;
  /** Ambient mode for this connection (default "quiet"). */
  mode: "quiet" | "ambient" | "directive" = "quiet";
  /** True when the client explicitly provided a mode at handshake time. */
  modeExplicitlySet = false;

  // State
  authenticated = false;
  sessionKey: string | null = null;

  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(socket: ServerWebSocket<WSData>, remoteAddress: string) {
    this.connId = `conn-${nextConnId++}`;
    // Default clientId to connId so legacy clients (no clientId in handshake)
    // and pre-handshake state behave as before — each conn is its own
    // "client" for broadcast exclusion. Overwritten in completeHandshake.
    this.clientId = this.connId;
    this.socket = socket;
    this.connectedAt = Date.now();
    this.remoteAddress = remoteAddress;

    // Set connId on socket data for lookup
    socket.data.connId = this.connId;
  }

  // ---------------------------------------------------------------------------
  // Handshake
  // ---------------------------------------------------------------------------

  /**
   * Start the handshake timer. If no valid connect frame is received
   * within timeoutMs, the connection is closed.
   */
  startHandshakeTimer(timeoutMs: number): void {
    this.handshakeTimer = setTimeout(() => {
      if (!this.authenticated) {
        log.warn("handshake timeout", { connId: this.connId });
        this.close(1008, "handshake timeout");
      }
    }, timeoutMs);
  }

  /** Clear handshake timer (called after successful connect). */
  clearHandshakeTimer(): void {
    if (this.handshakeTimer !== null) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
  }

  /**
   * Complete the handshake.
   */
  completeHandshake(
    clientVersion: string,
    clientPlatform: string,
    workingDirectory?: string,
    role?: "client" | "node",
    nodeId?: string,
    clientId?: string,
    mode?: "quiet" | "ambient" | "directive",
  ): void {
    this.authenticated = true;
    this.clientVersion = clientVersion;
    this.clientPlatform = clientPlatform;
    this.workingDirectory = workingDirectory ?? "";
    this.clientRole = role ?? "client";
    this.nodeId = nodeId ?? null;
    // Trim and validate clientId — empty / whitespace-only strings keep the
    // connId fallback so a misconfigured client still gets correct
    // exclusion within its own one socket.
    const trimmed = (clientId ?? "").trim();
    if (trimmed.length > 0) this.clientId = trimmed;
    if (mode === "ambient" || mode === "directive" || mode === "quiet") {
      this.mode = mode;
      this.modeExplicitlySet = true;
    }
    // else keep default "quiet" (modeExplicitlySet stays false)
    this.clearHandshakeTimer();
  }

  // ---------------------------------------------------------------------------
  // Session binding
  // ---------------------------------------------------------------------------

  /** Bind this connection to a session (receives events for that session). */
  bindSession(sessionKey: string): void {
    this.sessionKey = sessionKey;
  }

  /** Unbind from current session. */
  unbindSession(): void {
    this.sessionKey = null;
  }

  // ---------------------------------------------------------------------------
  // Sending
  // ---------------------------------------------------------------------------

  /** Check if connection is localhost (trusted, no auth needed). */
  isLocalhost(): boolean {
    return (
      this.remoteAddress === "127.0.0.1" ||
      this.remoteAddress === "::1" ||
      this.remoteAddress === "localhost" ||
      this.remoteAddress === "::ffff:127.0.0.1"
    );
  }

  /** Send a response frame to this client. */
  sendResponse(frame: ResponseFrame): void {
    try {
      this.socket.send(serializeFrame(frame));
    } catch {
      // Send failure — connection likely closed
    }
  }

  /**
   * Send an event frame to this client.
   * Returns true if sent successfully, false if backpressure or closed.
   *
   * Bun's ws.send() contract:
   *   >0  = bytes written, success
   *    0  = socket closed (no FIN received yet, but writes rejected)
   *   -1  = backpressure (send buffer full, transient)
   *
   * On 0 we close the socket ourselves so the `close` handler fires and
   * prunes the zombie from the connections map. On -1 we keep the conn —
   * backpressure is recoverable once the client drains.
   */
  sendEvent(frame: EventFrame): boolean {
    try {
      const result = this.socket.send(serializeFrame(frame));
      if (typeof result !== "number") return true;
      if (result > 0) return true;
      if (result === 0) {
        // 1011 = server-detected abnormal condition. RFC 6455 forbids 1006
        // (reserved) from being set on a close frame — runtimes that
        // enforce that throw, which would leave the zombie in place.
        try { this.socket.close(1011, "send returned 0"); } catch {}
      }
      return false;
    } catch {
      return false;
    }
  }

  /** Close the WebSocket connection. */
  close(code = 1000, reason = ""): void {
    this.clearHandshakeTimer();
    try {
      this.socket.close(code, reason);
    } catch {
      // Already closed
    }
  }
}

/**
 * Reset the connection ID counter. For testing only.
 */
export function resetConnectionCounter(): void {
  nextConnId = 1;
}
