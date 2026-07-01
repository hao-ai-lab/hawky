// =============================================================================
// Tests: Session Store
//
// Unit tests for session list fetching, switching, and channel creation.
// Mocks the socket store's rpc function.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { useSessionStore, synthesizeMetadataFromInput, buildFullInput, type TaskSummary } from "../src/store/session-store";
import { useSocketStore } from "../src/store/socket-store";

// Mock rpc function
let mockRpcResponses: Map<string, unknown> = new Map();

async function waitForAssertion(assertion: () => void, timeoutMs = 1000): Promise<void> {
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < timeoutMs) {
    try {
      assertion();
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  if (lastError) throw lastError;
  assertion();
}

const mockLocalStorageData: Record<string, string> = {};
const mockLocalStorage = {
  getItem: (key: string) => mockLocalStorageData[key] ?? null,
  setItem: (key: string, value: string) => { mockLocalStorageData[key] = value; },
  removeItem: (key: string) => { delete mockLocalStorageData[key]; },
  clear: () => {
    for (const key of Object.keys(mockLocalStorageData)) delete mockLocalStorageData[key];
  },
};

function resetMockLocalStorage(): void {
  mockLocalStorage.clear();
  Object.defineProperty(globalThis, "localStorage", {
    value: mockLocalStorage,
    configurable: true,
  });
}

function setupMockRpc() {
  const mockRpc = vi.fn(async (method: string, _params?: unknown) => {
    const response = mockRpcResponses.get(method);
    if (response instanceof Error) throw response;
    return response;
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

beforeEach(() => {
  mockRpcResponses = new Map();
  useSessionStore.setState({
    sessions: [],
    activeKey: "web:general",
    messages: [],
    loading: false,
  });
});

// -----------------------------------------------------------------------------
// Fetch sessions
// -----------------------------------------------------------------------------

describe("fetchSessions", () => {
  it("populates sessions from gateway RPC", async () => {
    setupMockRpc();
    mockRpcResponses.set("session.list", {
      sessions: [
        { id: "gw-web-general", createdAt: "2026-04-01", messageCount: 5, active: true },
        { id: "gw-heartbeat-main", createdAt: "2026-04-01", messageCount: 10, active: true },
      ],
    });

    await useSessionStore.getState().fetchSessions();

    const sessions = useSessionStore.getState().sessions;
    expect(sessions.length).toBe(2);
    expect(sessions[0].key).toBe("web:general");
    expect(sessions[0].isSystem).toBe(false);
    expect(sessions[1].key).toBe("heartbeat:main");
    expect(sessions[1].isSystem).toBe(true);
  });

  it("handles empty session list", async () => {
    setupMockRpc();
    mockRpcResponses.set("session.list", { sessions: [] });

    await useSessionStore.getState().fetchSessions();
    expect(useSessionStore.getState().sessions.length).toBe(0);
  });

  it("propagates contextUsagePercent / sessionTokens / sessionCostUSD from backend", async () => {
    setupMockRpc();
    mockRpcResponses.set("session.list", {
      sessions: [
        {
          id: "gw-web-general",
          createdAt: "2026-04-01",
          messageCount: 3,
          active: true,
          contextUsagePercent: 42,
          sessionTokens: { input: 1200, output: 340 },
          sessionCostUSD: 0.015,
        },
        {
          id: "gw-web-empty",
          createdAt: "2026-04-01",
          messageCount: 0,
          active: false,
          // No usage yet → null expected in store
        },
      ],
    });

    await useSessionStore.getState().fetchSessions();

    const sessions = useSessionStore.getState().sessions;
    const general = sessions.find((s) => s.key === "web:general")!;
    expect(general.contextUsagePercent).toBe(42);
    expect(general.sessionTokens).toEqual({ input: 1200, output: 340 });
    expect(general.sessionCostUSD).toBeCloseTo(0.015, 5);

    const empty = sessions.find((s) => s.key === "web:empty")!;
    expect(empty.contextUsagePercent).toBeNull();
    expect(empty.sessionTokens).toBeNull();
    expect(empty.sessionCostUSD).toBeNull();
  });

  it("keeps existing sessions on fetch failure", async () => {
    useSessionStore.setState({
      sessions: [{ id: "gw-web-old", key: "web:old", createdAt: "", messageCount: 1, active: true, isSystem: false }],
    });

    setupMockRpc();
    mockRpcResponses.set("session.list", new Error("Network error"));

    await useSessionStore.getState().fetchSessions();
    expect(useSessionStore.getState().sessions.length).toBe(1);
    expect(useSessionStore.getState().sessions[0].key).toBe("web:old");
  });
});

// -----------------------------------------------------------------------------
// Switch session
// -----------------------------------------------------------------------------

describe("switchSession", () => {
  it("updates activeKey and loads messages", async () => {
    const mockRpc = setupMockRpc();
    mockRpcResponses.set("session.resolve", { sessionKey: "web:code" });
    mockRpcResponses.set("session.history", {
      messages: [
        { role: "user", content: [{ type: "text", text: "Hello" }], timestamp: "2026-04-01T10:00:00Z" },
        { role: "assistant", content: [{ type: "text", text: "Hi!" }], timestamp: "2026-04-01T10:00:01Z" },
      ],
    });

    await useSessionStore.getState().switchSession("web:code");

    expect(useSessionStore.getState().activeKey).toBe("web:code");
    expect(useSessionStore.getState().messages.length).toBe(2);
    expect(useSessionStore.getState().messages[0].content).toBe("Hello");
    expect(useSessionStore.getState().messages[1].content).toBe("Hi!");
    expect(useSessionStore.getState().loading).toBe(false);
  });

  it("extracts document attachments from history (user PDF turn)", async () => {
    // A live session replay via session.history returns the document block
    // in memory (JSONL scrubs it, but fresh sessions don't). Reconstructing
    // must surface the pill metadata so ChatView can render the filename.
    setupMockRpc();
    mockRpcResponses.set("session.resolve", { sessionKey: "web:pdf-hist" });
    mockRpcResponses.set("session.history", {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "(PDF attached)" },
            {
              type: "document",
              title: "notes.pdf",
              source: { type: "base64", media_type: "application/pdf", data: "x".repeat(1024) },
            },
          ],
        },
      ],
    });

    await useSessionStore.getState().switchSession("web:pdf-hist");

    const msgs = useSessionStore.getState().messages;
    expect(msgs.length).toBe(1);
    expect(msgs[0].documents?.length).toBe(1);
    expect(msgs[0].documents?.[0].filename).toBe("notes.pdf");
    expect(msgs[0].documents?.[0].media_type).toBe("application/pdf");
    expect(msgs[0].documents?.[0].sizeBytes).toBeGreaterThan(0);
  });

  it("still shows a PDF turn even when the text is empty", async () => {
    setupMockRpc();
    mockRpcResponses.set("session.resolve", { sessionKey: "web:pdf-only" });
    mockRpcResponses.set("session.history", {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "" },
            {
              type: "document",
              title: "report.pdf",
              source: { type: "base64", media_type: "application/pdf", data: "x".repeat(1024) },
            },
          ],
        },
      ],
    });

    await useSessionStore.getState().switchSession("web:pdf-only");

    const msgs = useSessionStore.getState().messages;
    expect(msgs.length).toBe(1); // the user turn must not disappear
    expect(msgs[0].documents?.[0].filename).toBe("report.pdf");
    expect(msgs[0].content).toBe("(PDF attached)"); // fallback label
  });

  it("assigns a shared batchId to parallel tool_use blocks in history", async () => {
    // When the model emitted multiple tool_use blocks in a single assistant
    // turn, persisted history has no batchId — but the UI must still group
    // them as one parallel step. parseHistoryMessages synthesizes one.
    setupMockRpc();
    mockRpcResponses.set("session.resolve", { sessionKey: "web:hist" });
    mockRpcResponses.set("session.history", {
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "tu_a", name: "read_file", input: { file_path: "a.ts" } },
            { type: "tool_use", id: "tu_b", name: "read_file", input: { file_path: "b.ts" } },
          ],
        },
      ],
    });

    await useSessionStore.getState().switchSession("web:hist");

    const toolMsgs = useSessionStore.getState().messages.filter((m) => m.role === "tool");
    expect(toolMsgs.length).toBe(2);
    expect(toolMsgs[0].tool?.batchId).toBeDefined();
    expect(toolMsgs[1].tool?.batchId).toBe(toolMsgs[0].tool?.batchId);
  });

  it("does NOT batch tool_use blocks separated by assistant text", async () => {
    // Interleaved: tool_use, text, tool_use — this is a sequential narration,
    // not a parallel batch. If we synthesized one batchId, ChatView would
    // hoist the second tool up and reorder the intervening text.
    setupMockRpc();
    mockRpcResponses.set("session.resolve", { sessionKey: "web:hist-interleaved" });
    mockRpcResponses.set("session.history", {
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "tu_a", name: "read_file", input: { file_path: "a.ts" } },
            { type: "text", text: "now let me check the other" },
            { type: "tool_use", id: "tu_b", name: "read_file", input: { file_path: "b.ts" } },
          ],
        },
      ],
    });

    await useSessionStore.getState().switchSession("web:hist-interleaved");

    const toolMsgs = useSessionStore.getState().messages.filter((m) => m.role === "tool");
    expect(toolMsgs.length).toBe(2);
    expect(toolMsgs[0].tool?.batchId).toBeUndefined();
    expect(toolMsgs[1].tool?.batchId).toBeUndefined();
  });

  it("does not assign a batchId to a solitary historical tool_use", async () => {
    setupMockRpc();
    mockRpcResponses.set("session.resolve", { sessionKey: "web:hist-solo" });
    mockRpcResponses.set("session.history", {
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "tu_only", name: "read_file", input: { file_path: "x.ts" } },
          ],
        },
      ],
    });

    await useSessionStore.getState().switchSession("web:hist-solo");

    const toolMsgs = useSessionStore.getState().messages.filter((m) => m.role === "tool");
    expect(toolMsgs.length).toBe(1);
    expect(toolMsgs[0].tool?.batchId).toBeUndefined();
  });

  it("sets loading during switch", async () => {
    setupMockRpc();
    mockRpcResponses.set("session.resolve", { sessionKey: "web:test" });
    mockRpcResponses.set("session.history", { messages: [] });

    // Check loading is set synchronously
    const promise = useSessionStore.getState().switchSession("web:test");
    expect(useSessionStore.getState().loading).toBe(true);

    await promise;
    expect(useSessionStore.getState().loading).toBe(false);
  });

  it("handles switch failure gracefully", async () => {
    setupMockRpc();
    mockRpcResponses.set("session.resolve", new Error("Session error"));

    await useSessionStore.getState().switchSession("web:broken");

    expect(useSessionStore.getState().loading).toBe(false);
    expect(useSessionStore.getState().messages).toEqual([]);
  });

  it("hydrates pendingAskUser from session.currentTurn for a late-joining client", async () => {
    // A 2nd browser tab opened AFTER the agent broadcast `ask_user_request`
    // missed the original event. switchSession must learn about the pending
    // dialog from the server (via session.currentTurn) so the user can still
    // unblock the agent. Without this hydration the new tab shows nothing
    // and the agent is stuck forever.
    setupMockRpc();
    mockRpcResponses.set("session.resolve", { sessionKey: "web:late-ask" });
    mockRpcResponses.set("session.history", { messages: [], hasMore: false });
    mockRpcResponses.set("session.currentTurn", {
      streaming: false,
      text: "",
      busy: true,
      pendingPermission: null,
      pendingAskUser: {
        requestId: "ask-late-1",
        question: "Which option?",
        options: ["one", "two"],
        multi_select: false,
      },
    });

    await useSessionStore.getState().switchSession("web:late-ask");

    const s = useSessionStore.getState();
    expect(s.pendingAskUser).not.toBeNull();
    expect(s.pendingAskUser?.requestId).toBe("ask-late-1");
    expect(s.pendingAskUser?.question).toBe("Which option?");
    expect(s.pendingAskUser?.options).toEqual(["one", "two"]);
  });

  it("clears cached pending dialog when session.currentTurn explicitly returns null (resolved by another client)", async () => {
    // Codex P2: previously hydratedX ?? cachedX would resurrect a stale
    // dialog whenever the server authoritatively reported nothing pending
    // (e.g. another tab already resolved it). Server-fresh null must
    // override the cache; cache only fills the gap when the server
    // doesn't return the new fields at all (legacy gateway / RPC fail).
    setupMockRpc();
    mockRpcResponses.set("session.resolve", { sessionKey: "web:resolved-elsewhere" });
    mockRpcResponses.set("session.history", { messages: [], hasMore: false });
    // Server is the new build — both pending fields are present and null.
    mockRpcResponses.set("session.currentTurn", {
      streaming: false,
      text: "",
      busy: false,
      pendingPermission: null,
      pendingAskUser: null,
    });

    // Pre-seed the cache with stale dialogs (as if a broadcast had been
    // received earlier and another client then resolved them).
    useSessionStore.setState({
      sessionCache: {
        "web:resolved-elsewhere": {
          messages: [],
          agentStatus: "idle",
          statusLabel: "",
          contextUsagePercent: null,
          sessionTokens: null,
          sessionCostUSD: null,
          lastTurnUsage: null,
          lastTurnCostUSD: null,
          pendingPermission: { requestId: "stale-perm", toolName: "bash", toolInput: { command: "rm -rf /" } },
          pendingAskUser: { requestId: "stale-ask", question: "stale?", options: [] },
          taskSummary: null,
        },
      } as any,
    });

    await useSessionStore.getState().switchSession("web:resolved-elsewhere");

    const s = useSessionStore.getState();
    expect(s.pendingPermission).toBeNull();
    expect(s.pendingAskUser).toBeNull();
  });

  it("falls back to cached pending dialog when session.currentTurn lacks the new fields (legacy gateway)", async () => {
    // Backward-compat: an old gateway returns { streaming, text, busy }
    // without the new pendingPermission / pendingAskUser fields. In that
    // case we MUST keep the cached snapshot — flipping it to null would
    // be worse than the stale-resurrect concern, since the server here
    // just doesn't have the info.
    setupMockRpc();
    mockRpcResponses.set("session.resolve", { sessionKey: "web:legacy-gw" });
    mockRpcResponses.set("session.history", { messages: [], hasMore: false });
    mockRpcResponses.set("session.currentTurn", {
      streaming: false,
      text: "",
      busy: true,
      // No pendingPermission / pendingAskUser keys at all (old build).
    });

    useSessionStore.setState({
      sessionCache: {
        "web:legacy-gw": {
          messages: [],
          agentStatus: "idle",
          statusLabel: "",
          contextUsagePercent: null,
          sessionTokens: null,
          sessionCostUSD: null,
          lastTurnUsage: null,
          lastTurnCostUSD: null,
          pendingPermission: null,
          pendingAskUser: { requestId: "cached-ask", question: "from cache", options: ["x"] },
          taskSummary: null,
        },
      } as any,
    });

    await useSessionStore.getState().switchSession("web:legacy-gw");

    const s = useSessionStore.getState();
    expect(s.pendingAskUser?.requestId).toBe("cached-ask");
  });

  it("hydrates pendingPermission from session.currentTurn for a late-joining client", async () => {
    setupMockRpc();
    mockRpcResponses.set("session.resolve", { sessionKey: "web:late-perm" });
    mockRpcResponses.set("session.history", { messages: [], hasMore: false });
    mockRpcResponses.set("session.currentTurn", {
      streaming: false,
      text: "",
      busy: true,
      pendingPermission: {
        requestId: "perm-late-1",
        tool: "bash",
        input: { command: "rm -rf /tmp/x" },
        diffPreview: null,
        suggestions: [],
        suggestedPattern: "Bash(rm *)",
      },
      pendingAskUser: null,
    });

    await useSessionStore.getState().switchSession("web:late-perm");

    const s = useSessionStore.getState();
    expect(s.pendingPermission).not.toBeNull();
    expect(s.pendingPermission?.requestId).toBe("perm-late-1");
    expect(s.pendingPermission?.toolName).toBe("bash");
    expect(s.pendingPermission?.toolInput).toEqual({ command: "rm -rf /tmp/x" });
    expect(s.pendingPermission?.suggestedPattern).toBe("Bash(rm *)");
  });

  it("initializes historyMeta from session.history response", async () => {
    setupMockRpc();
    mockRpcResponses.set("session.resolve", { sessionKey: "web:paginated" });
    mockRpcResponses.set("session.history", {
      messages: [
        { index: 8, role: "user", content: [{ type: "text", text: "latest" }], timestamp: "2026-04-01T10:00:00Z" },
        { index: 9, role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: "2026-04-01T10:00:01Z" },
      ],
      total: 10,
      hasMore: true,
    });

    await useSessionStore.getState().switchSession("web:paginated");

    const meta = useSessionStore.getState().historyMeta;
    expect(meta).not.toBeNull();
    expect(meta!.oldestLoadedIndex).toBe(8);
    expect(meta!.hasMore).toBe(true);
    expect(meta!.loadingOlder).toBe(false);
  });

  it("seeds footer usage fields from the sidebar entry on switch", async () => {
    // Pre-populate the sidebar as fetchSessions would have
    useSessionStore.setState({
      sessions: [
        {
          id: "gw-web-general",
          key: "web:general",
          createdAt: "",
          messageCount: 2,
          active: true,
          isSystem: false,
          contextUsagePercent: 37,
          sessionTokens: { input: 500, output: 100 },
          sessionCostUSD: 0.002,
        },
      ],
      contextUsagePercent: null,
      sessionTokens: null,
      sessionCostUSD: null,
    });

    setupMockRpc();
    mockRpcResponses.set("session.history", {
      messages: [{ index: 0, role: "user", content: [{ type: "text", text: "hi" }] }],
      hasMore: false,
    });

    await useSessionStore.getState().switchSession("web:general");

    const s = useSessionStore.getState();
    expect(s.contextUsagePercent).toBe(37);
    expect(s.sessionTokens).toEqual({ input: 500, output: 100 });
    expect(s.sessionCostUSD).toBeCloseTo(0.002, 5);
  });

  it("historyMeta hasMore=false when full history fits", async () => {
    setupMockRpc();
    mockRpcResponses.set("session.resolve", { sessionKey: "web:short" });
    mockRpcResponses.set("session.history", {
      messages: [{ index: 0, role: "user", content: [{ type: "text", text: "hi" }] }],
      total: 1,
      hasMore: false,
    });

    await useSessionStore.getState().switchSession("web:short");
    expect(useSessionStore.getState().historyMeta!.hasMore).toBe(false);
    expect(useSessionStore.getState().historyMeta!.oldestLoadedIndex).toBe(0);
  });
});

