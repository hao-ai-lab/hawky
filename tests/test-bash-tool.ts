// =============================================================================
// Test: Bash Tool (2.1 verification)
// Run: bun run tests/test-bash-tool.ts
// =============================================================================

import { executeBash, bashToolDefinition } from "../src/tools/bash.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { ToolContext, StreamEvent } from "../src/agent/types.js";

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

function makeContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    session_id: "test",
    working_directory: process.cwd(),
    abort_signal: new AbortController().signal,
    emit: () => {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test 1: Simple echo command
// ---------------------------------------------------------------------------
console.log("\n--- Test 1: Simple echo command ---");

const r1 = await executeBash({
  command: 'echo hello',
  working_directory: process.cwd(),
  abort_signal: new AbortController().signal,
});

assert(r1.stdout.trim() === "hello", `stdout is 'hello' (got '${r1.stdout.trim()}')`);
assert(r1.stderr === "", `stderr is empty (got '${r1.stderr}')`);
assert(r1.exit_code === 0, `exit code is 0 (got ${r1.exit_code})`);
assert(r1.timed_out === false, "did not time out");
assert(r1.truncated === false, "not truncated");

// ---------------------------------------------------------------------------
// Test 2: Capture both stdout and stderr
// ---------------------------------------------------------------------------
console.log("\n--- Test 2: Capture both stdout and stderr ---");

const r2 = await executeBash({
  command: 'echo out && echo err >&2',
  working_directory: process.cwd(),
  abort_signal: new AbortController().signal,
});

assert(r2.stdout.trim() === "out", `stdout is 'out' (got '${r2.stdout.trim()}')`);
assert(r2.stderr.trim() === "err", `stderr is 'err' (got '${r2.stderr.trim()}')`);
assert(r2.exit_code === 0, "exit code is 0");

// ---------------------------------------------------------------------------
// Test 3: Non-zero exit code
// ---------------------------------------------------------------------------
console.log("\n--- Test 3: Non-zero exit code ---");

const r3 = await executeBash({
  command: 'exit 42',
  working_directory: process.cwd(),
  abort_signal: new AbortController().signal,
});

assert(r3.exit_code === 42, `exit code is 42 (got ${r3.exit_code})`);
assert(r3.timed_out === false, "did not time out");

// ---------------------------------------------------------------------------
// Test 4: Exit code 0 (success)
// ---------------------------------------------------------------------------
console.log("\n--- Test 4: Exit code 0 ---");

const r4 = await executeBash({
  command: 'true',
  working_directory: process.cwd(),
  abort_signal: new AbortController().signal,
});

assert(r4.exit_code === 0, `exit code is 0 (got ${r4.exit_code})`);

// ---------------------------------------------------------------------------
// Test 5: Timeout
// ---------------------------------------------------------------------------
console.log("\n--- Test 5: Timeout ---");

const startTime = Date.now();
const r5 = await executeBash({
  command: 'sleep 30',
  timeout_ms: 1000,
  working_directory: process.cwd(),
  abort_signal: new AbortController().signal,
});
const elapsed = Date.now() - startTime;

assert(r5.timed_out === true, "timed_out is true");
assert(r5.exit_code === null, `exit code is null on timeout (got ${r5.exit_code})`);
assert(elapsed < 5000, `completed within 5s (took ${elapsed}ms)`);

// ---------------------------------------------------------------------------
// Test 6: Streaming output line by line
// ---------------------------------------------------------------------------
console.log("\n--- Test 6: Streaming output line by line ---");

const streamedLines: { line: string; type: string }[] = [];
const r6 = await executeBash({
  command: 'for i in 1 2 3; do echo "line$i"; done',
  working_directory: process.cwd(),
  abort_signal: new AbortController().signal,
  on_output: (line, stream_type) => {
    streamedLines.push({ line, type: stream_type });
  },
});

assert(streamedLines.length === 3, `3 streamed lines (got ${streamedLines.length})`);
assert(streamedLines[0].line === "line1", `first line is 'line1' (got '${streamedLines[0]?.line}')`);
assert(streamedLines[1].line === "line2", `second line is 'line2' (got '${streamedLines[1]?.line}')`);
assert(streamedLines[2].line === "line3", `third line is 'line3' (got '${streamedLines[2]?.line}')`);
assert(streamedLines.every(l => l.type === "stdout"), "all lines are stdout");

// ---------------------------------------------------------------------------
// Test 7: Streaming stderr separately
// ---------------------------------------------------------------------------
console.log("\n--- Test 7: Streaming stderr separately ---");

const mixedLines: { line: string; type: string }[] = [];
const r7 = await executeBash({
  command: 'echo out1 && echo err1 >&2 && echo out2',
  working_directory: process.cwd(),
  abort_signal: new AbortController().signal,
  on_output: (line, stream_type) => {
    mixedLines.push({ line, type: stream_type });
  },
});

const stdoutLines = mixedLines.filter(l => l.type === "stdout");
const stderrLines = mixedLines.filter(l => l.type === "stderr");

assert(stdoutLines.length === 2, `2 stdout lines (got ${stdoutLines.length})`);
assert(stderrLines.length === 1, `1 stderr line (got ${stderrLines.length})`);
assert(stderrLines[0].line === "err1", `stderr line is 'err1' (got '${stderrLines[0]?.line}')`);

// ---------------------------------------------------------------------------
// Test 8: AbortSignal cancellation
// ---------------------------------------------------------------------------
console.log("\n--- Test 8: AbortSignal cancellation ---");

const ac = new AbortController();
const startAbort = Date.now();

// Abort after 500ms
setTimeout(() => ac.abort(), 500);

const r8 = await executeBash({
  command: 'sleep 30',
  working_directory: process.cwd(),
  abort_signal: ac.signal,
});
const abortElapsed = Date.now() - startAbort;

assert(r8.exit_code === null, `exit code is null on abort (got ${r8.exit_code})`);
assert(abortElapsed < 5000, `completed quickly after abort (took ${abortElapsed}ms)`);

// ---------------------------------------------------------------------------
// Test 9: Working directory
// ---------------------------------------------------------------------------
console.log("\n--- Test 9: Working directory ---");

const r9 = await executeBash({
  command: 'pwd',
  working_directory: '/tmp',
  abort_signal: new AbortController().signal,
});

assert(
  r9.stdout.trim() === "/tmp" || r9.stdout.trim() === "/private/tmp",
  `working dir is /tmp (got '${r9.stdout.trim()}')`,
);

// ---------------------------------------------------------------------------
// Test 10: Large output truncation
// ---------------------------------------------------------------------------
console.log("\n--- Test 10: Large output truncation ---");

const r10 = await executeBash({
  // Generate ~50KB of output (well over 30KB limit)
  command: 'for i in $(seq 1 2000); do echo "line $i: aaaaaaaaaaaaaaaaaaaaaaaaa"; done',
  working_directory: process.cwd(),
  abort_signal: new AbortController().signal,
});

assert(r10.truncated === true, "output was truncated");
assert(r10.stdout.includes("[output truncated"), "truncation notice in stdout");
assert(r10.stdout.length <= 35000, `stdout within limit (got ${r10.stdout.length} chars)`);

// ---------------------------------------------------------------------------
// Test 11: Nonexistent command
// ---------------------------------------------------------------------------
console.log("\n--- Test 11: Nonexistent command ---");

const r11 = await executeBash({
  command: 'nonexistent_command_xyz_12345',
  working_directory: process.cwd(),
  abort_signal: new AbortController().signal,
});

assert(r11.exit_code !== 0, `non-zero exit code (got ${r11.exit_code})`);
assert(
  r11.stderr.includes("not found") || r11.stderr.includes("No such file"),
  `stderr mentions not found (got '${r11.stderr.trim()}')`
);

// ---------------------------------------------------------------------------
// Test 12: Empty command via tool execute
// ---------------------------------------------------------------------------
console.log("\n--- Test 12: Empty command via tool execute ---");

const registry = new ToolRegistry();
registry.register(bashToolDefinition);

const r12 = await registry.execute("bash", { command: "" }, makeContext());
assert(r12.type === "error", "empty command returns error");
assert(r12.content.includes("empty"), `mentions empty (got '${r12.content}')`);

// ---------------------------------------------------------------------------
// Test 13: Tool execute - success case
// ---------------------------------------------------------------------------
console.log("\n--- Test 13: Tool execute - success case ---");

const r13 = await registry.execute("bash", { command: "echo works" }, makeContext());
assert(r13.type === "text", `result type is 'text' (got '${r13.type}')`);
assert(r13.content.includes("works"), `content includes 'works' (got '${r13.content}')`);

// ---------------------------------------------------------------------------
// Test 14: Tool execute - failure case
// ---------------------------------------------------------------------------
console.log("\n--- Test 14: Tool execute - failure case ---");

const r14 = await registry.execute("bash", { command: "exit 1" }, makeContext());
assert(r14.type === "error", `result type is 'error' (got '${r14.type}')`);
assert(r14.content.includes("failed"), `content mentions failed (got '${r14.content}')`);
assert(r14.content.includes("exit code 1"), `content includes exit code (got '${r14.content}')`);

// ---------------------------------------------------------------------------
// Test 15: Tool execute - timeout via tool
// ---------------------------------------------------------------------------
console.log("\n--- Test 15: Tool execute - timeout via tool ---");

const startT15 = Date.now();
const r15 = await registry.execute(
  "bash",
  { command: "sleep 30", timeout_ms: 1000 },
  makeContext(),
);
const elapsedT15 = Date.now() - startT15;

assert(r15.type === "error", "timeout returns error");
assert(r15.content.includes("timed out"), `mentions timed out (got '${r15.content}')`);
assert(elapsedT15 < 5000, `completed within 5s (took ${elapsedT15}ms)`);

// ---------------------------------------------------------------------------
// Test 16: Tool execute - emits streaming events
// ---------------------------------------------------------------------------
console.log("\n--- Test 16: Tool execute - emits streaming events ---");

const events: StreamEvent[] = [];
const r16 = await registry.execute(
  "bash",
  { command: 'echo a && echo b && echo c' },
  makeContext({ emit: (e) => events.push(e) }),
);

const streamEvents = events.filter(e => e.type === "tool_streaming");
assert(streamEvents.length === 3, `3 streaming events (got ${streamEvents.length})`);
assert(r16.type === "text", "result is text (success)");

// ---------------------------------------------------------------------------
// Test 17: Tool execute - abort via context
// ---------------------------------------------------------------------------
console.log("\n--- Test 17: Tool execute - abort via context ---");

const ac2 = new AbortController();
setTimeout(() => ac2.abort(), 500);

const startT17 = Date.now();
const r17 = await registry.execute(
  "bash",
  { command: "sleep 30" },
  makeContext({ abort_signal: ac2.signal }),
);
const elapsedT17 = Date.now() - startT17;

assert(r17.type === "error", "aborted returns error");
assert(r17.content.includes("interrupted"), `mentions interrupted (got '${r17.content}')`);
assert(elapsedT17 < 5000, `completed quickly (took ${elapsedT17}ms)`);

// ---------------------------------------------------------------------------
// Test 18: Multi-line command
// ---------------------------------------------------------------------------
console.log("\n--- Test 18: Multi-line command ---");

const r18 = await executeBash({
  command: `
    x=42
    echo "x is $x"
  `,
  working_directory: process.cwd(),
  abort_signal: new AbortController().signal,
});

assert(r18.exit_code === 0, "multi-line command succeeds");
assert(r18.stdout.trim() === "x is 42", `output is 'x is 42' (got '${r18.stdout.trim()}')`);

// ---------------------------------------------------------------------------
// Test 19: Tool definition shape
// ---------------------------------------------------------------------------
console.log("\n--- Test 19: Tool definition shape ---");

assert(bashToolDefinition.name === "bash", "tool name is 'bash'");
assert(bashToolDefinition.permission === "ask_user", "permission is 'ask_user'");
assert(bashToolDefinition.input_schema.required?.includes("command"), "'command' is required");
assert("timeout_ms" in bashToolDefinition.input_schema.properties, "schema has timeout_ms");
assert("description" in bashToolDefinition.input_schema.properties, "schema has description");

// ---------------------------------------------------------------------------
// Test 20: Already-aborted signal
// ---------------------------------------------------------------------------
console.log("\n--- Test 20: Already-aborted signal ---");

const preAborted = new AbortController();
preAborted.abort();

let execCalled = false;
const r20 = await executeBash({
  command: 'echo should_not_run',
  working_directory: process.cwd(),
  abort_signal: preAborted.signal,
  on_output: () => { execCalled = true; },
});

assert(r20.stdout === "", "no stdout on pre-aborted");
assert(execCalled === false, "on_output was never called");

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${"=".repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"=".repeat(60)}`);

if (failed > 0) {
  process.exit(1);
}
