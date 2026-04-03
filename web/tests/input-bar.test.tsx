import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { InputBar } from "../src/components/InputBar";
import { useSessionStore } from "../src/store/session-store";
import { useSocketStore } from "../src/store/socket-store";

beforeEach(() => {
  useSessionStore.setState({
    activeKey: "web:general",
    agentStatus: "idle",
    sendMessage: vi.fn() as any,
  });
  useSocketStore.setState({
    status: "connected",
  } as any);
});

describe("InputBar", () => {
  it("renders textarea for user channels", () => {
    render(<InputBar />);
    expect(screen.getByPlaceholderText(/message hawky/i)).toBeInTheDocument();
  });

  it("shows read-only notice for system sessions", () => {
    useSessionStore.setState({ activeKey: "heartbeat:main" });
    render(<InputBar />);
    expect(screen.getByText(/read only/i)).toBeInTheDocument();
  });

  // Cron sessions used to share the heartbeat read-only treatment. They're
  // chattable threads now: scheduled run opens the conversation, user can
  // reply right under it.
  it("renders chat input for cron sessions (chattable threads)", () => {
    useSessionStore.setState({ activeKey: "cron:hn-digest" });
    render(<InputBar />);
    expect(screen.queryByText(/read only/i)).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Reply in 🕐 hn-digest/)).toBeInTheDocument();
  });

  it("shows 'Connecting...' when disconnected", () => {
    useSocketStore.setState({ status: "disconnected" } as any);
    render(<InputBar />);
    expect(screen.getByPlaceholderText("Connecting...")).toBeInTheDocument();
  });

  it("shows 'Agent working...' when busy", () => {
    useSessionStore.setState({ agentStatus: "streaming" });
    render(<InputBar />);
    expect(screen.getByPlaceholderText("Agent working...")).toBeInTheDocument();
  });

  it("disables input when agent is busy", () => {
    useSessionStore.setState({ agentStatus: "thinking" });
    render(<InputBar />);
    const textarea = screen.getByPlaceholderText("Agent working...");
    expect(textarea).toBeDisabled();
  });

  it("disables send button when empty", () => {
    render(<InputBar />);
    const sendBtn = screen.getByTitle("Send");
    expect(sendBtn).toBeDisabled();
  });

  it("enables send button when text is entered", () => {
    render(<InputBar />);
    const textarea = screen.getByPlaceholderText(/message hawky/i);
    fireEvent.change(textarea, { target: { value: "Hello" } });
    const sendBtn = screen.getByTitle("Send");
    expect(sendBtn).not.toBeDisabled();
  });

  it("calls sendMessage on send button click", () => {
    const mockSend = vi.fn();
    useSessionStore.setState({ sendMessage: mockSend as any });

    render(<InputBar />);
    const textarea = screen.getByPlaceholderText(/message hawky/i);
    fireEvent.change(textarea, { target: { value: "Hello" } });
    fireEvent.click(screen.getByTitle("Send"));

    expect(mockSend).toHaveBeenCalledWith("Hello", undefined, undefined);
  });

  it("clears input after send", () => {
    useSessionStore.setState({ sendMessage: vi.fn() as any });

    render(<InputBar />);
    const textarea = screen.getByPlaceholderText(/message hawky/i) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "Hello" } });
    fireEvent.click(screen.getByTitle("Send"));

    expect(textarea.value).toBe("");
  });

  it("shows Stop button when agent is busy", () => {
    useSessionStore.setState({ agentStatus: "streaming" });
    render(<InputBar />);
    expect(screen.getByTitle("Stop")).toBeInTheDocument();
    expect(screen.queryByTitle("Send")).not.toBeInTheDocument();
  });

  it("shows Send button when agent is idle", () => {
    useSessionStore.setState({ agentStatus: "idle" });
    render(<InputBar />);
    expect(screen.getByTitle("Send")).toBeInTheDocument();
    expect(screen.queryByTitle("Stop")).not.toBeInTheDocument();
  });

  it("calls cancelAgent on Stop click", () => {
    const mockCancel = vi.fn();
    useSessionStore.setState({
      agentStatus: "thinking",
      cancelAgent: mockCancel as any,
    });
    render(<InputBar />);
    fireEvent.click(screen.getByTitle("Stop"));
    expect(mockCancel).toHaveBeenCalled();
  });

  it("Shift+Enter does not submit (allows newline)", () => {
    const mockSend = vi.fn();
    useSessionStore.setState({ sendMessage: mockSend as any });
    render(<InputBar />);
    const textarea = screen.getByPlaceholderText(/message hawky/i);
    fireEvent.change(textarea, { target: { value: "line 1" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("Enter submits the message", () => {
    const mockSend = vi.fn();
    useSessionStore.setState({ sendMessage: mockSend as any });
    render(<InputBar />);
    const textarea = screen.getByPlaceholderText(/message hawky/i);
    fireEvent.change(textarea, { target: { value: "Hello" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
    expect(mockSend).toHaveBeenCalled();
  });
});

// =============================================================================
// Keyboard shortcuts
// =============================================================================

describe("InputBar keyboard shortcuts", () => {
  it("Home key fires keydown event", () => {
    render(<InputBar />);
    const textarea = screen.getByPlaceholderText(/message hawky/i);
    fireEvent.change(textarea, { target: { value: "Hello World" } });
    // Home should not cause submit or other side effects
    const event = fireEvent.keyDown(textarea, { key: "Home" });
    // Event should be handled (preventDefault called)
    expect(event).toBe(false); // false = preventDefault was called
  });

  it("End key fires keydown event", () => {
    render(<InputBar />);
    const textarea = screen.getByPlaceholderText(/message hawky/i);
    fireEvent.change(textarea, { target: { value: "Hello World" } });
    const event = fireEvent.keyDown(textarea, { key: "End" });
    expect(event).toBe(false);
  });

  it("Ctrl+Left fires keydown event for word jump", () => {
    render(<InputBar />);
    const textarea = screen.getByPlaceholderText(/message hawky/i);
    fireEvent.change(textarea, { target: { value: "Hello World" } });
    const event = fireEvent.keyDown(textarea, { key: "ArrowLeft", ctrlKey: true });
    expect(event).toBe(false);
  });

  it("Ctrl+Right fires keydown event for word jump", () => {
    render(<InputBar />);
    const textarea = screen.getByPlaceholderText(/message hawky/i);
    fireEvent.change(textarea, { target: { value: "Hello World" } });
    const event = fireEvent.keyDown(textarea, { key: "ArrowRight", ctrlKey: true });
    expect(event).toBe(false);
  });

  it("plain arrow keys are not intercepted", () => {
    render(<InputBar />);
    const textarea = screen.getByPlaceholderText(/message hawky/i);
    fireEvent.change(textarea, { target: { value: "Hello" } });
    // Plain left arrow should NOT be prevented (browser handles)
    const event = fireEvent.keyDown(textarea, { key: "ArrowLeft" });
    expect(event).toBe(true); // true = not prevented
  });

  it("Ctrl+J inserts newline", () => {
    render(<InputBar />);
    const textarea = screen.getByPlaceholderText(/message hawky/i);
    fireEvent.change(textarea, { target: { value: "line1" } });
    const event = fireEvent.keyDown(textarea, { key: "j", ctrlKey: true });
    expect(event).toBe(false); // preventDefault called
  });

  it("Cmd+Left is not intercepted (browser native Home)", () => {
    render(<InputBar />);
    const textarea = screen.getByPlaceholderText(/message hawky/i);
    fireEvent.change(textarea, { target: { value: "Hello" } });
    // metaKey = Cmd on Mac — browser natively handles this as Home
    const event = fireEvent.keyDown(textarea, { key: "ArrowLeft", metaKey: true });
    expect(event).toBe(true); // not intercepted
  });
});