// -----------------------------------------------------------------------------
// loadOlderMessages
// -----------------------------------------------------------------------------

describe("loadOlderMessages", () => {
  it("prepends older messages and advances the cursor", async () => {
    setupMockRpc();
    mockRpcResponses.set("session.resolve", { sessionKey: "web:page" });
    // Initial switch: 2 recent messages (indexes 8, 9 of a 10-message history)
    mockRpcResponses.set("session.history", {
      messages: [
        { index: 8, role: "user", content: [{ type: "text", text: "newer" }] },
        { index: 9, role: "assistant", content: [{ type: "text", text: "reply" }] },
      ],
      total: 10,
      hasMore: true,
    });

    await useSessionStore.getState().switchSession("web:page");
    expect(useSessionStore.getState().messages.length).toBe(2);
    expect(useSessionStore.getState().historyMeta!.oldestLoadedIndex).toBe(8);

    // Next call returns older 3 messages (indexes 5,6,7)
    mockRpcResponses.set("session.history", {
      messages: [
        { index: 5, role: "user", content: [{ type: "text", text: "older-1" }] },
        { index: 6, role: "assistant", content: [{ type: "text", text: "older-2" }] },
        { index: 7, role: "user", content: [{ type: "text", text: "older-3" }] },
      ],
      total: 10,
      hasMore: true,
    });

    await useSessionStore.getState().loadOlderMessages();

    const state = useSessionStore.getState();
    expect(state.messages.length).toBe(5);
    // Older messages should be prepended (appear first)
    expect(state.messages[0].content).toBe("older-1");
    expect(state.messages[2].content).toBe("older-3");
    expect(state.messages[3].content).toBe("newer");
    // Cursor moved back to the oldest index we just loaded
    expect(state.historyMeta!.oldestLoadedIndex).toBe(5);
  });

  it("passes oldestLoadedIndex as beforeIndex cursor to backend", async () => {
    const mockRpc = setupMockRpc();
    mockRpcResponses.set("session.resolve", { sessionKey: "web:cursor" });
    mockRpcResponses.set("session.history", {
      messages: [{ index: 50, role: "user", content: [{ type: "text", text: "m" }] }],
      total: 100,
      hasMore: true,
    });
    await useSessionStore.getState().switchSession("web:cursor");
    mockRpc.mockClear();

    mockRpcResponses.set("session.history", {
      messages: [{ index: 0, role: "user", content: [{ type: "text", text: "older" }] }],
      total: 100,
      hasMore: false,
    });
    await useSessionStore.getState().loadOlderMessages();

    const call = mockRpc.mock.calls.find((c) => c[0] === "session.history");
    expect(call).toBeDefined();
    expect((call![1] as any).beforeIndex).toBe(50);
  });

  it("is a no-op when hasMore is false", async () => {
    const mockRpc = setupMockRpc();
    mockRpcResponses.set("session.resolve", { sessionKey: "web:done" });
    mockRpcResponses.set("session.history", {
      messages: [{ index: 0, role: "user", content: [{ type: "text", text: "only" }] }],
      total: 1,
      hasMore: false,
    });

    await useSessionStore.getState().switchSession("web:done");
    mockRpc.mockClear();

    await useSessionStore.getState().loadOlderMessages();

    // Should not call session.history again
    expect(mockRpc).not.toHaveBeenCalledWith("session.history", expect.anything());
  });

  it("is a no-op when no active session", async () => {
    const mockRpc = setupMockRpc();
    useSessionStore.setState({ activeKey: "", historyMeta: null });
    await useSessionStore.getState().loadOlderMessages();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("is a no-op when oldestLoadedIndex is null (no messages loaded)", async () => {
    const mockRpc = setupMockRpc();
    useSessionStore.setState({
      activeKey: "web:empty",
      historyMeta: { oldestLoadedIndex: null, hasMore: true, loadingOlder: false },
    });
    await useSessionStore.getState().loadOlderMessages();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("prevents concurrent fetches via loadingOlder flag", async () => {
    const mockRpc = setupMockRpc();
    mockRpcResponses.set("session.resolve", { sessionKey: "web:conc" });
    mockRpcResponses.set("session.history", {
      messages: [{ index: 9, role: "user", content: [{ type: "text", text: "m" }] }],
      total: 10,
      hasMore: true,
    });
    await useSessionStore.getState().switchSession("web:conc");

    // Second history call never resolves (simulates in-flight)
    let resolveFetch: (v: unknown) => void = () => {};
    const pending = new Promise((r) => { resolveFetch = r; });
    mockRpcResponses.set("session.history", pending);

    // Fire two concurrent loads — the second should short-circuit on loadingOlder
    const p1 = useSessionStore.getState().loadOlderMessages();
    const p2 = useSessionStore.getState().loadOlderMessages();

    // Exactly 2 calls: 1 from switchSession + 1 from the first loadOlderMessages
    // (the second loadOlderMessages call is gated by loadingOlder=true)
    expect(mockRpc.mock.calls.filter((c) => c[0] === "session.history").length).toBe(2);

    resolveFetch({ messages: [], total: 10, hasMore: false });
    await Promise.all([p1, p2]);
  });

  it("links tool_results across pagination boundaries", async () => {
    // Simulates: newer chunk has a tool_result whose matching tool_use is in
    // an older (not-yet-loaded) chunk. When the older chunk loads, the
    // tool card should be filled with the output from the orphan tool_result.
    setupMockRpc();
    mockRpcResponses.set("session.resolve", { sessionKey: "web:tools" });

    // Newer chunk (loaded first): contains tool_result for tool_use_id="abc"
    // but no matching tool_use in this chunk.
    mockRpcResponses.set("session.history", {
      messages: [
        {
          index: 5,
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "abc",
              content: "tool output from older chunk",
              is_error: false,
            },
          ],
        },
        { index: 6, role: "assistant", content: [{ type: "text", text: "done" }] },
      ],
      total: 7,
      hasMore: true,
    });

    await useSessionStore.getState().switchSession("web:tools");

    // Older chunk arrives with the matching tool_use
    mockRpcResponses.set("session.history", {
      messages: [
        { index: 3, role: "user", content: [{ type: "text", text: "please fetch" }] },
        {
          index: 4,
          role: "assistant",
          content: [
            { type: "tool_use", id: "abc", name: "bash", input: { command: "ls" } },
          ],
        },
      ],
      total: 7,
      hasMore: false,
    });

    await useSessionStore.getState().loadOlderMessages();

    const state = useSessionStore.getState();
    const toolMsg = state.messages.find((m) => m.role === "tool" && m.tool?.toolUseId === "abc");
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.tool!.output).toBe("tool output from older chunk");
    expect(toolMsg!.tool!.isError).toBe(false);
    // Orphan should be consumed after matching
    expect(state.orphanToolResults["abc"]).toBeUndefined();
  });

  it("drops synthesized metadata when an orphan tool_result is an error (regression guard)", async () => {
    // Codex P2 follow-up: the in-page error path already cleared
    // synthesized metadata for failed edit_file/write_file. The orphan
    // path used by infinite scroll did not, which would let a fake
    // green/red diff appear on a failed historical edit after loading
    // older messages. This test pins the orphan path doing the same reset.
    setupMockRpc();
    mockRpcResponses.set("session.resolve", { sessionKey: "web:err-orphan" });

    // Newer chunk: tool_result with is_error=true; matching tool_use lives
    // in the older, not-yet-loaded chunk.
    mockRpcResponses.set("session.history", {
      messages: [
        {
          index: 5,
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "edit-1",
              content: "Error: string not found in file",
              is_error: true,
            },
          ],
        },
      ],
      total: 6,
      hasMore: true,
    });
    await useSessionStore.getState().switchSession("web:err-orphan");

    // Older chunk: the matching edit_file tool_use that synthesized
    // metadata would otherwise survive on.
    mockRpcResponses.set("session.history", {
      messages: [
        { index: 3, role: "user", content: [{ type: "text", text: "edit it" }] },
        {
          index: 4,
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "edit-1",
              name: "edit_file",
              input: { file_path: "/tmp/x.txt", old_string: "foo", new_string: "bar" },
            },
          ],
        },
      ],
      total: 6,
      hasMore: false,
    });
    await useSessionStore.getState().loadOlderMessages();

    const toolMsg = useSessionStore
      .getState()
      .messages.find((m) => m.role === "tool" && m.tool?.toolUseId === "edit-1");
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.tool!.isError).toBe(true);
    expect(toolMsg!.tool!.status).toBe("error");
    // The load-bearing assertion: synthesized diff metadata is gone so
    // DiffView won't render a fake hunk for a failed edit.
    expect(toolMsg!.tool!.metadata).toBeUndefined();
  });

  it("updates hasMore to false when backend signals no more", async () => {
    setupMockRpc();
    mockRpcResponses.set("session.resolve", { sessionKey: "web:last" });
    mockRpcResponses.set("session.history", {
      messages: [{ index: 1, role: "user", content: [{ type: "text", text: "recent" }] }],
      total: 2,
      hasMore: true,
    });
    await useSessionStore.getState().switchSession("web:last");

    mockRpcResponses.set("session.history", {
      messages: [{ index: 0, role: "user", content: [{ type: "text", text: "oldest" }] }],
      total: 2,
      hasMore: false,
    });
    await useSessionStore.getState().loadOlderMessages();

    expect(useSessionStore.getState().historyMeta!.hasMore).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// Create channel
// -----------------------------------------------------------------------------

describe("createChannel", () => {
  it("creates session and adds to list", async () => {
    const mockRpc = setupMockRpc();
    mockRpcResponses.set("session.resolve", { sessionKey: "web:new-channel" });
    mockRpcResponses.set("session.history", { messages: [] });

    await useSessionStore.getState().createChannel("New Channel");

    const sessions = useSessionStore.getState().sessions;
    expect(sessions.some((s) => s.key === "web:new-channel")).toBe(true);
    expect(useSessionStore.getState().activeKey).toBe("web:new-channel");
  });

  it("sanitizes channel name", async () => {
    setupMockRpc();
    mockRpcResponses.set("session.resolve", { sessionKey: "web:my-project" });
    mockRpcResponses.set("session.history", { messages: [] });

    await useSessionStore.getState().createChannel("My Project!");

    const sessions = useSessionStore.getState().sessions;
    expect(sessions.some((s) => s.key === "web:my-project-")).toBe(true);
  });

  it("doesn't duplicate existing channel", async () => {
    useSessionStore.setState({
      sessions: [{ id: "gw-web-existing", key: "web:existing", createdAt: "", messageCount: 5, active: true, isSystem: false }],
    });

    setupMockRpc();
    mockRpcResponses.set("session.resolve", { sessionKey: "web:existing" });
    mockRpcResponses.set("session.history", { messages: [] });

    await useSessionStore.getState().createChannel("existing");

    const sessions = useSessionStore.getState().sessions;
    const matching = sessions.filter((s) => s.key === "web:existing");
    expect(matching.length).toBe(1); // No duplicate
  });
});

// -----------------------------------------------------------------------------
// ID → Key conversion
// -----------------------------------------------------------------------------

describe("session ID to key conversion", () => {
  it("converts gw-web-general to web:general", async () => {
    setupMockRpc();
    mockRpcResponses.set("session.list", {
      sessions: [{ id: "gw-web-general", messageCount: 0, active: false }],
    });

    await useSessionStore.getState().fetchSessions();
    expect(useSessionStore.getState().sessions[0].key).toBe("web:general");
  });

  it("converts gw-heartbeat-main to heartbeat:main", async () => {
    setupMockRpc();
    mockRpcResponses.set("session.list", {
      sessions: [{ id: "gw-heartbeat-main", messageCount: 0, active: false }],
    });

    await useSessionStore.getState().fetchSessions();
    expect(useSessionStore.getState().sessions[0].key).toBe("heartbeat:main");
  });

  it("converts gw-cron-abc123 to cron:abc123", async () => {
    setupMockRpc();
    mockRpcResponses.set("session.list", {
      sessions: [{ id: "gw-cron-abc123", messageCount: 0, active: false }],
    });

    await useSessionStore.getState().fetchSessions();
    const session = useSessionStore.getState().sessions[0];
    expect(session.key).toBe("cron:abc123");
    expect(session.isSystem).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// sendMessage
// -----------------------------------------------------------------------------

describe("sendMessage", () => {
  it("adds user message optimistically and sets thinking status", async () => {
    setupMockRpc();
    mockRpcResponses.set("chat.send", { completed: true });

    const promise = useSessionStore.getState().sendMessage("Hello");

    // Check optimistic state immediately
    const state = useSessionStore.getState();
    expect(state.messages.length).toBe(1);
    expect(state.messages[0].role).toBe("user");
    expect(state.messages[0].content).toBe("Hello");
    expect(state.agentStatus).toBe("thinking");

    await promise;
  });

  it("shows error on RPC failure", async () => {
    setupMockRpc();
    mockRpcResponses.set("chat.send", new Error("API timeout"));

    await useSessionStore.getState().sendMessage("Hello");

    const state = useSessionStore.getState();
    expect(state.agentStatus).toBe("idle");
    expect(state.messages.some((m) => m.content.includes("API timeout"))).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// handleEvent (streaming)
// -----------------------------------------------------------------------------

describe("handleEvent", () => {
  it("creates assistant message on first text event", () => {
    useSessionStore.getState().handleEvent({
      type: "event",
      event: "agent.text",
      payload: { type: "text", content: "Hello" },
    });

    const state = useSessionStore.getState();
    expect(state.agentStatus).toBe("streaming");
    expect(state.messages.length).toBe(1);
    expect(state.messages[0].role).toBe("assistant");
    expect(state.messages[0].content).toBe("Hello");
  });

  it("accumulates text events (after flush)", async () => {
    // Reset module-level streaming state by dispatching a done event
    useSessionStore.getState().handleEvent({
      type: "event", event: "agent.done", payload: { type: "done" },
    });
    useSessionStore.setState({
      messages: [],
      agentStatus: "idle",
    });

    useSessionStore.getState().handleEvent({
      type: "event",
      event: "agent.text",
      payload: { type: "text", content: "Hello" },
    });
    useSessionStore.getState().handleEvent({
      type: "event",
      event: "agent.text",
      payload: { type: "text", content: " world" },
    });

    // Finalize with done event (flushes pending text)
    useSessionStore.getState().handleEvent({
      type: "event",
      event: "agent.done",
      payload: { type: "done" },
    });

    const state = useSessionStore.getState();
    expect(state.messages.length).toBeGreaterThanOrEqual(1);
    const assistantMsg = state.messages.find((m) => m.role === "assistant");
    expect(assistantMsg?.content).toBe("Hello world");
  });

  it("replaces pre-tool draft text instead of creating a second assistant bubble", () => {
    useSessionStore.getState().handleEvent({
      type: "event",
      event: "agent.done",
      payload: { type: "done" },
    });
    useSessionStore.setState({ messages: [], agentStatus: "idle" });

    useSessionStore.getState().handleEvent({
      type: "event",
      event: "agent.text",
      payload: { type: "text", content: "I will check." },
    });
    useSessionStore.getState().handleEvent({
      type: "event",
      event: "agent.tool_use_start",
      payload: { tool_use_id: "T1", name: "bash", input: { command: "ls" } },
    });
    useSessionStore.getState().handleEvent({
      type: "event",
      event: "agent.tool_result",
      payload: { tool_use_id: "T1", name: "bash", content: "file.txt", is_error: false },
    });
    useSessionStore.getState().handleEvent({
      type: "event",
      event: "agent.text",
      payload: { type: "text", content: "Final answer after tool.", replace: true },
    });

    const state = useSessionStore.getState();
    const assistants = state.messages.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(1);
    expect(assistants[0].content).toBe("Final answer after tool.");
    expect(state.messages.filter((m) => m.role === "tool")).toHaveLength(1);
    expect(state.messages.some((m) => m.role === "assistant" && m.content === "I will check.")).toBe(false);
  });

  it("adds tool card on tool_use_start", () => {
    useSessionStore.getState().handleEvent({
      type: "event",
      event: "agent.tool_use_start",
      payload: { tool_use_id: "T1", name: "bash", input: { command: "ls" } },
    });

    const state = useSessionStore.getState();
    expect(state.messages.length).toBe(1);
    expect(state.messages[0].role).toBe("tool");
    expect(state.messages[0].tool?.name).toBe("bash");
    expect(state.messages[0].tool?.inputPreview).toBe("ls");
    expect(state.messages[0].tool?.status).toBe("running");
  });

  it("marks tool as success on tool_result", () => {
    useSessionStore.getState().handleEvent({
      type: "event",
      event: "agent.tool_use_start",
      payload: { tool_use_id: "T1", name: "bash", input: { command: "ls" } },
    });
    useSessionStore.getState().handleEvent({
      type: "event",
      event: "agent.tool_result",
      payload: { tool_use_id: "T1", name: "bash", content: "file1\nfile2", is_error: false },
    });

    const tool = useSessionStore.getState().messages[0].tool;
    expect(tool?.status).toBe("success");
    expect(tool?.output).toBe("file1\nfile2");
    expect(tool?.isError).toBe(false);
  });

  it("marks tool as error on failed tool_result", () => {
    useSessionStore.getState().handleEvent({
      type: "event",
      event: "agent.tool_use_start",
      payload: { tool_use_id: "T1", name: "bash", input: { command: "bad" } },
    });
    useSessionStore.getState().handleEvent({
      type: "event",
      event: "agent.tool_result",
      payload: { tool_use_id: "T1", name: "bash", content: "command not found", is_error: true },
    });

    const tool = useSessionStore.getState().messages[0].tool;
    expect(tool?.status).toBe("error");
    expect(tool?.isError).toBe(true);
  });

  it("caches background tool events for inactive sessions", () => {
    useSessionStore.setState({
      activeKey: "web:general",
      sessionCache: {
        "web:codex": {
          messages: [],
          agentStatus: "idle",
          statusLabel: "",
          contextUsagePercent: null,
          sessionTokens: null,
          sessionCostUSD: null,
          lastTurnUsage: null,
          lastTurnCostUSD: null,
          pendingPermission: null,
          pendingAskUser: null,
          taskSummary: null,
          permissionMode: null,
          forceBypass: false,
        },
      },
    });

    useSessionStore.getState().handleEvent({
      type: "event",
      event: "agent.tool_use_start",
      payload: {
        _sessionKey: "web:codex",
        tool_use_id: "T1",
        name: "hawky_session_list",
        input: { limit: 1 },
      },
    });
    useSessionStore.getState().handleEvent({
      type: "event",
      event: "agent.tool_result",
      payload: {
        _sessionKey: "web:codex",
        tool_use_id: "T1",
        name: "hawky_session_list",
        content: "session list empty",
        is_error: false,
      },
    });

    const cached = useSessionStore.getState().sessionCache["web:codex"];
    expect(cached.messages.length).toBe(1);
    expect(cached.messages[0].role).toBe("tool");
    expect(cached.messages[0].tool?.name).toBe("hawky_session_list");
    expect(cached.messages[0].tool?.status).toBe("success");
    expect(cached.messages[0].tool?.output).toBe("session list empty");
  });

  it("replaces background pre-tool draft text in the cached session", () => {
    useSessionStore.setState({
      activeKey: "web:general",
      sessionCache: {
        "web:codex": {
          messages: [],
          agentStatus: "idle",
          statusLabel: "",
          contextUsagePercent: null,
          sessionTokens: null,
          sessionCostUSD: null,
          lastTurnUsage: null,
          lastTurnCostUSD: null,
          pendingPermission: null,
          pendingAskUser: null,
          taskSummary: null,
          permissionMode: null,
          forceBypass: false,
        },
      },
    });

    useSessionStore.getState().handleEvent({
      type: "event",
      event: "agent.text",
      payload: { _sessionKey: "web:codex", type: "text", content: "I will check." },
    });
    useSessionStore.getState().handleEvent({
      type: "event",
      event: "agent.tool_use_start",
      payload: {
        _sessionKey: "web:codex",
        tool_use_id: "T1",
        name: "bash",
        input: { command: "ls" },
      },
    });
    useSessionStore.getState().handleEvent({
      type: "event",
      event: "agent.tool_result",
      payload: {
        _sessionKey: "web:codex",
        tool_use_id: "T1",
        name: "bash",
        content: "file.txt",
        is_error: false,
      },
    });
    useSessionStore.getState().handleEvent({
      type: "event",
      event: "agent.text",
      payload: {
        _sessionKey: "web:codex",
        type: "text",
        content: "Final answer after tool.",
        replace: true,
      },
    });

    const cached = useSessionStore.getState().sessionCache["web:codex"];
    const assistants = cached.messages.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(1);
    expect(assistants[0].content).toBe("Final answer after tool.");
    expect(cached.messages.filter((m) => m.role === "tool")).toHaveLength(1);
    expect(cached.messages.some((m) => m.role === "assistant" && m.content === "I will check.")).toBe(false);
  });

  it("sets idle on done event", () => {
    useSessionStore.setState({ agentStatus: "streaming" });

    useSessionStore.getState().handleEvent({
      type: "event",
      event: "agent.done",
      payload: { type: "done", usage: { input_tokens: 100, output_tokens: 50, context_usage_percent: 25 } },
    });

    expect(useSessionStore.getState().agentStatus).toBe("idle");
    expect(useSessionStore.getState().contextUsagePercent).toBe(25);
  });

  it("shows error message on error event", () => {
    useSessionStore.getState().handleEvent({
      type: "event",
      event: "agent.error",
      payload: { type: "error", content: "API overloaded" },
    });

    const state = useSessionStore.getState();
    expect(state.agentStatus).toBe("idle");
    expect(state.messages.some((m) => m.content.includes("API overloaded"))).toBe(true);
  });

  it("shows system status message on cancel event", () => {
    // Start streaming
    useSessionStore.getState().handleEvent({
      type: "event",
      event: "agent.text",
      payload: { type: "text", content: "Partial response" },
    });

    useSessionStore.getState().handleEvent({
      type: "event",
      event: "agent.cancel",
      payload: { type: "cancel", content: "Cancelled" },
    });

    const state = useSessionStore.getState();
    expect(state.agentStatus).toBe("idle");
    // Streaming text preserved without [cancelled] appended
    expect(state.messages[0].content).toBe("Partial response");
    // System status message added separately
    const systemMsg = state.messages.find((m) => m.role === "system" && m.content.includes("stopped"));
    expect(systemMsg).toBeTruthy();
  });

  it("suppresses 'Request aborted by user' error after cancel (no double system message)", () => {
    // User cancel sequence: backend emits cancel THEN an error with
    // "Request aborted by user". We want exactly one system message.
    useSessionStore.getState().handleEvent({
      type: "event",
      event: "agent.cancel",
      payload: { type: "cancel", content: "Cancelled" },
    });
    useSessionStore.getState().handleEvent({
      type: "event",
      event: "agent.error",
      payload: { type: "error", content: "Request aborted by user" },
    });

    const state = useSessionStore.getState();
    const systemMessages = state.messages.filter((m) => m.role === "system");
    // Exactly one system message (the "Generation stopped" from cancel)
    expect(systemMessages.length).toBe(1);
    expect(systemMessages[0].content).toMatch(/stopped/i);
    // No "Error: Request aborted" message should appear
    expect(state.messages.some((m) => m.content.includes("Request aborted by user"))).toBe(false);
  });

  it("still shows genuine (non-user-abort) error messages", () => {
    useSessionStore.getState().handleEvent({
      type: "event",
      event: "agent.error",
      payload: { type: "error", content: "API overloaded" },
    });
    const state = useSessionStore.getState();
    expect(state.messages.some((m) => m.content.includes("API overloaded"))).toBe(true);
  });

  it("still shows abort-worded errors that arrive WITHOUT a preceding cancel", () => {
    // Guard against regex-based suppression: a provider-side pre-abort error
    // without a matching cancel event should still surface to the user.
    useSessionStore.getState().handleEvent({
      type: "event",
      event: "agent.error",
      payload: { type: "error", content: "Request aborted before starting" },
    });
    const state = useSessionStore.getState();
    expect(state.messages.some((m) => m.content.includes("Request aborted before starting"))).toBe(true);
  });

  it("only suppresses the FIRST error after a cancel (follow-up errors still show)", () => {
    // cancel → error (suppressed) → next error (should surface)
    useSessionStore.getState().handleEvent({
      type: "event",
      event: "agent.cancel",
      payload: { type: "cancel", content: "Cancelled" },
    });
    useSessionStore.getState().handleEvent({
      type: "event",
      event: "agent.error",
      payload: { type: "error", content: "Request aborted by user" },
    });
    useSessionStore.getState().handleEvent({
      type: "event",
      event: "agent.error",
      payload: { type: "error", content: "Something else broke" },
    });
    const state = useSessionStore.getState();
    expect(state.messages.some((m) => m.content.includes("Request aborted by user"))).toBe(false);
    expect(state.messages.some((m) => m.content.includes("Something else broke"))).toBe(true);
  });

  it("cancel followed by a non-abort error STILL surfaces the error", () => {
    // Adversarial case: after a cancel, the backend sends a different error
    // (e.g., an API failure during cancellation itself). That error must
    // NOT be suppressed just because a cancel happened.
    useSessionStore.getState().handleEvent({
      type: "event",
      event: "agent.cancel",
      payload: { type: "cancel", content: "Cancelled" },
    });
    useSessionStore.getState().handleEvent({
      type: "event",
      event: "agent.error",
      payload: { type: "error", content: "API overloaded" },
    });
    const state = useSessionStore.getState();
    expect(state.messages.some((m) => m.content.includes("API overloaded"))).toBe(true);
  });

  it("cancel without a follow-up error — next turn's first error still surfaces", () => {
    // Adversarial case: backend sometimes sends only cancel (no abort-error).
    // The cancel flag must NOT survive into the next turn to suppress a
    // genuine error there. `done` clears the flag.
    useSessionStore.getState().handleEvent({
      type: "event",
      event: "agent.cancel",
      payload: { type: "cancel", content: "Cancelled" },
    });
    useSessionStore.getState().handleEvent({
      type: "event",
      event: "agent.done",
      payload: { type: "done" },
    });
    useSessionStore.getState().handleEvent({
      type: "event",
      event: "agent.error",
      payload: { type: "error", content: "Request aborted by user" },
    });
    const state = useSessionStore.getState();
    // Even abort-worded error must surface after `done` cleared the flag
    expect(state.messages.some((m) => m.content.includes("Request aborted by user"))).toBe(true);
  });

  it("cancel then new send — the new turn's first error still surfaces", async () => {
    // Adversarial case: user cancels, then sends a new message. If the new
    // turn's first error happens to be abort-worded, the stale cancel flag
    // must NOT suppress it — sendMessage clears the flag.
    useSessionStore.getState().handleEvent({
      type: "event",
      event: "agent.cancel",
      payload: { type: "cancel", content: "Cancelled" },
    });
    // sendMessage needs rpc to return a thenable for its .catch chain
    const mockSend = vi.fn(async () => ({ ok: true }));
    useSocketStore.setState({ rpc: mockSend as any });
    await useSessionStore.getState().sendMessage("new question");

    useSessionStore.getState().handleEvent({
      type: "event",
      event: "agent.error",
      payload: { type: "error", content: "Request aborted by user" },
    });
    const state = useSessionStore.getState();
    expect(state.messages.some((m) => m.content.includes("Request aborted by user"))).toBe(true);
  });

  it("shows system messages", () => {
    useSessionStore.getState().handleEvent({
      type: "event",
      event: "agent.system_message",
      payload: { type: "system_message", content: "Approaching context limit" },
    });

    const state = useSessionStore.getState();
    expect(state.messages[0].role).toBe("system");
    expect(state.messages[0].content).toBe("Approaching context limit");
  });

  it("ignores non-agent events", () => {
    useSessionStore.getState().handleEvent({
      type: "event",
      event: "heartbeat.started",
      payload: {},
    });

    expect(useSessionStore.getState().messages.length).toBe(0);
  });

  it("sets pendingPermission on permission_request", () => {
    useSessionStore.getState().handleEvent({
      type: "event",
      event: "agent.permission_request",
      payload: { _requestId: "perm-1", name: "bash", input: { command: "rm -rf /" } },
    });

    const state = useSessionStore.getState();
    expect(state.pendingPermission).not.toBeNull();
    expect(state.pendingPermission?.requestId).toBe("perm-1");
    expect(state.pendingPermission?.toolName).toBe("bash");
  });

  it("sets pendingAskUser on ask_user_request", () => {
    useSessionStore.getState().handleEvent({
      type: "event",
      event: "agent.ask_user_request",
      payload: { _requestId: "ask-1", question: "Continue?", options: ["yes", "no"] },
    });

    const state = useSessionStore.getState();
    expect(state.pendingAskUser).not.toBeNull();
    expect(state.pendingAskUser?.requestId).toBe("ask-1");
    expect(state.pendingAskUser?.question).toBe("Continue?");
    expect(state.pendingAskUser?.options).toEqual(["yes", "no"]);
  });

  it("caches pendingAskUser for a BACKGROUND session (different sessionKey from active)", () => {
    // Regression: the background handler used to listen for the wrong
    // event name ('ask_user.request') while the gateway broadcasts
    // 'agent.ask_user_request'. The mismatch silently dropped every
    // ask_user prompt for non-active sessions: when the user later
    // switched to that session the dialog never appeared.
    useSessionStore.setState({
      activeKey: "web:foreground",
      sessionCache: {},
    } as any);

    useSessionStore.getState().handleEvent({
      type: "event",
      event: "agent.ask_user_request",
      payload: {
        _sessionKey: "web:background",
        id: "ask-bg-1",
        question: "Pick a path",
        options: ["A", "B"],
      },
    } as any);

    const cached = useSessionStore.getState().sessionCache["web:background"];
    expect(cached?.pendingAskUser).not.toBeNull();
    expect(cached?.pendingAskUser?.requestId).toBe("ask-bg-1");
    expect(cached?.pendingAskUser?.question).toBe("Pick a path");
    expect(cached?.pendingAskUser?.options).toEqual(["A", "B"]);
  });

  it("clears pending prompts on done event", () => {
    useSessionStore.setState({
      pendingPermission: { requestId: "p", toolName: "bash", toolInput: {} },
      pendingAskUser: { requestId: "a", question: "?", options: [] },
    });

    useSessionStore.getState().handleEvent({
      type: "event",
      event: "agent.done",
      payload: { type: "done" },
    });

    expect(useSessionStore.getState().pendingPermission).toBeNull();
    expect(useSessionStore.getState().pendingAskUser).toBeNull();
  });

  it("mirrors usage onto the sidebar entry when agent.done fires for the active session", () => {
    useSessionStore.setState({
      activeKey: "web:general",
      sessions: [
        {
          id: "gw-web-general",
          key: "web:general",
          createdAt: "",
          messageCount: 2,
          active: true,
          isSystem: false,
          contextUsagePercent: 10,
          sessionTokens: null,
          sessionCostUSD: null,
        },
      ],
    });

    useSessionStore.getState().handleEvent({
      type: "event",
      event: "agent.done",
      payload: {
        type: "done",
        _sessionKey: "web:general",
        usage: { context_usage_percent: 47, input_tokens: 900, output_tokens: 220 },
        sessionCostUSD: 0.008,
      },
    });

    const s = useSessionStore.getState();
    expect(s.sessions[0].contextUsagePercent).toBe(47);
    // Cache buckets default to 0 when absent from the done payload — the
    // store always preserves the four-bucket shape so the footer can sum
    // total input without sprinkling ?? 0 at every read site.
    expect(s.sessions[0].sessionTokens).toEqual({ input: 900, output: 220, cacheRead: 0, cacheCreation: 0 });
    expect(s.sessions[0].sessionCostUSD).toBeCloseTo(0.008, 5);
  });

  it("mirrors usage onto the sidebar entry when agent.done fires for a background session", () => {
    // Covers the case where a heartbeat/cron/Slack-initiated turn completes
    // while the user is looking at a different channel — the ring must
    // update live, not stay stale until the next full session.list refresh.
    useSessionStore.setState({
      activeKey: "web:general",
      sessions: [
        {
          id: "gw-web-general",
          key: "web:general",
          createdAt: "",
          messageCount: 0,
          active: true,
          isSystem: false,
          contextUsagePercent: null,
          sessionTokens: null,
          sessionCostUSD: null,
        },
        {
          id: "gw-heartbeat-main",
          key: "heartbeat:main",
          createdAt: "",
          messageCount: 5,
          active: false,
          isSystem: true,
          contextUsagePercent: 12,
          sessionTokens: null,
          sessionCostUSD: null,
        },
      ],
      sessionCache: {
        "heartbeat:main": {
          messages: [],
          agentStatus: "idle",
          statusLabel: "",
          contextUsagePercent: null,
          sessionTokens: null,
          sessionCostUSD: null,
          lastTurnUsage: null,
          lastTurnCostUSD: null,
          pendingPermission: null,
          pendingAskUser: null,
          taskSummary: null,
          permissionMode: null,
          forceBypass: false,
        },
      },
    });

    useSessionStore.getState().handleEvent({
      type: "event",
      event: "agent.done",
      payload: {
        type: "done",
        _sessionKey: "heartbeat:main",
        usage: { context_usage_percent: 63, input_tokens: 4200, output_tokens: 510 },
        sessionCostUSD: 0.031,
      },
    });

    const s = useSessionStore.getState();
    const heartbeat = s.sessions.find((x) => x.key === "heartbeat:main")!;
    expect(heartbeat.contextUsagePercent).toBe(63);
    expect(heartbeat.sessionTokens).toEqual({ input: 4200, output: 510, cacheRead: 0, cacheCreation: 0 });
    expect(heartbeat.sessionCostUSD).toBeCloseTo(0.031, 5);

    // Active session row must not be touched when a background session completes
    const general = s.sessions.find((x) => x.key === "web:general")!;
    expect(general.contextUsagePercent).toBeNull();
    expect(general.sessionTokens).toBeNull();
  });
});

// =============================================================================
// user.message sibling broadcasts — attachment propagation
//
// Covers the fix for cross-client sync of messages that carry images or PDFs.
// The gateway excludes the sender from its `user.message` broadcast, so every
// payload we receive here comes from a sibling client (other tab / phone /
// TUI). The handler must surface attachment metadata so ChatView renders the
// thumbnail (images) or pill (PDFs) — dropping the metadata results in empty
// bubbles on the receiving side, which is the bug this guards against.
// =============================================================================

describe("handleEvent: user.message sibling attachments", () => {
  const TINY_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";

  beforeEach(() => {
    useSessionStore.setState({ activeKey: "web:general", messages: [], sessionCache: {} });
  });

  it("active session: image broadcast populates `images` with base64 so ChatView can render it", () => {
    useSessionStore.getState().handleEvent({
      type: "event",
      event: "user.message",
      sessionKey: "web:general",
      payload: {
        type: "user.message",
        sessionKey: "web:general",
        text: "check this",
        attachments: [{ base64: TINY_PNG_BASE64, media_type: "image/png" }],
        timestamp: "2026-04-22T00:00:00.000Z",
      },
    } as any);

    const msgs = useSessionStore.getState().messages;
    expect(msgs.length).toBe(1);
    expect(msgs[0].role).toBe("user");
    expect(msgs[0].content).toBe("check this");
    expect(msgs[0].images).toEqual([{ base64: TINY_PNG_BASE64, media_type: "image/png" }]);
    expect(msgs[0].documents).toBeUndefined();
  });

  it("active session: PDF broadcast populates `documents` with pill metadata", () => {
    useSessionStore.getState().handleEvent({
      type: "event",
      event: "user.message",
      sessionKey: "web:general",
      payload: {
        type: "user.message",
        sessionKey: "web:general",
        text: "see attached",
        documents: [{ media_type: "application/pdf", filename: "spec.pdf", sizeBytes: 12345 }],
        timestamp: "2026-04-22T00:00:00.000Z",
      },
    } as any);

    const msgs = useSessionStore.getState().messages;
    expect(msgs.length).toBe(1);
    expect(msgs[0].documents).toEqual([
      { media_type: "application/pdf", filename: "spec.pdf", sizeBytes: 12345 },
    ]);
    expect(msgs[0].images).toBeUndefined();
  });

  it("active session: attachment-only send (empty text + PDF) still renders the pill", () => {
    useSessionStore.getState().handleEvent({
      type: "event",
      event: "user.message",
      sessionKey: "web:general",
      payload: {
        type: "user.message",
        sessionKey: "web:general",
        text: "",
        documents: [{ media_type: "application/pdf", filename: "notes.pdf", sizeBytes: 500 }],
        timestamp: "2026-04-22T00:00:00.000Z",
      },
    } as any);

    const msgs = useSessionStore.getState().messages;
    expect(msgs.length).toBe(1);
    expect(msgs[0].content).toBe("");
    expect(msgs[0].documents?.[0]?.filename).toBe("notes.pdf");
  });

  it("background session: cached user.message also carries attachment metadata", () => {
    // Switch the active session AWAY from the target so the handler takes the
    // background/cache branch. Both branches share the extraction helper, but
    // they duplicate the message-construction code, so both need coverage.
    //
    // The gateway injects `_sessionKey` into every broadcast payload (see
    // src/gateway/broadcast.ts) — the handler routes on that, not on the
    // top-level frame.sessionKey, so tests must set it for the background
    // branch to fire.
    useSessionStore.setState({ activeKey: "web:other" });

    useSessionStore.getState().handleEvent({
      type: "event",
      event: "user.message",
      sessionKey: "web:general",
      payload: {
        type: "user.message",
        _sessionKey: "web:general",
        sessionKey: "web:general",
        text: "image from phone",
        attachments: [{ base64: TINY_PNG_BASE64, media_type: "image/png" }],
        documents: [{ media_type: "application/pdf", filename: "a.pdf", sizeBytes: 10 }],
        timestamp: "2026-04-22T00:00:00.000Z",
      },
    } as any);

    const cached = useSessionStore.getState().sessionCache["web:general"];
    expect(cached?.messages.length).toBe(1);
    const m = cached!.messages[0];
    expect(m.images?.[0]?.base64).toBe(TINY_PNG_BASE64);
    expect(m.documents?.[0]?.filename).toBe("a.pdf");
  });

  it("drops malformed attachment entries (missing base64 / media_type) rather than rendering garbage", () => {
    useSessionStore.getState().handleEvent({
      type: "event",
      event: "user.message",
      sessionKey: "web:general",
      payload: {
        type: "user.message",
        sessionKey: "web:general",
        text: "mixed bag",
        attachments: [
          { base64: TINY_PNG_BASE64, media_type: "image/png" },
          { media_type: "image/png" }, // missing base64 → skip
          { base64: "xyz" },            // missing media_type → skip
        ],
        timestamp: "2026-04-22T00:00:00.000Z",
      },
    } as any);

    const msgs = useSessionStore.getState().messages;
    expect(msgs[0].images?.length).toBe(1);
    expect(msgs[0].images?.[0]?.base64).toBe(TINY_PNG_BASE64);
  });
});

// =============================================================================
// session.updated — real-time session list refresh
// =============================================================================

describe("session.updated event", () => {
  beforeEach(() => {
    setupMockRpc();
    mockRpcResponses.set("session.list", {
      sessions: [
        { id: "gw-web-general", createdAt: "", messageCount: 3 },
        { id: "gw-cron-daily-digest", createdAt: "", messageCount: 5 },
      ],
    });
  });

  it("triggers fetchSessions on session.updated event", async () => {
    const { rpc } = useSocketStore.getState();

    useSessionStore.getState().handleEvent({
      type: "event",
      event: "session.updated",
      payload: { sessionKey: "cron:new-job" },
    });

    // fetchSessions calls session.list RPC
    await waitForAssertion(() => {
      expect(rpc).toHaveBeenCalledWith("session.list", { limit: 100 });
    });
  });

  it("updates session list after session.updated", async () => {
    useSessionStore.getState().handleEvent({
      type: "event",
      event: "session.updated",
      payload: { sessionKey: "cron:new-job" },
    });

    await waitForAssertion(() => {
      const sessions = useSessionStore.getState().sessions;
      expect(sessions.length).toBe(2);
      expect(sessions.some((s) => s.key === "web:general")).toBe(true);
      expect(sessions.some((s) => s.key === "cron:daily-digest")).toBe(true);
    });
  });
});

// =============================================================================
// hasUnread — Slack-style bold channel indicator
// =============================================================================

describe("hasUnread", () => {
  beforeEach(() => {
    setupMockRpc();
    useSessionStore.setState({
      activeKey: "web:general",
      hasUnread: {},
      unreadCounts: {},
    });
  });

  it("sets hasUnread on background agent.text event", () => {
    useSessionStore.getState().handleEvent({
      type: "event",
      event: "agent.text",
      payload: { content: "hello", _sessionKey: "web:other" },
    });

    expect(useSessionStore.getState().hasUnread["web:other"]).toBe(true);
  });

  it("sets hasUnread on background agent.done event", () => {
    useSessionStore.getState().handleEvent({
      type: "event",
      event: "agent.done",
      payload: { type: "done", _sessionKey: "web:other" },
    });

    expect(useSessionStore.getState().hasUnread["web:other"]).toBe(true);
  });

  it("sets hasUnread on background permission.request", () => {
    useSessionStore.getState().handleEvent({
      type: "event",
      event: "permission.request",
      payload: { requestId: "p1", tool: "bash", input: {}, _sessionKey: "web:other" },
    });

    expect(useSessionStore.getState().hasUnread["web:other"]).toBe(true);
  });

  it("does NOT set hasUnread for active session events", () => {
    useSessionStore.getState().handleEvent({
      type: "event",
      event: "agent.text",
      payload: { content: "hello", _sessionKey: "web:general" },
    });

    expect(useSessionStore.getState().hasUnread["web:general"]).toBeUndefined();
  });

  it("clears hasUnread on switchSession", async () => {
    useSessionStore.setState({ hasUnread: { "web:other": true } });
    mockRpcResponses.set("session.history", { messages: [] });
    mockRpcResponses.set("session.currentTurn", { streaming: false, text: "", busy: false });

    await useSessionStore.getState().switchSession("web:other");

    expect(useSessionStore.getState().hasUnread["web:other"]).toBeUndefined();
  });

  it("clears hasUnread on sendMessage", async () => {
    useSessionStore.setState({ hasUnread: { "web:general": true } });
    mockRpcResponses.set("chat.send", { ok: true });

    await useSessionStore.getState().sendMessage("test");

    expect(useSessionStore.getState().hasUnread["web:general"]).toBeUndefined();
  });

  it("does not re-set hasUnread if already true (avoids re-render)", () => {
    useSessionStore.setState({ hasUnread: { "web:other": true } });
    const setBefore = useSessionStore.getState().hasUnread;

    useSessionStore.getState().handleEvent({
      type: "event",
      event: "agent.text",
      payload: { content: "more text", _sessionKey: "web:other" },
    });

    // Reference should be the same (no unnecessary state update)
    expect(useSessionStore.getState().hasUnread).toBe(setBefore);
  });

  it("sets hasUnread for system sessions (cron/heartbeat)", () => {
    useSessionStore.getState().handleEvent({
      type: "event",
      event: "agent.text",
      payload: { content: "cron output", _sessionKey: "cron:daily-digest" },
    });

    expect(useSessionStore.getState().hasUnread["cron:daily-digest"]).toBe(true);
  });
});

// =============================================================================
// activeKey persistence — localStorage
// =============================================================================

describe("activeKey persistence", () => {
  beforeEach(() => {
    setupMockRpc();
    resetMockLocalStorage();
    useSessionStore.setState({
      activeKey: "web:general",
      hasUnread: {},
      unreadCounts: {},
    });
  });

  it("saves activeKey to localStorage after successful switchSession", async () => {
    mockRpcResponses.set("session.history", { messages: [] });
    mockRpcResponses.set("session.currentTurn", { streaming: false, text: "", busy: false });

    await useSessionStore.getState().switchSession("web:code");

    expect(globalThis.localStorage.getItem("hawky:activeKey")).toBe("web:code");
  });

  it("clears persisted key on switchSession failure", async () => {
    globalThis.localStorage.setItem("hawky:activeKey", "web:old");
    mockRpcResponses.set("session.history", new Error("session not found"));

    await useSessionStore.getState().switchSession("web:deleted");

    expect(globalThis.localStorage.getItem("hawky:activeKey")).toBeNull();
  });

  it("falls back to web:general when localStorage is empty", () => {
    globalThis.localStorage.removeItem("hawky:activeKey");
    const fallback = globalThis.localStorage.getItem("hawky:activeKey") ?? "web:general";
    expect(fallback).toBe("web:general");
  });
});

// -----------------------------------------------------------------------------
// Unread persistence — badges must survive a page reload / cross-tab open
// -----------------------------------------------------------------------------

describe("unread persistence (localStorage)", () => {
  beforeEach(() => {
    setupMockRpc();
    resetMockLocalStorage();
    useSessionStore.setState({
      activeKey: "web:general",
      hasUnread: {},
      unreadCounts: {},
      sessions: [],
    });
  });

  it("writes to localStorage when a background agent.text sets hasUnread", () => {
    useSessionStore.getState().handleEvent({
      type: "event",
      event: "agent.text",
      payload: { content: "hi", _sessionKey: "web:other" },
    });

    const raw = globalThis.localStorage.getItem("hawky:unread");
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed.hasUnread["web:other"]).toBe(true);
  });

  it("writes to localStorage when a background agent.done increments the counter", () => {
    useSessionStore.getState().handleEvent({
      type: "event",
      event: "agent.done",
      payload: { type: "done", _sessionKey: "web:other" },
    });

    const raw = globalThis.localStorage.getItem("hawky:unread");
    const parsed = JSON.parse(raw!);
    expect(parsed.counts["web:other"]).toBe(1);
    expect(parsed.hasUnread["web:other"]).toBe(true);
  });

  it("writes to localStorage and updates the OS badge when a background user.message arrives", () => {
    const setAppBadgeMock = vi.fn();
    const clearAppBadgeMock = vi.fn();
    (globalThis as any).navigator.setAppBadge = setAppBadgeMock;
    (globalThis as any).navigator.clearAppBadge = clearAppBadgeMock;

    useSessionStore.setState({
      activeKey: "web:general",
      sessionCache: {},
      unreadCounts: { "web:existing": 2 },
      hasUnread: {},
    });

    useSessionStore.getState().handleEvent({
      type: "event",
      event: "user.message",
      payload: {
        _sessionKey: "web:other",
        text: "from phone",
        timestamp: "2026-04-22T00:00:00.000Z",
      },
    });

    const parsed = JSON.parse(globalThis.localStorage.getItem("hawky:unread")!);
    expect(parsed.counts["web:other"]).toBe(1);
    expect(parsed.counts["web:existing"]).toBe(2);
    expect(parsed.hasUnread["web:other"]).toBe(true);
    expect(setAppBadgeMock).toHaveBeenLastCalledWith(3);
    expect(useSessionStore.getState().sessionCache["web:other"]?.messages[0]?.content).toBe("from phone");
  });

  it("writes the -1 sentinel when a background permission request lands", () => {
    useSessionStore.getState().handleEvent({
      type: "event",
      event: "permission.request",
      payload: {
        _sessionKey: "web:other",
        requestId: "r1",
        tool: "bash",
        input: { command: "ls" },
      },
    });

    const parsed = JSON.parse(globalThis.localStorage.getItem("hawky:unread")!);
    expect(parsed.counts["web:other"]).toBe(-1);
  });

  it("drops the entry from localStorage when user opens the channel via switchSession", async () => {
    // Prime: web:other has an unread badge
    globalThis.localStorage.setItem(
      "hawky:unread",
      JSON.stringify({
        counts: { "web:other": 3 },
        hasUnread: { "web:other": true },
      }),
    );
    useSessionStore.setState({
      unreadCounts: { "web:other": 3 },
      hasUnread: { "web:other": true },
    });
    mockRpcResponses.set("session.history", { messages: [] });

    await useSessionStore.getState().switchSession("web:other");

    const parsed = JSON.parse(globalThis.localStorage.getItem("hawky:unread")!);
    expect(parsed.counts["web:other"]).toBeUndefined();
    expect(parsed.hasUnread["web:other"]).toBeUndefined();
  });

  it("drops the entry from localStorage when user sends a message to that channel", () => {
    useSessionStore.setState({
      activeKey: "web:general",
      unreadCounts: { "web:general": 2 },
      hasUnread: { "web:general": true },
    });

    // sendMessage is fire-and-forget; the unread clear is synchronous.
    void useSessionStore.getState().sendMessage("hello");

    const parsed = JSON.parse(globalThis.localStorage.getItem("hawky:unread")!);
    expect(parsed.counts["web:general"]).toBeUndefined();
    expect(parsed.hasUnread["web:general"]).toBeUndefined();
  });

  it("fetchSessions does NOT prune entries for sessions absent from the response", async () => {
    // Codex P2: session.list is paginated + filtered, so absence from one
    // response doesn't mean the session is gone. We must only prune when
    // we know a session is actually deleted (deleteSession action below).
    globalThis.localStorage.setItem(
      "hawky:unread",
      JSON.stringify({
        counts: { "web:alive": 1, "web:off-page": 5 },
        hasUnread: { "web:alive": true, "web:off-page": true },
      }),
    );
    useSessionStore.setState({
      unreadCounts: { "web:alive": 1, "web:off-page": 5 },
      hasUnread: { "web:alive": true, "web:off-page": true },
    });
    mockRpcResponses.set("session.list", {
      sessions: [
        { id: "web/alive", createdAt: "", messageCount: 1, active: false },
        // web/off-page deliberately not returned (simulates >100 workspaces).
      ],
    });

    await useSessionStore.getState().fetchSessions();

    const state = useSessionStore.getState();
    expect(state.unreadCounts["web:off-page"]).toBe(5);
    expect(state.hasUnread["web:off-page"]).toBe(true);
  });

  it("deleteSession prunes the key + persists + updates the OS badge", async () => {
    const setAppBadgeMock = vi.fn();
    const clearAppBadgeMock = vi.fn();
    (globalThis as any).navigator.setAppBadge = setAppBadgeMock;
    (globalThis as any).navigator.clearAppBadge = clearAppBadgeMock;

    useSessionStore.setState({
      activeKey: "web:general",
      sessions: [
        { id: "web/general", key: "web:general", createdAt: "", messageCount: 1, active: true, isSystem: false },
        { id: "web/gone", key: "web:gone", createdAt: "", messageCount: 1, active: false, isSystem: false },
      ],
      unreadCounts: { "web:gone": 3, "web:kept": 2 },
      hasUnread: { "web:gone": true, "web:kept": true },
    });
    globalThis.localStorage.setItem(
      "hawky:unread",
      JSON.stringify({
        counts: { "web:gone": 3, "web:kept": 2 },
        hasUnread: { "web:gone": true, "web:kept": true },
      }),
    );
    mockRpcResponses.set("session.delete", { ok: true });

    await useSessionStore.getState().deleteSession("web:gone");

    const parsed = JSON.parse(globalThis.localStorage.getItem("hawky:unread")!);
    // The deleted key is gone from memory + storage.
    expect(parsed.counts["web:gone"]).toBeUndefined();
    expect(parsed.hasUnread["web:gone"]).toBeUndefined();
    // But the other key survives.
    expect(parsed.counts["web:kept"]).toBe(2);
    // And the OS badge reflects the new total (2, down from 5).
    expect(setAppBadgeMock).toHaveBeenLastCalledWith(2);
  });

  it("session.renamed remap writes the new key to localStorage", () => {
    globalThis.localStorage.setItem(
      "hawky:unread",
      JSON.stringify({
        counts: { "web:old-name": 4 },
        hasUnread: { "web:old-name": true },
      }),
    );
    useSessionStore.setState({
      activeKey: "web:general",
      unreadCounts: { "web:old-name": 4 },
      hasUnread: { "web:old-name": true },
    });

    useSessionStore.getState().handleEvent({
      type: "event",
      event: "session.renamed",
      payload: { oldKey: "web:old-name", newKey: "web:new-name" },
    });

    const parsed = JSON.parse(globalThis.localStorage.getItem("hawky:unread")!);
    expect(parsed.counts["web:old-name"]).toBeUndefined();
    expect(parsed.counts["web:new-name"]).toBe(4);
    expect(parsed.hasUnread["web:new-name"]).toBe(true);
  });

  it("loadUnread tolerates corrupt localStorage values", () => {
    // Corrupt blob should not crash the module — the store should fall back
    // to empty defaults. We re-import the store to hit the init path.
    globalThis.localStorage.setItem("hawky:unread", "not json {{{");
    // The module-level initial-unread load ran once at import time; we can't
    // re-run it without re-importing, but we can verify the helper is
    // tolerant by inspecting the store's current behavior after reset:
    useSessionStore.setState({ unreadCounts: {}, hasUnread: {} });
    // A subsequent mutation must still succeed and overwrite the bad blob.
    useSessionStore.getState().handleEvent({
      type: "event",
      event: "agent.text",
      payload: { content: "x", _sessionKey: "web:recover" },
    });
    const parsed = JSON.parse(globalThis.localStorage.getItem("hawky:unread")!);
    expect(parsed.hasUnread["web:recover"]).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// buildFullInput — bounded display string derived from tool_use input.
// The UI needs enough text to show the user what ran, but storing the
// raw input on every tool message would eat megabytes for large edits.
// -----------------------------------------------------------------------------

describe("buildFullInput", () => {
  it("returns the full bash command", () => {
    expect(buildFullInput("bash", { command: "ls -la /tmp" })).toBe("ls -la /tmp");
  });

  it("returns file_path for edit_file / write_file / read_file (ignoring large bodies)", () => {
    // The whole point of the cap — edit_file with a huge old_string/new_string
    // must NOT result in the whole thing being stored. We only keep file_path.
    const big = "x".repeat(200_000);
    const result = buildFullInput("edit_file", {
      file_path: "/tmp/foo.md",
      old_string: big,
      new_string: big,
    });
    expect(result).toBe("/tmp/foo.md");
    expect((result ?? "").length).toBeLessThan(100);
  });

  it("returns write_file path (not the 100KB content)", () => {
    const big = "y".repeat(150_000);
    const result = buildFullInput("write_file", { file_path: "/tmp/big.txt", content: big });
    expect(result).toBe("/tmp/big.txt");
  });

  it("returns grep pattern plus path when path is present", () => {
    expect(buildFullInput("grep", { pattern: "TODO", path: "src/" })).toBe("TODO  (in src/)");
    expect(buildFullInput("grep", { pattern: "TODO" })).toBe("TODO");
  });

  it("returns url for web_fetch and query for web_search", () => {
    expect(buildFullInput("web_fetch", { url: "https://x.example" })).toBe("https://x.example");
    expect(buildFullInput("web_search", { query: "llm serving" })).toBe("llm serving");
  });

  it("caps the display string at ~10K chars and marks the truncation", () => {
    const big = "a".repeat(12_000);
    const result = buildFullInput("bash", { command: big });
    expect(result).toBeDefined();
    expect((result ?? "").length).toBeLessThanOrEqual(10_050);
    expect(result).toContain("(truncated)");
  });

  it("falls back to pretty-printed JSON for unknown tools", () => {
    const result = buildFullInput("custom_tool_xyz", { foo: "bar", n: 3 });
    expect(result).toContain("\"foo\"");
    expect(result).toContain("\"bar\"");
    expect(result).toContain("\"n\"");
  });

  it("returns undefined for null/non-object input", () => {
    expect(buildFullInput("bash", null)).toBeUndefined();
    expect(buildFullInput("bash", undefined)).toBeUndefined();
    expect(buildFullInput(undefined, { command: "x" })).toBeUndefined();
  });
});

// -----------------------------------------------------------------------------
// synthesizeMetadataFromInput — recover diff metadata from tool_use input
// -----------------------------------------------------------------------------

describe("synthesizeMetadataFromInput", () => {
  it("rebuilds edit_file metadata from old_string + new_string", () => {
    const meta = synthesizeMetadataFromInput("edit_file", {
      file_path: "/tmp/foo.md",
      old_string: "alpha\nbeta",
      new_string: "alpha\nbeta\ngamma",
    });
    expect(meta).toBeDefined();
    expect(meta!.file_path).toBe("/tmp/foo.md");
    expect(meta!.old_string).toBe("alpha\nbeta");
    expect(meta!.new_string).toBe("alpha\nbeta\ngamma");
    expect(meta!.lines_added).toBe(3);
    expect(meta!.lines_removed).toBe(2);
  });

  it("rebuilds write_file metadata as a new-file diff (old_content === null)", () => {
    // old_content must be null (not ""): the renderer maps null → "" so the
    // diff still shows the full content as added, and formatToolSummary
    // checks `old_content === null` to emit the "New file, N lines" summary
    // on reload. Setting "" here would silently kill the summary line.
    const meta = synthesizeMetadataFromInput("write_file", {
      file_path: "/tmp/new.txt",
      content: "first\nsecond\n",
    });
    expect(meta).toBeDefined();
    expect(meta!.file_path).toBe("/tmp/new.txt");
    expect(meta!.new_content).toBe("first\nsecond\n");
    expect(meta!.old_content).toBeNull();
  });

  it("returns undefined for tools without diffable input", () => {
    expect(synthesizeMetadataFromInput("read_file", { file_path: "/x" })).toBeUndefined();
    expect(synthesizeMetadataFromInput("bash", { command: "ls" })).toBeUndefined();
    expect(synthesizeMetadataFromInput("grep", { pattern: "TODO" })).toBeUndefined();
  });

  it("returns undefined when edit_file is missing required fields", () => {
    expect(synthesizeMetadataFromInput("edit_file", {})).toBeUndefined();
    expect(
      synthesizeMetadataFromInput("edit_file", { old_string: "a" }),
    ).toBeUndefined();
    expect(
      synthesizeMetadataFromInput("edit_file", { new_string: "b" }),
    ).toBeUndefined();
  });

  it("falls back to 'file' when file_path is missing or non-string", () => {
    const meta = synthesizeMetadataFromInput("edit_file", {
      old_string: "a",
      new_string: "b",
    });
    expect(meta!.file_path).toBe("file");
  });

  it("returns undefined for null/non-object input", () => {
    expect(synthesizeMetadataFromInput("edit_file", null)).toBeUndefined();
    expect(synthesizeMetadataFromInput("edit_file", undefined)).toBeUndefined();
    expect(synthesizeMetadataFromInput(undefined, { old_string: "a" })).toBeUndefined();
  });

  it("returns undefined when edit_file diff exceeds MAX_DIFF_METADATA_CHARS", () => {
    // 50_000 cap mirrors the live tool's metadata cap, so an edit that
    // streamed safely (with old_string/new_string nulled out at source) won't
    // suddenly become a giant diff payload after a page reload.
    const big = "x".repeat(50_001);
    expect(
      synthesizeMetadataFromInput("edit_file", { old_string: big, new_string: "ok" }),
    ).toBeUndefined();
    expect(
      synthesizeMetadataFromInput("edit_file", { old_string: "ok", new_string: big }),
    ).toBeUndefined();
    // Just under the cap still works.
    const justUnder = "x".repeat(50_000);
    expect(
      synthesizeMetadataFromInput("edit_file", { old_string: justUnder, new_string: "ok" }),
    ).toBeDefined();
  });

  it("returns undefined when write_file content exceeds MAX_DIFF_METADATA_CHARS", () => {
    const big = "x".repeat(50_001);
    expect(
      synthesizeMetadataFromInput("write_file", { content: big, file_path: "/x" }),
    ).toBeUndefined();
    expect(
      synthesizeMetadataFromInput("write_file", { content: "small", file_path: "/x" }),
    ).toBeDefined();
  });
});

// -----------------------------------------------------------------------------
// History parsing attaches synthesized metadata to historical edit_file
// -----------------------------------------------------------------------------

describe("history parsing — diff recovery", () => {
  it("attaches synthesized metadata to historical edit_file tool_use", async () => {
    setupMockRpc();
    mockRpcResponses.set("session.resolve", { sessionKey: "web:diff-recover" });
    mockRpcResponses.set("session.history", {
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tu_edit",
              name: "edit_file",
              input: {
                file_path: "/home/hao/foo.md",
                old_string: "## Six axes",
                new_string: "## Seven axes",
              },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu_edit",
              content: "File edited successfully",
              is_error: false,
            },
          ],
        },
      ],
    });

    await useSessionStore.getState().switchSession("web:diff-recover");

    const toolMsg = useSessionStore.getState().messages.find((m) => m.role === "tool");
    expect(toolMsg?.tool?.metadata).toBeDefined();
    expect(toolMsg!.tool!.metadata!.old_string).toBe("## Six axes");
    expect(toolMsg!.tool!.metadata!.new_string).toBe("## Seven axes");
    // Output from the tool_result still flows through unchanged.
    expect(toolMsg!.tool!.output).toBe("File edited successfully");
  });

  it("does not attach metadata to historical read_file tool_use", async () => {
    setupMockRpc();
    mockRpcResponses.set("session.resolve", { sessionKey: "web:read-noop" });
    mockRpcResponses.set("session.history", {
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "tu_r", name: "read_file", input: { file_path: "/x" } },
          ],
        },
      ],
    });

    await useSessionStore.getState().switchSession("web:read-noop");
    const toolMsg = useSessionStore.getState().messages.find((m) => m.role === "tool");
    expect(toolMsg?.tool?.metadata).toBeUndefined();
  });

  it("clears synthesized metadata when the historical edit_file failed", async () => {
    // Without this guard, a failed edit (e.g. old_string not found) would
    // still render a green/red diff and a "Added N lines" summary on reload,
    // misleading the user into thinking the file changed when it didn't.
    setupMockRpc();
    mockRpcResponses.set("session.resolve", { sessionKey: "web:diff-error" });
    mockRpcResponses.set("session.history", {
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tu_fail",
              name: "edit_file",
              input: { file_path: "/x.md", old_string: "missing", new_string: "replacement" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu_fail",
              content: "Error: old_string not found in file",
              is_error: true,
            },
          ],
        },
      ],
    });

    await useSessionStore.getState().switchSession("web:diff-error");
    const toolMsg = useSessionStore.getState().messages.find((m) => m.role === "tool");
    expect(toolMsg?.tool?.isError).toBe(true);
    expect(toolMsg?.tool?.metadata).toBeUndefined();
  });

  it("stores a bounded fullInput on historical tool messages for un-truncated display", async () => {
    // inputPreview caps at 80 chars (for labels); fullInput stores the full
    // command/path up to MAX_FULL_INPUT_CHARS so the expanded row can show
    // the whole thing. Critically, we do NOT stash the raw block.input —
    // that would keep megabytes of edit_file old_string/new_string in the
    // store for every tool call in a long session.
    setupMockRpc();
    mockRpcResponses.set("session.resolve", { sessionKey: "web:full-input" });
    const longCmd = "a".repeat(200) + " && echo done";
    mockRpcResponses.set("session.history", {
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tu_bash",
              name: "bash",
              input: { command: longCmd, description: "very long test command" },
            },
          ],
        },
      ],
    });

    await useSessionStore.getState().switchSession("web:full-input");
    const toolMsg = useSessionStore.getState().messages.find((m) => m.role === "tool");
    expect(toolMsg?.tool?.fullInput).toBe(longCmd);
    // inputPreview remains capped for label use.
    expect(toolMsg!.tool!.inputPreview.length).toBeLessThan(longCmd.length);
    // Raw input object is NOT kept on the tool message.
    expect((toolMsg!.tool as Record<string, unknown>).input).toBeUndefined();
  });

  it("attaches synthesized metadata to a successful historical write_file", async () => {
    // Mirror of the edit_file success test, but for write_file: when a
    // tool_result with is_error=false is matched, synthesize metadata
    // from the cached input so DiffView can render the new-file diff.
    setupMockRpc();
    mockRpcResponses.set("session.resolve", { sessionKey: "web:write-recover" });
    mockRpcResponses.set("session.history", {
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tu_write",
              name: "write_file",
              input: { file_path: "/tmp/n.txt", content: "hello\nworld" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu_write",
              content: "ok",
              is_error: false,
            },
          ],
        },
      ],
    });

    await useSessionStore.getState().switchSession("web:write-recover");
    const toolMsg = useSessionStore.getState().messages.find((m) => m.role === "tool");
    expect(toolMsg?.tool?.metadata).toBeDefined();
    expect(toolMsg!.tool!.metadata!.new_content).toBe("hello\nworld");
    // old_content === null is the contract that lets formatToolSummary
    // emit "New file, N lines" on reload (vs "" which would lose the summary).
    expect(toolMsg!.tool!.metadata!.old_content).toBeNull();
    expect(toolMsg?.tool?.status).toBe("success");
  });

  it("reloaded successful write_file produces 'New file, N lines' summary", async () => {
    // Codex P2 round 3: write_file synthesis used to set old_content="",
    // which made formatToolSummary's `=== null` check fail and the
    // "New file, N lines" summary disappeared on reload. This test
    // ties the synthesis contract to the rendering contract — if either
    // side regresses, the summary line goes missing.
    const { formatToolSummary } = await import("../src/utils/toolDisplay");
    setupMockRpc();
    mockRpcResponses.set("session.resolve", { sessionKey: "web:write-summary" });
    mockRpcResponses.set("session.history", {
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tu_w",
              name: "write_file",
              input: { file_path: "/tmp/n.txt", content: "alpha\nbeta\ngamma" },
            },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tu_w", content: "ok", is_error: false },
          ],
        },
      ],
    });

    await useSessionStore.getState().switchSession("web:write-summary");
    const toolMsg = useSessionStore.getState().messages.find((m) => m.role === "tool");
    expect(toolMsg?.tool?.metadata).toBeDefined();
    const summary = formatToolSummary("write_file", toolMsg!.tool!.metadata, false, toolMsg!.tool!.output);
    expect(summary).toBe("New file, 3 lines");
  });

  it("legacy history (tool_use with no tool_result, but transcript continued) marks tool as success + metadata", async () => {
    // Codex P2 round 4: older / legacy session payloads can contain a
    // tool_use without a persisted tool_result, even though the
    // conversation continued past it (proving the tool finished). The
    // post-pass should flip such tools from "running" to "success" and
    // synthesize metadata, otherwise the row would spin forever on reload.
    // The follow-up assistant message has a different timestamp (a
    // new turn) — that's the signal that the prior tool's turn is
    // closed.
    setupMockRpc();
    mockRpcResponses.set("session.resolve", { sessionKey: "web:legacy" });
    mockRpcResponses.set("session.history", {
      messages: [
        { role: "user", content: [{ type: "text", text: "edit it" }], timestamp: "2026-04-23T01:00:00Z" },
        {
          role: "assistant",
          timestamp: "2026-04-23T01:00:01Z",
          content: [
            {
              type: "tool_use",
              id: "tu_legacy",
              name: "edit_file",
              input: { file_path: "/tmp/old.md", old_string: "foo", new_string: "bar" },
            },
          ],
        },
        // No tool_result block — but the assistant continued, so the
        // tool must have finished. Different timestamp = different turn.
        { role: "assistant", content: [{ type: "text", text: "Done." }], timestamp: "2026-04-23T01:00:02Z" },
      ],
    });

    await useSessionStore.getState().switchSession("web:legacy");
    const toolMsg = useSessionStore.getState().messages.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(toolMsg?.tool?.status).toBe("success");
    expect(toolMsg?.tool?.metadata).toBeDefined();
    expect(toolMsg!.tool!.metadata!.old_string).toBe("foo");
    expect(toolMsg!.tool!.metadata!.new_string).toBe("bar");
  });

  it("error orphan stitched onto an older tool with speculative metadata clears that metadata", async () => {
    // Defense-in-depth for the round-3 + round-4 interaction. The post-pass
    // in parseHistoryMessages may speculatively synthesize metadata for a
    // tool_use whose transcript continued past it. If a later orphan
    // tool_result arrives revealing the tool actually failed, the orphan
    // applier MUST clear the speculative metadata so the row doesn't keep
    // showing a fake green/red diff for a failed change.
    setupMockRpc();
    mockRpcResponses.set("session.resolve", { sessionKey: "web:err-orphan-pp" });
    // Newer chunk: an orphan tool_result with is_error=true.
    mockRpcResponses.set("session.history", {
      messages: [
        {
          index: 4,
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu_pp",
              content: "boom",
              is_error: true,
            },
          ],
        },
        { index: 5, role: "assistant", content: [{ type: "text", text: "Sorry, edit failed." }] },
      ],
      total: 6,
      hasMore: true,
    });
    await useSessionStore.getState().switchSession("web:err-orphan-pp");

    // Older chunk: tool_use with continuation past it (so the post-pass
    // would speculatively flip it to success + synthesize metadata).
    mockRpcResponses.set("session.history", {
      messages: [
        { index: 1, role: "user", content: [{ type: "text", text: "rename foo to bar" }] },
        {
          index: 2,
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tu_pp",
              name: "edit_file",
              input: { file_path: "/tmp/x.md", old_string: "foo", new_string: "bar" },
            },
          ],
        },
        // Continuation past the tool_use → post-pass thinks success.
        { index: 3, role: "assistant", content: [{ type: "text", text: "Working on it" }] },
      ],
      total: 6,
      hasMore: false,
    });
    await useSessionStore.getState().loadOlderMessages();

    const toolMsg = useSessionStore
      .getState()
      .messages.find((m) => m.role === "tool" && m.tool?.toolUseId === "tu_pp");
    expect(toolMsg).toBeDefined();
    expect(toolMsg?.tool?.isError).toBe(true);
    expect(toolMsg?.tool?.status).toBe("error");
    // The load-bearing assertion: speculative metadata is gone.
    expect(toolMsg?.tool?.metadata).toBeUndefined();
  });

  it("parallel in-flight tool_use batch keeps ALL tools as 'running', not just the last (regression guard)", async () => {
    // Codex P2 round 5: when the agent emits multiple tool_use blocks in
    // a single assistant turn (parallel batch) and the page reload lands
    // before any tool_result arrives, every tool message in the batch is
    // followed by another tool message — so a flat "any later message
    // means completed" rule wrongly flipped the first N-1 to success and
    // leaked synthesized diffs. The post-pass must only treat the
    // trailing tail of contiguous unresolved tool messages as in-flight.
    setupMockRpc();
    mockRpcResponses.set("session.resolve", { sessionKey: "web:parallel-inflight" });
    mockRpcResponses.set("session.history", {
      messages: [
        { role: "user", content: [{ type: "text", text: "edit two files" }], timestamp: "2026-04-23T01:00:00Z" },
        {
          role: "assistant",
          // All three tool_use blocks come from a single assistant
          // turn → they share the same timestamp; the post-pass uses
          // that to recognize them all as part of the trailing turn.
          timestamp: "2026-04-23T01:00:01Z",
          content: [
            {
              type: "tool_use",
              id: "tu_p1",
              name: "edit_file",
              input: { file_path: "/tmp/a.md", old_string: "foo", new_string: "bar" },
            },
            {
              type: "tool_use",
              id: "tu_p2",
              name: "edit_file",
              input: { file_path: "/tmp/b.md", old_string: "baz", new_string: "qux" },
            },
            {
              type: "tool_use",
              id: "tu_p3",
              name: "write_file",
              input: { file_path: "/tmp/c.md", content: "hello" },
            },
          ],
        },
        // No tool_results — entire batch is still in flight.
      ],
    });

    await useSessionStore.getState().switchSession("web:parallel-inflight");
    const state = useSessionStore.getState();
    const t1 = state.messages.find((m) => m.tool?.toolUseId === "tu_p1");
    const t2 = state.messages.find((m) => m.tool?.toolUseId === "tu_p2");
    const t3 = state.messages.find((m) => m.tool?.toolUseId === "tu_p3");
    expect(t1?.tool?.status).toBe("running");
    expect(t2?.tool?.status).toBe("running");
    expect(t3?.tool?.status).toBe("running");
    expect(t1?.tool?.metadata).toBeUndefined();
    expect(t2?.tool?.metadata).toBeUndefined();
    expect(t3?.tool?.metadata).toBeUndefined();
  });

  it("interleaved in-flight turn (tool_use → text → tool_use, no results) keeps both tools 'running' (regression guard)", async () => {
    // Codex P2 round 6: an assistant message can mix tool_use blocks
    // and text blocks (e.g. "Reading two files… [tool_use a]
    // …then writing… [tool_use b]"). My parser splits this into
    // [tool a, assistant text, tool b]. With a contiguous-tail rule
    // the text breaks the tail and tool a wrongly flips to success.
    // Timestamp grouping fixes it: all three messages share the same
    // source timestamp, so they're recognized as one trailing turn.
    setupMockRpc();
    mockRpcResponses.set("session.resolve", { sessionKey: "web:interleaved-inflight" });
    mockRpcResponses.set("session.history", {
      messages: [
        { role: "user", content: [{ type: "text", text: "do two things" }], timestamp: "2026-04-23T01:00:00Z" },
        {
          role: "assistant",
          timestamp: "2026-04-23T01:00:01Z",
          content: [
            {
              type: "tool_use",
              id: "tu_a",
              name: "edit_file",
              input: { file_path: "/tmp/a.md", old_string: "foo", new_string: "bar" },
            },
            { type: "text", text: "Reading the second file..." },
            {
              type: "tool_use",
              id: "tu_b",
              name: "edit_file",
              input: { file_path: "/tmp/b.md", old_string: "baz", new_string: "qux" },
            },
          ],
        },
        // No tool_results — entire interleaved turn is in-flight.
      ],
    });

    await useSessionStore.getState().switchSession("web:interleaved-inflight");
    const state = useSessionStore.getState();
    const tA = state.messages.find((m) => m.tool?.toolUseId === "tu_a");
    const tB = state.messages.find((m) => m.tool?.toolUseId === "tu_b");
    expect(tA?.tool?.status).toBe("running");
    expect(tB?.tool?.status).toBe("running");
    expect(tA?.tool?.metadata).toBeUndefined();
    expect(tB?.tool?.metadata).toBeUndefined();
  });

  it("leaves an in-flight historical edit_file as 'running' with no metadata (regression guard)", async () => {
    // Codex P2 follow-up: a page reload that lands mid-tool would
    // otherwise display a synthesized diff for an edit that hasn't
    // finished and may still fail. With no matching tool_result, the
    // tool message must stay status='running' and have no metadata so
    // ToolLine renders the spinner, not a fake completed diff.
    setupMockRpc();
    mockRpcResponses.set("session.resolve", { sessionKey: "web:in-flight" });
    mockRpcResponses.set("session.history", {
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tu_inflight",
              name: "edit_file",
              input: { file_path: "/tmp/x.md", old_string: "foo", new_string: "bar" },
            },
          ],
        },
        // No tool_result — tool was still running when history was captured.
      ],
    });

    await useSessionStore.getState().switchSession("web:in-flight");
    const toolMsg = useSessionStore.getState().messages.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(toolMsg?.tool?.status).toBe("running");
    expect(toolMsg?.tool?.metadata).toBeUndefined();
    expect(toolMsg?.tool?.isError).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Matrix cells that were only covered implicitly — pinning explicit tests
  // so the coherent post-pass algorithm stays correct across future edits.
  // -------------------------------------------------------------------------

  it("case 3 (cross-page success edit_file): orphan stitch synthesizes diff metadata", async () => {
    // Covers the edit_file variant of the existing cross-page test (which
    // uses bash, and so has no metadata to synthesize). On stitch we must
    // rebuild old_string/new_string from the cached tool_use input so the
    // green/red diff reappears on infinite-scroll.
    setupMockRpc();
    mockRpcResponses.set("session.resolve", { sessionKey: "web:xpage-edit" });

    // Newer chunk: tool_result for tu_x (success). No matching tool_use
    // here — it lives in the older chunk.
    mockRpcResponses.set("session.history", {
      messages: [
        {
          index: 4,
          role: "user",
          timestamp: "2026-04-23T01:00:02Z",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu_x",
              content: "ok",
              is_error: false,
            },
          ],
        },
        {
          index: 5,
          role: "assistant",
          timestamp: "2026-04-23T01:00:03Z",
          content: [{ type: "text", text: "done." }],
        },
      ],
      total: 6,
      hasMore: true,
    });
    await useSessionStore.getState().switchSession("web:xpage-edit");

    // Older chunk: the matching edit_file tool_use.
    mockRpcResponses.set("session.history", {
      messages: [
        {
          index: 2,
          role: "user",
          timestamp: "2026-04-23T01:00:00Z",
          content: [{ type: "text", text: "rename foo to bar" }],
        },
        {
          index: 3,
          role: "assistant",
          timestamp: "2026-04-23T01:00:01Z",
          content: [
            {
              type: "tool_use",
              id: "tu_x",
              name: "edit_file",
              input: { file_path: "/tmp/x.md", old_string: "foo", new_string: "bar" },
            },
          ],
        },
      ],
      total: 6,
      hasMore: false,
    });
    await useSessionStore.getState().loadOlderMessages();

    const toolMsg = useSessionStore
      .getState()
      .messages.find((m) => m.role === "tool" && m.tool?.toolUseId === "tu_x");
    expect(toolMsg).toBeDefined();
    expect(toolMsg?.tool?.status).toBe("success");
    expect(toolMsg?.tool?.isError).toBe(false);
    expect(toolMsg?.tool?.metadata).toBeDefined();
    expect(toolMsg!.tool!.metadata!.old_string).toBe("foo");
    expect(toolMsg!.tool!.metadata!.new_string).toBe("bar");
  });

  it("case 9 (legacy cross-page): older page legacy tool_use flips to success after merge with newer page", async () => {
    // The failure mode that rounds 4–7 kept re-introducing. The older
    // page, parsed in isolation, ends in a trailing tool_use with no
    // tool_result and nothing after — so parseHistoryMessages (correctly,
    // in isolation) leaves it "running". But the already-loaded newer
    // page already has messages after it, proving the tool finished.
    // The re-pass on the MERGED window must reclassify the legacy tool
    // to "success" and synthesize its diff metadata. Without this the
    // row spins forever across the pagination boundary.
    setupMockRpc();
    mockRpcResponses.set("session.resolve", { sessionKey: "web:xpage-legacy" });

    // Newer chunk: assistant continuation text (no tool_result at all,
    // since this is the legacy shape where tool_result was never
    // persisted).
    mockRpcResponses.set("session.history", {
      messages: [
        {
          index: 4,
          role: "assistant",
          timestamp: "2026-04-23T01:00:02Z",
          content: [{ type: "text", text: "edit applied." }],
        },
      ],
      total: 5,
      hasMore: true,
    });
    await useSessionStore.getState().switchSession("web:xpage-legacy");

    // Older chunk ENDS in the tool_use (nothing after it in this page).
    mockRpcResponses.set("session.history", {
      messages: [
        {
          index: 2,
          role: "user",
          timestamp: "2026-04-23T01:00:00Z",
          content: [{ type: "text", text: "fix the typo" }],
        },
        {
          index: 3,
          role: "assistant",
          timestamp: "2026-04-23T01:00:01Z",
          content: [
            {
              type: "tool_use",
              id: "tu_legacy_x",
              name: "edit_file",
              input: { file_path: "/tmp/x.md", old_string: "teh", new_string: "the" },
            },
          ],
        },
      ],
      total: 5,
      hasMore: false,
    });
    await useSessionStore.getState().loadOlderMessages();

    const toolMsg = useSessionStore
      .getState()
      .messages.find((m) => m.role === "tool" && m.tool?.toolUseId === "tu_legacy_x");
    expect(toolMsg).toBeDefined();
    // Load-bearing: status flipped from "running" (per-page parse) to
    // "success" by the merged-window re-pass.
    expect(toolMsg?.tool?.status).toBe("success");
    expect(toolMsg?.tool?.metadata).toBeDefined();
    expect(toolMsg!.tool!.metadata!.old_string).toBe("teh");
    expect(toolMsg!.tool!.metadata!.new_string).toBe("the");
  });

  it("case 10 (no timestamps): timestamp-less tools are NOT reclassified — live-streaming protection", async () => {
    // Without timestamps the algorithm cannot tell historical from live
    // streaming data, and live tool_use_start events carry no timestamp.
    // The conservative rule: leave timestamp-less tools alone. A
    // reclassification mistake here would hide a spinner on a real
    // in-flight tool. History-reclassification still works because
    // historical messages always carry timestamps; this fallback only
    // affects degenerate / test-only data.
    setupMockRpc();
    mockRpcResponses.set("session.resolve", { sessionKey: "web:no-ts" });
    mockRpcResponses.set("session.history", {
      messages: [
        { role: "user", content: [{ type: "text", text: "do two edits" }] },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tu_a_nots",
              name: "edit_file",
              input: { file_path: "/tmp/a.md", old_string: "a", new_string: "A" },
            },
          ],
        },
        { role: "assistant", content: [{ type: "text", text: "next" }] },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tu_b_nots",
              name: "edit_file",
              input: { file_path: "/tmp/b.md", old_string: "b", new_string: "B" },
            },
          ],
        },
      ],
    });

    await useSessionStore.getState().switchSession("web:no-ts");
    const state = useSessionStore.getState();
    const tA = state.messages.find((m) => m.tool?.toolUseId === "tu_a_nots");
    const tB = state.messages.find((m) => m.tool?.toolUseId === "tu_b_nots");
    // Both stay "running" — missing timestamps → conservative default.
    // The alternative (using position-based fallback) caused a Codex
    // P1 regression where mid-turn parallel batches were corrupted
    // during pagination.
    expect(tA?.tool?.status).toBe("running");
    expect(tA?.tool?.metadata).toBeUndefined();
    expect(tB?.tool?.status).toBe("running");
    expect(tB?.tool?.metadata).toBeUndefined();
  });

  it("case P1 regression (live streaming merged with paginated history): live tools stay running AND historical legacy tools still reclassify", async () => {
    // Concrete Codex P1 (twice-iterated): mid-turn user scrolls back.
    // state.messages contains live-streamed tool_use_start messages
    // (no timestamp) alongside historical ones. Two load-bearing rules:
    //   (1) live timestamp-less tools must NOT be flipped to success;
    //   (2) historical legacy tools in the older page MUST still be
    //       reclassified to success using the last historical
    //       timestamp as the trailing-turn reference (not the live tail).
    setupMockRpc();
    mockRpcResponses.set("session.resolve", { sessionKey: "web:live-paginate" });
    // Initial page: historical conversation with an assistant reply.
    mockRpcResponses.set("session.history", {
      messages: [
        {
          index: 4,
          role: "user",
          timestamp: "2026-04-23T01:00:04Z",
          content: [{ type: "text", text: "hello" }],
        },
        {
          index: 5,
          role: "assistant",
          timestamp: "2026-04-23T01:00:05Z",
          content: [{ type: "text", text: "hi" }],
        },
      ],
      total: 6,
      hasMore: true,
    });
    await useSessionStore.getState().switchSession("web:live-paginate");

    // Simulate a live-streaming parallel batch landing: two tool_use
    // events, neither resolved. These have NO timestamp (matches
    // production shape of tool messages created via agent.tool_use_start).
    useSessionStore.setState({
      messages: [
        ...useSessionStore.getState().messages,
        {
          id: "live-1",
          role: "tool" as const,
          content: "",
          tool: {
            toolUseId: "live_tu_1",
            name: "edit_file",
            inputPreview: "/tmp/x.md",
            status: "running",
            output: "",
            isError: false,
          },
        },
        {
          id: "live-2",
          role: "tool" as const,
          content: "",
          tool: {
            toolUseId: "live_tu_2",
            name: "edit_file",
            inputPreview: "/tmp/y.md",
            status: "running",
            output: "",
            isError: false,
          },
        },
      ],
    });

    // User scrolls back: older page ENDS with a legacy tool_use whose
    // continuation is already proven by the already-loaded historical
    // messages. This tool MUST be reclassified to success, not left
    // spinning just because the window currently trails in live events.
    mockRpcResponses.set("session.history", {
      messages: [
        {
          index: 2,
          role: "user",
          timestamp: "2026-04-23T01:00:02Z",
          content: [{ type: "text", text: "fix typo" }],
        },
        {
          index: 3,
          role: "assistant",
          timestamp: "2026-04-23T01:00:03Z",
          content: [
            {
              type: "tool_use",
              id: "tu_legacy_live",
              name: "edit_file",
              input: { file_path: "/tmp/z.md", old_string: "teh", new_string: "the" },
            },
          ],
        },
      ],
      total: 6,
      hasMore: false,
    });
    await useSessionStore.getState().loadOlderMessages();

    const state = useSessionStore.getState();
    const legacy = state.messages.find((m) => m.tool?.toolUseId === "tu_legacy_live");
    const live1 = state.messages.find((m) => m.tool?.toolUseId === "live_tu_1");
    const live2 = state.messages.find((m) => m.tool?.toolUseId === "live_tu_2");

    // (1) Live tools preserved.
    expect(live1?.tool?.status).toBe("running");
    expect(live2?.tool?.status).toBe("running");
    expect(live1?.tool?.metadata).toBeUndefined();
    expect(live2?.tool?.metadata).toBeUndefined();

    // (2) Legacy historical tool reclassified using the last
    //     HISTORICAL timestamp as the trailing-turn reference.
    expect(legacy?.tool?.status).toBe("success");
    expect(legacy?.tool?.metadata).toBeDefined();
    expect(legacy!.tool!.metadata!.old_string).toBe("teh");
    expect(legacy!.tool!.metadata!.new_string).toBe("the");
  });
});

