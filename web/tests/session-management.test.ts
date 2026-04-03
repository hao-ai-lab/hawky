// =============================================================================
// Tests: Session Management Store Actions
//
// Covers: renameSession, archiveSession, deleteSession, pinSession, unpinSession
// Tests the store actions, RPC calls, and state updates.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { useSessionStore, type SessionInfo } from "../src/store/session-store";
import { useSocketStore } from "../src/store/socket-store";

// =============================================================================
// Helpers
// =============================================================================

let mockRpc: ReturnType<typeof vi.fn>;
let rpcCalls: Array<{ method: string; params: unknown }> = [];

function setupMockRpc() {
  rpcCalls = [];
  mockRpc = vi.fn(async (method: string, params?: unknown) => {
    rpcCalls.push({ method, params });
    // session.list return for fetchSessions re-sort
    if (method === "session.list") {
      return { sessions: useSessionStore.getState().sessions.map((s) => ({
        id: s.id, createdAt: s.createdAt, messageCount: s.messageCount,
        active: s.active, displayName: s.displayName, pinned: s.pinned, archived: s.archived,
      }))};
    }
    return { ok: true };
  });

  useSocketStore.setState({
    status: "connected",
    error: null,
    client: null,
    eventListeners: new Set(),
    rpc: mockRpc as any,
    connect: vi.fn() as any,
    disconnect: vi.fn(),
    subscribe: vi.fn(() => () => {}),
  });

  return mockRpc;
}

function makeSession(overrides: Partial<SessionInfo> & { key: string }): SessionInfo {
  return {
    id: `gw-${overrides.key.replace(":", "-")}`,
    createdAt: "",
    messageCount: 0,
    active: false,
    isSystem: false,
    displayName: null,
    pinned: false,
    archived: false,
    ...overrides,
  };
}

beforeEach(() => {
  rpcCalls = [];
  useSessionStore.setState({
    sessions: [
      makeSession({ key: "web:general", messageCount: 5, active: true }),
      makeSession({ key: "web:testing", messageCount: 2 }),
      makeSession({ key: "heartbeat:main", isSystem: true, messageCount: 10, active: true }),
    ],
    activeKey: "web:general",
    messages: [],
    loading: false,
  });
  setupMockRpc();
});

// =============================================================================
// renameSession
// =============================================================================

describe("renameSession", () => {
  it("sends newKey for user sessions (deep rename)", async () => {
    await useSessionStore.getState().renameSession("web:general", "My Project");
    expect(rpcCalls.some((c) => c.method === "session.rename")).toBe(true);
    const call = rpcCalls.find((c) => c.method === "session.rename");
    expect(call?.params).toEqual({ sessionKey: "web:general", newKey: "web:My Project" });
  });

  it("sends displayName for heartbeat sessions (label-only)", async () => {
    await useSessionStore.getState().renameSession("heartbeat:main", "Pulse");
    const call = rpcCalls.find((c) => c.method === "session.rename");
    expect(call?.params).toEqual({ sessionKey: "heartbeat:main", displayName: "Pulse" });
  });

  it("updates displayName locally for system sessions", async () => {
    // Deep rename (user sessions) is reconciled via the session.renamed
    // broadcast, which isn't exercised here. Singleton sessions keep the
    // old optimistic-update path.
    await useSessionStore.getState().renameSession("heartbeat:main", "Renamed");
    const session = useSessionStore.getState().sessions.find((s) => s.key === "heartbeat:main");
    expect(session?.displayName).toBe("Renamed");
  });

  it("empty name clears displayName via the label path", async () => {
    await useSessionStore.getState().renameSession("web:general", "");
    const call = rpcCalls.find((c) => c.method === "session.rename");
    expect(call?.params).toEqual({ sessionKey: "web:general", displayName: "" });
    const session = useSessionStore.getState().sessions.find((s) => s.key === "web:general");
    expect(session?.displayName).toBeNull();
  });

  it("does not affect other sessions", async () => {
    await useSessionStore.getState().renameSession("heartbeat:main", "Changed");
    const testing = useSessionStore.getState().sessions.find((s) => s.key === "web:testing");
    expect(testing?.displayName).toBeNull();
  });
});

// =============================================================================
// archiveSession
// =============================================================================

describe("archiveSession", () => {
  it("calls session.archive RPC", async () => {
    await useSessionStore.getState().archiveSession("web:testing");
    expect(rpcCalls.some((c) => c.method === "session.archive")).toBe(true);
    const call = rpcCalls.find((c) => c.method === "session.archive");
    expect(call?.params).toEqual({ sessionKey: "web:testing" });
  });

  it("removes session from visible list", async () => {
    await useSessionStore.getState().archiveSession("web:testing");
    const sessions = useSessionStore.getState().sessions;
    expect(sessions.find((s) => s.key === "web:testing")).toBeUndefined();
  });

  it("switches to another session when archiving active session", async () => {
    // Mock session.resolve and session.history for switchSession
    mockRpc.mockImplementation(async (method: string, params?: any) => {
      rpcCalls.push({ method, params });
      if (method === "session.archive") return { ok: true };
      if (method === "session.resolve") return { sessionKey: params?.sessionKey, sessionId: "test", messageCount: 0 };
      if (method === "session.history") return { messages: [], sessionKey: params?.sessionKey, total: 0 };
      if (method === "session.list") return { sessions: [] };
      return { ok: true };
    });

    await useSessionStore.getState().archiveSession("web:general");
    // Should have attempted to switch session (web clients use session.history, not session.resolve)
    const switchCalls = rpcCalls.filter((c) => c.method === "session.history");
    expect(switchCalls.length).toBeGreaterThan(0);
  });
});

