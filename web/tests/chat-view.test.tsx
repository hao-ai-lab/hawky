import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ChatView } from "../src/components/ChatView";
import { useSessionStore } from "../src/store/session-store";

beforeEach(() => {
  useSessionStore.setState({
    messages: [],
    loading: false,
    agentStatus: "idle",
  });
});

describe("ChatView", () => {
  it("shows welcome message when empty and idle", () => {
    render(<ChatView />);
    expect(screen.getByText("Send a message to get started")).toBeInTheDocument();
  });

  // Codex regression: a session with zero messages but at least one
  // notification (heartbeat that fired into a fresh channel) used to fall
  // through the empty-state early return and render the placeholder
  // instead of the card. Empty-state now requires both messages AND
  // notifications to be empty.
  it("shows the notification card (not the empty-state) when only a heartbeat has arrived", () => {
    useSessionStore.setState({
      activeKey: "web:general",
      messages: [],
      loading: false,
      agentStatus: "idle",
      notificationsBySession: {
        "web:general": [
          {
            id: "n-1",
            sessionKey: "web:general",
            origin: "heartbeat",
            title: "Heartbeat Update",
            body: "All systems nominal.",
            timestamp: "2026-04-24T20:00:00.000Z",
          },
        ],
      },
    });
    render(<ChatView />);
    expect(screen.queryByText("Send a message to get started")).not.toBeInTheDocument();
    expect(screen.getByText(/All systems nominal/)).toBeInTheDocument();
    expect(screen.getByText("heartbeat")).toBeInTheDocument();
  });

  it("shows loading indicator", () => {
    useSessionStore.setState({ loading: true });
    render(<ChatView />);
    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  it("renders user messages", () => {
    useSessionStore.setState({
      messages: [{ id: "1", role: "user", content: "Hello there" }],
    });
    render(<ChatView />);
    expect(screen.getByText("Hello there")).toBeInTheDocument();
  });

  it("renders assistant messages", () => {
    useSessionStore.setState({
      messages: [{ id: "1", role: "assistant", content: "Hi! How can I help?" }],
    });
    render(<ChatView />);
    expect(screen.getByText("Hi! How can I help?")).toBeInTheDocument();
  });

  it("renders system messages", () => {
    useSessionStore.setState({
      messages: [{ id: "1", role: "system", content: "Error: API timeout" }],
    });
    render(<ChatView />);
    expect(screen.getByText("Error: API timeout")).toBeInTheDocument();
  });

  it("renders tool invocations as a collapsible step", () => {
    useSessionStore.setState({
      messages: [{
        id: "1",
        role: "tool",
        content: "",
        tool: {
          toolUseId: "T1",
          name: "bash",
          inputPreview: "ls -la",
          status: "success",
          output: "file1\nfile2",
          isError: false,
        },
      }],
    });
    render(<ChatView />);
    // Collapsed by default — only the step headline is visible.
    expect(screen.getByText("Run bash: ls -la")).toBeInTheDocument();
    // The raw tool name and output are hidden until the step is expanded.
    expect(screen.queryByText("bash")).toBeNull();
    expect(screen.queryByText("file1")).toBeNull();
  });

  it("keeps legacy (no batchId) tool messages as separate steps", () => {
    // History reconstructed from persisted tool_use/tool_result blocks
    // has no batchId. Adjacent tools there are sequential turns, not a
    // parallel batch — they must render as distinct steps so the "list
    // files, then read one" flow isn't collapsed into a single group.
    useSessionStore.setState({
      messages: [
        {
          id: "1",
          role: "tool",
          content: "",
          tool: {
            toolUseId: "T1",
            name: "bash",
            inputPreview: "ls",
            status: "success",
            output: "",
            isError: false,
          },
        },
        {
          id: "2",
          role: "tool",
          content: "",
          tool: {
            toolUseId: "T2",
            name: "read_file",
            inputPreview: "foo.ts",
            status: "success",
            output: "",
            isError: false,
          },
        },
      ],
    });
    render(<ChatView />);
    expect(screen.getByText("Run bash: ls")).toBeInTheDocument();
    expect(screen.getByText("Read foo.ts")).toBeInTheDocument();
    // A merged step would produce "2 tools: bash command, read" — make sure we don't.
    expect(screen.queryByText(/2 tools/)).toBeNull();
  });

  it("groups multiple parallel tool messages into one step", () => {
    useSessionStore.setState({
      messages: [
        {
          id: "1",
          role: "tool",
          content: "",
          tool: {
            toolUseId: "T1",
            name: "read_file",
            inputPreview: "a.ts",
            status: "success",
            output: "",
            isError: false,
            batchId: "B1",
          },
        },
        {
          id: "2",
          role: "tool",
          content: "",
          tool: {
            toolUseId: "T2",
            name: "read_file",
            inputPreview: "b.ts",
            status: "success",
            output: "",
            isError: false,
            batchId: "B1",
          },
        },
      ],
    });
    render(<ChatView />);
    // One step headline summarises both tools.
    expect(screen.getByText("2 reads")).toBeInTheDocument();
    // Old "⚡ N tools" row must no longer render.
    expect(screen.queryByText(/⚡/)).toBeNull();
  });

  it("shows thinking indicator when agent is thinking", () => {
    useSessionStore.setState({
      messages: [{ id: "1", role: "user", content: "Question" }],
      agentStatus: "thinking",
    });
    render(<ChatView />);
    expect(screen.getByText("Thinking...")).toBeInTheDocument();
  });

  it("shows generating indicator when streaming", () => {
    useSessionStore.setState({
      messages: [{ id: "1", role: "user", content: "Question" }],
      agentStatus: "streaming",
    });
    render(<ChatView />);
    expect(screen.getByText("Generating...")).toBeInTheDocument();
  });

  it("does not show status indicator when idle", () => {
    useSessionStore.setState({
      messages: [{ id: "1", role: "user", content: "Question" }],
      agentStatus: "idle",
    });
    render(<ChatView />);
    expect(screen.queryByText("Thinking...")).not.toBeInTheDocument();
    expect(screen.queryByText("Generating...")).not.toBeInTheDocument();
  });

  it("shows compacting indicator when /compact is running", () => {
    // Regression: the indicator's `agentStatus === "thinking" ||
    // "streaming"` check excluded "compacting", so /compact would lock
    // the input but show no status row — leaving the user wondering if
    // anything was happening.
    useSessionStore.setState({
      messages: [{ id: "1", role: "user", content: "/compact" }],
      agentStatus: "compacting",
      statusLabel: "Compacting context...",
    });
    render(<ChatView />);
    expect(screen.getByText("Compacting context...")).toBeInTheDocument();
  });

  it("falls back to a default compacting label when statusLabel is empty", () => {
    useSessionStore.setState({
      messages: [{ id: "1", role: "user", content: "/compact" }],
      agentStatus: "compacting",
      statusLabel: "",
    });
    render(<ChatView />);
    expect(screen.getByText("Compacting context...")).toBeInTheDocument();
  });

  it("has scroll-to-bottom button container", () => {
    render(<ChatView />);
    expect(screen.queryByLabelText("Scroll to bottom")).not.toBeInTheDocument();
  });

  it("shows copy button on user message", () => {
    useSessionStore.setState({
      messages: [{ id: "1", role: "user", content: "Hello there" }],
      agentStatus: "idle",
    });
    render(<ChatView />);
    const copyButtons = screen.getAllByLabelText("Copy");
    expect(copyButtons.length).toBeGreaterThanOrEqual(1);
  });

  it("shows copy button on assistant message", () => {
    useSessionStore.setState({
      messages: [{ id: "1", role: "assistant", content: "Here is my answer" }],
      agentStatus: "idle",
    });
    render(<ChatView />);
    const copyButtons = screen.getAllByLabelText("Copy");
    expect(copyButtons.length).toBeGreaterThanOrEqual(1);
  });

  it("does not show copy button on system messages", () => {
    useSessionStore.setState({
      messages: [{ id: "1", role: "system", content: "System info" }],
      agentStatus: "idle",
    });
    render(<ChatView />);
    expect(screen.queryByLabelText("Copy")).not.toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Last-turn debug footer (Phase 4) — diagnostic line under the cumulative
  // usage summary that shows what the most recent API call billed.
  // ---------------------------------------------------------------------------

  it("renders 'last turn:' debug footer when lastTurnUsage is set", () => {
    useSessionStore.setState({
      messages: [
        { id: "1", role: "user", content: "hi" },
        { id: "2", role: "assistant", content: "hello" },
      ],
      agentStatus: "idle",
      sessionTokens: { input: 10000, output: 500 },
      sessionCostUSD: 0.12,
      lastTurnUsage: { input: 100, output: 80, cacheRead: 5000, cacheCreation: 0 },
      lastTurnCostUSD: 0.003,
    } as any);
    render(<ChatView />);
    // Cumulative summary still appears
    expect(screen.getByText(/10\.0K↓ 500↑/)).toBeInTheDocument();
    // Last-turn diagnostic appears
    expect(screen.getByText(/last turn:/)).toBeInTheDocument();
    // Cache-read split is broken out so the user can see prompt-cache hit
    expect(screen.getByText(/5\.0K↓ cached/)).toBeInTheDocument();
  });

  it("hides 'last turn:' debug footer when there's no lastTurnUsage", () => {
    useSessionStore.setState({
      messages: [
        { id: "1", role: "user", content: "hi" },
        { id: "2", role: "assistant", content: "hello" },
      ],
      agentStatus: "idle",
      sessionTokens: { input: 100, output: 50 },
      sessionCostUSD: 0.01,
      lastTurnUsage: null,
      lastTurnCostUSD: null,
    } as any);
    render(<ChatView />);
    expect(screen.queryByText(/last turn:/)).toBeNull();
  });

  it("does not show another session's lastTurnUsage after switching (per-session scoping)", async () => {
    // Codex P2 regression: lastTurnUsage was top-level, so finishing a turn
    // in session A and switching to session B leaked A's footer onto B's
    // view. Fix: include lastTurn fields in PerSessionCache, save on
    // switch-away, restore on switch-back, null out on first-open.
    const { useSocketStore } = await import("../src/store/socket-store");
    useSocketStore.setState({
      status: "connected",
      error: null,
      client: null,
      eventListeners: new Set(),
      rpc: vi.fn(async (method: string) => {
        if (method === "session.resolve") return { sessionKey: "web:b" };
        if (method === "session.history") return { messages: [], hasMore: false };
        if (method === "task.list") return { tasks: [] };
        if (method === "session.currentTurn") return { busy: false };
        return {};
      }) as any,
      connect: vi.fn() as any,
      disconnect: vi.fn(),
      subscribe: vi.fn(() => () => {}),
    } as any);
    // Session A is active and has just-finished diagnostics.
    useSessionStore.setState({
      activeKey: "web:a",
      messages: [
        { id: "1", role: "user", content: "hi" },
        { id: "2", role: "assistant", content: "hello" },
      ],
      agentStatus: "idle",
      sessionTokens: { input: 5000, output: 200 },
      sessionCostUSD: 0.05,
      lastTurnUsage: { input: 1234, output: 56, cacheRead: 0, cacheCreation: 0 },
      lastTurnCostUSD: 0.001,
      sessions: [
        { key: "web:a", id: "web/a", displayName: "A", isSystem: false, messageCount: 2, createdAt: "" },
        { key: "web:b", id: "web/b", displayName: "B", isSystem: false, messageCount: 0, createdAt: "" },
      ],
    } as any);
    // Switch to session B (which has never seen a turn).
    await useSessionStore.getState().switchSession("web:b");
    // B's view must NOT show A's last-turn diagnostic.
    expect(useSessionStore.getState().lastTurnUsage).toBeNull();
    expect(useSessionStore.getState().lastTurnCostUSD).toBeNull();
    // Switch back to A — its diagnostic should be restored from cache.
    await useSessionStore.getState().switchSession("web:a");
    expect(useSessionStore.getState().lastTurnUsage?.input).toBe(1234);
    expect(useSessionStore.getState().lastTurnCostUSD).toBe(0.001);
  });

  it("cumulative ↓ sums fresh + cacheRead + cacheCreation (so caching doesn't make context look smaller)", () => {
    // With prompt caching engaged the bulk of input shifts from `input`
    // to `cacheRead`. The cumulative footer used to show only `input`,
    // making a long conversation suddenly look like ~5K. The total-input
    // display sums all three input buckets so it represents what the
    // model actually processed and stays stable as caching engages.
    useSessionStore.setState({
      messages: [
        { id: "1", role: "user", content: "hi" },
        { id: "2", role: "assistant", content: "hello" },
      ],
      agentStatus: "idle",
      sessionTokens: { input: 5000, output: 200, cacheRead: 50000, cacheCreation: 2000 },
      sessionCostUSD: 0.05,
      lastTurnUsage: null,
      lastTurnCostUSD: null,
    } as any);
    render(<ChatView />);
    // 5K + 50K + 2K = 57K (rounded by formatTokens to "57.0K")
    expect(screen.getByText(/57\.0K↓ 200↑/)).toBeInTheDocument();
  });

  it("cumulative footer still renders with legacy {input,output} payload (no cache fields)", () => {
    // Back-compat: older session.list payloads don't carry cacheRead /
    // cacheCreation. Treat missing as 0 — don't crash, don't refuse to
    // render the line.
    useSessionStore.setState({
      messages: [
        { id: "1", role: "user", content: "hi" },
      ],
      agentStatus: "idle",
      sessionTokens: { input: 1234, output: 56 },
      sessionCostUSD: 0.01,
      lastTurnUsage: null,
      lastTurnCostUSD: null,
    } as any);
    render(<ChatView />);
    expect(screen.getByText(/1\.2K↓ 56↑/)).toBeInTheDocument();
  });

  it("includes cache_creation in the footer when set", () => {
    useSessionStore.setState({
      messages: [
        { id: "1", role: "user", content: "hi" },
        { id: "2", role: "assistant", content: "hello" },
      ],
      agentStatus: "idle",
      sessionTokens: { input: 100, output: 50 },
      sessionCostUSD: 0.01,
      lastTurnUsage: { input: 200, output: 80, cacheRead: 0, cacheCreation: 8000 },
      lastTurnCostUSD: 0.05,
    } as any);
    render(<ChatView />);
    expect(screen.getByText(/8\.0K↓ cache-write/)).toBeInTheDocument();
  });
});
