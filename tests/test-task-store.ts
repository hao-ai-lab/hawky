// =============================================================================
// Task Store Tests
//
// Tests for session-level task tracking: create, update, status workflow,
// event emission, per-turn reminder formatting, edge cases.
// =============================================================================

import { describe, expect, test, beforeEach } from "bun:test";
import { TaskStore } from "../src/agent/task_store.js";
import { taskCreateToolDefinition, taskUpdateToolDefinition } from "../src/tools/task.js";
import { resetAllTaskStores, getTaskStore } from "../src/tools/task_global.js";
import { buildPerTurnReminders } from "../src/agent/context.js";
import type { ToolContext } from "../src/agent/types.js";

/**
 * Default context uses session_id = "test"; tests that need cross-session
 * isolation use unique session_ids per call. The store is in-memory only
 * (no disk persistence), so tests only need to reset the Map between runs.
 */
function makeContext(session_id = "test"): ToolContext {
  return {
    session_id,
    working_directory: "/tmp",
    abort_signal: new AbortController().signal,
    emit: () => {},
  };
}

beforeEach(() => {
  resetAllTaskStores();
});

// =============================================================================
// TaskStore — basic operations
// =============================================================================

describe("TaskStore — create", () => {
  test("creates a task with pending status", () => {
    const store = new TaskStore();
    const id = store.create("Fix the bug");
    expect(id).toBe("task_1");
    const tasks = store.getTasks();
    expect(tasks.length).toBe(1);
    expect(tasks[0].description).toBe("Fix the bug");
    expect(tasks[0].status).toBe("pending");
  });

  test("auto-increments task IDs", () => {
    const store = new TaskStore();
    const id1 = store.create("Task 1");
    const id2 = store.create("Task 2");
    const id3 = store.create("Task 3");
    expect(id1).toBe("task_1");
    expect(id2).toBe("task_2");
    expect(id3).toBe("task_3");
  });

  test("sets created_at timestamp", () => {
    const store = new TaskStore();
    store.create("Timestamped");
    const task = store.getTasks()[0];
    expect(task.created_at).toBeTruthy();
    expect(new Date(task.created_at).getTime()).toBeGreaterThan(0);
  });

  test("auto-clears completed tasks on create — 'fresh batch' semantics", () => {
    // After all prior tasks are done, the next create starts fresh:
    // completed rows are pruned. Without this, the chip accumulates
    // completed rows forever (15-tasks-after-10 failure mode seen
    // in manual testing).
    const store = new TaskStore();
    const first = store.create("Old 1");
    const second = store.create("Old 2");
    store.update(first, "completed");
    store.update(second, "completed");
    expect(store.getTasks()).toHaveLength(2);

    const third = store.create("Fresh batch");
    expect(store.getTasks()).toHaveLength(1);
    expect(store.getTasks()[0].description).toBe("Fresh batch");
  });

  test("nextIdCounter stays monotonic across auto-clear (Codex P2)", () => {
    // Reusing task_1 after a prune would be dangerous: the LLM's
    // conversation history still references the OLD task_1, and a
    // later task_update("task_1", "completed") could silently hit
    // the new row instead. Always advance the counter past whatever
    // was ever assigned in this session.
    const store = new TaskStore();
    const a = store.create("a"); // task_1
    const b = store.create("b"); // task_2
    store.update(a, "completed");
    store.update(b, "completed");

    const c = store.create("c");
    expect(c).toBe("task_3"); // NOT "task_1"

    // And again — another full completion cycle doesn't reset.
    store.update(c, "completed");
    const d = store.create("d");
    expect(d).toBe("task_4");
  });

  test("does NOT auto-clear if any task is still pending or in_progress", () => {
    const store = new TaskStore();
    const a = store.create("keep me");
    const b = store.create("done");
    store.update(b, "completed");
    // Not all completed — a is still pending. New create must NOT wipe.
    const c = store.create("another");
    expect(store.getTasks().map((t) => t.id)).toEqual([a, b, c]);
    expect(c).toBe("task_3");
  });
});

describe("TaskStore — update", () => {
  test("updates task status", () => {
    const store = new TaskStore();
    const id = store.create("My task");
    store.update(id, "in_progress");
    expect(store.getTasks()[0].status).toBe("in_progress");
    store.update(id, "completed");
    expect(store.getTasks()[0].status).toBe("completed");
  });

  test("returns false for non-existent task", () => {
    const store = new TaskStore();
    expect(store.update("nonexistent", "completed")).toBe(false);
  });

  test("returns true for successful update", () => {
    const store = new TaskStore();
    const id = store.create("Task");
    expect(store.update(id, "in_progress")).toBe(true);
  });
});

