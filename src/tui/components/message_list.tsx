// =============================================================================
// Message List Component
//
// Two parts:
// 1. <Static> for committed messages (won't re-render, scrolls up naturally)
// 2. Live area for the current streaming assistant message
//
// The welcome banner is the first static item.
// Tool output entries are rendered with ToolOutput component.
//
// Message display (matches Claude Code / COCO patterns):
// - User messages: colored background block (dark yellow bg, white text)
// - Assistant messages: ⏺ prefix (cyan) + markdown-rendered text
// - Tool messages: status icon + tool name + tree-branch output
// - System messages: italic gray
// =============================================================================

import React from "react";
import { Box, Static, Text } from "ink";
import { ToolOutput } from "./tool_output.js";
import { WelcomeScreen } from "./welcome_screen.js";
import { Markdown, StreamingMarkdown } from "./markdown.js";
import type { DisplayMessage } from "../types.js";

interface MessageListProps {
  messages: DisplayMessage[];
  model: string;
  /** The currently streaming message (shown in live area, not in Static) */
  streamingMessage?: DisplayMessage | null;
  /** Number of messages already prepainted to stdout (skip in Static) */
  staticBaseline?: number;
  /** Key to force Static remount on terminal resize (COCO pattern) */
  staticRemountKey?: number;
  /** Git branch for welcome screen */
  gitBranch?: string;
  /** Git clean status for welcome screen */
  gitClean?: boolean;
  /** Session info for welcome screen */
  sessionInfo?: string;
  /** Working directory for welcome screen */
  workingDirectory?: string;
  /** Verbose mode — show full tool output (Ctrl+O toggle) */
  verbose?: boolean;
}

// Task tools are hidden from the message stream (COCO pattern).
// Updates flow through TaskTray instead.
const HIDDEN_TOOLS = new Set(["task_create", "task_update"]);

/** Cyan ⏺ dot prefix as ANSI string (for embedding in text via Markdown prefix prop) */
const DOT_PREFIX = "\x1b[36m⏺\x1b[39m ";

/** A single message entry */
function MessageEntry({ msg, verbose }: { msg: DisplayMessage; verbose?: boolean }) {
  if (msg.role === "tool" && msg.toolData) {
    if (HIDDEN_TOOLS.has(msg.toolData.toolName)) return null;
    return <ToolOutput data={msg.toolData} verbose={verbose} />;
  }
  if (msg.role === "user") {
    return (
      <Box paddingX={1} marginTop={1}>
        <Text backgroundColor="#6a6a00" color="#ffffff">{` ${msg.text} `}</Text>
      </Box>
    );
  }
  if (msg.role === "assistant") {
    return (
      <Box paddingX={1} marginTop={1}>
        <Markdown prefix={DOT_PREFIX}>{msg.text}</Markdown>
      </Box>
    );
  }
  // system
  return (
    <Box paddingX={1} marginTop={1}>
      <Text color="gray" italic>{msg.text}</Text>
    </Box>
  );
}

// Unified indicator color (matches Claude Code's gray)
const INDICATOR_COLOR = "#949494";

// Items for <Static>: welcome banner + messages + batch headers
interface StaticItem {
  id: string;
  type: "welcome" | "message" | "batch_header";
  msg?: DisplayMessage;
  /** Batch header text (e.g., "⚡ 3 tools: bash, grep") */
  batchText?: string;
}

/**
 * Build Static items from committed messages.
 * Inserts batch headers before tool groups that share a batchId.
 * Each batch header has a stable ID derived from the batchId, so
 * Static renders it once and keeps it (no position-tracking issues).
 */
