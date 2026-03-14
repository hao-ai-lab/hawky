// =============================================================================
// TUI Types
// =============================================================================

/** A message displayed in the TUI message list */
export interface DisplayMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  text: string;
  timestamp: string;
  /** Tool-specific display data (only when role === "tool") */
  toolData?: ToolDisplayData;
}

/** Tool execution display state */
export interface ToolDisplayData {
  toolUseId: string;
  toolName: string;
  /** One-line preview of tool input (e.g., "echo hello" for bash) */
  inputPreview: string;
  status: ToolDisplayStatus;
  /** Output lines accumulated during and after execution */
  outputLines: ToolOutputLine[];
  /** Is this an error result? */
  isError: boolean;
  /** Tool-specific metadata (e.g., diff data for edit_file/write_file) */
  metadata?: Record<string, unknown>;
  /** Timestamp when tool started executing (Date.now()) for elapsed timer */
  startedAt?: number;
  /** Why this tool was auto-approved (undefined if user was prompted) */
  approvalReason?: string;
  /** Batch ID — tools in the same batch share this for visual grouping */
  batchId?: string;
  /** Total tools in this batch */
  batchSize?: number;
}

export type ToolDisplayStatus = "pending" | "executing" | "success" | "error" | "canceled";

export interface ToolOutputLine {
  type: "stdout" | "stderr";
  content: string;
}

/** TUI status */
export type TuiStatus = "idle" | "thinking" | "streaming" | "compacting" | "error";

/** Token usage for display in status bar */
export interface DisplayTokenUsage {
  input_tokens: number;
  output_tokens: number;
  /** Optional cache buckets — present once Anthropic prompt caching engages.
   *  Display sites should sum input + cache_read + cache_creation when
   *  showing total input tokens, otherwise the bar appears to shrink as
   *  caching kicks in. */
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  context_window_tokens?: number;
  context_usage_percent?: number;
}

/** Pending permission request state */
export interface PendingPermission {
  id: string;
  toolUseId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  /** Gateway RPC request ID (for resolving via WebSocket) */
  _requestId?: string;
  /** Context-aware suggestions (e.g., "switch to acceptEdits", "allow edits in folder") */
  suggestions?: import("../agent/types.js").PermissionSuggestion[];
  /** Server-suggested allow-rule pattern for "Always allow `<pattern>`" */
  suggestedPattern?: string;
}

/** Pending ask_user request state */
export interface PendingAskUser {
  id: string;
  toolName?: string;
  question: string;
  options: string[];
  multiSelect?: boolean;
  /** Gateway RPC request ID (for resolving via WebSocket) */
  _requestId?: string;
}

/** Option for InteractiveSelector */
export interface SelectorOption {
  id: string;
  label: string;
  description?: string;
  /** If true, selecting this option prompts for free-form text input */
  freeForm?: boolean;
}
