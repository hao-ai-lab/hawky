import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { LiveTranscription } from "../src/components/LiveTranscription";
import { useSocketStore } from "../src/store/socket-store";

function mockSocket(status: string) {
  useSocketStore.setState({
    status: status as any,
    error: null,
    client: null,
    eventListeners: new Set(),
    rpc: (async () => ({})) as any,
    connect: vi.fn() as any,
    disconnect: vi.fn(),
    subscribe: vi.fn(() => () => {}),
  });
}

beforeEach(() => {
  mockSocket("disconnected");
});

describe("LiveTranscription", () => {
  it("disables Start until the gateway is connected", () => {
    mockSocket("disconnected");
    render(<LiveTranscription />);
    const start = screen.getByRole("button", { name: "Start" });
    expect(start).toBeDisabled();
    expect(screen.getByText(/connect to the gateway/i)).toBeInTheDocument();
  });

  it("enables Start once connected and shows the speak prompt", () => {
    mockSocket("connected");
    render(<LiveTranscription />);
    const start = screen.getByRole("button", { name: "Start" });
    expect(start).not.toBeDisabled();
    expect(screen.getByText(/press start and speak/i)).toBeInTheDocument();
  });

  it("disables Copy when there is no transcript yet", () => {
    mockSocket("connected");
    render(<LiveTranscription />);
    expect(screen.getByRole("button", { name: "Copy" })).toBeDisabled();
  });

  it("renders the microphone transcription header", () => {
    mockSocket("connected");
    render(<LiveTranscription />);
    expect(screen.getByText(/microphone transcription/i)).toBeInTheDocument();
  });
});
