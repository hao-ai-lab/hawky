// =============================================================================
// Ask User Prompt Component
//
// Shown when the agent calls ask_user tool. Displays the question with
// selectable options via InteractiveSelector, or free-form text input if
// no options provided.
// =============================================================================

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { InteractiveSelector } from "./interactive_selector.js";
import type { PendingAskUser, SelectorOption } from "../types.js";

interface AskUserPromptProps {
  askUser: PendingAskUser;
  onRespond: (answers: string[]) => void;
  onCancel?: () => void;
}

export function AskUserPrompt({ askUser, onRespond, onCancel }: AskUserPromptProps) {
  const [freeFormValue, setFreeFormValue] = useState("");
  const hasOptions = askUser.options.length > 0;

  // Handle Esc in free-form mode (InteractiveSelector handles its own Esc)
  useInput((_input, key) => {
    if (key.escape && !hasOptions && onCancel) {
      onCancel();
    }
  });

  // Build selector options from ask_user options
  const selectorOptions: SelectorOption[] = hasOptions
    ? askUser.options.map((opt, i) => ({
        id: `opt_${i}`,
        label: opt,
        freeForm: opt.includes("Something else"),
      }))
    : [];

  const handleSelect = (optionId: string, text?: string) => {
    if (text) {
      onRespond([text]);
    } else {
      const index = parseInt(optionId.replace("opt_", ""), 10);
      const selectedLabel = askUser.options[index];
      onRespond([selectedLabel]);
    }
  };

  const handleFreeFormSubmit = (text: string) => {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    onRespond([trimmed]);
  };

  return (
    <Box flexDirection="column" paddingX={1}>
      {/* Header */}
      <Box>
        <Text color="cyan" bold>── Question </Text>
        <Text color="cyan">{"─".repeat(40)}</Text>
      </Box>

      {/* Question text */}
      <Box paddingLeft={2} marginTop={0}>
        <Text>{askUser.question}</Text>
      </Box>

      {/* Options or free-form */}
      <Box marginTop={1}>
        {hasOptions ? (
          <InteractiveSelector
            options={selectorOptions}
            onSelect={handleSelect}
            onCancel={onCancel}
          />
        ) : (
          <Box flexDirection="column" paddingX={1}>
            <Box>
              <Text color="cyan">{"❯ "}</Text>
              <TextInput
                value={freeFormValue}
                onChange={setFreeFormValue}
                onSubmit={handleFreeFormSubmit}
                placeholder="Type your answer..."
              />
            </Box>
            {onCancel && (
              <Box marginTop={0}>
                <Text color="gray">  Esc to cancel</Text>
              </Box>
            )}
          </Box>
        )}
      </Box>
    </Box>
  );
}
