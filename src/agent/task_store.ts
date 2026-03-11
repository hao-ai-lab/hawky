// =============================================================================
// Task Store
//
// Per-session scratchpad for the agent's multi-step work. Modeled after
// COCO's TodoStore and Claude Code's V1 TodoWrite — **in-memory only,
// ephemeral**. Tasks die on gateway restart by design: this is the
// agent's working memory for one unit of work, NOT the user's long-term
// todo list. Long-term user todos live in workspace memory files
// (`memory/*.md`, distillation output) and surface via memory_search.
//
// Per-session scoping: keyed by sessionKey in the registry in
// task_global.ts. A task created in session A does NOT appear in
// session B's per-turn reminder (Defect A fix from the audit).
//
// EventEmitter pattern: TUI components subscribe to "update" events
// for real-time re-render. The `nextIdCounter` lives on the store
// instance, not as a module global, so `task_1` in session A and
// `task_1` in session B don't collide.
// =============================================================================

import { EventEmitter } from "node:events";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export type TaskStatus = "pending" | "in_progress" | "completed";

export interface SessionTask {
  id: string;
  description: string;
  status: TaskStatus;
  created_at: string;
}

export interface TaskSummary {
  tasks: SessionTask[];
  total: number;
  completed: number;
  in_progress: number;
  pending: number;
}

// -----------------------------------------------------------------------------
// Task Store
// -----------------------------------------------------------------------------

export class TaskStore extends EventEmitter {
  private tasks: SessionTask[] = [];
  private nextIdCounter = 0;
  /**
   * Current session key for this store. Set by the registry
   * (`task_global.ts`) on creation, and rewritten by
   * `renameTaskStore` so the registry's broadcaster listener can
   * always report the up-to-date key without having to tear down
   * and re-attach listeners on rename. Undefined when the store is
   * constructed outside the registry (a handful of unit tests).
   */
  sessionKey?: string;

  constructor() {
    super();
    // TUI tests mount many components that each subscribe; avoid the warning
    this.setMaxListeners(50);
  }

  /** Create a new task. Returns the task ID. */
  create(description: string): string {
    // "Fresh batch" auto-clear: if every existing task is completed,
    // treat this create as the start of new work and drop the stale
    // done rows. Without this, the UI chip / reminder keep
    // accumulating completed rows indefinitely.
    //
    // Keep `nextIdCounter` monotonic across the prune, even though
    // the tasks array resets. The LLM's conversation history still
    // references old task ids; reusing task_1 for a new task would
    // make a later task_update("task_1", ...) silently hit the wrong
    // row. (Codex P2.)
    if (this.tasks.length > 0 && this.tasks.every((t) => t.status === "completed")) {
      this.tasks = [];
    }
    const id = `task_${++this.nextIdCounter}`;
    const task: SessionTask = {
      id,
      description,
      status: "pending",
      created_at: new Date().toISOString(),
    };
    this.tasks.push(task);
    this.emit("update", this.getSummary());
    return id;
  }

  /** Update a task's status. Returns true if successful. */
  update(taskId: string, status: TaskStatus): boolean {
    const task = this.tasks.find((t) => t.id === taskId);
    if (!task) return false;
    task.status = status;
    this.emit("update", this.getSummary());
    return true;
  }

  /** Check if there are any incomplete (pending or in_progress) tasks. */
  hasIncompleteTasks(): boolean {
    return this.tasks.some((t) => t.status === "pending" || t.status === "in_progress");
  }

  /** Get the currently in-progress task (first one found). */
  getInProgressTask(): SessionTask | null {
    return this.tasks.find((t) => t.status === "in_progress") ?? null;
  }

  /** Get all tasks. */
  getTasks(): SessionTask[] {
    return [...this.tasks];
  }

  /** Get summary stats. */
  getSummary(): TaskSummary {
    return {
      tasks: [...this.tasks],
      total: this.tasks.length,
      completed: this.tasks.filter((t) => t.status === "completed").length,
      in_progress: this.tasks.filter((t) => t.status === "in_progress").length,
      pending: this.tasks.filter((t) => t.status === "pending").length,
    };
  }

  /** Format tasks for per-turn system reminder. */
  formatForReminder(): string {
    if (this.tasks.length === 0) return "";
    const lines: string[] = ["Active session tasks:"];
    for (const task of this.tasks) {
      if (task.status === "completed") continue; // Skip completed in reminder
      const marker = task.status === "in_progress" ? "→" : "○";
      lines.push(`  ${marker} ${task.description} (${task.status})`);
    }
    if (lines.length === 1) return ""; // All completed
    lines.push("Mark tasks as completed immediately when done.");
    return lines.join("\n");
  }

  /** Clear all tasks (new session or explicit reset). */
  clear(): void {
    this.tasks = [];
    this.nextIdCounter = 0;
    this.emit("update", this.getSummary());
  }
}
