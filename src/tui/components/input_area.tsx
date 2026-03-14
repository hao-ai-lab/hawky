// =============================================================================
// Input Area Component
//
// Text input at the bottom of the TUI, wrapped in a rounded border box.
// - Enter submits
// - Ctrl+J inserts newline
// - Ctrl+C exits (two-press pattern)
// - Esc cancels a running agent turn (when canCancel is true)
// - Up/Down navigates input history
// =============================================================================

import React, { useState, useCallback, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import { MultiLineInput } from "./multi_line_input.js";
import { useInputHistory, extractUserMessages, persistToHistory } from "../hooks/use_input_history.js";
import type { DisplayMessage } from "../types.js";

interface InputAreaProps {
  onSubmit: (text: string) => void;
  onExit: () => void;
  onCancel?: () => void;
  onToggleTaskViewer?: () => void;
  placeholder?: string;
  disabled?: boolean;
  /** When true, Esc triggers onCancel. */
  canCancel?: boolean;
  /** Previous user messages for history population (on resume) */
  previousMessages?: DisplayMessage[];
}

export function InputArea({
  onSubmit, onExit, onCancel, onToggleTaskViewer, placeholder, disabled, canCancel, previousMessages,
}: InputAreaProps) {
  const { goBack, goForward, addToHistory, resetNavigation } = useInputHistory();
  const [externalValue, setExternalValue] = useState<string | null>(null);
  const [ctrlCHint, setCtrlCHint] = useState(false);
  const ctrlCTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // No resize handling here — handled at App level with clearAndRemountStatic

  // Populate history from previous messages (on resume)
  const historyPopulatedRef = React.useRef(false);
  React.useEffect(() => {
    if (previousMessages && !historyPopulatedRef.current) {
      const userTexts = extractUserMessages(previousMessages);
      for (const text of userTexts) {
        addToHistory(text);
      }
      historyPopulatedRef.current = true;
    }
  }, [previousMessages, addToHistory]);

  useInput((_input, key) => {
    // Ctrl+C: two-press exit pattern
    if (key.ctrl && _input === "c") {
      if (canCancel && onCancel) {
        // During agent turn: first Ctrl+C cancels turn
        onCancel();
        return;
      }
      if (ctrlCHint) {
        // Second press within 1s → exit
        onExit();
        return;
      }
      // First press when idle → show hint
      setCtrlCHint(true);
      if (ctrlCTimerRef.current) clearTimeout(ctrlCTimerRef.current);
      ctrlCTimerRef.current = setTimeout(() => setCtrlCHint(false), 1000);
      return;
    }

    // Ctrl+D: toggle task viewer
    if (key.ctrl && _input === "d") {
      onToggleTaskViewer?.();
      return;
    }

    // Ctrl+O handled at App level (global — works even during prompts)

    if (key.escape && canCancel && onCancel) {
      onCancel();
    }
  });

  const handleSubmit = useCallback((text: string) => {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    addToHistory(trimmed);
    persistToHistory(trimmed); // Persist to ~/.hawky/history.jsonl
    resetNavigation();
    setExternalValue(null);
    onSubmit(trimmed);
  }, [addToHistory, resetNavigation, onSubmit]);

  const handleHistoryBack = useCallback((draft: string): string | null => {
    const prev = goBack(draft);
    if (prev !== null) {
      setExternalValue(prev);
    }
    return prev;
  }, [goBack]);

  const handleHistoryForward = useCallback((): string | null => {
    const next = goForward();
    if (next !== null) {
      setExternalValue(next);
    }
    return next;
  }, [goForward]);

  // Draw border as a plain text line of ─ chars, always at current terminal width
  return (
    <Box flexDirection="column">
      {ctrlCHint && (
        <Box paddingX={1}>
          <Text color="yellow">Press Ctrl+C again to exit</Text>
        </Box>
      )}
      <Box borderStyle="single" borderTop={true} borderBottom={true} borderLeft={false} borderRight={false} borderColor="gray" paddingX={1}>
        <Text color="green" bold>{"❯ "}</Text>
        {disabled ? (
          <Text color="gray">Agent working... (Esc to cancel)</Text>
        ) : (
          <MultiLineInput
            onSubmit={handleSubmit}
            placeholder={placeholder ?? "Type a message... (Ctrl+J for newline)"}
            onHistoryBack={handleHistoryBack}
            onHistoryForward={handleHistoryForward}
            externalValue={externalValue}
          />
        )}
      </Box>
    </Box>
  );
}
