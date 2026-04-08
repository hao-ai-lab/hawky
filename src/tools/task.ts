// =============================================================================
// Task Tools
//
// Two tools for per-session task tracking:
// - task_create: create a task for multi-step work
// - task_update: update task status (pending → in_progress → completed)
//
// These tools route through getTaskStore(context.session_id) so each session
// gets its own store — tasks never leak across sessions. TUI components
// (TaskTray, TaskViewer) subscribe to the active session's store for
// real-time updates; web surfaces will do the same once Item 5 ships.
//
// Tool output is hidden from the message stream (like COCO) — users see
// updates via TaskTray instead.
// =============================================================================

import type { ToolDefinition, ToolContext, ToolResult } from "../agent/types.js";
import { getTaskStore } from "./task_global.js";

// -----------------------------------------------------------------------------
// task_create
// -----------------------------------------------------------------------------

interface TaskCreateInput {
  description: string;
}

async function executeTaskCreate(
  input: TaskCreateInput,
  context: ToolContext,
): Promise<ToolResult> {
  // Scope to this session. Tasks created in one session never appear
  // in another's reminder — see task_global.ts for the registry.
  const store = getTaskStore(context.session_id);
  const id = store.create(input.description);
  const summary = store.getSummary();
  return {
    type: "text",
    content: `Task created: ${id} — "${input.description}" (${summary.total} total, ${summary.pending} pending)`,
  };
}

export const taskCreateToolDefinition: ToolDefinition<TaskCreateInput> = {
  name: "task_create",
  description:
    "Create a task to track multi-step work. Use when modifying 2+ files, " +
    "implementing features, refactoring, or any non-trivial work. " +
    "Each step should be a separate task.",
  input_schema: {
    type: "object",
    properties: {
      description: {
        type: "string",
        description: "Brief description of the task step (e.g., 'Update auth middleware', 'Write tests for user API').",
      },
    },
    required: ["description"],
  },
  execute: executeTaskCreate,
  permission: "always_approve",
};

// -----------------------------------------------------------------------------
// task_update
// -----------------------------------------------------------------------------

interface TaskUpdateInput {
  task_id: string;
  status: string;
}

async function executeTaskUpdate(
  input: TaskUpdateInput,
  context: ToolContext,
): Promise<ToolResult> {
  const store = getTaskStore(context.session_id);
  const status = input.status as "pending" | "in_progress" | "completed";

  if (!["pending", "in_progress", "completed"].includes(status)) {
    return {
      type: "error",
      content: `Invalid status "${input.status}". Must be one of: pending, in_progress, completed.`,
    };
  }

  const success = store.update(input.task_id, status);
  if (!success) {
    return {
      type: "error",
      content: `Task "${input.task_id}" not found.`,
    };
  }

  const summary = store.getSummary();
  return {
    type: "text",
    content: `Task ${input.task_id} updated to "${status}" (${summary.completed}/${summary.total} done)`,
  };
}

export const taskUpdateToolDefinition: ToolDefinition<TaskUpdateInput> = {
  name: "task_update",
  description:
    "Update the status of a session task. Mark as 'in_progress' when starting work, " +
    "'completed' IMMEDIATELY when done. Do not batch — update in real-time.",
  input_schema: {
    type: "object",
    properties: {
      task_id: {
        type: "string",
        description: "The task ID returned by task_create (e.g., 'task_1').",
      },
      status: {
        type: "string",
        description: "New status: 'pending', 'in_progress', or 'completed'.",
      },
    },
    required: ["task_id", "status"],
  },
  execute: executeTaskUpdate,
  permission: "always_approve",
};
