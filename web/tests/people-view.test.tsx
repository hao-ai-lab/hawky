import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { PeopleView } from "../src/components/PeopleView";
import { useSocketStore } from "../src/store/socket-store";

function mockSocket(rpc: (method: string, params?: unknown) => Promise<unknown>, status = "connected") {
  useSocketStore.setState({
    status: status as any,
    error: null,
    client: null,
    eventListeners: new Set(),
    rpc: rpc as any,
    connect: vi.fn() as any,
    disconnect: vi.fn(),
    subscribe: vi.fn(() => () => {}),
  });
}

beforeEach(() => {
  useSocketStore.setState({ status: "disconnected", rpc: (async () => ({})) as any });
});

describe("PeopleView", () => {
  it("renders people returned by people.list", async () => {
    mockSocket(async (method) => {
      if (method === "people.list") {
        return {
          ok: true,
          available: true,
          people: [
            {
              id: "p1",
              name: "Jay",
              facts: ["Loves rock climbing"],
              recaps: [{ summary: "Talked about the demo." }],
              last_seen_at: "2026-06-20T05:51:11Z",
            },
          ],
        };
      }
      return {};
    });

    render(<PeopleView />);

    expect(await screen.findByText("Jay")).toBeInTheDocument();
    expect(screen.getByText("Loves rock climbing")).toBeInTheDocument();
    expect(screen.getByText(/Talked about the demo/)).toBeInTheDocument();
  });

  it("shows the 'service not running' state when unavailable", async () => {
    mockSocket(async (method) => {
      if (method === "people.list") {
        return { ok: true, available: false, people: [], note: "Face database service is not running." };
      }
      return {};
    });

    render(<PeopleView />);

    await waitFor(() =>
      expect(screen.getAllByText(/face database service is not running/i).length).toBeGreaterThan(0),
    );
  });

  it("shows an empty state when available with no people", async () => {
    mockSocket(async (method) => {
      if (method === "people.list") return { ok: true, available: true, people: [] };
      return {};
    });

    render(<PeopleView />);

    await waitFor(() => expect(screen.getByText(/no people enrolled yet/i)).toBeInTheDocument());
  });

  it("prompts to connect when the gateway is disconnected", () => {
    mockSocket(async () => ({}), "disconnected");
    render(<PeopleView />);
    expect(screen.getByText(/connect to the gateway/i)).toBeInTheDocument();
  });
});
