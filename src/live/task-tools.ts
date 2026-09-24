export const BACKEND_TOOL = {
  type: "function",
  name: "session_send_message",
  description:
    "Send a concise request or context packet to the Hawk backend agent for durable work, tool use, memory, files, or longer reasoning. Briefly acknowledge before calling when useful. Completion arrives automatically; do not poll task status.",
  parameters: {
    type: "object",
    properties: {
      message: { type: "string", description: "The precise task. Preserve full-file versus summary requests and all corrections." },
      execution: { type: "string", enum: ["serial", "read_only"], description: "Use read_only for independent reads/searches so two tasks can run concurrently. Read-only jobs cannot modify files or run commands. Otherwise use serial." },
      depends_on: { type: "array", items: { type: "string" }, description: "IDs of tasks that must complete first." },
      continue_task: { type: "string", description: "Continue this task's backend conversation; omit for unrelated work." },
      constraints: { type: "string", description: "Constraints and evidence required to consider the task complete." },
    },
    required: ["message"],
    additionalProperties: false,
  },
};

export const BACKEND_CONTROL_TOOL = {
  type: "function", name: "session_task_control",
  description: "List or check backend task status only when the user asks about progress. Never poll: completion arrives automatically. Cancel work only when asked, or revise after a user correction. Stopping speech does not cancel backend work.",
  parameters: { type: "object", properties: {
    action: { type: "string", enum: ["list", "status", "cancel", "revise"] },
    task_id: { type: "string", description: "Task ID from a delegation result; required except for list." },
    message: { type: "string", description: "For revise: the complete corrected task." },
  }, required: ["action"], additionalProperties: false },
};

