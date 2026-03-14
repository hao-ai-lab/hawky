// =============================================================================
// Interactive Selector Component
//
// Arrow-key navigable option list. Used by both permission prompts and ask_user.
// Same interaction pattern as COCO's InteractiveSelector:
// - Arrow keys (↑/↓) move highlight with wrap-around
// - Enter confirms highlighted option
// - Number keys (1-9) for quick selection
// - Free-form text input for "Something else" options
// =============================================================================

import React, { useState, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import type { SelectorOption } from "../types.js";

interface InteractiveSelectorProps {
  options: SelectorOption[];
  onSelect: (optionId: string, text?: string) => void;
  onCancel?: () => void;
}

export function InteractiveSelector({ options, onSelect, onCancel }: InteractiveSelectorProps) {
  const [highlightIndex, setHighlightIndex] = useState(0);
  const [freeFormMode, setFreeFormMode] = useState(false);
  const [freeFormText, setFreeFormText] = useState("");

  useInput((_input, key) => {
    if (freeFormMode) {
      if (key.escape) {
        setFreeFormMode(false);
        setFreeFormText("");
      }
      return; // TextInput handles the rest
    }

    // Arrow navigation with wrap-around
    if (key.upArrow) {
      setHighlightIndex((prev) => (prev - 1 + options.length) % options.length);
    }
    if (key.downArrow) {
      setHighlightIndex((prev) => (prev + 1) % options.length);
    }

    // Enter confirms
    if (key.return) {
      const option = options[highlightIndex];
      if (option.freeForm) {
        setFreeFormMode(true);
        setFreeFormText("");
      } else {
        onSelect(option.id);
      }
    }

    // Number keys for quick selection (1-9)
    const num = parseInt(_input, 10);
    if (num >= 1 && num <= options.length) {
      const option = options[num - 1];
      if (option.freeForm) {
        setHighlightIndex(num - 1);
        setFreeFormMode(true);
        setFreeFormText("");
      } else {
        onSelect(option.id);
      }
    }

    // Escape cancels
    if (key.escape && onCancel) {
      onCancel();
    }
  });

  const handleFreeFormSubmit = useCallback((text: string) => {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      setFreeFormMode(false);
      return;
    }
    const option = options[highlightIndex];
    onSelect(option.id, trimmed);
  }, [highlightIndex, options, onSelect]);

  return (
    <Box flexDirection="column" paddingX={1}>
      {options.map((option, index) => {
        const isHighlighted = index === highlightIndex;
        const marker = isHighlighted ? "❯" : " ";
        const color = isHighlighted ? "cyan" : "gray";
        const num = index + 1;

        return (
          <Box key={option.id}>
            <Text color={color}>
              {marker} {num}. {option.label}
            </Text>
            {option.description && (
              <Text color="gray"> — {option.description}</Text>
            )}
          </Box>
        );
      })}

      {freeFormMode && (
        <Box paddingLeft={2} marginTop={1}>
          <Text color="cyan">{"❯ "}</Text>
          <TextInput
            value={freeFormText}
            onChange={setFreeFormText}
            onSubmit={handleFreeFormSubmit}
            placeholder="Type your answer..."
          />
        </Box>
      )}

      <Box marginTop={1}>
        <Text color="gray">
          {"  ↑/↓ navigate · Enter confirm · 1-"}{options.length}{" quick-select"}
          {onCancel ? " · Esc cancel" : ""}
        </Text>
      </Box>
    </Box>
  );
}
