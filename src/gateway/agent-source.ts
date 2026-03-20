// =============================================================================
// Agent Event Source Interface
//
// Abstraction over agent communication. Both AgentLoop (used by gateway
// internally) and GatewayClient (used by TUI) implement this interface.
// TUI components only depend on this interface — they never touch AgentLoop.
//
// Pattern: Inspired by COCO's AgentService.subscribe() callback interface.
// =============================================================================

import type { StreamEvent, StreamEventCallback, ChatMessage, TokenUsage } from "../agent/types.js";
import type { PermissionDecision } from "../agent/tool_executor.js";

// -----------------------------------------------------------------------------
// Interface
// -----------------------------------------------------------------------------

export interface AgentEventSource {
  /** Subscribe to agent stream events. Returns an unsubscribe function. */
  subscribe(callback: StreamEventCallback): () => void;

  /** Send a user message. Resolves when the agent turn completes. */
  sendMessage(text: string, attachments?: Array<{ base64: string; media_type: string }>): Promise<void>;

  /** Cancel the current agent turn. */
  cancel(): void;

  /** Get conversation history. Async because client mode fetches via RPC. */
  getHistory(): Promise<ChatMessage[]>;

  /** Clear conversation history (for /new command). */
  clearHistory(): void;

  /** Trigger memory flush — extract durable memories to daily logs. */
  flush?(): void;

  /** Trigger context compaction — summarize old messages to free context space. */
  compact?(): void;

  /** Check if the agent is currently processing a message. */
  isRunning(): boolean;

  /** Switch to a different session. Returns the new session's history. */
  switchSession?(newSessionKey: string): Promise<ChatMessage[]>;

  /** Get the current session key. */
  getSessionKey?(): string;

  /** Resolve a pending permission request (gateway mode). */
  resolvePermission?(requestId: string, decision: string, feedback?: string, pattern?: string): Promise<void>;

  /** Resolve a pending ask_user request (gateway mode). */
  resolveAskUser?(requestId: string, answers: string[]): Promise<void>;

  /** Send a raw RPC call to the gateway (gateway mode only). */
  rpc?(method: string, params?: unknown): Promise<unknown>;
}

/** Connection status for client mode. */
export type ConnectionStatus = "connected" | "disconnected" | "reconnecting" | "connecting";
