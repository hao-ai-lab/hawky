// =============================================================================
// Socket Store (Zustand) — web-ios
//
// Owns the gateway WebSocket connection + an `rpc()` helper + event
// subscription. Mirrors the proven web/ socket-store: two-step device-token
// acquisition (fetch /auth/device?mode=json, else redirect to mode=web), stale-
// client guards, and a single reconnecting WebSocketClient instance.
// =============================================================================

import { create } from "zustand";
import { WebSocketClient, type ConnectionStatus } from "./ws-client";
import type { EventFrame } from "@hawky/protocol";
import { getOrMintClientId } from "./client-id";

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
  } catch { /* localStorage unavailable */ }
  return undefined;
}

function storeDeviceToken(token: string): void {
  try {
    for (const key of DEVICE_TOKEN_KEYS) localStorage.setItem(key, token);
  } catch { /* localStorage unavailable */ }
}

export function clearStoredDeviceTokens(): void {
  try {
    for (const key of DEVICE_TOKEN_KEYS) localStorage.removeItem(key);
  } catch { /* localStorage unavailable */ }
}

interface SocketState {
  status: ConnectionStatus;
  error: string | null;
  client: WebSocketClient | null;
  rpc: (method: string, params?: unknown) => Promise<unknown>;
  eventListeners: Set<(event: EventFrame) => void>;
  connect: (options: { url: string; sessionKey: string; token?: string }) => Promise<void>;
  disconnect: () => void;
  subscribe: (listener: (event: EventFrame) => void) => () => void;
}

export const useSocketStore = create<SocketState>((set, get) => ({
  status: "disconnected",
  error: null,
  client: null,
  eventListeners: new Set(),

  rpc: async (method, params) => {
    const client = get().client;
    if (!client) throw new Error("Not connected");
    return client.rpc(method, params);
  },

  connect: async (options) => {
    const existing = get().client;
    if (existing) existing.close();

    let currentClient: WebSocketClient | null = null;

    async function acquireToken(): Promise<string | null> {
      try {
        const res = await fetch("/auth/device?mode=json&device=web-ios");
        const ct = res.headers.get("content-type") ?? "";
        if (res.ok && ct.includes("application/json")) {
          const body = (await res.json()) as { ok: boolean; token?: string };
          if (body.ok && body.token) {
            storeDeviceToken(body.token);
            return body.token;
          }
        }
      } catch { /* fetch failed (CF Access likely blocking) */ }

      window.location.href =
        "/auth/device?mode=web&device=web-ios&return_url=" +
        encodeURIComponent(window.location.pathname + window.location.search);
      return null; // page navigating away
    }

    const initialToken = options.token ?? getStoredDeviceToken() ?? (await acquireToken());
    if (!initialToken) {
      set({ status: "disconnected" });
      return;
    }

    const client = new WebSocketClient({
      url: options.url,
      sessionKey: options.sessionKey,
      token: initialToken,
      clientId: getOrMintClientId(),
      platform: "web-ios",
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
      if (msg.includes("Invalid or missing device token")) {
        const token = await acquireToken();
        if (token) {
          client.close();
          const authed = new WebSocketClient({ ...client.getOptions(), token, onAuthFailed: acquireToken });
          currentClient = authed;
          set({ client: authed, error: null });
          try { await authed.connect(); return; } catch { /* fall through */ }
        }
      }
      set({ error: msg, status: "disconnected" });
      throw err;
    }
  },

  disconnect: () => {
    get().client?.close();
    clearStoredDeviceTokens();
    set({ client: null, status: "disconnected", error: null });
  },

  subscribe: (listener) => {
    get().eventListeners.add(listener);
    return () => { get().eventListeners.delete(listener); };
  },
}));
