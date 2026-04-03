// =============================================================================
// Tests: BypassPill component
//
// Verifies visibility (hidden in default/accept-edits, visible in bypass),
// label variants (session vs gateway-flag), and the click-to-disable
// behavior (session-only — gateway-flag click is a no-op).
// =============================================================================

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { BypassPill } from "../src/components/BypassPill";
import { useSessionStore } from "../src/store/session-store";
import { useSocketStore } from "../src/store/socket-store";

beforeEach(() => {
  // Each test starts with a clean store
  useSessionStore.setState({
    permissionMode: null,
    forceBypass: false,
    activeKey: "web:test",
  } as any);
});

describe("BypassPill — visibility", () => {
  it("renders nothing when mode is null", () => {
    const { container } = render(<BypassPill />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing in default mode", () => {
    useSessionStore.setState({ permissionMode: "default" } as any);
    const { container } = render(<BypassPill />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing in accept-edits mode", () => {
    useSessionStore.setState({ permissionMode: "accept-edits" } as any);
    const { container } = render(<BypassPill />);
    expect(container.firstChild).toBeNull();
  });

  it("renders when mode is bypass", () => {
    useSessionStore.setState({ permissionMode: "bypass" } as any);
    render(<BypassPill />);
    expect(screen.getByRole("button")).toBeInTheDocument();
  });
});

describe("BypassPill — label variants", () => {
  it("shows BYPASS for session-level bypass", () => {
    useSessionStore.setState({
      permissionMode: "bypass",
      forceBypass: false,
    } as any);
    render(<BypassPill />);
    expect(screen.getByText("BYPASS")).toBeInTheDocument();
  });

  it("shows 'BYPASS (gateway flag)' when forceBypass is set", () => {
    useSessionStore.setState({
      permissionMode: "bypass",
      forceBypass: true,
    } as any);
    render(<BypassPill />);
    expect(screen.getByText("BYPASS (gateway flag)")).toBeInTheDocument();
  });
});

describe("BypassPill — click-to-disable", () => {
  it("session-level bypass: click sends permission.mode RPC with mode=default", () => {
    const rpc = vi.fn(async () => ({}));
    useSocketStore.setState({
      status: "connected", error: null, client: null, rpc: rpc as any,
      connect: vi.fn() as any, disconnect: vi.fn(),
      subscribe: vi.fn(() => () => {}), eventListeners: new Set(),
    });
    useSessionStore.setState({
      permissionMode: "bypass",
      forceBypass: false,
      activeKey: "web:test",
    } as any);

    render(<BypassPill />);
    fireEvent.click(screen.getByRole("button"));

    expect(rpc).toHaveBeenCalledWith("permission.mode", {
      mode: "default",
      sessionKey: "web:test",
    });
  });

  it("gateway-flag bypass: click is a no-op (no RPC, button is disabled)", () => {
    const rpc = vi.fn(async () => ({}));
    useSocketStore.setState({
      status: "connected", error: null, client: null, rpc: rpc as any,
      connect: vi.fn() as any, disconnect: vi.fn(),
      subscribe: vi.fn(() => () => {}), eventListeners: new Set(),
    });
    useSessionStore.setState({
      permissionMode: "bypass",
      forceBypass: true,
      activeKey: "web:test",
    } as any);

    render(<BypassPill />);
    const btn = screen.getByRole("button") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);

    expect(rpc).not.toHaveBeenCalled();
  });
});
