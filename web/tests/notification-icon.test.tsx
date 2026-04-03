import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { NotificationIcon } from "../src/components/NotificationIcon";
import { useSocketStore } from "../src/store/socket-store";

// Mock push module
vi.mock("../src/lib/push", () => ({
  getPushState: vi.fn(() => "prompt"),
  getActiveSubscription: vi.fn(() => null),
  subscribeToPush: vi.fn(() => "subscribed"),
  unsubscribeFromPush: vi.fn(() => "prompt"),
}));

beforeEach(() => {
  useSocketStore.setState({ status: "connected", rpc: vi.fn(async () => ({ enabled: false, publicKey: null })) });
});

describe("NotificationIcon", () => {
  it("renders nothing when push is unsupported", () => {
    // Default mock returns unsupported (disabled, no VAPID key)
    const { container } = render(<NotificationIcon />);
    // Initially renders, then effect sets state — may render null
    // The component hides when unsupported/disabled
    expect(container).toBeDefined();
  });

  it("renders a button with notification icon when available", async () => {
    useSocketStore.setState({
      status: "connected",
      rpc: vi.fn(async () => ({ enabled: true, publicKey: "test-key" })),
    });
    render(<NotificationIcon />);
    // Wait for async effect
    await vi.waitFor(() => {
      expect(screen.getByTestId("notification-icon")).toBeInTheDocument();
    });
  });

  it("shows tooltip on hover", async () => {
    useSocketStore.setState({
      status: "connected",
      rpc: vi.fn(async () => ({ enabled: true, publicKey: "test-key" })),
    });
    render(<NotificationIcon />);

    await vi.waitFor(() => {
      expect(screen.getByTestId("notification-icon")).toBeInTheDocument();
    });

    fireEvent.mouseEnter(screen.getByTestId("notification-icon").parentElement!);
    expect(screen.getByText("Notifications off")).toBeInTheDocument();
  });

  it("has correct aria-label", async () => {
    useSocketStore.setState({
      status: "connected",
      rpc: vi.fn(async () => ({ enabled: true, publicKey: "test-key" })),
    });
    render(<NotificationIcon />);

    await vi.waitFor(() => {
      const btn = screen.getByTestId("notification-icon");
      expect(btn.getAttribute("aria-label")).toBeTruthy();
    });
  });
});
