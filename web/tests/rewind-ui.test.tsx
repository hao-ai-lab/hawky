// =============================================================================
// Test: Rewind UI (Part 2)
//
// Covers the web pieces that land on top of the chat.rewind backend RPC:
//   - Store action `rewindAndSend` — optimistic truncate + RPC + resend
//   - `session.rewound` event handler — sibling-tab refresh
//   - MessageBubble edit mode — pencil → textarea → Send → rewindAndSend
//
// Backend is mocked (the socket store's rpc function).
// =============================================================================

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { useSessionStore, type SessionMessage } from "../src/store/session-store";
import { useSocketStore } from "../src/store/socket-store";
import { ChatView } from "../src/components/ChatView";

// -----------------------------------------------------------------------------
// Setup
// -----------------------------------------------------------------------------

let rpcCalls: Array<{ method: string; params: unknown }>;

function setupStores(messages: SessionMessage[] = []) {
  rpcCalls = [];
  useSocketStore.setState({
    status: "connected",
    error: null,
    client: null,
    eventListeners: new Set(),
    rpc: vi.fn(async (method: string, params: unknown) => {
      rpcCalls.push({ method, params });
      // chat.rewind → returns a fake ack; chat.send → fire-and-forget.
      if (method === "chat.rewind") {
        return { rewound: true, droppedCount: 2, sideEffects: { filesModified: 0, bashCommands: 0, webRequests: 0, cronJobsCreated: 0, subagentsSpawned: 0 } };
      }
      return {};
    }) as any,
    connect: vi.fn() as any,
    disconnect: vi.fn(),
    subscribe: vi.fn(() => () => {}),
  });
  useSessionStore.setState({
    activeKey: "web:test",
    messages,
    agentStatus: "idle",
    statusLabel: "",
    sessions: [],
    loading: false,
    sessionCache: {},
    hasUnread: {},
    unreadCounts: {},
    // Default to "no older pages" so the edit pencil appears unless a
    // specific test opts in to the hasMore-true branch.
    historyMeta: { oldestLoadedIndex: 0, hasMore: false, loadingOlder: false },
  } as any);
}

beforeEach(() => {
  setupStores();
});

// -----------------------------------------------------------------------------
// Store action: rewindAndSend
// -----------------------------------------------------------------------------

describe("rewindAndSend store action", () => {
  it("optimistically truncates messages at the given backendIndex", async () => {
    setupStores([
      { id: "1", role: "user", content: "turn 1", backendIndex: 0 },
      { id: "2", role: "assistant", content: "reply 1", backendIndex: 1 },
      { id: "3", role: "user", content: "turn 2", backendIndex: 2 },
      { id: "4", role: "assistant", content: "reply 2", backendIndex: 3 },
      { id: "5", role: "user", content: "turn 3", backendIndex: 4 },
    ]);
    // Rewind to backend index 2 (the second user bubble). Drop everything
    // at-or-after that index, keeping only messages 0 and 1.
    await act(async () => {
      await useSessionStore.getState().rewindAndSend(2, "new message");
    });
    const remaining = useSessionStore.getState().messages;
    expect(remaining.length).toBeGreaterThanOrEqual(2);
    expect(remaining[0].content).toBe("turn 1");
    expect(remaining[1].content).toBe("reply 1");
    expect(remaining.find((m) => m.id === "3")).toBeUndefined();
    expect(remaining.find((m) => m.id === "4")).toBeUndefined();
    expect(remaining.find((m) => m.id === "5")).toBeUndefined();
  });

  it("calls chat.rewind with the given messageIndex", async () => {
    setupStores([
      { id: "1", role: "user", content: "u0", backendIndex: 0 },
      { id: "2", role: "user", content: "u1", backendIndex: 5 },
    ]);
    await act(async () => {
      await useSessionStore.getState().rewindAndSend(5, "replacement");
    });
    const rewind = rpcCalls.find((c) => c.method === "chat.rewind");
    expect(rewind).toBeDefined();
    const params = rewind!.params as { sessionKey: string; messageIndex: number };
    expect(params.sessionKey).toBe("web:test");
    expect(params.messageIndex).toBe(5);
  });

  it("calls chat.send with the new message after rewind", async () => {
    setupStores([{ id: "1", role: "user", content: "u0", backendIndex: 0 }]);
    await act(async () => {
      await useSessionStore.getState().rewindAndSend(0, "fresh start");
    });
    const send = rpcCalls.find((c) => c.method === "chat.send");
    expect(send).toBeDefined();
    const sendParams = send!.params as { message: string; sessionKey: string };
    expect(sendParams.message).toBe("fresh start");
  });

  it("surfaces a system error if chat.rewind rejects", async () => {
    setupStores([
      { id: "1", role: "user", content: "u0", backendIndex: 0 },
      { id: "2", role: "user", content: "u1", backendIndex: 1 },
    ]);
    useSocketStore.setState({
      rpc: vi.fn(async (method: string) => {
        if (method === "chat.rewind") throw new Error("boom");
        if (method === "session.resolve") return { sessionKey: "web:test" };
        if (method === "session.history") return { messages: [] };
        return {};
      }) as any,
    } as any);
    await act(async () => {
      await useSessionStore.getState().rewindAndSend(0, "x");
    });
    const systemErr = useSessionStore
      .getState()
      .messages.find((m) => m.role === "system" && String(m.content).includes("Rewind failed"));
    expect(systemErr).toBeDefined();
  });
});

