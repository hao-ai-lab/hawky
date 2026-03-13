// =============================================================================
// Mock AgentEventSource for TUI tests
//
// Simulates agent behavior without a real AgentLoop or gateway.
// Tests can push events directly to subscribers.
// =============================================================================

import type { AgentEventSource } from "../../src/gateway/agent-source.js";
import type { StreamEvent, StreamEventCallback, ChatMessage } from "../../src/agent/types.js";
import type { LLMProvider } from "../../src/agent/provider.js";
import type { HawkyConfig } from "../../src/agent/types.js";
import { AgentLoop } from "../../src/agent/loop.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { registerBuiltinTools } from "../../src/tools/builtin.js";
import type { PermissionDecision, PermissionResolver } from "../../src/agent/tool_executor.js";

export class MockAgentSource implements AgentEventSource {
  private subscribers: StreamEventCallback[] = [];
  private running = false;
  private history: ChatMessage[] = [];

  /** Send handler — tests can override to control behavior */
  onSendMessage: ((text: string) => Promise<void>) | null = null;

  subscribe(callback: StreamEventCallback): () => void {
    this.subscribers.push(callback);
    return () => {
      this.subscribers = this.subscribers.filter((cb) => cb !== callback);
    };
  }

  async sendMessage(text: string): Promise<void> {
    this.running = true;
    try {
      if (this.onSendMessage) {
        await this.onSendMessage(text);
      }
    } finally {
      this.running = false;
    }
  }

  cancel(): void {
    this.emit({ type: "cancel", content: "Cancelled." });
    this.running = false;
  }

  async getHistory(): Promise<ChatMessage[]> {
    return this.history;
  }

  clearHistory(): void {
    this.history = [];
  }

  isRunning(): boolean {
    return this.running;
  }

  async switchSession(_newSessionKey: string): Promise<ChatMessage[]> {
    return this.history;
  }

  getSessionKey(): string {
    return "test:main";
  }

  async resolvePermission(_requestId: string, _decision: string): Promise<void> {
    // Mock: no-op (test can override if needed)
  }

  async resolveAskUser(_requestId: string, _answers: string[]): Promise<void> {
    // Mock: no-op (test can override if needed)
  }

  // ---------------------------------------------------------------------------
  // Test helpers
  // ---------------------------------------------------------------------------

  /** Push an event to all subscribers (for test control). */
  emit(event: StreamEvent): void {
    for (const cb of this.subscribers) {
      try {
        cb(event);
      } catch { /* ignore */ }
    }
  }

  /** Set history for session resume tests. */
  setHistory(messages: ChatMessage[]): void {
    this.history = messages;
  }

  /** Simulate a complete text response (emit text + done). */
  async simulateTextResponse(text: string): Promise<void> {
    this.emit({ type: "text", content: text });
    this.emit({ type: "done", usage: { input_tokens: 10, output_tokens: 5 } });
  }

  /** Simulate a tool call + result cycle. */
  async simulateToolCall(toolName: string, input: Record<string, unknown>, result: string): Promise<void> {
    this.emit({ type: "tool_use_start", tool_use_id: "tool_1", name: toolName, input });
    this.emit({ type: "tool_result", tool_use_id: "tool_1", name: toolName, content: result, is_error: false });
  }
}

// =============================================================================
// Bridge: Wrap LLMProvider + AgentLoop as AgentEventSource
//
// This allows existing TUI tests to keep their MockProvider/SlowProvider/etc
// while using the new App interface. The bridge creates a real AgentLoop
// internally — same behavior as the old standalone mode, but exposed via
// the AgentEventSource interface.
// =============================================================================

export class AgentLoopSource implements AgentEventSource {
  private loop: AgentLoop;
  private subscribers: StreamEventCallback[] = [];

  constructor(provider: LLMProvider, config: HawkyConfig, opts?: {
    workingDirectory?: string;
    permissionResolver?: PermissionResolver;
  }) {
    const registry = new ToolRegistry();
    registerBuiltinTools(registry);

    this.loop = new AgentLoop({
      provider,
      registry,
      config,
      working_directory: opts?.workingDirectory ?? "/tmp",
      permissionResolver: opts?.permissionResolver,
    });

    // Forward loop events to our subscribers
    this.loop.subscribe((event) => {
      for (const cb of this.subscribers) {
        try { cb(event); } catch { /* ignore */ }
      }
    });
  }

  subscribe(callback: StreamEventCallback): () => void {
    this.subscribers.push(callback);
    return () => {
      this.subscribers = this.subscribers.filter((cb) => cb !== callback);
    };
  }

  async sendMessage(text: string): Promise<void> {
    await this.loop.sendMessage(text);
  }

  cancel(): void {
    this.loop.cancel();
  }

  async getHistory(): Promise<ChatMessage[]> {
    return this.loop.getHistory();
  }

  clearHistory(): void {
    this.loop.clearHistory();
  }

  isRunning(): boolean {
    return this.loop.isRunning();
  }

  async switchSession(_newSessionKey: string): Promise<ChatMessage[]> {
    return this.loop.getHistory();
  }

  getSessionKey(): string {
    return "test:main";
  }

  async resolvePermission(_requestId: string, _decision: string): Promise<void> {}
  async resolveAskUser(_requestId: string, _answers: string[]): Promise<void> {}

  /** Access the underlying AgentLoop (for tests that need it). */
  getLoop(): AgentLoop {
    return this.loop;
  }
}
