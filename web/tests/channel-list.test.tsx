import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ChannelList } from "../src/components/ChannelList";
import { useSessionStore } from "../src/store/session-store";
import { useSocketStore } from "../src/store/socket-store";

beforeEach(() => {
  // Reset collapse state so each test starts with default (collapsed)
  localStorage.removeItem("hawky:systemCollapsed");

  useSessionStore.setState({
    sessions: [
      { id: "gw-web-general", key: "web:general", createdAt: "", messageCount: 5, active: true, isSystem: false },
      { id: "gw-web-code", key: "web:code", createdAt: "", messageCount: 0, active: false, isSystem: false },
      { id: "gw-heartbeat-main", key: "heartbeat:main", createdAt: "", messageCount: 10, active: true, isSystem: true },
      { id: "gw-cron-digest", key: "cron:digest", createdAt: "", messageCount: 3, active: false, isSystem: true },
    ],
    activeKey: "web:general",
    messages: [],
    loading: false,
  });

  // Mock RPC for any session operations
  useSocketStore.setState({
    status: "connected",
    rpc: vi.fn(async () => ({})) as any,
  } as any);
});

describe("ChannelList", () => {
  it("renders user channels", () => {
    render(<ChannelList />);
    expect(screen.getByText("general")).toBeInTheDocument();
    expect(screen.getByText("code")).toBeInTheDocument();
  });

  it("system section collapsed by default, shows count", () => {
    render(<ChannelList />);
    expect(screen.getByText("System (2)")).toBeInTheDocument();
    // System channels hidden when collapsed
    expect(screen.queryByText("heartbeat")).not.toBeInTheDocument();
    expect(screen.queryByText("digest")).not.toBeInTheDocument();
  });

  it("expands system section on click to show readable names", () => {
    render(<ChannelList />);
    const systemHeader = screen.getByText("System (2)").closest("button")!;
    fireEvent.click(systemHeader);
    expect(screen.getByText("heartbeat")).toBeInTheDocument(); // heartbeat:main → "heartbeat"
    expect(screen.getByText("digest")).toBeInTheDocument(); // cron:digest → "digest"
  });

  it("shows section headers", () => {
    render(<ChannelList />);
    expect(screen.getByText("Channels")).toBeInTheDocument();
    expect(screen.getByText("System (2)")).toBeInTheDocument();
  });

  it("highlights active channel", () => {
    render(<ChannelList />);
    const generalBtn = screen.getByText("general").closest("button");
    expect(generalBtn?.className).toContain("font-medium");
  });

  it("does not highlight inactive channels", () => {
    render(<ChannelList />);
    const codeBtn = screen.getByText("code").closest("button");
    expect(codeBtn?.className).not.toContain("text-accent");
  });

  it("shows system sessions with icons when expanded", () => {
    render(<ChannelList />);
    // Expand system section first
    const systemHeader = screen.getByText("System (2)").closest("button")!;
    fireEvent.click(systemHeader);
    // System channels render with heart/clock icons (no "watch" badge)
    expect(screen.getByText("heartbeat")).toBeInTheDocument();
    expect(screen.getByText("digest")).toBeInTheDocument();
  });

  it("shows context ring when user channel has contextUsagePercent", () => {
    useSessionStore.setState({
      sessions: [
        {
          id: "gw-web-general",
          key: "web:general",
          createdAt: "",
          messageCount: 5,
          active: true,
          isSystem: false,
          contextUsagePercent: 42,
        },
      ],
      activeKey: "web:general",
    });
    render(<ChannelList />);
    // Ring exposes its percent via aria-label (React-driven tooltip is hover-only)
    expect(screen.getByLabelText("42% of context used")).toBeInTheDocument();
  });

  it("does not show context ring when contextUsagePercent is 0 or null", () => {
    useSessionStore.setState({
      sessions: [
        {
          id: "gw-web-code",
          key: "web:code",
          createdAt: "",
          messageCount: 0,
          active: false,
          isSystem: false,
          contextUsagePercent: 0,
        },
      ],
      activeKey: "web:general",
    });
    render(<ChannelList />);
    expect(screen.queryByLabelText(/of context used/)).not.toBeInTheDocument();
  });

  it("context ring shows tooltip text on hover (instantly, not via native title)", () => {
    useSessionStore.setState({
      sessions: [
        {
          id: "gw-web-general",
          key: "web:general",
          createdAt: "",
          messageCount: 3,
          active: true,
          isSystem: false,
          contextUsagePercent: 58,
        },
      ],
      activeKey: "web:general",
    });
    render(<ChannelList />);
    const ring = screen.getByLabelText("58% of context used");
    // Tooltip text is not in the DOM until hover
    expect(screen.queryByText("58% of context used", { selector: "span" })).not.toBeInTheDocument();
    fireEvent.mouseEnter(ring);
    // After mouseEnter, tooltip renders immediately (no timer, matches HeaderIcon pattern)
    expect(screen.getByText("58% of context used", { selector: "span" })).toBeInTheDocument();
    fireEvent.mouseLeave(ring);
    expect(screen.queryByText("58% of context used", { selector: "span" })).not.toBeInTheDocument();
  });

  it("has create channel button", () => {
    render(<ChannelList />);
    expect(screen.getByLabelText("Create channel")).toBeInTheDocument();
  });

  it("shows input when create button clicked", () => {
    render(<ChannelList />);
    fireEvent.click(screen.getByLabelText("Create channel"));
    expect(screen.getByPlaceholderText("channel-name")).toBeInTheDocument();
  });

  it("shows 'No channels yet' when empty", () => {
    useSessionStore.setState({
      sessions: [
        { id: "gw-heartbeat-main", key: "heartbeat:main", createdAt: "", messageCount: 0, active: true, isSystem: true },
      ],
    });
    render(<ChannelList />);
    expect(screen.getByText("No channels yet")).toBeInTheDocument();
  });

  it("hides flush sessions (internal)", () => {
    useSessionStore.setState({
      sessions: [
        { id: "gw-web-general", key: "web:general", createdAt: "", messageCount: 0, active: true, isSystem: false },
        { id: "gw-flush-tui-main", key: "flush:tui-main", createdAt: "", messageCount: 0, active: false, isSystem: true },
      ],
    });
    render(<ChannelList />);
    expect(screen.getByText("general")).toBeInTheDocument();
    expect(screen.queryByText(/flush/i)).not.toBeInTheDocument();
  });

  it("hides System section when no system sessions", () => {
    useSessionStore.setState({
      sessions: [
        { id: "gw-web-general", key: "web:general", createdAt: "", messageCount: 0, active: true, isSystem: false },
      ],
    });
    render(<ChannelList />);
    expect(screen.queryByText(/^System/)).not.toBeInTheDocument();
  });
});