// -----------------------------------------------------------------------------
// session.rewound event handler
// -----------------------------------------------------------------------------

describe("session.rewound event handler", () => {
  it("refetches history for the active session when the event fires", async () => {
    setupStores([
      { id: "1", role: "user", content: "u0" },
      { id: "2", role: "assistant", content: "a0" },
    ]);
    // Swap rpc to a capturing mock that records session.history calls.
    let historyFetches = 0;
    useSocketStore.setState({
      rpc: vi.fn(async (method: string) => {
        if (method === "session.resolve") return { sessionKey: "web:test" };
        if (method === "session.history") {
          historyFetches++;
          return { messages: [] };
        }
        return {};
      }) as any,
    } as any);

    act(() => {
      useSessionStore.getState().handleEvent({
        type: "event",
        event: "session.rewound",
        payload: { sessionKey: "web:test", droppedCount: 2, keptCount: 0 },
      } as any);
    });
    // switchSession is async — give it a microtask to run
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(historyFetches).toBeGreaterThan(0);
  });

  it("agent.user_committed stamps backendIndex on the optimistic user bubble", () => {
    // Principled fix: backend emits this event the moment it appends the
    // user message to history. Frontend matches the optimistic bubble
    // (last user message without backendIndex) and stamps it, so the
    // pencil affordance appears immediately — no polling, no refetch.
    setupStores([
      // A previously-loaded user message (already has its backend index)
      { id: "m1", role: "user", content: "older", backendIndex: 0 },
      { id: "m2", role: "assistant", content: "hi", backendIndex: 1 },
      // An optimistic just-typed user message awaiting confirmation
      { id: "m3", role: "user", content: "just typed" },
    ]);
    act(() => {
      useSessionStore.getState().handleEvent({
        type: "event",
        event: "agent.user_committed",
        payload: { message_index: 7 },
      } as any);
    });
    const msgs = useSessionStore.getState().messages;
    // Pre-existing message must be untouched
    expect(msgs.find((m) => m.id === "m1")?.backendIndex).toBe(0);
    // Optimistic message must now have its backendIndex
    expect(msgs.find((m) => m.id === "m3")?.backendIndex).toBe(7);
  });

  it("invalidates the background cache for non-active sessions", () => {
    setupStores();
    useSessionStore.setState({
      sessionCache: {
        "web:other": {
          messages: [{ id: "x", role: "user", content: "cached" }],
          agentStatus: "idle",
          statusLabel: "",
          contextUsagePercent: null,
          sessionTokens: null,
          sessionCostUSD: null,
          pendingPermission: null,
          pendingAskUser: null,
          taskSummary: null,
        },
      } as any,
    });
    act(() => {
      useSessionStore.getState().handleEvent({
        type: "event",
        event: "session.rewound",
        payload: { sessionKey: "web:other", droppedCount: 1, keptCount: 3 },
      } as any);
    });
    expect(useSessionStore.getState().sessionCache["web:other"]).toBeUndefined();
  });
});

// -----------------------------------------------------------------------------
// MessageBubble edit affordance (integration through ChatView)
// -----------------------------------------------------------------------------

