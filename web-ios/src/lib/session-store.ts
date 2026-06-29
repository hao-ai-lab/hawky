// =============================================================================
// Session store — the Live "bridge session" + a clean, iOS-style session list.
//
// Drives the Hawky → History menu. The gateway's session.list returns every
// persisted session (including transient realtime probe sessions, cron, and
// empty ones); here we filter to real user conversations and sort iOS-style
// (pinned → most recent), with rename / delete / pin actions.
// =============================================================================

import { create } from "zustand";
import { useSocketStore } from "./socket-store";

const ACTIVE_KEY_STORAGE = "hawky-ios-active-session";

export interface SessionEntry {
  key: string;
  id: string;
  displayName?: string | null;
  createdAt: string;
  messageCount: number;
  active?: boolean;
  pinned?: boolean;
  archived?: boolean;
}

function rpc(method: string, params?: unknown) {
  return useSocketStore.getState().rpc(method, params);
}

// The URL carries a clean session id (ChatGPT-style) — the `web:` channel
// prefix is dropped for readability and restored on load. So the key
// `web:ios-mqog8147` appears in the URL as `?session=ios-mqog8147`.
function keyToUrlId(key: string): string {
  return key.startsWith("web:") ? key.slice(4) : key;
}
function urlIdToKey(idOrKey: string): string {
  return idOrKey.includes(":") ? idOrKey : `web:${idOrKey}`;
}

/** The active session is reflected in the URL (?session=…), ChatGPT-style:
 *  the URL wins on load (shareable / reloadable), else localStorage, else default. */
function loadActive(): string {
  try {
    const fromUrl = new URLSearchParams(window.location.search).get("session");
    if (fromUrl && fromUrl.trim()) return urlIdToKey(fromUrl.trim());
  } catch { /* no window */ }
  try { return localStorage.getItem(ACTIVE_KEY_STORAGE) || "web:ios"; } catch { return "web:ios"; }
}

/** Reflect the active session key in the URL without a navigation/reload. */
function syncUrl(key: string): void {
  try {
    const url = new URL(window.location.href);
    url.searchParams.set("session", keyToUrlId(key));
    window.history.replaceState({}, "", url);
  } catch { /* no window */ }
}

/**
 * Convert a session.list `id` to the canonical session key. Session keys use
 * `:` as the channel separator (e.g. `web:ios`); session.list returns ids with
 * `/` (e.g. `web/ios`). Normalize the FIRST `/` to `:`.
 */
export function sessionKeyFromId(id: string): string {
  if (id.includes(":")) return id;
  const slash = id.indexOf("/");
  return slash >= 0 ? `${id.slice(0, slash)}:${id.slice(slash + 1)}` : id;
}

/** A friendly display name from a session key/displayName. */
export function sessionDisplayName(s: SessionEntry): string {
  if (s.displayName && s.displayName.trim()) return s.displayName;
  const k = s.key;
  return k.includes(":") ? k.slice(k.indexOf(":") + 1) : k;
}

// Channels that are NOT user chat conversations — hidden from History.
const HIDDEN_CHANNELS = ["realtime", "cron", "heartbeat", "node", "probe"];

/**
 * Keep only real user conversations:
 *   - drop transient/system channels (realtime:, cron:, heartbeat:, …)
 *   - drop empty (0-message) sessions UNLESS it's the active one
 * Then sort iOS-style: pinned first, then most-recent, then name.
 */
export function cleanSessions(raw: SessionEntry[], activeKey: string): SessionEntry[] {
  const filtered = raw.filter((s) => {
    const channel = s.key.includes(":") ? s.key.slice(0, s.key.indexOf(":")) : s.key;
    if (HIDDEN_CHANNELS.includes(channel)) return false;
    // Hide the per-session "-bridge" backend channels (agent delegation noise).
    if (s.key.endsWith("-bridge")) return false;
    if (s.messageCount <= 0 && s.key !== activeKey) return false;
    return true;
  });
  return filtered.sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    if (a.createdAt !== b.createdAt) return a.createdAt > b.createdAt ? -1 : 1;
    return sessionDisplayName(a).localeCompare(sessionDisplayName(b));
  });
}

interface SessionState {
  activeKey: string;
  sessions: SessionEntry[];
  loading: boolean;
  setActive: (key: string) => void;
  newSession: () => string;
  fetchSessions: () => Promise<void>;
  rename: (key: string, displayName: string) => Promise<void>;
  remove: (key: string) => Promise<void>;
  togglePin: (key: string, pinned: boolean) => Promise<void>;
  /** Auto-title a session from its first user message (ChatGPT-style), once. */
  maybeAutoTitle: (key: string, firstMessage: string) => Promise<void>;
}

export const useSessionStore = create<SessionState>((set, get) => ({
  activeKey: loadActive(),
  sessions: [],
  loading: false,

  setActive: (key) => {
    try { localStorage.setItem(ACTIVE_KEY_STORAGE, key); } catch { /* ignore */ }
    syncUrl(key);
    set({ activeKey: key });
  },

  newSession: () => {
    const key = `web:ios-${Date.now().toString(36)}`;
    get().setActive(key);
    return key;
  },

  fetchSessions: async () => {
    set({ loading: true });
    try {
      const res = (await rpc("session.list", { limit: 60 })) as {
        sessions: Array<{ id: string; createdAt: string; messageCount: number; active?: boolean; displayName?: string | null; pinned?: boolean; archived?: boolean }>;
      };
      const all: SessionEntry[] = (res.sessions ?? []).map((s) => ({ ...s, key: sessionKeyFromId(s.id) }));
      set({ sessions: cleanSessions(all, get().activeKey), loading: false });
    } catch {
      set({ loading: false });
    }
  },

  rename: async (key, displayName) => {
    const name = displayName.trim();
    if (!name) return;
    try { await rpc("session.rename", { sessionKey: key, displayName: name }); } catch { /* ignore */ }
    await get().fetchSessions();
  },

  remove: async (key) => {
    try { await rpc("session.delete", { sessionKey: key }); } catch { /* ignore */ }
    // If we deleted the active session, fall back to a fresh one.
    if (get().activeKey === key) get().newSession();
    await get().fetchSessions();
  },

  togglePin: async (key, pinned) => {
    try { await rpc(pinned ? "session.pin" : "session.unpin", { sessionKey: key }); } catch { /* ignore */ }
    await get().fetchSessions();
  },

  maybeAutoTitle: async (key, firstMessage) => {
    if (autoTitled.has(key)) return;
    autoTitled.add(key);
    const existing = get().sessions.find((s) => s.key === key);
    // Only title if it doesn't already have a custom name.
    if (existing?.displayName && existing.displayName.trim()) return;
    const title = firstMessage.trim().replace(/\s+/g, " ").slice(0, 50);
    if (!title) return;
    try { await rpc("session.rename", { sessionKey: key, displayName: title }); } catch { /* ignore */ }
    await get().fetchSessions();
  },
}));

// Sessions we've already attempted to auto-title (once per page load).
const autoTitled = new Set<string>();
