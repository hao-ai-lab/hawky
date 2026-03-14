// =============================================================================
// Permission Prompt Component
//
// Inline prompt shown when a tool needs user approval. Wraps InteractiveSelector
// with tool name header, input preview, and structured diff preview for file tools.
// When "No" is selected, shows a feedback input so the user can explain why.
// =============================================================================

import React, { useMemo, useState, useCallback } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Box, Text, useInput } from "ink";
import { InteractiveSelector } from "./interactive_selector.js";
import { formatToolPreview } from "../utils/format_tool_preview.js";
import {
  computeDiffHunks,
  formatDiffHunks,
} from "../utils/structured_diff.js";
import type { PendingPermission, SelectorOption } from "../types.js";
import type { PermissionDecision } from "../../agent/tool_executor.js";

/**
 * What the suggested pattern would look like if it were a literal wrap
 * around the exact command/path. Used to suppress the "Always allow
 * <pattern>" option when it'd be redundant with "Always allow this
 * command".
 */
function formatLiteralPattern(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "bash" && typeof input.command === "string") return `Bash(${input.command})`;
  if (toolName === "read_file" && typeof input.file_path === "string") return `Read(${input.file_path})`;
  if (toolName === "edit_file" && typeof input.file_path === "string") return `Edit(${input.file_path})`;
  if (toolName === "write_file" && typeof input.file_path === "string") return `Write(${input.file_path})`;
  return toolName;
}

/** Find the 1-based line number where old_string starts in a file */
function findMatchLine(filePath: string, oldString: string): number {
  try {
    const absPath = filePath.startsWith("/") ? filePath : resolve(process.cwd(), filePath);
    const content = readFileSync(absPath, "utf-8");
    const index = content.indexOf(oldString);
    if (index < 0) return 1;
    return content.substring(0, index).split("\n").length;
  } catch {
    return 1;
  }
}

interface PermissionPromptProps {
  permission: PendingPermission;
  onRespond: (decision: PermissionDecision, feedback?: string, pattern?: string) => void;
  onCancel?: () => void;
}

/** Inline text input for deny feedback. */
function FeedbackInput({ onSubmit }: { onSubmit: (text: string) => void }) {
  const [value, setValue] = useState("");

  useInput((input, key) => {
    if (key.return) {
      onSubmit(value.trim());
      return;
    }
    if (key.backspace || key.delete) {
      setValue((v) => v.slice(0, -1));
      return;
    }
    if (key.escape) {
      onSubmit(""); // Skip feedback
      return;
    }
    if (!key.ctrl && !key.meta && input) {
      setValue((v) => v + input);
    }
  });

  return (
    <Box paddingLeft={2} marginTop={1}>
      <Text color="#949494">Reason (optional, Enter to skip): </Text>
      <Text>{value}<Text color="yellow">▍</Text></Text>
    </Box>
  );
}

export function PermissionPrompt({ permission, onRespond, onCancel }: PermissionPromptProps) {
  const [showFeedback, setShowFeedback] = useState(false);
  const preview = formatToolPreview(permission.toolName, permission.toolInput);

  const isBash = permission.toolName === "bash";
  const isNodesSystemRun = permission.toolName === "nodes"
    && permission.toolInput?.action === "invoke"
    && permission.toolInput?.command === "system.run";
  // edit_file and write_file are one permission class — label accordingly.
  const isFileEdit = permission.toolName === "edit_file" || permission.toolName === "write_file";
  const alwaysAllowLabel = (isBash || isNodesSystemRun)
    ? "Always allow this command"
    : isFileEdit
      ? "Always allow file edits"
      : `Always allow ${permission.toolName}`;
  const options: SelectorOption[] = [
    { id: "allow_once", label: "Yes" },
    { id: "deny", label: "No" },
    { id: "allow_always", label: alwaysAllowLabel },
  ];

  // Suggested-pattern option (e.g., `Bash(git log *)`) — broader than
  // the literal grant above. Hidden when the suggestion would be the
  // same as the literal form (no broadening on offer).
  const literalPattern = formatLiteralPattern(permission.toolName, permission.toolInput);
  const showPatternOption = !!(
    permission.suggestedPattern &&
    permission.suggestedPattern !== literalPattern
  );
  if (showPatternOption) {
    options.push({
      id: "allow_always_pattern",
      label: `Always allow ${permission.suggestedPattern}`,
    });
  }

  // Add suggestion-based options
  if (permission.suggestions) {
    for (const suggestion of permission.suggestions) {
      if (suggestion.type === "setMode" && suggestion.mode === "accept-edits") {
        options.push({ id: "accept_edits", label: "Allow all edits in project" });
      }
      if (suggestion.type === "addDirectory") {
        const dir = suggestion.directory;
        const shortDir = dir.length > 40 ? "..." + dir.slice(-37) : dir;
        options.push({ id: "allow_directory", label: `Allow edits in ${shortDir}` });
      }
    }
  }

  const handleSelect = useCallback((optionId: string) => {
    if (optionId === "deny") {
      setShowFeedback(true);
      return;
    }
    if (optionId === "allow_always_pattern") {
      onRespond("allow_always", undefined, permission.suggestedPattern);
      return;
    }
    onRespond(optionId as PermissionDecision);
  }, [onRespond, permission.suggestedPattern]);

  const handleFeedback = useCallback((text: string) => {
    onRespond("deny", text || undefined);
  }, [onRespond]);

  // Generate structured diff preview for edit_file
  const diffPreview = useMemo(() => {
    if (permission.toolName !== "edit_file") return null;
    const oldStr = permission.toolInput.old_string;
    const newStr = permission.toolInput.new_string;
    const filePath = permission.toolInput.file_path as string | undefined;
    if (typeof oldStr !== "string" || typeof newStr !== "string") return null;

    const startLine = filePath ? findMatchLine(filePath, oldStr) : 1;
    const hunks = computeDiffHunks(oldStr, newStr, filePath);
    return formatDiffHunks(hunks, { filePath, syntaxHighlight: true, startLine });
  }, [permission.toolName, permission.toolInput]);

  return (
    <Box flexDirection="column" paddingX={1}>
      {/* Header */}
      <Box>
        <Text color="yellow" bold>── {permission.toolName} </Text>
        <Text color="yellow">{"─".repeat(Math.max(0, 50 - permission.toolName.length))}</Text>
      </Box>

      {/* Input preview */}
      {preview && (
        <Box paddingLeft={2} marginTop={0}>
          <Text color="white">{preview}</Text>
        </Box>
      )}

      {/* Structured diff preview for file tools */}
      {diffPreview && (
        <Box paddingLeft={2} marginTop={1} flexDirection="column">
          <Text>{diffPreview}</Text>
        </Box>
      )}

      {/* Selector or feedback input */}
      {showFeedback ? (
        <FeedbackInput onSubmit={handleFeedback} />
      ) : (
        <Box marginTop={1}>
          <InteractiveSelector
            options={options}
            onSelect={handleSelect}
            onCancel={onCancel}
          />
        </Box>
      )}
    </Box>
  );
}