describe("TaskStore — queries", () => {
  test("hasIncompleteTasks returns true when pending tasks exist", () => {
    const store = new TaskStore();
    store.create("Pending");
    expect(store.hasIncompleteTasks()).toBe(true);
  });

  test("hasIncompleteTasks returns false when all completed", () => {
    const store = new TaskStore();
    const id = store.create("Done");
    store.update(id, "completed");
    expect(store.hasIncompleteTasks()).toBe(false);
  });

  test("hasIncompleteTasks returns false when empty", () => {
    const store = new TaskStore();
    expect(store.hasIncompleteTasks()).toBe(false);
  });

  test("getInProgressTask returns in_progress task", () => {
    const store = new TaskStore();
    const id1 = store.create("First");
    const id2 = store.create("Second");
    store.update(id2, "in_progress");
    expect(store.getInProgressTask()?.id).toBe(id2);
  });

  test("getInProgressTask returns null when none in progress", () => {
    const store = new TaskStore();
    store.create("Pending");
    expect(store.getInProgressTask()).toBeNull();
  });

  test("getSummary returns correct counts", () => {
    const store = new TaskStore();
    store.create("A");
    store.create("B");
    store.create("C");
    store.update("task_1", "completed");
    store.update("task_2", "in_progress");
    const s = store.getSummary();
    expect(s.total).toBe(3);
    expect(s.completed).toBe(1);
    expect(s.in_progress).toBe(1);
    expect(s.pending).toBe(1);
  });
});

// =============================================================================
// TaskStore — events
// =============================================================================

describe("TaskStore — events", () => {
  test("emits update on create", () => {
    const store = new TaskStore();
    let emitted = false;
    store.on("update", () => { emitted = true; });
    store.create("Task");
    expect(emitted).toBe(true);
  });

  test("emits update on status change", () => {
    const store = new TaskStore();
    const id = store.create("Task");
    let count = 0;
    store.on("update", () => { count++; });
    store.update(id, "in_progress");
    store.update(id, "completed");
    expect(count).toBe(2);
  });

  test("emits update on clear", () => {
    const store = new TaskStore();
    store.create("Task");
    let emitted = false;
    store.on("update", () => { emitted = true; });
    store.clear();
    expect(emitted).toBe(true);
  });

  test("update event includes summary", () => {
    const store = new TaskStore();
    let received: any = null;
    store.on("update", (s) => { received = s; });
    store.create("Task");
    expect(received).not.toBeNull();
    expect(received.total).toBe(1);
  });
});

// =============================================================================
// TaskStore — formatForReminder
// =============================================================================

describe("TaskStore — formatForReminder", () => {
  test("empty when no tasks", () => {
    const store = new TaskStore();
    expect(store.formatForReminder()).toBe("");
  });

  test("shows pending tasks with ○ marker", () => {
    const store = new TaskStore();
    store.create("Write tests");
    const reminder = store.formatForReminder();
    expect(reminder).toContain("○ Write tests");
    expect(reminder).toContain("pending");
  });

  test("shows in_progress tasks with → marker", () => {
    const store = new TaskStore();
    const id = store.create("Fix bug");
    store.update(id, "in_progress");
    const reminder = store.formatForReminder();
    expect(reminder).toContain("→ Fix bug");
  });

  test("excludes completed tasks", () => {
    const store = new TaskStore();
    const id = store.create("Done task");
    store.update(id, "completed");
    expect(store.formatForReminder()).toBe("");
  });

  test("includes discipline reminder", () => {
    const store = new TaskStore();
    store.create("Task");
    expect(store.formatForReminder()).toContain("Mark tasks as completed");
  });
});

// =============================================================================
// TaskStore — clear
// =============================================================================

describe("TaskStore — clear", () => {
  test("removes all tasks", () => {
    const store = new TaskStore();
    store.create("A");
    store.create("B");
    store.clear();
    expect(store.getTasks()).toEqual([]);
    expect(store.getSummary().total).toBe(0);
  });
});

// =============================================================================
// Task Tools — via tool definitions
// =============================================================================

describe("Task Tools", () => {
  test("task_create creates task and returns ID", async () => {
    const result = await taskCreateToolDefinition.execute(
      { description: "Implement auth" } as any,
      makeContext(),
    );
    expect(result.type).toBe("text");
    expect(result.content).toContain("task_1");
    expect(result.content).toContain("Implement auth");
  });

  test("task_update changes status", async () => {
    await taskCreateToolDefinition.execute(
      { description: "My task" } as any,
      makeContext(),
    );
    const result = await taskUpdateToolDefinition.execute(
      { task_id: "task_1", status: "in_progress" } as any,
      makeContext(),
    );
    expect(result.type).toBe("text");
    expect(result.content).toContain("in_progress");
  });

  test("task_update rejects invalid status", async () => {
    await taskCreateToolDefinition.execute(
      { description: "Task" } as any,
      makeContext(),
    );
    const result = await taskUpdateToolDefinition.execute(
      { task_id: "task_1", status: "invalid" } as any,
      makeContext(),
    );
    expect(result.type).toBe("error");
    expect(result.content).toContain("Invalid status");
  });

  test("task_update rejects non-existent task", async () => {
    const result = await taskUpdateToolDefinition.execute(
      { task_id: "task_999", status: "completed" } as any,
      makeContext(),
    );
    expect(result.type).toBe("error");
    expect(result.content).toContain("not found");
  });

  test("tools route to the session's task store", async () => {
    // Per-session scoping: the tool must resolve its store from the
    // ToolContext.session_id. Writing through taskCreate lands in the
    // store identified by that session_id.
    await taskCreateToolDefinition.execute(
      { description: "Session test" } as any,
      makeContext("session-a"),
    );
    const store = getTaskStore("session-a");
    expect(store.getTasks().length).toBe(1);
    expect(store.getTasks()[0].description).toBe("Session test");

    // A different session must NOT see that task.
    const otherStore = getTaskStore("session-b");
    expect(otherStore.getTasks().length).toBe(0);
  });
});

