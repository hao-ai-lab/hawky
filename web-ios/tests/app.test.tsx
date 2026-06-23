import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { App } from "../src/App";
import { useSocketStore } from "../src/lib/socket-store";
import { useNav } from "../src/lib/nav";
import { useSessionStore } from "../src/lib/session-store";

function mockSocket(status: string, rpc?: (m: string, p?: unknown) => Promise<unknown>) {
  useSocketStore.setState({
    status: status as any,
    error: null,
    client: null,
    eventListeners: new Set(),
    rpc: (rpc ?? (async () => ({}))) as any,
    connect: vi.fn() as any,
    disconnect: vi.fn(),
    subscribe: vi.fn(() => () => {}),
  });
}

function nav(label: string) {
  const aside = document.querySelector("aside")!;
  fireEvent.click(within(aside as HTMLElement).getByText(label));
}

beforeEach(() => {
  useNav.setState({ route: "live" });
  useSessionStore.setState({ activeKey: "web:ios", sessions: [], loading: false });
  mockSocket("connected");
});

describe("web-ios shell (Live-focused)", () => {
  it("sidebar shows only Live, People, Memory, Settings", () => {
    render(<App />);
    const aside = document.querySelector("aside")!;
    for (const label of ["Live", "People", "Memory", "Settings"]) {
      expect(within(aside as HTMLElement).getByText(label)).toBeInTheDocument();
    }
    // Deleted nav items are gone.
    for (const gone of ["Chat", "Recordings", "Notifications"]) {
      expect(within(aside as HTMLElement).queryByText(gone)).toBeNull();
    }
  });

  it("starts on Live with the call button + Hawky session menu trigger", () => {
    render(<App />);
    expect(screen.getByLabelText("Start session")).toBeInTheDocument();
    expect(screen.getByLabelText("Session menu")).toBeInTheDocument();
  });

  it("Hawky pill opens the session menu (New session / History / Status)", () => {
    render(<App />);
    fireEvent.click(screen.getByLabelText("Session menu"));
    expect(screen.getByText("New session")).toBeInTheDocument();
    expect(screen.getByText("History")).toBeInTheDocument();
    expect(screen.getByText("Status")).toBeInTheDocument();
  });

  it("navigates to People and loads people.list", async () => {
    const rpc = vi.fn(async (m: string) =>
      m === "people.list" ? { ok: true, available: true, people: [{ id: "p1", name: "Jay", facts: [], recaps: [] }] } : {},
    );
    mockSocket("connected", rpc);
    render(<App />);
    nav("People");
    expect(await screen.findByText("Jay")).toBeInTheDocument();
  });

  it("navigates to Memory and lists workspace files", async () => {
    const rpc = vi.fn(async (m: string) =>
      m === "workspace.list" ? { files: [{ name: "MEMORY.md", path: "MEMORY.md", editable: true, size: 42 }] } : {},
    );
    mockSocket("connected", rpc);
    render(<App />);
    nav("Memory");
    expect(await screen.findByText("MEMORY.md")).toBeInTheDocument();
  });

  it("Settings shows the full Live settings sections", async () => {
    const rpc = vi.fn(async (m: string) => (m === "config.get" ? { provider: "openai", model: "gpt-4o" } : {}));
    mockSocket("connected", rpc);
    render(<App />);
    nav("Settings");
    // Settings is two-pane; the Live sections live under the "Live" category.
    const settingsNav = document.querySelectorAll("main nav")[0]!;
    fireEvent.click(within(settingsNav as HTMLElement).getByText("Live"));
    expect(screen.getByText("Live · Provider")).toBeInTheDocument();
    expect(screen.getByText("Live · Turn detection")).toBeInTheDocument();
    expect(screen.getByText("Live · Hawk bridge")).toBeInTheDocument();
  });

  it("Settings has Appearance (theme) and App Layout (tab hide) categories", () => {
    mockSocket("connected");
    render(<App />);
    nav("Settings");
    const settingsNav = document.querySelectorAll("main nav")[0]!;
    fireEvent.click(within(settingsNav as HTMLElement).getByText("Appearance"));
    expect(screen.getByText(/Theme/)).toBeInTheDocument();
    fireEvent.click(within(settingsNav as HTMLElement).getByText("App Layout"));
    // Live + Settings are always shown; People/Memory are toggleable.
    expect(screen.getAllByText(/Always shown/).length).toBeGreaterThanOrEqual(2);
  });
});
