// =============================================================================
// Task Viewer Component
//
// Fullscreen overlay showing all session tasks with status.
// Opened via Ctrl+D, closed via q/Esc.
// Subscribes to TaskStore for real-time updates.
// =============================================================================

import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import { getTaskStore } from "../../tools/task_global.js";
import type { TaskSummary } from "../../agent/task_store.js";

interface TaskViewerProps {
  onClose: () => void;
  /** Active session key — the viewer renders THIS session's tasks. */
  sessionKey: string;
}

const STATUS_ICONS: Record<string, { icon: string; color: string }> = {
  completed: { icon: "✓", color: "green" },
  in_progress: { icon: "→", color: "cyan" },
  pending: { icon: "○", color: "yellow" },
};

export function TaskViewer({ onClose, sessionKey }: TaskViewerProps) {
  const [summary, setSummary] = useState<TaskSummary>(getTaskStore(sessionKey).getSummary());

  useEffect(() => {
    const store = getTaskStore(sessionKey);
    // Seed with current snapshot — store may have changed since first
    // useState call if the session key just flipped.
    setSummary(store.getSummary());
    const onUpdate = (s: TaskSummary) => setSummary(s);
    store.on("update", onUpdate);
    return () => { store.off("update", onUpdate); };
  }, [sessionKey]);

  useInput((_input, key) => {
    if (key.escape || _input === "q") {
      onClose();
    }
  });

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">Session Tasks</Text>
        <Text color="gray"> ({summary.completed}/{summary.total} done)</Text>
      </Box>

      {summary.tasks.length === 0 ? (
        <Text color="gray">No tasks yet. The agent will create tasks for multi-step work.</Text>
      ) : (
        summary.tasks.map((task, i) => {
          const cfg = STATUS_ICONS[task.status];
          const isDone = task.status === "completed";
          const num = `${i + 1}.`;
          return (
            <Box key={task.id} marginBottom={0}>
              <Text color={cfg.color}>{`  ${num.padEnd(4)}${cfg.icon}  `}</Text>
              <Text color={isDone ? "gray" : undefined} strikethrough={isDone} wrap="wrap">
                {task.description}
              </Text>
              {!isDone && <Text color="yellow">{` [${task.status}]`}</Text>}
            </Box>
          );
        })
      )}

      <Box marginTop={1}>
        <Text color="gray">Press q or Esc to close</Text>
      </Box>
    </Box>
  );
}
