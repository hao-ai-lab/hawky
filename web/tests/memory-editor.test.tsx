// =============================================================================
// Tests: Memory Editor
//
// Unit tests for the MemoryEditor file browser and MemoryFileView viewer/editor.
// Uses mocked RPC responses — no real gateway connection.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryEditor } from "../src/components/MemoryEditor";
import { MemoryFileView } from "../src/components/MemoryFileView";
import { useSocketStore } from "../src/store/socket-store";

// Mock the socket store
const mockRpc = vi.fn();

beforeEach(() => {
  vi.restoreAllMocks();
  mockRpc.mockReset();

  // Set up socket store with connected status and mock rpc
  useSocketStore.setState({
    status: "connected",
    rpc: mockRpc,
  });
});

// =============================================================================
// MemoryEditor (file browser)
// =============================================================================

describe("MemoryEditor", () => {
  const mockFiles = {
    files: [
      { name: "MEMORY.md", path: "MEMORY.md", editable: true, size: 2048 },
      { name: "SOUL.md", path: "SOUL.md", editable: false, size: 1024 },
      { name: "USER.md", path: "USER.md", editable: false, size: 512 },
      { name: "2026-04-04.md", path: "memory/2026-04-04.md", editable: true, size: 256 },
      { name: "2026-04-03.md", path: "memory/2026-04-03.md", editable: true, size: 128 },
    ],
  };

  it("shows loading state", () => {
    mockRpc.mockImplementation(() => new Promise(() => {})); // Never resolves
    render(<MemoryEditor onClose={() => {}} />);
    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  it("renders file list after loading", async () => {
    mockRpc.mockResolvedValue(mockFiles);
    render(<MemoryEditor onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText("MEMORY.md")).toBeInTheDocument();
    });
    expect(screen.getByText("SOUL.md")).toBeInTheDocument();
    expect(screen.getByText("2026-04-04.md")).toBeInTheDocument();
  });

  it("separates workspace files and daily logs", async () => {
    mockRpc.mockResolvedValue(mockFiles);
    render(<MemoryEditor onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText("Workspace")).toBeInTheDocument();
    });
    expect(screen.getByText("Daily Logs")).toBeInTheDocument();
  });

  it("shows lock icon for read-only files", async () => {
    mockRpc.mockResolvedValue(mockFiles);
    render(<MemoryEditor onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText("SOUL.md")).toBeInTheDocument();
    });
    // SOUL.md and USER.md should have lock icons
    const locks = screen.getAllByText("🔒");
    expect(locks.length).toBe(2); // SOUL.md and USER.md
  });

  it("shows file sizes", async () => {
    mockRpc.mockResolvedValue(mockFiles);
    render(<MemoryEditor onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText("2.0 KB")).toBeInTheDocument(); // MEMORY.md
    });
  });

  it("shows empty state when no files", async () => {
    mockRpc.mockResolvedValue({ files: [] });
    render(<MemoryEditor onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText("No workspace files found")).toBeInTheDocument();
    });
  });
});

// =============================================================================
// MemoryFileView (file viewer/editor)
// =============================================================================

describe("MemoryFileView", () => {
  it("shows loading state", () => {
    mockRpc.mockImplementation(() => new Promise(() => {}));
    render(<MemoryFileView path="MEMORY.md" editable={true} onBack={() => {}} />);
    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  it("renders markdown content in view mode", async () => {
    mockRpc.mockResolvedValue({ content: "# Hello World\n\nSome **bold** text.", editable: true });
    render(<MemoryFileView path="MEMORY.md" editable={true} onBack={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText("Hello World")).toBeInTheDocument();
    });
  });

  it("shows Edit button for editable files", async () => {
    mockRpc.mockResolvedValue({ content: "# Test", editable: true });
    render(<MemoryFileView path="MEMORY.md" editable={true} onBack={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText("Edit")).toBeInTheDocument();
    });
  });

  it("does not show Edit button for read-only files", async () => {
    mockRpc.mockResolvedValue({ content: "# Soul", editable: false });
    render(<MemoryFileView path="SOUL.md" editable={false} onBack={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText("Soul")).toBeInTheDocument();
    });
    expect(screen.queryByText("Edit")).not.toBeInTheDocument();
    expect(screen.getByText("read-only")).toBeInTheDocument();
  });

  it("switches to edit mode on Edit click", async () => {
    mockRpc.mockResolvedValue({ content: "# Test content", editable: true });
    render(<MemoryFileView path="MEMORY.md" editable={true} onBack={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText("Edit")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Edit"));

    // Should now show textarea with raw content
    const textarea = screen.getByRole("textbox");
    expect(textarea).toBeInTheDocument();
    expect((textarea as HTMLTextAreaElement).value).toBe("# Test content");
    // Edit button should now say Preview
    expect(screen.getByText("Preview")).toBeInTheDocument();
  });

  it("calls onBack when back button clicked", async () => {
    mockRpc.mockResolvedValue({ content: "# Test", editable: true });
    const onBack = vi.fn();
    render(<MemoryFileView path="MEMORY.md" editable={true} onBack={onBack} />);

    await waitFor(() => {
      expect(screen.getByText("Edit")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText("Back to file list"));
    expect(onBack).toHaveBeenCalled();
  });

  it("shows file not found for missing files", async () => {
    mockRpc.mockRejectedValue(new Error("not found"));
    render(<MemoryFileView path="NONEXISTENT.md" editable={false} onBack={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText("File not found")).toBeInTheDocument();
    });
  });

  it("saves on blur when content changed", async () => {
    mockRpc.mockResolvedValueOnce({ content: "original", editable: true });
    render(<MemoryFileView path="MEMORY.md" editable={true} onBack={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText("Edit")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Edit"));

    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "updated content" } });

    // Should not save immediately (only the initial read so far)
    expect(mockRpc).toHaveBeenCalledTimes(1);

    // Blur triggers save
    mockRpc.mockResolvedValueOnce({ ok: true, path: "MEMORY.md" });
    fireEvent.blur(textarea);

    await waitFor(() => {
      expect(mockRpc).toHaveBeenCalledWith("workspace.write", {
        path: "MEMORY.md",
        content: "updated content",
      });
    });
  });
});
