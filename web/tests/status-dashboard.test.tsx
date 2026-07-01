// =============================================================================
// Tests: Status Dashboard
//
// Unit tests for the gateway status dashboard component.
// Uses mocked RPC responses — no real gateway connection.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { StatusDashboard } from "../src/components/StatusDashboard";
import { useSocketStore } from "../src/store/socket-store";

const mockRpc = vi.fn();

const mockStatus = {
  timestamp: Date.now(),
  uptimeSeconds: 3661,
  connections: {
    count: 2,
    clients: [
      { connId: "conn-1", platform: "web", sessionKey: "web:general" },
      { connId: "conn-2", platform: "tui", sessionKey: "tui:main" },
    ],
  },
  sessions: { count: 3, keys: ["web:general", "tui:main", "heartbeat:main"] },
  heartbeat: {
    enabled: true,
    lastRunAt: Date.now() - 60000,
    lastStatus: "ran",
    lastDurationMs: 2500,
    nextRunAt: Date.now() + 1740000,
    running: false,
    lastConsolidatedAt: Date.now() - 86400000,
  },
  cron: {
    enabled: true,
    jobCount: 2,
    enabledJobCount: 1,
    jobs: [
      { id: "j1", name: "hn-digest", enabled: true, nextRunAt: Date.now() + 3600000, lastRunAt: Date.now() - 7200000, lastStatus: "ok", lastDurationMs: 5000 },
      { id: "j2", name: "local-diff", enabled: false, nextRunAt: null, lastRunAt: null, lastStatus: null, lastDurationMs: null },
    ],
  },
  usage: {
    date: "2026-04-05",
    tokens: { input: 45000, output: 12000, cacheRead: 30000, cacheCreation: 5000 },
    costUSD: 0.42,
    byModel: { "claude-sonnet-4-6": { input: 40000, output: 10000, costUSD: 0.27 } },
    apiCalls: 15,
  },
};

const mockUsageHistory = {
  range: "7d",
  entries: [
    { date: "2026-04-05", tokens: { input: 45000, output: 12000, cacheRead: 30000, cacheCreation: 5000 }, costUSD: 0.42, apiCalls: 15, byModel: { "claude-sonnet-4-6": { input: 40000, output: 10000, costUSD: 0.27 } } },
    { date: "2026-04-04", tokens: { input: 20000, output: 5000, cacheRead: 0, cacheCreation: 0 }, costUSD: 0.15, apiCalls: 8, byModel: {} },
  ],
  summary: { totalCostUSD: 0.57, totalTokens: 82000, totalApiCalls: 23, activeDays: 2, dailyAvgCost: 0.285, peakDay: { date: "2026-04-05", costUSD: 0.42 }, byModel: { "claude-sonnet-4-6": { tokens: 50000, costUSD: 0.27 } } },
};

beforeEach(() => {
  vi.restoreAllMocks();
  mockRpc.mockReset();
  // Mock both gateway.status and gateway.usageHistory RPCs
  mockRpc.mockImplementation((method: string) => {
    if (method === "gateway.status") return Promise.resolve(mockStatus);
    if (method === "gateway.usageHistory") return Promise.resolve(mockUsageHistory);
    return Promise.reject(new Error(`Unknown method: ${method}`));
  });
  useSocketStore.setState({ status: "connected", rpc: mockRpc } as any);
});