// =============================================================================
// Per-turn reminder integration
// =============================================================================

describe("Per-turn reminder with tasks", () => {
  test("includes task list when tasks exist", () => {
    const result = buildPerTurnReminders({
      tasks: [
        { description: "Fix bug", status: "in_progress" },
        { description: "Write tests", status: "pending" },
      ],
    });
    expect(result).toContain("Fix bug");
    expect(result).toContain("Write tests");
    expect(result).toContain("<system-reminder>");
  });

  test("excludes completed tasks", () => {
    const result = buildPerTurnReminders({
      tasks: [
        { description: "Done", status: "completed" },
        { description: "Pending", status: "pending" },
      ],
    });
    expect(result).not.toContain("Done");
    expect(result).toContain("Pending");
  });

  test("empty when all tasks completed", () => {
    const result = buildPerTurnReminders({
      tasks: [
        { description: "Done1", status: "completed" },
        { description: "Done2", status: "completed" },
      ],
    });
    expect(result).toBe("");
  });

  test("empty when no tasks", () => {
    expect(buildPerTurnReminders({ tasks: [] })).toBe("");
  });
});

// =============================================================================
// Tool definitions shape
// =============================================================================

describe("Tool definitions", () => {
  test("task_create has correct shape", () => {
    expect(taskCreateToolDefinition.name).toBe("task_create");
    expect(taskCreateToolDefinition.permission).toBe("always_approve");
    expect(taskCreateToolDefinition.input_schema.required).toContain("description");
  });

  test("task_update has correct shape", () => {
    expect(taskUpdateToolDefinition.name).toBe("task_update");
    expect(taskUpdateToolDefinition.permission).toBe("always_approve");
    expect(taskUpdateToolDefinition.input_schema.required).toContain("task_id");
    expect(taskUpdateToolDefinition.input_schema.required).toContain("status");
  });
});

// =============================================================================
// System prompt includes task tracking section
// =============================================================================

describe("System prompt — task tracking", () => {
  test("includes Task Tracking section", async () => {
    const { buildSystemPrompt } = await import("../src/agent/context.js");
    const prompt = buildSystemPrompt({ working_directory: "/tmp", model: "test" });
    expect(prompt).toContain("# Task Tracking");
    expect(prompt).toContain("task_create");
    expect(prompt).toContain("task_update");
    expect(prompt).toContain("Mark completed IMMEDIATELY");
  });
});

// =============================================================================
// Workflow simulation
// =============================================================================

describe("Workflow simulation", () => {
  test("full task lifecycle: create → in_progress → completed", async () => {
    const ctx = makeContext();

    // Create 3 tasks
    await taskCreateToolDefinition.execute({ description: "Step 1: Schema" } as any, ctx);
    await taskCreateToolDefinition.execute({ description: "Step 2: API" } as any, ctx);
    await taskCreateToolDefinition.execute({ description: "Step 3: Tests" } as any, ctx);

    const store = getTaskStore("test");
    expect(store.getSummary().total).toBe(3);
    expect(store.getSummary().pending).toBe(3);

    // Start step 1
    await taskUpdateToolDefinition.execute({ task_id: "task_1", status: "in_progress" } as any, ctx);
    expect(store.getInProgressTask()?.description).toBe("Step 1: Schema");

    // Complete step 1, start step 2
    await taskUpdateToolDefinition.execute({ task_id: "task_1", status: "completed" } as any, ctx);
    await taskUpdateToolDefinition.execute({ task_id: "task_2", status: "in_progress" } as any, ctx);
    expect(store.getSummary().completed).toBe(1);
    expect(store.getSummary().in_progress).toBe(1);
    expect(store.getSummary().pending).toBe(1);

    // Complete all
    await taskUpdateToolDefinition.execute({ task_id: "task_2", status: "completed" } as any, ctx);
    await taskUpdateToolDefinition.execute({ task_id: "task_3", status: "in_progress" } as any, ctx);
    await taskUpdateToolDefinition.execute({ task_id: "task_3", status: "completed" } as any, ctx);
    expect(store.hasIncompleteTasks()).toBe(false);
    expect(store.getSummary().completed).toBe(3);
  });
});