function buildStaticItems(messages: DisplayMessage[]): StaticItem[] {
  const items: StaticItem[] = [];
  const seenBatches = new Set<string>();

  for (const msg of messages) {
    // Skip hidden tools
    if (msg.role === "tool" && msg.toolData && HIDDEN_TOOLS.has(msg.toolData.toolName)) continue;

    // Insert batch header before the first tool in a new batch
    if (msg.role === "tool" && msg.toolData?.batchId && !seenBatches.has(msg.toolData.batchId)) {
      seenBatches.add(msg.toolData.batchId);
      // Use batchSize from the event (accurate even when batch is partially committed)
      const totalSize = msg.toolData.batchSize ?? 1;
      // Collect unique visible tool names from committed tools in this batch
      const batchTools = messages.filter(
        (m) => m.toolData?.batchId === msg.toolData!.batchId && !HIDDEN_TOOLS.has(m.toolData?.toolName ?? ""),
      );
      // Only show header when 2+ visible tools in the batch
      if (totalSize > 1 && batchTools.length > 1) {
        const toolNames = [...new Set(batchTools.map((m) => m.toolData?.toolName ?? "tool"))];
        const summary = toolNames.length <= 3
          ? toolNames.join(", ")
          : `${toolNames.slice(0, 2).join(", ")} +${toolNames.length - 2} more`;
        items.push({
          id: `batch-${msg.toolData.batchId}`,
          type: "batch_header",
          batchText: `⚡ ${totalSize} tools: ${summary}`,
        });
      }
    }

    items.push({ id: msg.id, type: "message", msg });
  }
  return items;
}

export function MessageList({ messages, model, streamingMessage, staticBaseline = 0, staticRemountKey = 0, gitBranch, gitClean, sessionInfo, workingDirectory, verbose = false }: MessageListProps) {
  // Committed messages go into Static (rendered once, scroll up)
  // The streaming message is NOT in Static — it goes in the live area
  // Tool messages that are still executing also stay in live area
  // Messages below staticBaseline were already prepainted to stdout — skip them
  const committedMessages = messages.filter((m, index) => {
    // Skip prepainted messages
    if (index < staticBaseline) return false;
    // Exclude the streaming assistant message
    if (streamingMessage && m.id === streamingMessage.id) return false;
    // Exclude executing tool entries (they need live updates for spinner)
    if (m.role === "tool" && m.toolData?.status === "executing") return false;
    return true;
  });

  // Executing tool entries go in live area (spinner needs re-rendering)
  // Exclude hidden task tools from count and display
  const executingTools = messages.filter(
    (m) => m.role === "tool" && m.toolData?.status === "executing" && !HIDDEN_TOOLS.has(m.toolData?.toolName ?? ""),
  );

  // Build Static items with batch headers. Each batch header has a stable ID
  // derived from batchId, so Static renders it once and keeps it permanently.
  const items: StaticItem[] = [
    { id: "__welcome__", type: "welcome" },
    ...buildStaticItems(committedMessages),
  ];

  return (
    <Box flexDirection="column">
      <Static key={`static-${staticRemountKey}`} items={items}>
        {(item: StaticItem) => {
          if (item.type === "welcome") {
            return (
              <Box key={item.id}>
                <WelcomeScreen
                  model={model}
                  workingDirectory={workingDirectory ?? process.cwd()}
                  gitBranch={gitBranch}
                  gitClean={gitClean}
                  sessionInfo={sessionInfo}
                />
              </Box>
            );
          }
          if (item.type === "batch_header") {
            return (
              <Box key={item.id} paddingX={1} marginTop={1}>
                <Text color={INDICATOR_COLOR}>{item.batchText}</Text>
              </Box>
            );
          }
          return (
            <Box key={item.id}>
              <MessageEntry msg={item.msg!} verbose={verbose} />
            </Box>
          );
        }}
      </Static>

      {/* Live area: executing tools (spinner needs re-rendering) */}
      {executingTools.length > 1 && (
        <Box paddingX={1} marginTop={1}>
          <Text color={INDICATOR_COLOR}>⚡ {executingTools.length} tools running</Text>
        </Box>
      )}
      {executingTools.map((m) => (
        <Box key={m.id}>
          <MessageEntry msg={m} verbose={verbose} />
        </Box>
      ))}

      {/* Live area: streaming assistant message */}
      {streamingMessage && (
        <Box flexDirection="column" paddingX={1} marginTop={1}>
          <StreamingMarkdown prefix={DOT_PREFIX}>{streamingMessage.text}</StreamingMarkdown>
          <Text color="gray">{"  ▍"}</Text>
        </Box>
      )}
    </Box>
  );
}
