// =============================================================================
// Test: Core Types & StreamEvent System (1.2 verification)
// Run: bun run tests/test-stream-events.ts
// =============================================================================

import { StreamEventEmitter, streamEvents } from "../src/agent/stream.js";
import type {
  StreamEvent,
  TextStreamEvent,
  ThinkingStreamEvent,
  ToolUseStartEvent,
  ToolStreamingEvent,
  ToolResultEvent,
  PermissionRequestEvent,
  PermissionResultEvent,
  ErrorStreamEvent,
  DoneStreamEvent,
  CancelStreamEvent,
  AskUserRequestEvent,
  AskUserResponseEvent,
  QueueMessageEvent,
  SystemMessageEvent,
  ToolDefinition,
  ToolResult,
  ToolContext,
  ChatMessage,
  ContentBlock,
  AnthropicToolDefinition,
  TokenUsage,
} from "../src/agent/types.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.error(`  ✗ ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Test 1: All StreamEvent types are constructable
// ---------------------------------------------------------------------------
console.log("\n--- Test 1: All StreamEvent types are constructable ---");

const events: StreamEvent[] = [
  { type: "text", content: "hello" } satisfies TextStreamEvent,
  { type: "thinking", content: "hmm..." } satisfies ThinkingStreamEvent,
  { type: "tool_use_start", tool_use_id: "t1", name: "bash", input: { command: "ls" } } satisfies ToolUseStartEvent,
  { type: "tool_streaming", tool_use_id: "t1", stream_type: "stdout", content: "file.txt" } satisfies ToolStreamingEvent,
  { type: "tool_result", tool_use_id: "t1", name: "bash", content: "file.txt", is_error: false } satisfies ToolResultEvent,
  { type: "permission_request", id: "p1", tool_use_id: "t2", tool_name: "bash", tool_input: { command: "rm -rf" } } satisfies PermissionRequestEvent,
  { type: "permission_result", id: "p1", decision: "allow_once" } satisfies PermissionResultEvent,
  { type: "ask_user_request", id: "a1", tool_use_id: "t3", question: "Which one?", options: ["A", "B"], multi_select: false } satisfies AskUserRequestEvent,
  { type: "ask_user_response", id: "a1", selected: ["A"] } satisfies AskUserResponseEvent,
  { type: "error", content: "something went wrong", code: "api_error" } satisfies ErrorStreamEvent,
  { type: "done", usage: { input_tokens: 100, output_tokens: 50 } } satisfies DoneStreamEvent,
  { type: "cancel", content: "Request cancelled by user" } satisfies CancelStreamEvent,
  { type: "queue_message", content: "queued msg", position: 1 } satisfies QueueMessageEvent,
  { type: "system_message", content: "compacted", subtype: "compaction" } satisfies SystemMessageEvent,
];

assert(events.length === 14, `All 14 event types created (got ${events.length})`);
for (const e of events) {
  assert(typeof e.type === "string", `Event type "${e.type}" is valid`);
}

// ---------------------------------------------------------------------------
// Test 2: StreamEventEmitter subscribe and emit
// ---------------------------------------------------------------------------
console.log("\n--- Test 2: StreamEventEmitter subscribe and emit ---");

const emitter = new StreamEventEmitter();
const received: StreamEvent[] = [];

const unsub = emitter.subscribe((event) => {
  received.push(event);
});

assert(emitter.subscriberCount === 1, "One subscriber registered");

emitter.emit({ type: "text", content: "hello" });
emitter.emit({ type: "text", content: "world" });

assert(received.length === 2, `Received 2 events (got ${received.length})`);
assert(received[0].type === "text", "First event is text");
assert((received[0] as TextStreamEvent).content === "hello", "First event content is 'hello'");
assert((received[1] as TextStreamEvent).content === "world", "Second event content is 'world'");

// ---------------------------------------------------------------------------
// Test 3: Unsubscribe stops delivery
// ---------------------------------------------------------------------------
console.log("\n--- Test 3: Unsubscribe stops delivery ---");

unsub();
assert(emitter.subscriberCount === 0, "No subscribers after unsub");

emitter.emit({ type: "text", content: "should not arrive" });
assert(received.length === 2, `Still 2 events after unsub (got ${received.length})`);

// ---------------------------------------------------------------------------
// Test 4: Multiple subscribers
// ---------------------------------------------------------------------------
console.log("\n--- Test 4: Multiple subscribers ---");

const received1: StreamEvent[] = [];
const received2: StreamEvent[] = [];

const unsub1 = emitter.subscribe((e) => received1.push(e));
const unsub2 = emitter.subscribe((e) => received2.push(e));

assert(emitter.subscriberCount === 2, "Two subscribers registered");

emitter.emit({ type: "done" });

assert(received1.length === 1, "Subscriber 1 got event");
assert(received2.length === 1, "Subscriber 2 got event");

unsub1();
unsub2();

// ---------------------------------------------------------------------------
// Test 5: Subscriber error doesn't break emitter
// ---------------------------------------------------------------------------
console.log("\n--- Test 5: Subscriber error doesn't break emitter ---");

const safeReceived: StreamEvent[] = [];
emitter.subscribe(() => { throw new Error("bad subscriber"); });
emitter.subscribe((e) => safeReceived.push(e));

