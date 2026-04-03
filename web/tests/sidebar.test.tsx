import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Sidebar } from "../src/components/Sidebar";
import { useSessionStore } from "../src/store/session-store";

// Mock matchMedia for jsdom (used by dark mode detection)
Object.defineProperty(window, "matchMedia", {
  value: vi.fn(() => ({ matches: false })),
  writable: true,
});

beforeEach(() => {
  // Reset session store
  useSessionStore.setState({
    sessions: [
      { id: "gw-web-general", key: "web:general", createdAt: "", messageCount: 5, active: true, isSystem: false },
      { id: "gw-web-code", key: "web:code", createdAt: "", messageCount: 0, active: false, isSystem: false },
      { id: "gw-heartbeat-main", key: "heartbeat:main", createdAt: "", messageCount: 10, active: true, isSystem: true },
    ],
    activeKey: "web:general",
    messages: [],
    loading: false,
  });
});

describe("Sidebar", () => {
  it("renders Hawky title", () => {
    render(<Sidebar />);
    expect(screen.getByText("Hawky")).toBeInTheDocument();
  });

  it("renders settings button", () => {
    render(<Sidebar onSettingsOpen={() => {}} />);
    expect(screen.getByText("Settings")).toBeInTheDocument();
  });

  it("renders channel list from session store", () => {
    render(<Sidebar />);
    expect(screen.getByText("general")).toBeInTheDocument();
    expect(screen.getByText("code")).toBeInTheDocument();
  });

  it("system section collapsed by default", () => {
    render(<Sidebar />);
    expect(screen.getByText("System (1)")).toBeInTheDocument();
    // Heartbeat not visible when collapsed
    expect(screen.queryByText("heartbeat")).not.toBeInTheDocument();
  });

  it("shows Channels and System section headers", () => {
    render(<Sidebar />);
    expect(screen.getByText("Channels")).toBeInTheDocument();
    expect(screen.getByText("System (1)")).toBeInTheDocument();
  });
});
