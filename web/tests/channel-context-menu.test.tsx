// =============================================================================
// Tests: Channel List Context Menu
//
// Covers: right-click context menu, rename flow, delete confirmation,
//         pin/unpin indicator, display name rendering.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ChannelList } from "../src/components/ChannelList";
import { useSessionStore } from "../src/store/session-store";
import { useSocketStore } from "../src/store/socket-store";

beforeEach(() => {
  localStorage.removeItem("hawky:systemCollapsed");

  useSessionStore.setState({
    sessions: [
      { id: "gw-web-general", key: "web:general", createdAt: "", messageCount: 5, active: true, isSystem: false, displayName: null, pinned: false, archived: false },
      { id: "gw-web-code", key: "web:code", createdAt: "", messageCount: 2, active: false, isSystem: false, displayName: "Code Project", pinned: true, archived: false },
      { id: "gw-heartbeat-main", key: "heartbeat:main", createdAt: "", messageCount: 10, active: true, isSystem: true, displayName: null, pinned: false, archived: false },
      { id: "gw-cron-meta-monitor", key: "cron:meta-monitor", createdAt: "", messageCount: 3, active: false, isSystem: true, displayName: null, pinned: false, archived: false },
    ],
    activeKey: "web:general",
    messages: [],
    loading: false,
  });

  useSocketStore.setState({
    status: "connected",
    rpc: vi.fn(async () => ({})) as any,
  } as any);
});

// =============================================================================
// Display name rendering
// =============================================================================

describe("display name", () => {
  it("shows displayName when set", () => {
    render(<ChannelList />);
    expect(screen.getByText("Code Project")).toBeInTheDocument();
  });

  it("falls back to key-derived name when no displayName", () => {
    render(<ChannelList />);
    expect(screen.getByText("general")).toBeInTheDocument();
  });
});

// =============================================================================
// Pin indicator
// =============================================================================

describe("pin indicator", () => {
  it("shows pin icon for pinned sessions (before channel icon)", () => {
    render(<ChannelList />);
    // The pinned session "Code Project" should have an SVG pin icon + channel icon
    const codeButton = screen.getByText("Code Project").closest("button")!;
    const svgs = codeButton.querySelectorAll("svg");
    // Should have 2 SVGs: pin icon (first) + channel icon (second)
    expect(svgs.length).toBe(2);
  });

  it("pin icon appears before channel icon in DOM order", () => {
    render(<ChannelList />);
    const codeButton = screen.getByText("Code Project").closest("button")!;
    const svgs = codeButton.querySelectorAll("svg");
    // First SVG is pin (w-3 h-3), second is channel icon (w-5 h-5)
    expect(svgs[0].classList.contains("w-3")).toBe(true);
    expect(svgs[1].classList.contains("w-5")).toBe(true);
  });

  it("does not show pin icon for unpinned sessions", () => {
    render(<ChannelList />);
    const generalButton = screen.getByText("general").closest("button")!;
    const svgs = generalButton.querySelectorAll("svg");
    // Only channel icon, no pin icon
    expect(svgs.length).toBe(1);
  });

  it("context ring is visible alongside pin icon", () => {
    // Sidebar now shows a context-usage ring (not raw message count) on the
    // right edge. Make sure a pinned session can render both icons together.
    useSessionStore.setState({
      sessions: [
        {
          id: "gw-web-code",
          key: "web:code",
          createdAt: "",
          messageCount: 2,
          active: false,
          isSystem: false,
          displayName: "Code Project",
          pinned: true,
          archived: false,
          contextUsagePercent: 34,
        },
      ],
      activeKey: "web:general",
    });
    render(<ChannelList />);
    const codeButton = screen.getByText("Code Project").closest("button")!;
    expect(codeButton.querySelector('[data-context-percent="34"]')).not.toBeNull();
    // Pin icon is still rendered (first SVG is pin, second is channel, third is ring)
    expect(codeButton.querySelectorAll("svg").length).toBe(3);
  });
});

// =============================================================================
// Context menu
// =============================================================================