describe("StatusDashboard", () => {
  it("shows loading state", () => {
    mockRpc.mockImplementation(() => new Promise(() => {})); // Never resolves
    render(<StatusDashboard />);
    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  it("renders gateway status after loading", async () => {
    // Uses default mock from beforeEach
    render(<StatusDashboard />);

    await waitFor(() => {
      expect(screen.getByText("1h 1m")).toBeInTheDocument(); // 3661 seconds
    });
  });

  it("renders heartbeat section", async () => {
    // Uses default mock from beforeEach
    render(<StatusDashboard />);

    await waitFor(() => {
      expect(screen.getByText("Heartbeat")).toBeInTheDocument();
    });
    expect(screen.getByText("Healthy")).toBeInTheDocument();
  });

  it("renders cron jobs", async () => {
    // Uses default mock from beforeEach
    render(<StatusDashboard />);

    await waitFor(() => {
      expect(screen.getByText("hn-digest")).toBeInTheDocument();
    });
    expect(screen.getByText("local-diff")).toBeInTheDocument();
    expect(screen.getByText("(disabled)")).toBeInTheDocument();
  });

  it("cron next-run shows a date qualifier when not today", async () => {
    // Override the default cron jobs with explicit nextRunAt values so we
    // can assert on tomorrow / weekday / month-day formatting. A bare
    // clock time alone (e.g. "07:00 PM") leaves the user guessing whether
    // it fires today, tomorrow, or next week — fmtNextRun fixes that.
    const now = Date.now();
    const oneDay = 86_400_000;
    const tomorrow = new Date(now + oneDay);
    tomorrow.setHours(19, 0, 0, 0);
    const inThreeDays = new Date(now + 3 * oneDay);
    inThreeDays.setHours(10, 0, 0, 0);
    const inTwoWeeks = new Date(now + 14 * oneDay);
    inTwoWeeks.setHours(9, 0, 0, 0);

    mockRpc.mockImplementation((method: string) => {
      if (method === "gateway.status") {
        return Promise.resolve({
          ...mockStatus,
          cron: {
            ...mockStatus.cron,
            jobs: [
              { id: "a", name: "j-tomorrow", enabled: true, nextRunAt: tomorrow.getTime(), lastRunAt: null, lastStatus: null, lastDurationMs: null },
              { id: "b", name: "j-soon", enabled: true, nextRunAt: inThreeDays.getTime(), lastRunAt: null, lastStatus: null, lastDurationMs: null },
              { id: "c", name: "j-faraway", enabled: true, nextRunAt: inTwoWeeks.getTime(), lastRunAt: null, lastStatus: null, lastDurationMs: null },
            ],
          },
        });
      }
      if (method === "gateway.usageHistory") return Promise.resolve(mockUsageHistory);
      return Promise.resolve(null);
    });

    render(<StatusDashboard />);

    await waitFor(() => {
      expect(screen.getByText("j-tomorrow")).toBeInTheDocument();
    });

    const rowFor = (jobName: string) => {
      const row = screen.getByText(jobName).closest("div.flex.items-start");
      if (!row) throw new Error(`Could not find row for ${jobName}`);
      return within(row as HTMLElement);
    };

    // Tomorrow → "Tomorrow HH:MM"
    expect(rowFor("j-tomorrow").getByText(/Tomorrow \d{2}:\d{2}/)).toBeInTheDocument();
    // 3 days out → weekday short name + time
    const weekday3 = inThreeDays.toLocaleDateString([], { weekday: "short" });
    expect(rowFor("j-soon").getByText(new RegExp(`${weekday3} \\d{2}:\\d{2}`))).toBeInTheDocument();
    // 2 weeks out → month + day + time
    const monthDay = inTwoWeeks.toLocaleDateString([], { month: "short", day: "numeric" });
    expect(
      rowFor("j-faraway").getByText(new RegExp(`${monthDay.replace(/\s/g, "\\s")} \\d{2}:\\d{2}`)),
    ).toBeInTheDocument();
  });

  it("renders usage stats section", async () => {
    render(<StatusDashboard />);

    await waitFor(() => {
      expect(screen.getByText("Usage")).toBeInTheDocument();
    });
    // Summary shows total from history (0.57, not today's 0.42)
    // Needs waitFor because usage history is fetched via a separate async RPC
    await waitFor(() => {
      expect(screen.getByText("$0.57")).toBeInTheDocument();
    });
  });

  it("renders active sessions", async () => {
    // Uses default mock from beforeEach
    render(<StatusDashboard />);

    await waitFor(() => {
      expect(screen.getByText("Active Sessions")).toBeInTheDocument();
    });
    expect(screen.getByText("heartbeat:main")).toBeInTheDocument();
  });

  it("shows connection details", async () => {
    // Uses default mock from beforeEach
    render(<StatusDashboard />);

    await waitFor(() => {
      expect(screen.getByText("Connected Clients")).toBeInTheDocument();
    });
    // KV rows: label=platform, value=sessionKey
    expect(screen.getByText("web")).toBeInTheDocument();
    expect(screen.getByText("tui")).toBeInTheDocument();
  });

  it("shows model breakdown in usage history", async () => {
    render(<StatusDashboard />);

    await waitFor(() => {
      expect(screen.getByText("claude-sonnet-4-6")).toBeInTheDocument();
    });
  });

  it("handles error state", async () => {
    mockRpc.mockImplementation(() => Promise.reject(new Error("connection failed")));
    render(<StatusDashboard />);

    await waitFor(() => {
      expect(screen.getByText("Unable to load status")).toBeInTheDocument();
    });
  });
});