emitter.emit({ type: "text", content: "after error" });
assert(safeReceived.length === 1, "Good subscriber still received event despite bad subscriber");

emitter.clear();

// ---------------------------------------------------------------------------
// Test 6: AsyncGenerator via streamEvents()
// ---------------------------------------------------------------------------
console.log("\n--- Test 6: AsyncGenerator via streamEvents() ---");

const emitter2 = new StreamEventEmitter();
const collected: StreamEvent[] = [];

// Emit events after a small delay (simulates async agent loop)
setTimeout(() => {
  emitter2.emit({ type: "text", content: "token1" });
  emitter2.emit({ type: "text", content: "token2" });
  emitter2.emit({ type: "done" });
}, 10);

for await (const event of streamEvents(emitter2)) {
  collected.push(event);
}

assert(collected.length === 3, `AsyncGenerator collected 3 events (got ${collected.length})`);
assert(collected[0].type === "text", "First is text");
assert(collected[2].type === "done", "Last is done (terminal)");

// ---------------------------------------------------------------------------
// Test 7: AsyncGenerator respects AbortSignal
// ---------------------------------------------------------------------------
console.log("\n--- Test 7: AsyncGenerator respects AbortSignal ---");

const emitter3 = new StreamEventEmitter();
const abortController = new AbortController();
const abortCollected: StreamEvent[] = [];

// Emit one event, then abort on next tick, then emit another after abort
setTimeout(() => {
  emitter3.emit({ type: "text", content: "before abort" });
}, 10);

setTimeout(() => {
  abortController.abort();
}, 30);

setTimeout(() => {
  emitter3.emit({ type: "text", content: "after abort" });
}, 50);

for await (const event of streamEvents(emitter3, abortController.signal)) {
  abortCollected.push(event);
}

// Should get the event emitted before abort; the one after abort should not arrive
assert(abortCollected.length === 1, `Got 1 event before abort (got ${abortCollected.length})`);

// ---------------------------------------------------------------------------
// Test 8: ToolDefinition shape
// ---------------------------------------------------------------------------
console.log("\n--- Test 8: ToolDefinition shape ---");

const dummyTool: ToolDefinition<{ command: string }> = {
  name: "bash",
  description: "Execute a shell command",
  input_schema: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command to run" },
    },
    required: ["command"],
  },
  permission: "ask_user",
  execute: async (input, _context) => {
    return { type: "text", content: `ran: ${input.command}` };
  },
};

assert(dummyTool.name === "bash", "Tool name is 'bash'");
assert(dummyTool.permission === "ask_user", "Tool permission is 'ask_user'");

// Test execute
const mockContext: ToolContext = {
  session_id: "test-session",
  working_directory: "/tmp",
  abort_signal: new AbortController().signal,
  emit: () => {},
};

const result = await dummyTool.execute({ command: "ls" }, mockContext);
assert(result.type === "text", "Tool result type is 'text'");
assert(result.content === "ran: ls", "Tool result content is correct");

// ---------------------------------------------------------------------------
// Test 9: AnthropicToolDefinition extraction
// ---------------------------------------------------------------------------
console.log("\n--- Test 9: AnthropicToolDefinition extraction ---");

// This is the shape we'd send to the Claude API
const apiTool: AnthropicToolDefinition = {
  name: dummyTool.name,
  description: dummyTool.description,
  input_schema: dummyTool.input_schema,
};

assert(apiTool.name === "bash", "API tool name matches");
assert(apiTool.input_schema.type === "object", "API tool schema type is object");
assert("command" in apiTool.input_schema.properties, "API tool schema has 'command' property");

// ---------------------------------------------------------------------------
// Test 10: ChatMessage and ContentBlock
// ---------------------------------------------------------------------------
console.log("\n--- Test 10: ChatMessage and ContentBlock ---");

const userMsg: ChatMessage = {
  role: "user",
  content: [
    { type: "text", text: "Hello, what files are in this directory?" },
  ],
  id: "msg-1",
  timestamp: new Date().toISOString(),
};

const assistantMsg: ChatMessage = {
  role: "assistant",
  content: [
    { type: "thinking", thinking: "I should use the glob tool..." },
    { type: "text", text: "Let me check..." },
    { type: "tool_use", id: "tu-1", name: "glob", input: { pattern: "*" } },
  ],
  id: "msg-2",
};

const toolResultMsg: ChatMessage = {
  role: "user",
  content: [
    { type: "tool_result", tool_use_id: "tu-1", content: "file1.ts\nfile2.ts", is_error: false },
  ],
  id: "msg-3",
};

assert(userMsg.role === "user", "User message role is 'user'");
assert(assistantMsg.content.length === 3, "Assistant message has 3 content blocks");
assert(assistantMsg.content[0].type === "thinking", "First block is thinking");
assert(assistantMsg.content[1].type === "text", "Second block is text");
assert(assistantMsg.content[2].type === "tool_use", "Third block is tool_use");
assert(toolResultMsg.content[0].type === "tool_result", "Tool result block is correct type");

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${"=".repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"=".repeat(60)}`);

if (failed > 0) {
  process.exit(1);
}