describe("context menu", () => {
  it("opens on right-click of user channel", () => {
    render(<ChannelList />);
    const generalBtn = screen.getByText("general").closest("button")!;
    fireEvent.contextMenu(generalBtn);
    expect(screen.getByText("Rename")).toBeInTheDocument();
    expect(screen.getByText("Pin to top")).toBeInTheDocument();
    expect(screen.getByText("Archive")).toBeInTheDocument();
    expect(screen.getByText("Delete")).toBeInTheDocument();
  });

  it("shows 'Unpin' for pinned session", () => {
    render(<ChannelList />);
    const codeBtn = screen.getByText("Code Project").closest("button")!;
    fireEvent.contextMenu(codeBtn);
    expect(screen.getByText("Unpin")).toBeInTheDocument();
  });

  it("closes context menu on Escape", () => {
    render(<ChannelList />);
    const generalBtn = screen.getByText("general").closest("button")!;
    fireEvent.contextMenu(generalBtn);
    expect(screen.getByText("Rename")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByText("Rename")).not.toBeInTheDocument();
  });

  it("does not show context menu for heartbeat/flush sessions", () => {
    // Expand system section first
    render(<ChannelList />);
    const systemHeader = screen.getByText(/System \(\d+\)/).closest("button")!;
    fireEvent.click(systemHeader);
    const heartbeatBtn = screen.getByText("heartbeat").closest("button")!;
    fireEvent.contextMenu(heartbeatBtn);
    // No menu at all for heartbeat sessions
    expect(screen.queryByText("Rename")).not.toBeInTheDocument();
    expect(screen.queryByText("Delete")).not.toBeInTheDocument();
    expect(screen.queryByText("Pin to top")).not.toBeInTheDocument();
    expect(screen.queryByText("Archive")).not.toBeInTheDocument();
  });

  it("heartbeat right-click does not render empty menu rectangle", () => {
    render(<ChannelList />);
    const systemHeader = screen.getByText(/System \(\d+\)/).closest("button")!;
    fireEvent.click(systemHeader);
    const heartbeatBtn = screen.getByText("heartbeat").closest("button")!;
    fireEvent.contextMenu(heartbeatBtn);
    const menuButtons = document.querySelectorAll('[class*="min-w-"]');
    expect(menuButtons.length).toBe(0);
  });

  it("shows Rename / Pin / Delete on cron sessions (chattable now), no Archive", () => {
    // Cron sessions used to be Delete-only because they were treated as
    // read-only system threads. They're first-class chattable sessions
    // now and get the user-session menu — except Archive, which is
    // intentionally withheld: archive hides the session from the sidebar
    // but the backing cron keeps firing, and there's no web Unarchive
    // surface yet. Hiding it here prevents the "active job orphaned in
    // an unreachable hidden thread" footgun Codex flagged.
    render(<ChannelList />);
    const systemHeader = screen.getByText(/System \(\d+\)/).closest("button")!;
    fireEvent.click(systemHeader);
    const cronBtn = screen.getByText("meta-monitor").closest("button")!;
    fireEvent.contextMenu(cronBtn);
    expect(screen.getByText("Rename")).toBeInTheDocument();
    expect(screen.getByText("Pin to top")).toBeInTheDocument();
    expect(screen.getByText("Delete")).toBeInTheDocument();
    expect(screen.queryByText("Archive")).not.toBeInTheDocument();
  });

  it("Delete on cron session opens type-to-confirm dialog", () => {
    render(<ChannelList />);
    const systemHeader = screen.getByText(/System \(\d+\)/).closest("button")!;
    fireEvent.click(systemHeader);
    const cronBtn = screen.getByText("meta-monitor").closest("button")!;
    fireEvent.contextMenu(cronBtn);
    fireEvent.click(screen.getByText("Delete"));
    // Cron-specific dialog title and instruction
    expect(screen.getByText("Delete cron job?")).toBeInTheDocument();
    expect(screen.getByText(/to confirm/i)).toBeInTheDocument();
  });
});

// =============================================================================
// Delete confirmation
// =============================================================================

describe("delete confirmation", () => {
  it("shows confirmation dialog when Delete is clicked", () => {
    render(<ChannelList />);
    const generalBtn = screen.getByText("general").closest("button")!;
    fireEvent.contextMenu(generalBtn);
    fireEvent.click(screen.getByText("Delete"));
    expect(screen.getByText("Delete session?")).toBeInTheDocument();
    expect(screen.getByText(/permanently delete/)).toBeInTheDocument();
  });

  it("calls deleteSession on confirm", () => {
    const mockDelete = vi.fn();
    useSessionStore.setState({ deleteSession: mockDelete } as any);
    render(<ChannelList />);
    const generalBtn = screen.getByText("general").closest("button")!;
    fireEvent.contextMenu(generalBtn);
    fireEvent.click(screen.getByText("Delete"));
    // Click confirm button in dialog
    const confirmBtn = screen.getByRole("button", { name: "Delete" });
    fireEvent.click(confirmBtn);
  });

  it("closes dialog on cancel", () => {
    render(<ChannelList />);
    const generalBtn = screen.getByText("general").closest("button")!;
    fireEvent.contextMenu(generalBtn);
    fireEvent.click(screen.getByText("Delete"));
    expect(screen.getByText("Delete session?")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Cancel"));
    expect(screen.queryByText("Delete session?")).not.toBeInTheDocument();
  });
});

// =============================================================================
// Rename flow
// =============================================================================

describe("rename flow", () => {
  it("shows input when Rename is clicked from context menu", () => {
    render(<ChannelList />);
    const generalBtn = screen.getByText("general").closest("button")!;
    fireEvent.contextMenu(generalBtn);
    fireEvent.click(screen.getByText("Rename"));
    // Should show an input field
    const input = screen.getByRole("textbox");
    expect(input).toBeInTheDocument();
  });

  it("pre-fills input with current name", () => {
    render(<ChannelList />);
    const generalBtn = screen.getByText("general").closest("button")!;
    fireEvent.contextMenu(generalBtn);
    fireEvent.click(screen.getByText("Rename"));
    const input = screen.getByRole("textbox") as HTMLInputElement;
    expect(input.value).toBe("general");
  });

  it("pre-fills input with displayName when set", () => {
    render(<ChannelList />);
    const codeBtn = screen.getByText("Code Project").closest("button")!;
    fireEvent.contextMenu(codeBtn);
    fireEvent.click(screen.getByText("Rename"));
    const input = screen.getByRole("textbox") as HTMLInputElement;
    expect(input.value).toBe("Code Project");
  });
});
