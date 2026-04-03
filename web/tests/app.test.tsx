import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { App } from "../src/App";
import { useSessionStore } from "../src/store/session-store";
import { useSocketStore } from "../src/store/socket-store";
import { installMockWebSocket } from "./helpers/mock-websocket";

// Mock matchMedia for jsdom (used by Sidebar dark mode detection)
Object.defineProperty(window, "matchMedia", {
  value: vi.fn(() => ({ matches: false })),
  writable: true,
});

beforeEach(() => {
  installMockWebSocket();

  // Set up session store with test data
  useSessionStore.setState({
    sessions: [
      { id: "gw-web-general", key: "web:general", createdAt: "", messageCount: 0, active: true, isSystem: false },
    ],
    activeKey: "web:general",
    messages: [],
    loading: false,
  });

  // Mock socket store as disconnected (avoid real WS in tests)
  useSocketStore.setState({
    status: "disconnected",
    error: null,
    client: null,
    eventListeners: new Set(),
  });
});

describe("App layout", () => {
  it("renders the app title", () => {
    render(<App />);
    const titles = screen.getAllByText("Hawky");
    expect(titles.length).toBeGreaterThanOrEqual(1);
  });

  it("renders the active channel in header", () => {
    render(<App />);
    const matches = screen.getAllByText("general");
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });

  it("shows welcome message when no messages", () => {
    render(<App />);
    expect(screen.getByText("Send a message to get started")).toBeInTheDocument();
  });

  it("shows input bar for user channels", () => {
    render(<App />);
    expect(screen.getByPlaceholderText(/type a message|connecting/i)).toBeInTheDocument();
  });

  it("shows read-only notice for system sessions", () => {
    useSessionStore.setState({ activeKey: "heartbeat:main" });
    render(<App />);
    expect(screen.getByText(/read only/i)).toBeInTheDocument();
  });

  it("shows lock icon for system sessions", () => {
    useSessionStore.setState({ activeKey: "cron:job123" });
    render(<App />);
    // System channels show lock prefix instead of "(watching)" text
    expect(screen.getByText(/job123/)).toBeInTheDocument();
  });

  it("renders loaded messages", () => {
    useSessionStore.setState({
      messages: [
        { id: "m1", role: "user", content: "Hello there" },
        { id: "m2", role: "assistant", content: "Hi! How can I help?" },
      ],
    });
    render(<App />);
    expect(screen.getByText("Hello there")).toBeInTheDocument();
    expect(screen.getByText("Hi! How can I help?")).toBeInTheDocument();
  });

  it("shows loading state", () => {
    useSessionStore.setState({ loading: true });
    render(<App />);
    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });
});

describe("App responsive", () => {
  it("hamburger button exists for mobile", () => {
    render(<App />);
    expect(screen.getByLabelText("Toggle sidebar")).toBeInTheDocument();
  });
});
