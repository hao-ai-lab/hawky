import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PermissionDialog } from "../src/components/PermissionDialog";
import { useSessionStore } from "../src/store/session-store";
import { useSocketStore } from "../src/store/socket-store";

beforeEach(() => {
  useSessionStore.setState({ pendingPermission: null });
  useSocketStore.setState({
    rpc: vi.fn(async () => ({})) as any,
  } as any);
});

describe("PermissionDialog", () => {
  it("renders nothing when no pending permission", () => {
    const { container } = render(<PermissionDialog />);
    expect(container.innerHTML).toBe("");
  });

  it("shows dialog when permission is pending", () => {
    useSessionStore.setState({
      pendingPermission: {
        requestId: "perm-1",
        toolName: "bash",
        toolInput: { command: "rm -rf /tmp/test" },
      },
    });
    render(<PermissionDialog />);
    // "Allow" and "bash" are in separate elements
    expect(screen.getByText("bash")).toBeInTheDocument();
    expect(screen.getByText(/rm -rf/)).toBeInTheDocument();
  });

  it("shows three action buttons", () => {
    useSessionStore.setState({
      pendingPermission: {
        requestId: "perm-1",
        toolName: "bash",
        toolInput: { command: "ls" },
      },
    });
    render(<PermissionDialog />);
    expect(screen.getByText("Allow once")).toBeInTheDocument();
    expect(screen.getByText(/Always allow/)).toBeInTheDocument();
    expect(screen.getByText("Deny")).toBeInTheDocument();
  });

  it("does not show countdown timer (no timeout)", () => {
    useSessionStore.setState({
      pendingPermission: {
        requestId: "perm-1",
        toolName: "bash",
        toolInput: { command: "ls" },
      },
    });
    render(<PermissionDialog />);
    expect(screen.queryByText(/\d+s/)).toBeNull();
  });

  it("clears pending permission on Allow once", () => {
    useSessionStore.setState({
      pendingPermission: {
        requestId: "perm-1",
        toolName: "bash",
        toolInput: { command: "ls" },
      },
    });
    render(<PermissionDialog />);
    fireEvent.click(screen.getByText("Allow once"));
    expect(useSessionStore.getState().pendingPermission).toBeNull();
  });

  it("clears pending permission on Deny (with feedback step)", () => {
    useSessionStore.setState({
      pendingPermission: {
        requestId: "perm-1",
        toolName: "bash",
        toolInput: { command: "ls" },
      },
    });
    render(<PermissionDialog />);
    // Click Deny — shows feedback input
    fireEvent.click(screen.getByText("Deny"));
    // Feedback input should be visible
    expect(screen.getByPlaceholderText(/Reason/)).toBeInTheDocument();
    // Click the Deny button in the feedback row to submit
    fireEvent.click(screen.getByText("Deny"));
    expect(useSessionStore.getState().pendingPermission).toBeNull();
  });

  it("shows file path for file tools", () => {
    useSessionStore.setState({
      pendingPermission: {
        requestId: "perm-1",
        toolName: "edit_file",
        toolInput: { file_path: "/Users/example/test.ts" },
      },
    });
    render(<PermissionDialog />);
    expect(screen.getByText(/\/Users\/example\/test\.ts/)).toBeInTheDocument();
  });

  it("shows 'Always allow this command' for bash tool", () => {
    useSessionStore.setState({
      pendingPermission: {
        requestId: "perm-1",
        toolName: "bash",
        toolInput: { command: "echo hi" },
      },
    });
    render(<PermissionDialog />);
    expect(screen.getByText(/Always allow this command/)).toBeInTheDocument();
  });

  it("shows 'Always allow file edits' for edit_file (grouped label)", () => {
    useSessionStore.setState({
      pendingPermission: {
        requestId: "perm-1",
        toolName: "edit_file",
        toolInput: { file_path: "/tmp/foo.ts" },
      },
    });
    render(<PermissionDialog />);
    expect(screen.getByText("Always allow file edits")).toBeInTheDocument();
    expect(screen.queryByText("Always allow edit_file")).toBeNull();
  });

  it("shows 'Always allow file edits' for write_file (grouped label)", () => {
    useSessionStore.setState({
      pendingPermission: {
        requestId: "perm-1",
        toolName: "write_file",
        toolInput: { file_path: "/tmp/foo.ts" },
      },
    });
    render(<PermissionDialog />);
    expect(screen.getByText("Always allow file edits")).toBeInTheDocument();
    expect(screen.queryByText("Always allow write_file")).toBeNull();
  });

  it("shows 'Always allow <tool>' for non-grouped tools", () => {
    useSessionStore.setState({
      pendingPermission: {
        requestId: "perm-1",
        toolName: "read_file",
        toolInput: { file_path: "/tmp/foo.ts" },
      },
    });
    render(<PermissionDialog />);
    expect(screen.getByText("Always allow read_file")).toBeInTheDocument();
  });

  it("hides 'Always allow this command' for one-off bash scripts (heredoc / multiline / very long)", () => {
    // From the bug report: a multiline python heredoc command would
    // produce both an unusable exact-match grant AND an unusable
    // pattern button (the entire heredoc rendered as the button label).
    // Both now hide. "Allow once" stays so the user can still proceed.
    useSessionStore.setState({
      pendingPermission: {
        requestId: "perm-heredoc",
        toolName: "bash",
        toolInput: {
          command: "python3 << 'PY'\nimport sys, os\nprint('hi')\nPY",
        },
        // Backend now also returns "" for one-off commands; assert the
        // frontend gates on the command shape directly so the dialog
        // is correct even if the backend's empty signal isn't honored.
        suggestedPattern: "",
      },
    });
    render(<PermissionDialog />);
    expect(screen.queryByText(/Always allow this command/)).toBeNull();
    expect(screen.queryByText(/Always allow Bash/)).toBeNull();
    // Sanity: "Allow once" still rendered.
    expect(screen.getByText("Allow once")).toBeInTheDocument();
  });

  it("still shows 'Always allow this command' for short single-line bash commands", () => {
    useSessionStore.setState({
      pendingPermission: {
        requestId: "perm-short",
        toolName: "bash",
        toolInput: { command: "git log --oneline" },
      },
    });
    render(<PermissionDialog />);
    expect(screen.getByText(/Always allow this command/)).toBeInTheDocument();
  });
});
