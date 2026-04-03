// =============================================================================
// Tests: TaskChip component
//
// Covers: visibility contract (hidden when no tasks), label formatting,
// expand/collapse behavior, and status-glyph mapping for each row.
// =============================================================================

import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TaskChip } from "../src/components/TaskChip";
import { useSessionStore, type TaskSummary } from "../src/store/session-store";

function setSummary(summary: TaskSummary | null) {
  useSessionStore.setState({ taskSummary: summary } as any);
}

beforeEach(() => {
  // Reset to a known empty state each test. Explicit activeKey so
  // tests that don't exercise sub-agent sessions aren't accidentally
  // running under a `subagent:*` key (which would hide the chip).
  useSessionStore.setState({ taskSummary: null, activeKey: "web:general" } as any);
});

// -----------------------------------------------------------------------------
// Visibility
// -----------------------------------------------------------------------------

describe("TaskChip — visibility", () => {
  it("renders nothing when taskSummary is null", () => {
    const { container } = render(<TaskChip />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when total is 0", () => {
    setSummary({ tasks: [], total: 0, completed: 0, in_progress: 0, pending: 0 });
    const { container } = render(<TaskChip />);
    expect(container.firstChild).toBeNull();
  });

  it("renders when there is at least one task", () => {
    setSummary({
      tasks: [{ id: "task_1", description: "do thing", status: "pending", created_at: "" }],
      total: 1,
      completed: 0,
      in_progress: 0,
      pending: 1,
    });
    render(<TaskChip />);
    expect(screen.getByRole("button")).toBeInTheDocument();
  });

  it("renders nothing for subagent:* sessions even with active tasks (Codex P3 regression)", () => {
    // Sub-agent sessions are internal scratch — their task state
    // shouldn't appear in the main UI even if someone routes to one.
    useSessionStore.setState({ activeKey: "subagent:web:parent:agent_1" } as any);
    setSummary({
      tasks: [{ id: "task_1", description: "internal scratch", status: "pending", created_at: "" }],
      total: 1, completed: 0, in_progress: 0, pending: 1,
    });
    const { container } = render(<TaskChip />);
    expect(container.firstChild).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// Label formatting
// -----------------------------------------------------------------------------

describe("TaskChip — label", () => {
  it("singular when total is 1 and none in progress", () => {
    setSummary({
      tasks: [{ id: "task_1", description: "x", status: "pending", created_at: "" }],
      total: 1,
      completed: 0,
      in_progress: 0,
      pending: 1,
    });
    render(<TaskChip />);
    expect(screen.getByText("1 task")).toBeInTheDocument();
  });

  it("plural when multiple pending tasks", () => {
    setSummary({
      tasks: [
        { id: "task_1", description: "x", status: "pending", created_at: "" },
        { id: "task_2", description: "y", status: "pending", created_at: "" },
      ],
      total: 2,
      completed: 0,
      in_progress: 0,
      pending: 2,
    });
    render(<TaskChip />);
    expect(screen.getByText("2 tasks")).toBeInTheDocument();
  });

  it("chip counts only active tasks — completed rows don't inflate the number", () => {
    // Store holds a completed row + a pending row; the chip should
    // say "1 task" (only the pending one counts).
    setSummary({
      tasks: [
        { id: "task_1", description: "done", status: "completed", created_at: "" },
        { id: "task_2", description: "still to do", status: "pending", created_at: "" },
      ],
      total: 2,
      completed: 1,
      in_progress: 0,
      pending: 1,
    });
    render(<TaskChip />);
    expect(screen.getByText("1 task")).toBeInTheDocument();
  });

  it("chip hides when all tasks are completed (even though store still has rows)", () => {
    // Until the next task_create fires the auto-clear, the store holds
    // completed tasks. The chip must hide in the meantime — it's a
    // signal about outstanding work, not a historical receipt.
    setSummary({
      tasks: [
        { id: "task_1", description: "done a", status: "completed", created_at: "" },
        { id: "task_2", description: "done b", status: "completed", created_at: "" },
      ],
      total: 2,
      completed: 2,
      in_progress: 0,
      pending: 0,
    });
    const { container } = render(<TaskChip />);
    expect(container.firstChild).toBeNull();
  });

  it("shows 'N active / total' when anything is in_progress", () => {
    setSummary({
      tasks: [
        { id: "task_1", description: "x", status: "in_progress", created_at: "" },
        { id: "task_2", description: "y", status: "pending", created_at: "" },
      ],
      total: 2,
      completed: 0,
      in_progress: 1,
      pending: 1,
    });
    render(<TaskChip />);
    expect(screen.getByText("1 active / 2")).toBeInTheDocument();
  });

  it("expanded state resets on session switch even when both sessions have active tasks (Codex P3 regression)", () => {
    // User expands in session A, then switches to session B (which
    // also has active tasks). B's chip must render collapsed — no
    // leaked popover from A.
    useSessionStore.setState({ activeKey: "web:A" } as any);
    setSummary({
      tasks: [{ id: "task_1", description: "in A", status: "pending", created_at: "" }],
      total: 1, completed: 0, in_progress: 0, pending: 1,
    });
    const { rerender } = render(<TaskChip />);
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("in A")).toBeInTheDocument();

    // Simulate session switch: activeKey changes, taskSummary flips
    // to B's state (also has tasks).
    useSessionStore.setState({ activeKey: "web:B" } as any);
    setSummary({
      tasks: [{ id: "task_1", description: "in B", status: "pending", created_at: "" }],
      total: 1, completed: 0, in_progress: 0, pending: 1,
    });
    rerender(<TaskChip />);

    // Chip visible (B has active work) but NOT expanded.
    expect(screen.getByRole("button")).toBeInTheDocument();
    expect(screen.queryByText("in B")).toBeNull();
    expect(screen.queryByText("in A")).toBeNull();
  });

  it("expanded state resets when the chip hides and reappears (Codex P3 regression)", () => {
    // User expands the chip, then completes all tasks. The chip hides.
    // When a new task_create starts a fresh batch, the chip must NOT
    // come back pre-expanded — expanded state should reset.
    setSummary({
      tasks: [{ id: "task_1", description: "one", status: "pending", created_at: "" }],
      total: 1, completed: 0, in_progress: 0, pending: 1,
    });
    const { rerender } = render(<TaskChip />);
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("one")).toBeInTheDocument(); // expanded

    // All tasks complete — chip hides.
    setSummary({
      tasks: [{ id: "task_1", description: "one", status: "completed", created_at: "" }],
      total: 1, completed: 1, in_progress: 0, pending: 0,
    });
    rerender(<TaskChip />);
    // Chip is hidden (returns null), so no button to query — pass by
    // asserting the expanded content is gone.
    expect(screen.queryByText("one")).toBeNull();

    // New batch — the auto-clear kicked in on the backend so this is
    // a fresh task_1 again.
    setSummary({
      tasks: [{ id: "task_1", description: "fresh", status: "pending", created_at: "" }],
      total: 1, completed: 0, in_progress: 0, pending: 1,
    });
    rerender(<TaskChip />);
    // Chip is visible again but NOT expanded (no task description in DOM).
    expect(screen.getByRole("button")).toBeInTheDocument();
    expect(screen.queryByText("fresh")).toBeNull();
  });

  it("the '/ total' in the label counts only active tasks, not completed ones", () => {
    // 1 in_progress + 1 pending + 3 completed → label should read
    // "1 active / 2", NOT "1 active / 5". The completed rows are
    // pending auto-clear and shouldn't inflate the denominator.
    setSummary({
      tasks: [
        { id: "task_1", description: "a", status: "completed", created_at: "" },
        { id: "task_2", description: "b", status: "completed", created_at: "" },
        { id: "task_3", description: "c", status: "completed", created_at: "" },
        { id: "task_4", description: "d", status: "in_progress", created_at: "" },
        { id: "task_5", description: "e", status: "pending", created_at: "" },
      ],
      total: 5,
      completed: 3,
      in_progress: 1,
      pending: 1,
    });
    render(<TaskChip />);
    expect(screen.getByText("1 active / 2")).toBeInTheDocument();
  });
});

// -----------------------------------------------------------------------------
// Expand / collapse + row rendering
// -----------------------------------------------------------------------------

describe("TaskChip — expand / collapse", () => {
  function setup() {
    setSummary({
      tasks: [
        { id: "task_1", description: "completed thing", status: "completed", created_at: "" },
        { id: "task_2", description: "active thing", status: "in_progress", created_at: "" },
        { id: "task_3", description: "queued thing", status: "pending", created_at: "" },
      ],
      total: 3,
      completed: 1,
      in_progress: 1,
      pending: 1,
    });
  }

  it("starts collapsed — task descriptions are not in the DOM", () => {
    setup();
    render(<TaskChip />);
    expect(screen.queryByText("completed thing")).toBeNull();
    expect(screen.queryByText("active thing")).toBeNull();
    expect(screen.queryByText("queued thing")).toBeNull();
  });

  it("click on the chip reveals all task rows and the summary header", () => {
    setup();
    render(<TaskChip />);
    fireEvent.click(screen.getByRole("button"));

    expect(screen.getByText("completed thing")).toBeInTheDocument();
    expect(screen.getByText("active thing")).toBeInTheDocument();
    expect(screen.getByText("queued thing")).toBeInTheDocument();
    // Expanded header: "Session tasks — 1 / 3"
    expect(screen.getByText(/1 \/ 3/)).toBeInTheDocument();
  });

  it("click again collapses the card", () => {
    setup();
    render(<TaskChip />);
    const btn = screen.getByRole("button");
    fireEvent.click(btn); // expand
    fireEvent.click(btn); // collapse
    expect(screen.queryByText("completed thing")).toBeNull();
  });

  it("each row has the correct status glyph", () => {
    setup();
    render(<TaskChip />);
    fireEvent.click(screen.getByRole("button"));
    // Glyphs are rendered as text — find by exact match.
    // (Multiple identical glyphs may appear in complex views; here each
    //  status appears once so getByText is unambiguous.)
    expect(screen.getByText("✓")).toBeInTheDocument();
    expect(screen.getByText("→")).toBeInTheDocument();
    expect(screen.getByText("○")).toBeInTheDocument();
  });

  it("completed row is struck through", () => {
    setup();
    render(<TaskChip />);
    fireEvent.click(screen.getByRole("button"));
    const completedRow = screen.getByText("completed thing").closest("li")!;
    expect(completedRow.className).toContain("line-through");
  });
});
