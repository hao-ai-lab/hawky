// =============================================================================
// Socket Store (Zustand)
//
// Global state for the WebSocket connection. The WebSocketClient class
// dispatches state updates here. React components subscribe to slices
// via selectors — only affected components re-render.
//
// Pattern: Zustand + external WebSocket (consensus best practice 2025).
// =============================================================================

import { create } from "zustand";
import { WebSocketClient, type ConnectionStatus } from "../lib/ws-client";
import type { EventFrame } from "@hawky/protocol";
import { getOrMintClientId } from "../lib/client-id";

const DEVICE_TOKEN_KEYS = [
  "hawky_device_token",
  "hawky-device-token",
  "hawky-auth-token",
  "gateway-token",
] as const;

export function getStoredDeviceToken(): string | undefined {
  try {
    for (const key of DEVICE_TOKEN_KEYS) {
      const token = localStorage.getItem(key);
      if (token) return token;
    }
  } catch { /* localStorage may be unavailable */ }
  return undefined;
}

function storeDeviceToken(token: string): void {
  try {
    for (const key of DEVICE_TOKEN_KEYS) localStorage.setItem(key, token);
  } catch { /* localStorage may be unavailable */ }
}

// -----------------------------------------------------------------------------
// Store types
// -----------------------------------------------------------------------------

interface SocketState {
  /** Current connection status */
  status: ConnectionStatus;
  /** Error message (if any) */
  error: string | null;
  /** The WebSocket client instance (singleton) */
  client: WebSocketClient | null;
  /** RPC function — call gateway methods */
  rpc: (method: string, params?: unknown) => Promise<unknown>;
  /** Event listeners — components register to receive specific events */
  eventListeners: Set<(event: EventFrame) => void>;

  // Actions
  /** Initialize and connect to the gateway */
  connect: (options: {
    url: string;
    sessionKey: string;
    token?: string;
  }) => Promise<void>;
  /** Disconnect from the gateway */
  disconnect: () => void;
  /** Subscribe to gateway events (returns unsubscribe function) */
  subscribe: (listener: (event: EventFrame) => void) => () => void;
}

// -----------------------------------------------------------------------------
// Store
// -----------------------------------------------------------------------------

export const useSocketStore = create<SocketState>((set, get) => ({
  status: "disconnected",
  error: null,
  client: null,
  eventListeners: new Set(),

  rpc: async (method: string, params?: unknown) => {
    const client = get().client;
    if (!client) throw new Error("Not connected");
    return client.rpc(method, params);
  },

  connect: async (options) => {
    // Don't create duplicate connections
    const existing = get().client;
    if (existing) {
      existing.close();
    }

    // Capture a reference to this client so stale callbacks from a
    // superseded client (after HMR or reconnect-with-new-options) are ignored.
    let currentClient: WebSocketClient | null = null;

    // Acquire a device token. Two-step fallback:
    // 1. Try fetch("/auth/device?mode=json") — works if CF Access cookie is valid
    // 2. If fetch fails (CF Access blocking) — redirect the whole page to
    //    /auth/device?mode=web which triggers CF login, stores token in
    //    localStorage, and redirects back to the app.
    async function acquireToken(): Promise<string | null> {
      try {
        const res = await fetch("/auth/device?mode=json&device=web-browser");
        const ct = res.headers.get("content-type") ?? "";
        if (res.ok && ct.includes("application/json")) {
          const body = await res.json() as { ok: boolean; token?: string };
          if (body.ok && body.token) {
            storeDeviceToken(body.token);
            return body.token;
          }
        }
      } catch { /* fetch failed */ }

      // JSON fetch didn't work — CF Access is likely blocking it.
      // Redirect the page to trigger CF login → token stored → back to app.
      window.location.href = "/auth/device?mode=web&device=web-browser&return_url=" +
        encodeURIComponent(window.location.pathname + window.location.search);
      return null; // page is navigating away
    }

    const initialToken = options.token ?? getStoredDeviceToken() ?? await acquireToken();
    if (!initialToken) {
      set({ status: "disconnected" });
      return;
    }

    const client = new WebSocketClient({
      url: options.url,
      sessionKey: options.sessionKey,
      token: initialToken,
      clientId: getOrMintClientId(),
      platform: "web",
      onStatusChange: (status) => {
        if (get().client !== currentClient) return;
        set({ status });
      },
      onEvent: (event) => {
        if (get().client !== currentClient) return;
        for (const listener of get().eventListeners) {
          try { listener(event); } catch { /* non-fatal */ }
        }
      },
      onError: (error) => {
        if (get().client !== currentClient) return;
        set({ error });
      },
      onAuthFailed: acquireToken,
    });

    currentClient = client;

    set({ client, error: null });

    try {
      await client.connect();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);

      // If unauthorized on initial connect, try to acquire a token and retry once.
      // Only match the explicit auth rejection message — generic "Connection closed"
      // from transient network issues should use normal reconnect, not forced reauth.
      if (msg.includes("Invalid or missing device token")) {
        const token = await acquireToken();
        if (token) {
          client.close();
          const authedClient = new WebSocketClient({
            ...client.getOptions(),
            token,
            onAuthFailed: acquireToken,
          });
          currentClient = authedClient;
          set({ client: authedClient, error: null });
          try {
            await authedClient.connect();
            return;
          } catch { /* fall through */ }
        }
      }

      set({
        error: msg,
        status: "disconnected",
      });
      throw err;
    }
  },

  disconnect: () => {
    const client = get().client;
    if (client) {
      client.close();
    }
    set({ client: null, status: "disconnected", error: null });
  },

  subscribe: (listener) => {
    get().eventListeners.add(listener);
    return () => {
      get().eventListeners.delete(listener);
    };
  },
}));