// =============================================================================
// deleteSession
// =============================================================================

describe("deleteSession", () => {
  it("calls session.delete RPC", async () => {
    await useSessionStore.getState().deleteSession("web:testing");
    expect(rpcCalls.some((c) => c.method === "session.delete")).toBe(true);
    const call = rpcCalls.find((c) => c.method === "session.delete");
    expect(call?.params).toEqual({ sessionKey: "web:testing" });
  });

  it("removes session from list", async () => {
    await useSessionStore.getState().deleteSession("web:testing");
    const sessions = useSessionStore.getState().sessions;
    expect(sessions.find((s) => s.key === "web:testing")).toBeUndefined();
  });

  it("switches away when deleting active session", async () => {
    mockRpc.mockImplementation(async (method: string, params?: any) => {
      rpcCalls.push({ method, params });
      if (method === "session.delete") return { ok: true, deleted: true };
      if (method === "session.resolve") return { sessionKey: params?.sessionKey, sessionId: "test", messageCount: 0 };
      if (method === "session.history") return { messages: [], sessionKey: params?.sessionKey, total: 0 };
      if (method === "session.list") return { sessions: [] };
      return { ok: true };
    });

    await useSessionStore.getState().deleteSession("web:general");
    // Web clients use session.history (not session.resolve) during switchSession
    const switchCalls = rpcCalls.filter((c) => c.method === "session.history");
    expect(switchCalls.length).toBeGreaterThan(0);
  });
});

// =============================================================================
// pinSession / unpinSession
// =============================================================================

describe("pinSession", () => {
  it("calls session.pin RPC", async () => {
    await useSessionStore.getState().pinSession("web:general");
    expect(rpcCalls.some((c) => c.method === "session.pin")).toBe(true);
  });

  it("sets pinned=true in session list", async () => {
    await useSessionStore.getState().pinSession("web:general");
    const session = useSessionStore.getState().sessions.find((s) => s.key === "web:general");
    expect(session?.pinned).toBe(true);
  });

  it("triggers fetchSessions to re-sort", async () => {
    await useSessionStore.getState().pinSession("web:general");
    expect(rpcCalls.some((c) => c.method === "session.list")).toBe(true);
  });
});

describe("unpinSession", () => {
  it("calls session.unpin RPC", async () => {
    await useSessionStore.getState().unpinSession("web:general");
    expect(rpcCalls.some((c) => c.method === "session.unpin")).toBe(true);
  });

  it("sets pinned=false in session list", async () => {
    // Start pinned
    useSessionStore.setState((s) => ({
      sessions: s.sessions.map((ses) =>
        ses.key === "web:general" ? { ...ses, pinned: true } : ses,
      ),
    }));
    await useSessionStore.getState().unpinSession("web:general");
    const session = useSessionStore.getState().sessions.find((s) => s.key === "web:general");
    expect(session?.pinned).toBe(false);
  });
});

// =============================================================================
// fetchSessions sort order with pinned
// =============================================================================

describe("fetchSessions sort order", () => {
  it("sorts pinned sessions before unpinned (within non-system)", async () => {
    mockRpc.mockImplementation(async (method: string) => {
      if (method === "session.list") {
        return {
          sessions: [
            { id: "gw-web-general", createdAt: "", messageCount: 5, active: true, displayName: null, pinned: false, archived: false },
            { id: "gw-web-pinned", createdAt: "", messageCount: 1, active: false, displayName: "Pinned One", pinned: true, archived: false },
          ],
        };
      }
      return {};
    });

    await useSessionStore.getState().fetchSessions();
    const sessions = useSessionStore.getState().sessions;
    expect(sessions[0].key).toBe("web:pinned");
    expect(sessions[0].pinned).toBe(true);
  });

  it("includes displayName from server in session list", async () => {
    mockRpc.mockImplementation(async (method: string) => {
      if (method === "session.list") {
        return {
          sessions: [
            { id: "gw-web-general", createdAt: "", messageCount: 5, active: true, displayName: "My Project", pinned: false, archived: false },
          ],
        };
      }
      return {};
    });

    await useSessionStore.getState().fetchSessions();
    const session = useSessionStore.getState().sessions.find((s) => s.key === "web:general");
    expect(session?.displayName).toBe("My Project");
  });
});