describe("MessageBubble edit affordance", () => {
  it("shows a pencil button on user bubbles loaded from history", () => {
    setupStores([
      { id: "1", role: "user", content: "hello there", backendIndex: 0 },
      { id: "2", role: "assistant", content: "hi", backendIndex: 1 },
    ]);
    render(<ChatView />);
    const editButtons = screen.getAllByLabelText("Edit and resend");
    expect(editButtons.length).toBe(1);
  });

  it("does NOT show pencil on optimistic bubbles (no backendIndex yet)", () => {
    setupStores([{ id: "1", role: "user", content: "just typed, awaiting confirmation" }]);
    render(<ChatView />);
    expect(screen.queryByLabelText("Edit and resend")).toBeNull();
  });

  it("clicking pencil enters edit mode with the message prefilled", () => {
    setupStores([{ id: "1", role: "user", content: "original text", backendIndex: 0 }]);
    render(<ChatView />);
    fireEvent.click(screen.getByLabelText("Edit and resend"));
    const textarea = screen.getByLabelText("Edit message") as HTMLTextAreaElement;
    expect(textarea.value).toBe("original text");
    expect(screen.getByText("Send")).toBeInTheDocument();
    expect(screen.getByText("Cancel")).toBeInTheDocument();
  });

  it("Cancel exits edit mode without calling RPC", () => {
    setupStores([{ id: "1", role: "user", content: "original", backendIndex: 0 }]);
    render(<ChatView />);
    fireEvent.click(screen.getByLabelText("Edit and resend"));
    fireEvent.click(screen.getByText("Cancel"));
    expect(screen.queryByLabelText("Edit message")).toBeNull();
    expect(rpcCalls.find((c) => c.method === "chat.rewind")).toBeUndefined();
  });

  it("Send dispatches rewindAndSend with the message's backendIndex", async () => {
    setupStores([
      { id: "1", role: "user", content: "first", backendIndex: 0 },
      { id: "2", role: "assistant", content: "...", backendIndex: 1 },
      { id: "3", role: "user", content: "second", backendIndex: 2 },
    ]);
    render(<ChatView />);
    // Second user bubble has the second Edit button.
    const editButtons = screen.getAllByLabelText("Edit and resend");
    expect(editButtons.length).toBe(2);
    fireEvent.click(editButtons[1]); // second bubble (backendIndex 2)
    const textarea = screen.getByLabelText("Edit message") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "edited second" } });
    await act(async () => {
      fireEvent.click(screen.getByText("Send"));
      await new Promise((r) => setTimeout(r, 0));
    });
    const rewind = rpcCalls.find((c) => c.method === "chat.rewind");
    expect(rewind).toBeDefined();
    expect((rewind!.params as any).messageIndex).toBe(2);
  });

  it("does not call RPC when the edited text is unchanged", async () => {
    setupStores([{ id: "1", role: "user", content: "nothing changes", backendIndex: 0 }]);
    render(<ChatView />);
    fireEvent.click(screen.getByLabelText("Edit and resend"));
    await act(async () => {
      fireEvent.click(screen.getByText("Send"));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(rpcCalls.find((c) => c.method === "chat.rewind")).toBeUndefined();
  });

  it("paginated sessions still show the pencil — backendIndex is absolute", () => {
    // Codex P1 follow-up: under the old userTurnIndex contract we had to
    // hide the affordance on paginated views to avoid a wrong index. With
    // backendIndex (absolute, sourced from each loaded message) it works
    // correctly even when older pages aren't loaded.
    setupStores([
      { id: "1", role: "user", content: "visible turn", backendIndex: 100 },
    ]);
    useSessionStore.setState({
      historyMeta: { oldestLoadedIndex: 100, hasMore: true, loadingOlder: false },
    } as any);
    render(<ChatView />);
    expect(screen.getByLabelText("Edit and resend")).toBeInTheDocument();
  });

  // Codex P2 guard — attachment-only placeholder messages have content
  // like "(image attached)" which is truthy. Must NOT expose the pencil;
  // there's no original prose to edit.
  it("hides pencil on attachment-only placeholder bubbles", () => {
    setupStores([
      {
        id: "1",
        role: "user",
        content: "(image attached)",
        backendIndex: 0,
        images: [{ base64: "x", media_type: "image/png" }],
      },
      {
        id: "2",
        role: "user",
        content: "(PDF attached)",
        backendIndex: 1,
        documents: [{ media_type: "application/pdf", filename: "x.pdf", sizeBytes: 100 }],
      },
      { id: "3", role: "user", content: "real prose", backendIndex: 2 },
    ]);
    render(<ChatView />);
    const edits = screen.queryAllByLabelText("Edit and resend");
    // Only the "real prose" bubble should have the pencil.
    expect(edits.length).toBe(1);
  });
});
