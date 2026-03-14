// =============================================================================
// Task Tray Component
//
// Compact task status bar shown above the input area.
// Only visible when there's an in_progress task (COCO pattern).
// Hides automatically when all tasks complete.
// Subscribes to TaskStore events for real-time updates.
//
// Example:
//   ─── Task: Write tests for auth (2/4 done) (ctrl+d to open tasks)
// =============================================================================

import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { getTaskStore } from "../../tools/task_global.js";
import type { TaskSummary } from "../../agent/task_store.js";

interface TaskTrayProps {
  /** Active session key — the tray renders the tasks for THIS session. */
  sessionKey: string;
}

export function TaskTray({ sessionKey }: TaskTrayProps) {
  const [summary, setSummary] = useState<TaskSummary | null>(null);

  useEffect(() => {
    // Re-subscribe whenever the active session changes. Each session has
    // its own store, so a bad subscription = stale tasks from another
    // session. The dependency on sessionKey forces cleanup + rebind.
    const store = getTaskStore(sessionKey);
    const initial = store.getSummary();
    setSummary(initial.total > 0 ? initial : null);

    const onUpdate = (s: TaskSummary) => {
      setSummary(s.total > 0 ? s : null);
    };
    store.on("update", onUpdate);
    return () => { store.off("update", onUpdate); };
  }, [sessionKey]);

  // Only show when there's an in_progress task (COCO pattern)
  const inProgress = summary?.tasks.find((t) => t.status === "in_progress");
  if (!summary || summary.total === 0 || !inProgress) return null;

  return (
    <Box paddingX={1}>
      <Text color="gray">─── </Text>
      <Text bold color="cyan">Task: </Text>
      <Text color="cyan">{inProgress.description} </Text>
      <Text dimColor>({summary.completed}/{summary.total} done) </Text>
      <Text dimColor>(ctrl+d to open tasks)</Text>
    </Box>
  );
}