// =============================================================================
// task.update event + task.list RPC seeding
// =============================================================================

describe("task chip state", () => {
  beforeEach(() => {
    useSocketStore.setState({
      status: "connected",
      error: null,
      client: null,
      rpc: vi.fn(async () => ({})) as any,
      connect: vi.fn() as any,
      disconnect: vi.fn(),
      subscribe: vi.fn(() => () => {}),
      eventListeners: new Set(),
    });
    useSessionStore.setState({
      sessions: [],
      activeKey: "web:general",
      messages: [],
      loading: false,
      taskSummary: null,
      sessionCache: {},
      unreadCounts: {},
      hasUnread: {},
    } as any);
  });

  function fire(event: string, payload: Record<string, unknown>, sessionKey = "web:general") {
    useSessionStore.getState().handleEvent({
      type: "event",
      event,
      payload: { ...payload, _sessionKey: sessionKey },
    } as any);
  }

  const sampleSummary = {
    tasks: [
      { id: "task_1", description: "fix bug", status: "in_progress" as const, created_at: "2026-01-01T00:00:00Z" },
      { id: "task_2", description: "write test", status: "pending" as const, created_at: "2026-01-01T00:00:00Z" },
    ],
    total: 2,
    completed: 0,
    in_progress: 1,
    pending: 1,
  };

  it("active-session task.update writes to top-level taskSummary", () => {
    fire("task.update", { summary: sampleSummary });
    expect(useSessionStore.getState().taskSummary).toEqual(sampleSummary);
  });

  it("background-session task.update writes only to that session's cache, not active", () => {
    fire("task.update", { summary: sampleSummary }, "web:other");
    expect(useSessionStore.getState().taskSummary).toBeNull();
    const cached = useSessionStore.getState().sessionCache["web:other"];
    expect(cached?.taskSummary).toEqual(sampleSummary);
  });

  it("background task.update does NOT mark the session as unread (Codex P2 regression)", () => {
    // task.update is a silent state-sync event. It must not bold the
    // sidebar channel name the way user.message / agent.done do.
    useSessionStore.setState({ hasUnread: {}, unreadCounts: {} } as any);
    fire("task.update", { summary: sampleSummary }, "web:background");
    expect(useSessionStore.getState().hasUnread["web:background"]).toBeUndefined();
    expect(useSessionStore.getState().unreadCounts["web:background"]).toBeUndefined();
    // But the cached taskSummary IS updated.
    expect(useSessionStore.getState().sessionCache["web:background"]?.taskSummary).toEqual(sampleSummary);
  });

  it("task.update with an empty summary clears the chip state", () => {
    // Start with tasks, then receive a clear (simulating /new).
    useSessionStore.setState({ taskSummary: sampleSummary } as any);
    fire("task.update", {
      summary: { tasks: [], total: 0, completed: 0, in_progress: 0, pending: 0 },
    });
    expect(useSessionStore.getState().taskSummary?.total).toBe(0);
  });

  it("missing summary on task.update is ignored (no NPE)", () => {
    useSessionStore.setState({ taskSummary: sampleSummary } as any);
    fire("task.update", {});
    // State unchanged.
    expect(useSessionStore.getState().taskSummary).toEqual(sampleSummary);
  });

  it("deleteSession drops the cached session entry so a reused key starts fresh (Codex P2 regression)", async () => {
    // Codex P2: after deleteSession, sessionCache still held the old
    // session's state — including taskSummary. Recreating the same
    // sessionKey would briefly show the dead session's chip until
    // task.list RPC returned.
    const mockRpc = vi.fn(async () => ({}));
    useSocketStore.setState({
      status: "connected",
      error: null,
      client: null,
      rpc: mockRpc as any,
      connect: vi.fn() as any,
      disconnect: vi.fn(),
      subscribe: vi.fn(() => () => {}),
      eventListeners: new Set(),
    });
    useSessionStore.setState({
      sessions: [
        { id: "web/doomed", key: "web:doomed", createdAt: "", messageCount: 0, active: false, isSystem: false },
        { id: "web/survivor", key: "web:survivor", createdAt: "", messageCount: 0, active: false, isSystem: false },
      ],
      activeKey: "web:survivor",
      messages: [],
      loading: false,
      taskSummary: null,
      sessionCache: {
        "web:doomed": {
          messages: [],
          agentStatus: "idle",
          statusLabel: "",
          contextUsagePercent: null,
          sessionTokens: null,
          sessionCostUSD: null,
          pendingPermission: null,
          pendingAskUser: null,
          taskSummary: sampleSummary,
        },
      },
      unreadCounts: {},
      hasUnread: {},
    } as any);

    await useSessionStore.getState().deleteSession("web:doomed");

    // The dead session's cache entry is gone so a reused sessionKey
    // would not inherit its stale taskSummary.
    expect(useSessionStore.getState().sessionCache["web:doomed"]).toBeUndefined();
  });

  it("deleting the ACTIVE session does not re-cache its stale state via fallback switchSession (Codex P2 regression)", async () => {
    // Bug: switchSession unconditionally writes the previous session's
    // state to sessionCache[prevKey] before moving on. When
    // deleteSession removes the ACTIVE session, it then calls
    // switchSession() as the fallback — which immediately writes the
    // just-deleted key's state back to the cache. Recreating the
    // same key later would briefly surface the dead session's
    // taskSummary.
    const rpc = vi.fn(async (method: string) => {
      if (method === "session.history") return { messages: [] };
      if (method === "session.currentTurn") return {};
      if (method === "task.list") return { summary: null };
      return {};
    });
    useSocketStore.setState({
      status: "connected", error: null, client: null, rpc: rpc as any,
      connect: vi.fn() as any, disconnect: vi.fn(),
      subscribe: vi.fn(() => () => {}), eventListeners: new Set(),
    });
    useSessionStore.setState({
      sessions: [
        { id: "web/active-doomed", key: "web:active-doomed", createdAt: "", messageCount: 0, active: true, isSystem: false },
        { id: "web/survivor", key: "web:survivor", createdAt: "", messageCount: 0, active: false, isSystem: false },
      ],
      activeKey: "web:active-doomed", // this one is ACTIVE
      messages: [],
      taskSummary: sampleSummary, // the dead session has live task state
      sessionCache: {},
      unreadCounts: {}, hasUnread: {},
    } as any);

    await useSessionStore.getState().deleteSession("web:active-doomed");
    // Let the fire-and-forget switchSession run its cache-save branch.
    await new Promise((r) => setTimeout(r, 0));

    // The deleted session must NOT have been written back into the
    // cache by the fallback switch. Otherwise recreating this key
    // would inherit the dead session's chip.
    expect(useSessionStore.getState().sessionCache["web:active-doomed"]).toBeUndefined();
  });

  it("archiveSession also drops the cached entry", async () => {
    const mockRpc = vi.fn(async () => ({}));
    useSocketStore.setState({
      status: "connected",
      error: null,
      client: null,
      rpc: mockRpc as any,
      connect: vi.fn() as any,
      disconnect: vi.fn(),
      subscribe: vi.fn(() => () => {}),
      eventListeners: new Set(),
    });
    useSessionStore.setState({
      sessions: [
        { id: "web/archive-me", key: "web:archive-me", createdAt: "", messageCount: 0, active: false, isSystem: false },
        { id: "web/other", key: "web:other", createdAt: "", messageCount: 0, active: false, isSystem: false },
      ],
      activeKey: "web:other",
      taskSummary: null,
      sessionCache: {
        "web:archive-me": {
          messages: [],
          agentStatus: "idle",
          statusLabel: "",
          contextUsagePercent: null,
          sessionTokens: null,
          sessionCostUSD: null,
          pendingPermission: null,
          pendingAskUser: null,
          taskSummary: sampleSummary,
        },
      },
    } as any);

    await useSessionStore.getState().archiveSession("web:archive-me");
    expect(useSessionStore.getState().sessionCache["web:archive-me"]).toBeUndefined();
  });

  it("stale task.list from an older switch does NOT clobber newer state (Codex P2 regression)", async () => {
    // Scenario: A → B → A with a slow task.list for the first switch
    // to A. If the first response resolves after the second switch
    // has started, it must be dropped — not written over the newer
    // state.
    const staleFromFirstSwitch: TaskSummary = {
      tasks: [{ id: "task_1", description: "stale A", status: "pending", created_at: "" }],
      total: 1, completed: 0, in_progress: 0, pending: 1,
    };

    let resolveFirst: (v: any) => void = () => {};
    const firstPromise = new Promise((r) => { resolveFirst = r; });
    // Two sequential task.list RPCs: the first for the first A, the
    // second for the re-switch back to A. We arrange the second to
    // resolve "empty" (no tasks) and want to prove the first doesn't
    // retroactively replace that state.
    let taskCallCount = 0;
    const rpc = vi.fn(async (method: string) => {
      if (method === "session.history") return { messages: [] };
      if (method === "session.currentTurn") return {};
      if (method === "task.list") {
        taskCallCount++;
        if (taskCallCount === 1) return firstPromise;
        return { sessionKey: "web:stale", summary: null };
      }
      return {};
    });
    useSocketStore.setState({ rpc } as any);

    // First switch to A.
    await useSessionStore.getState().switchSession("web:stale");
    // Switch to B to bump the token.
    await useSessionStore.getState().switchSession("web:other");
    // Switch back to A — this starts a NEW token.
    await useSessionStore.getState().switchSession("web:stale");

    // State after the second A-switch: task.list #2 resolved with
    // null summary → taskSummary unchanged (still null).
    expect(useSessionStore.getState().taskSummary).toBeNull();

    // Now the first task.list resolves (late). It must be dropped —
    // not overwrite the current state.
    resolveFirst({ sessionKey: "web:stale", summary: staleFromFirstSwitch });
    await Promise.resolve(); await Promise.resolve();

    expect(useSessionStore.getState().taskSummary).toBeNull();
  });

  it("task.update during switchSession's in-flight task.list is NOT overwritten by the RPC (Codex P2 regression)", async () => {
    // Two-part guarantee (race-safe + non-blocking):
    //   1. task.list is fired in parallel with session.history — does
    //      NOT block main hydration. A slow task.list must not stall
    //      the main render.
    //   2. If a task.update event arrives while task.list is still in
    //      flight, the chip must stay on the newer event data when
    //      task.list eventually resolves (no regression).
    const staleFromRpc: TaskSummary = {
      tasks: [{ id: "task_1", description: "stale", status: "pending", created_at: "" }],
      total: 1, completed: 0, in_progress: 0, pending: 1,
    };
    const freshFromEvent: TaskSummary = {
      tasks: [
        { id: "task_1", description: "stale", status: "completed", created_at: "" },
        { id: "task_2", description: "newer", status: "pending", created_at: "" },
      ],
      total: 2, completed: 1, in_progress: 0, pending: 1,
    };

    let resolveTaskRpc: (v: any) => void = () => {};
    const taskRpcPromise = new Promise((r) => { resolveTaskRpc = r; });
    const rpc = vi.fn(async (method: string) => {
      if (method === "session.history") return { messages: [] };
      if (method === "session.currentTurn") return {};
      if (method === "task.list") return taskRpcPromise;
      return {};
    });
    useSocketStore.setState({ rpc } as any);

    // switchSession should complete even while task.list is still
    // pending — the main flow doesn't block on it.
    await useSessionStore.getState().switchSession("web:race");
    expect(useSessionStore.getState().loading).toBe(false);

    // Now inject a newer task.update event — chip reflects it.
    fire("task.update", { summary: freshFromEvent }, "web:race");
    expect(useSessionStore.getState().taskSummary).toEqual(freshFromEvent);

    // Resolve the still-pending task.list RPC with stale data. The
    // fire-and-forget applier must NOT clobber the fresher state.
    resolveTaskRpc({ sessionKey: "web:race", summary: staleFromRpc });
    await Promise.resolve(); await Promise.resolve(); // settle microtasks

    expect(useSessionStore.getState().taskSummary).toEqual(freshFromEvent);
  });
});
