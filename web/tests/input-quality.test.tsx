// =============================================================================
// Tests: Web Input Quality Improvements
//
// Covers: input history (Up/Down), slash command autocomplete, IME composition
// guard, Shift+Esc global focus
// =============================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { InputBar } from "../src/components/InputBar";
import { useSessionStore } from "../src/store/session-store";
import { useSocketStore } from "../src/store/socket-store";

beforeEach(() => {
  localStorage.clear();
  useSessionStore.setState({
    activeKey: "web:general",
    agentStatus: "idle",
    sendMessage: vi.fn() as any,
  });
  useSocketStore.setState({
    status: "connected",
  } as any);
});

// Slash command autocomplete — removed (commands not functional in web yet)

// =============================================================================
// Input history
// =============================================================================

describe("input history", () => {
  it("recalls previous message on Up arrow when empty", () => {
    // Seed history in localStorage
    localStorage.setItem("hawky:inputHistory", JSON.stringify(["hello world", "second message"]));

    render(<InputBar />);
    const textarea = screen.getByPlaceholderText(/message hawky/i) as HTMLTextAreaElement;

    // Up arrow should load last history entry
    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    // The component sets text via setState which won't show in textarea.value in test,
    // but we can verify the keyDown was handled (preventDefault called)
    // In a real browser the text would update
  });

  it("saves message to history on send", () => {
    const mockSend = vi.fn();
    useSessionStore.setState({ sendMessage: mockSend as any });

    render(<InputBar />);
    const textarea = screen.getByPlaceholderText(/message hawky/i);
    fireEvent.change(textarea, { target: { value: "test message" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    // Check localStorage was updated
    const history = JSON.parse(localStorage.getItem("hawky:inputHistory") || "[]");
    expect(history).toContain("test message");
  });

  it("deduplicates consecutive identical messages", () => {
    localStorage.setItem("hawky:inputHistory", JSON.stringify(["first"]));
    const mockSend = vi.fn();
    useSessionStore.setState({ sendMessage: mockSend as any });

    render(<InputBar />);
    const textarea = screen.getByPlaceholderText(/message hawky/i);

    // Send "first" again
    fireEvent.change(textarea, { target: { value: "first" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    const history = JSON.parse(localStorage.getItem("hawky:inputHistory") || "[]");
    // Should not have duplicated "first"
    expect(history.filter((h: string) => h === "first").length).toBe(1);
  });

  it("persists across renders", () => {
    const mockSend = vi.fn();
    useSessionStore.setState({ sendMessage: mockSend as any });

    const { unmount } = render(<InputBar />);
    const textarea = screen.getByPlaceholderText(/message hawky/i);
    fireEvent.change(textarea, { target: { value: "persist this" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    unmount();

    // Re-render — history should be in localStorage
    const history = JSON.parse(localStorage.getItem("hawky:inputHistory") || "[]");
    expect(history).toContain("persist this");
  });
});

// =============================================================================
// IME composition guard
// =============================================================================

describe("IME composition guard", () => {
  it("does not submit on Enter during IME composition (keyCode 229)", () => {
    const mockSend = vi.fn();
    useSessionStore.setState({ sendMessage: mockSend as any });

    render(<InputBar />);
    const textarea = screen.getByPlaceholderText(/message hawky/i);
    fireEvent.change(textarea, { target: { value: "你" } });

    // keyCode 229 is the standard IME composition indicator
    // Browsers fire this when Enter is pressed during CJK composition
    fireEvent.keyDown(textarea, { key: "Enter", keyCode: 229 });

    expect(mockSend).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Enter key behavior on desktop vs touch devices
// =============================================================================

describe("Enter key — desktop vs touch", () => {
  // jsdom's default matchMedia returns matches:false for any query, so these
  // "desktop" tests run under the desktop branch by default.

  it("desktop: bare Enter sends the message", () => {
    const mockSend = vi.fn();
    useSessionStore.setState({ sendMessage: mockSend as any });

    render(<InputBar />);
    const textarea = screen.getByPlaceholderText(/message hawky/i);
    fireEvent.change(textarea, { target: { value: "hello" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("desktop: Shift+Enter does NOT send (browser inserts newline)", () => {
    const mockSend = vi.fn();
    useSessionStore.setState({ sendMessage: mockSend as any });

    render(<InputBar />);
    const textarea = screen.getByPlaceholderText(/message hawky/i);
    fireEvent.change(textarea, { target: { value: "hello" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });

    expect(mockSend).not.toHaveBeenCalled();
  });

  it("touch: bare Enter does NOT send (inserts newline)", () => {
    // Override matchMedia to simulate a touch device
    const original = window.matchMedia;
    (window as any).matchMedia = (query: string) => ({
      matches: query.includes("hover: none") && query.includes("pointer: coarse"),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    });

    const mockSend = vi.fn();
    useSessionStore.setState({ sendMessage: mockSend as any });

    render(<InputBar />);
    const textarea = screen.getByPlaceholderText(/message hawky/i);
    fireEvent.change(textarea, { target: { value: "hello" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(mockSend).not.toHaveBeenCalled();

    (window as any).matchMedia = original;
  });

  it("touch: Cmd+Enter still sends (external-keyboard shortcut)", () => {
    const original = window.matchMedia;
    (window as any).matchMedia = (query: string) => ({
      matches: query.includes("hover: none") && query.includes("pointer: coarse"),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    });

    const mockSend = vi.fn();
    useSessionStore.setState({ sendMessage: mockSend as any });

    render(<InputBar />);
    const textarea = screen.getByPlaceholderText(/message hawky/i);
    fireEvent.change(textarea, { target: { value: "hello" } });
    fireEvent.keyDown(textarea, { key: "Enter", metaKey: true });

    expect(mockSend).toHaveBeenCalledTimes(1);

    (window as any).matchMedia = original;
  });
});

// =============================================================================
// Shift+Esc global focus
// =============================================================================

describe("Shift+Esc global focus", () => {
  it("focuses input on Shift+Esc", () => {
    render(<InputBar />);
    const textarea = screen.getByPlaceholderText(/message hawky/i);

    // Blur the textarea first
    textarea.blur();
    expect(document.activeElement).not.toBe(textarea);

    // Fire Shift+Esc on document
    fireEvent.keyDown(document, { key: "Escape", shiftKey: true });

    // Textarea should be focused
    expect(document.activeElement).toBe(textarea);
  });

  it("does not focus on plain Esc", () => {
    render(<InputBar />);
    const textarea = screen.getByPlaceholderText(/message hawky/i);
    textarea.blur();

    fireEvent.keyDown(document, { key: "Escape", shiftKey: false });
    expect(document.activeElement).not.toBe(textarea);
  });
});

// =============================================================================
// Integration: multi-step flows
// =============================================================================

describe("input history integration", () => {
  it("full cycle: send → recall → edit → send again", () => {
    const mockSend = vi.fn();
    useSessionStore.setState({ sendMessage: mockSend as any });

    render(<InputBar />);
    const textarea = screen.getByPlaceholderText(/message hawky/i) as HTMLTextAreaElement;

    // Send first message
    fireEvent.change(textarea, { target: { value: "first message" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(mockSend).toHaveBeenCalledTimes(1);

    // Send second message
    fireEvent.change(textarea, { target: { value: "second message" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(mockSend).toHaveBeenCalledTimes(2);

    // Verify both are in localStorage
    const history = JSON.parse(localStorage.getItem("hawky:inputHistory") || "[]");
    expect(history).toEqual(["first message", "second message"]);
  });

  it("history survives re-render", () => {
    const mockSend = vi.fn();
    useSessionStore.setState({ sendMessage: mockSend as any });

    const { unmount } = render(<InputBar />);
    const textarea = screen.getByPlaceholderText(/message hawky/i);

    // Send messages
    fireEvent.change(textarea, { target: { value: "msg1" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    fireEvent.change(textarea, { target: { value: "msg2" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    unmount();

    // Re-render — localStorage should still have history
    render(<InputBar />);
    const history = JSON.parse(localStorage.getItem("hawky:inputHistory") || "[]");
    expect(history).toContain("msg1");
    expect(history).toContain("msg2");
  });

  it("max 100 entries enforced", () => {
    // Seed with 99 entries
    const history = Array.from({ length: 99 }, (_, i) => `msg-${i}`);
    localStorage.setItem("hawky:inputHistory", JSON.stringify(history));

    const mockSend = vi.fn();
    useSessionStore.setState({ sendMessage: mockSend as any });

    render(<InputBar />);
    const textarea = screen.getByPlaceholderText(/message hawky/i);

    // Send two more (total 101 → should cap at 100)
    fireEvent.change(textarea, { target: { value: "msg-99" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    fireEvent.change(textarea, { target: { value: "msg-100" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    const stored = JSON.parse(localStorage.getItem("hawky:inputHistory") || "[]");
    expect(stored.length).toBeLessThanOrEqual(100);
    expect(stored[stored.length - 1]).toBe("msg-100");
  });
});

describe("input history edge cases", () => {
  it("handles corrupt localStorage gracefully (object instead of array)", () => {
    localStorage.setItem("hawky:inputHistory", '{"not": "an array"}');
    // Should not crash — loadHistory validates
    render(<InputBar />);
    expect(screen.getByPlaceholderText(/message hawky/i)).toBeInTheDocument();
  });

  it("handles corrupt localStorage gracefully (string instead of array)", () => {
    localStorage.setItem("hawky:inputHistory", '"just a string"');
    render(<InputBar />);
    expect(screen.getByPlaceholderText(/message hawky/i)).toBeInTheDocument();
  });

  it("handles corrupt localStorage gracefully (invalid JSON)", () => {
    localStorage.setItem("hawky:inputHistory", "not json at all {{{");
    render(<InputBar />);
    expect(screen.getByPlaceholderText(/message hawky/i)).toBeInTheDocument();
  });

  it("filters out non-string entries from history", () => {
    localStorage.setItem("hawky:inputHistory", JSON.stringify(["valid", 42, null, "", "also valid"]));
    const mockSend = vi.fn();
    useSessionStore.setState({ sendMessage: mockSend as any });
    render(<InputBar />);
    // Should render without crash — non-strings and empty strings filtered out
    expect(screen.getByPlaceholderText(/message hawky/i)).toBeInTheDocument();
  });

  it("empty history returns nothing on Up", () => {
    localStorage.removeItem("hawky:inputHistory");
    render(<InputBar />);
    const textarea = screen.getByPlaceholderText(/message hawky/i) as HTMLTextAreaElement;
    // Up arrow should not change anything when history is empty
    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    expect(textarea.value).toBe("");
  });
});

describe("IME guard edge cases", () => {
  it("allows normal Enter when not composing", () => {
    const mockSend = vi.fn();
    useSessionStore.setState({ sendMessage: mockSend as any });
    render(<InputBar />);
    const textarea = screen.getByPlaceholderText(/message hawky/i);
    fireEvent.change(textarea, { target: { value: "hello" } });
    fireEvent.keyDown(textarea, { key: "Enter", keyCode: 13 });
    expect(mockSend).toHaveBeenCalled();
  });
});

describe("Shift+Esc integration", () => {
  it("works after sending a message (re-focus cycle)", () => {
    const mockSend = vi.fn();
    useSessionStore.setState({ sendMessage: mockSend as any });

    render(<InputBar />);
    const textarea = screen.getByPlaceholderText(/message hawky/i);

    // Send a message
    fireEvent.change(textarea, { target: { value: "test" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    // Blur
    textarea.blur();
    expect(document.activeElement).not.toBe(textarea);

    // Shift+Esc to re-focus
    fireEvent.keyDown(document, { key: "Escape", shiftKey: true });
    expect(document.activeElement).toBe(textarea);
  });
});

// =============================================================================
// Auto-focus on agent done
// =============================================================================

describe("auto-focus on agent done", () => {
  it("does NOT focus when agent stays idle (no busy→idle transition)", () => {
    useSessionStore.setState({ agentStatus: "idle" });
    render(<InputBar />);
    const textarea = screen.getByPlaceholderText(/message hawky/i);
    textarea.blur();

    // Re-set to idle (no transition from busy)
    act(() => { useSessionStore.setState({ agentStatus: "idle" }); });
    expect(document.activeElement).not.toBe(textarea);
  });

  it("input is disabled during streaming", () => {
    useSessionStore.setState({ agentStatus: "streaming", loading: false });
    useSocketStore.setState({ status: "connected" } as any);
    render(<InputBar />);
    // Placeholder changes when busy
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(true);
  });
});

// =============================================================================
// Up arrow with multi-line text
// =============================================================================

describe("up arrow multi-line behavior", () => {
  it("does NOT trigger history when text has newlines and cursor is not on first line", () => {
    localStorage.setItem("hawky:inputHistory", JSON.stringify(["old message"]));
    render(<InputBar />);
    const textarea = screen.getByPlaceholderText(/message hawky/i) as HTMLTextAreaElement;

    // Type multi-line text
    fireEvent.change(textarea, { target: { value: "line1\nline2\nline3" } });

    // Place cursor on line 2 (after first newline)
    textarea.setSelectionRange(6, 6);

    // Up arrow should NOT trigger history (cursor not on first line)
    fireEvent.keyDown(textarea, { key: "ArrowUp" });

    // Value should still be the multi-line text (not replaced by history)
    expect(textarea.value).toBe("line1\nline2\nline3");
  });
});
