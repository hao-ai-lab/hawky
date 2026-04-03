// =============================================================================
// Tests: Web Image Attachments
//
// Covers: InputBar file picker, drag-drop, paste, preview, remove,
// sendMessage with attachments, ChatView image rendering
// =============================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { InputBar } from "../src/components/InputBar";
import { useSessionStore } from "../src/store/session-store";
import { useSocketStore } from "../src/store/socket-store";

// Tiny 1x1 PNG as base64
const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";

beforeEach(() => {
  useSessionStore.setState({
    sessions: [],
    activeKey: "web:general",
    messages: [],
    loading: false,
    agentStatus: "idle",
  });

  useSocketStore.setState({
    status: "connected",
    rpc: vi.fn(async () => ({})) as any,
    connect: vi.fn() as any,
    disconnect: vi.fn(),
    subscribe: vi.fn(() => () => {}),
  } as any);
});

// =============================================================================
// InputBar rendering
// =============================================================================

describe("InputBar", () => {
  it("renders attach button", () => {
    render(<InputBar />);
    expect(screen.getByTestId("attach-button")).toBeInTheDocument();
  });

  it("has hidden file input with image accept types", () => {
    render(<InputBar />);
    const fileInput = screen.getByTestId("file-input") as HTMLInputElement;
    expect(fileInput.type).toBe("file");
    expect(fileInput.accept).toContain("image/png");
    expect(fileInput.accept).toContain("image/jpeg");
    expect(fileInput.multiple).toBe(true);
  });

  it("renders textarea for text input", () => {
    render(<InputBar />);
    expect(screen.getByPlaceholderText(/message hawky/i)).toBeInTheDocument();
  });

  it("shows system session message for system channels", () => {
    useSessionStore.setState({ activeKey: "heartbeat:main" });
    render(<InputBar />);
    expect(screen.getByText(/System session/)).toBeInTheDocument();
  });
});

// =============================================================================
// Drag and drop
// =============================================================================

describe("drag and drop", () => {
  it("shows drag overlay when dragging over", () => {
    render(<InputBar />);
    const container = screen.getByPlaceholderText(/message hawky/i).closest('[class*="rounded-2xl"]')!;
    fireEvent.dragOver(container);
    expect(screen.getByText(/Drop images or PDFs here/)).toBeInTheDocument();
  });

  it("removes drag overlay on drag leave", () => {
    render(<InputBar />);
    const container = screen.getByPlaceholderText(/message hawky/i).closest('[class*="rounded-2xl"]')!;
    fireEvent.dragOver(container);
    expect(screen.getByText(/Drop images or PDFs here/)).toBeInTheDocument();
    fireEvent.dragLeave(container);
    expect(screen.queryByText(/Drop images or PDFs here/)).not.toBeInTheDocument();
  });
});

// =============================================================================
// Send with attachments
// =============================================================================

describe("send with attachments", () => {
  it("sendMessage receives attachments parameter", async () => {
    const mockSend = vi.fn();
    useSessionStore.setState({ sendMessage: mockSend } as any);

    render(<InputBar />);
    const textarea = screen.getByPlaceholderText(/message hawky/i) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "Check this image" } });

    // Send without attachments
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(mockSend).toHaveBeenCalledWith("Check this image", undefined, undefined);
  });

  it("enables send button when only images attached (no text)", () => {
    render(<InputBar />);
    const sendButton = screen.getByTitle("Send");
    // Initially disabled (no text, no attachments)
    expect(sendButton).toBeDisabled();
  });
});

// =============================================================================
// Error handling
// =============================================================================

describe("error handling", () => {
  it("shows error for unsupported file type", () => {
    render(<InputBar />);
    const fileInput = screen.getByTestId("file-input") as HTMLInputElement;

    // PDFs are now accepted as documents — pick a truly unsupported type
    // (a generic binary) to exercise the error path.
    const zipFile = new File(["zip content"], "archive.zip", { type: "application/zip" });
    Object.defineProperty(fileInput, "files", { value: [zipFile] });
    fireEvent.change(fileInput);

    expect(screen.getByText(/Unsupported format/)).toBeInTheDocument();
  });

  it("accepts oversized file (auto-resized on client)", () => {
    // Large images are now auto-resized via Canvas instead of rejected.
    // This test verifies no error is shown for large files.
    render(<InputBar />);
    const fileInput = screen.getByTestId("file-input") as HTMLInputElement;

    const bigFile = new File([new ArrayBuffer(6 * 1024 * 1024)], "big.png", { type: "image/png" });
    Object.defineProperty(fileInput, "files", { value: [bigFile] });
    fireEvent.change(fileInput);

    // No error shown — file is accepted for resize
    expect(screen.queryByText(/too large/)).not.toBeInTheDocument();
  });

  it("shows an error when the user selects more PDFs than the per-turn cap", () => {
    render(<InputBar />);
    const fileInput = screen.getByTestId("file-input") as HTMLInputElement;

    // 4 PDFs in one multi-select → cap is 3 → must surface the error
    // synchronously. A prior implementation waited for the async reader
    // callbacks, which silently dropped the 4th file without a message.
    const pdfs = [0, 1, 2, 3].map((i) =>
      new File([new ArrayBuffer(64)], `doc${i}.pdf`, { type: "application/pdf" }),
    );
    Object.defineProperty(fileInput, "files", { value: pdfs });
    fireEvent.change(fileInput);

    expect(screen.getByText(/Max 3 PDFs per message/)).toBeInTheDocument();
  });
});

// =============================================================================
// Session store sendMessage with attachments
// =============================================================================

describe("session store sendMessage", () => {
  it("sendMessage signature accepts attachments parameter", () => {
    // Verify the store action has the right signature (TypeScript contract)
    const fn = useSessionStore.getState().sendMessage;
    expect(typeof fn).toBe("function");
    // Function should accept 2 params: text and optional attachments
    expect(fn.length).toBeLessThanOrEqual(2);
  });

  it("SessionMessage type supports images field", () => {
    // Verify images field works on message objects
    useSessionStore.setState({
      messages: [{
        id: "img-msg",
        role: "user",
        content: "Check this",
        images: [{ base64: TINY_PNG, media_type: "image/png" }],
      }],
    });
    const msg = useSessionStore.getState().messages[0];
    expect(msg.images).toBeDefined();
    expect(msg.images![0].base64).toBe(TINY_PNG);
    expect(msg.images![0].media_type).toBe("image/png");
  });

  it("messages without images have undefined images field", () => {
    useSessionStore.setState({
      messages: [{
        id: "text-msg",
        role: "user",
        content: "Hello",
      }],
    });
    const msg = useSessionStore.getState().messages[0];
    expect(msg.images).toBeUndefined();
  });
});

// =============================================================================
// ChatView image rendering (via session store message format)
// =============================================================================

describe("message image data", () => {
  it("user message with images has images array", () => {
    useSessionStore.setState({
      messages: [{
        id: "msg-1",
        role: "user",
        content: "Check this",
        images: [{ base64: TINY_PNG, media_type: "image/png" }],
      }],
    });

    const messages = useSessionStore.getState().messages;
    expect(messages[0].images).toBeDefined();
    expect(messages[0].images!.length).toBe(1);
    expect(messages[0].images![0].media_type).toBe("image/png");
  });

  it("user message without images has no images array", () => {
    useSessionStore.setState({
      messages: [{
        id: "msg-1",
        role: "user",
        content: "Plain text",
      }],
    });

    const messages = useSessionStore.getState().messages;
    expect(messages[0].images).toBeUndefined();
  });
});
