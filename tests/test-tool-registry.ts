// =============================================================================
// Test: Tool Registry (1.3 verification)
// Run: bun run tests/test-tool-registry.ts
// =============================================================================

import {
  ToolRegistry,
  getToolRegistry,
  resetToolRegistry,
} from "../src/tools/registry.js";
import {
  builtinToolsExtensionManifest,
  registerBuiltinTools,
} from "../src/tools/builtin.js";
import type {
  ToolDefinition,
  ToolContext,
  ToolResult,
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
// Helper: create a dummy tool
// ---------------------------------------------------------------------------

function makeTool(
  name: string,
  permission: "auto_approve" | "ask_user" | "always_approve" = "auto_approve",
  opts?: { executeFn?: (input: any, ctx: ToolContext) => Promise<ToolResult> },
): ToolDefinition {
  return {
    name,
    description: `Test tool: ${name}`,
    input_schema: {
      type: "object",
      properties: {
        value: { type: "string", description: "A test value" },
      },
      required: ["value"],
    },
    permission,
    execute: opts?.executeFn ?? (async (input: any) => ({
      type: "text" as const,
      content: `${name} executed with: ${input.value}`,
    })),
  };
}

function makeContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    session_id: "test-session",
    working_directory: "/tmp",
    abort_signal: new AbortController().signal,
    emit: () => {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test 1: Register and get a tool
// ---------------------------------------------------------------------------
console.log("\n--- Test 1: Register and get a tool ---");

const bashTool = makeTool("bash", "ask_user");

const registry = new ToolRegistry();

registry.register(bashTool);

const retrieved = registry.get("bash");
assert(retrieved !== undefined, "get('bash') returns the tool");
assert(retrieved?.name === "bash", "Retrieved tool name is 'bash'");
assert(retrieved?.permission === "ask_user", "Retrieved tool permission is 'ask_user'");

// ---------------------------------------------------------------------------
// Test 2: get() returns undefined for nonexistent tool
// ---------------------------------------------------------------------------
console.log("\n--- Test 2: get() returns undefined for nonexistent ---");

const missing = registry.get("nonexistent");
assert(missing === undefined, "get('nonexistent') returns undefined");

// ---------------------------------------------------------------------------
// Test 3: has() checks existence
// ---------------------------------------------------------------------------
console.log("\n--- Test 3: has() checks existence ---");

assert(registry.has("bash") === true, "has('bash') returns true");
assert(registry.has("nonexistent") === false, "has('nonexistent') returns false");

// ---------------------------------------------------------------------------
// Test 4: count property
// ---------------------------------------------------------------------------
console.log("\n--- Test 4: count property ---");

assert(registry.count === 1, `count is 1 (got ${registry.count})`);

registry.register(makeTool("read_file"));
registry.register(makeTool("write_file", "ask_user"));

assert(registry.count === 3, `count is 3 after registering 2 more (got ${registry.count})`);

// ---------------------------------------------------------------------------
// Test 5: getAll() returns all tools
// ---------------------------------------------------------------------------
console.log("\n--- Test 5: getAll() returns all tools ---");

const all = registry.getAll();
assert(all.length === 3, `getAll() returns 3 tools (got ${all.length})`);

const names = all.map((t) => t.name).sort();
assert(
  names.join(",") === "bash,read_file,write_file",
  `Tool names are bash,read_file,write_file (got ${names.join(",")})`,
);

// ---------------------------------------------------------------------------
// Test 6: registerAll() batch registration
// ---------------------------------------------------------------------------
console.log("\n--- Test 6: registerAll() batch registration ---");

const reg2 = new ToolRegistry();
reg2.registerAll([
  makeTool("glob"),
  makeTool("grep"),
  makeTool("list_dir"),
]);

assert(reg2.count === 3, `Batch registered 3 tools (got ${reg2.count})`);
assert(reg2.has("glob"), "Has 'glob'");
assert(reg2.has("grep"), "Has 'grep'");
assert(reg2.has("list_dir"), "Has 'list_dir'");

// ---------------------------------------------------------------------------
// Test 7: Re-registration overwrites
// ---------------------------------------------------------------------------
console.log("\n--- Test 7: Re-registration overwrites ---");

const reg3 = new ToolRegistry();
reg3.register(makeTool("bash", "ask_user"));

assert(reg3.get("bash")?.permission === "ask_user", "Initially ask_user");

// Re-register with different permission (should warn but succeed)
reg3.register(makeTool("bash", "auto_approve"));

assert(reg3.get("bash")?.permission === "auto_approve", "After re-register: auto_approve");
assert(reg3.count === 1, "Count still 1 (overwrite, not duplicate)");

// ---------------------------------------------------------------------------
// Test 8: clear() removes all tools
// ---------------------------------------------------------------------------
console.log("\n--- Test 8: clear() removes all tools ---");

const reg4 = new ToolRegistry();
reg4.registerAll([makeTool("a"), makeTool("b"), makeTool("c")]);
assert(reg4.count === 3, "3 tools before clear");

reg4.clear();
assert(reg4.count === 0, "0 tools after clear");
assert(reg4.get("a") === undefined, "get('a') returns undefined after clear");

// ---------------------------------------------------------------------------
// Test 9: getApiDefinitions() returns Anthropic format
// ---------------------------------------------------------------------------
console.log("\n--- Test 9: getApiDefinitions() returns Anthropic format ---");

const reg5 = new ToolRegistry();
reg5.registerAll([
  makeTool("bash", "ask_user"),
  makeTool("read_file"),
  makeTool("glob"),
]);

const apiDefs = reg5.getApiDefinitions();

assert(apiDefs.length === 3, `3 API definitions (got ${apiDefs.length})`);

// Verify shape: only name, description, input_schema
for (const def of apiDefs) {
  assert(typeof def.name === "string", `${def.name}: has name (string)`);
  assert(typeof def.description === "string", `${def.name}: has description (string)`);
  assert(def.input_schema.type === "object", `${def.name}: has input_schema with type 'object'`);
  assert("properties" in def.input_schema, `${def.name}: input_schema has properties`);

  // Verify internal fields are NOT present
  const asAny = def as any;
  assert(asAny.execute === undefined, `${def.name}: no 'execute' in API definition`);
  assert(asAny.permission === undefined, `${def.name}: no 'permission' in API definition`);
}

// ---------------------------------------------------------------------------
// Test 10: execute() - successful execution
// ---------------------------------------------------------------------------
console.log("\n--- Test 10: execute() - successful execution ---");

const reg6 = new ToolRegistry();
reg6.register(makeTool("echo", "auto_approve", {
  executeFn: async (input: any) => ({
    type: "text",
    content: `echoed: ${input.value}`,
  }),
}));

const result1 = await reg6.execute("echo", { value: "hello" }, makeContext());
assert(result1.type === "text", "Result type is 'text'");
assert(result1.content === "echoed: hello", `Result content is correct (got '${result1.content}')`);

// ---------------------------------------------------------------------------
// Test 11: execute() - unknown tool returns error
// ---------------------------------------------------------------------------
console.log("\n--- Test 11: execute() - unknown tool returns error ---");

const result2 = await reg6.execute("nonexistent_tool", {}, makeContext());
assert(result2.type === "error", "Unknown tool returns error type");
assert(result2.content.includes("Unknown tool"), `Error mentions 'Unknown tool' (got '${result2.content}')`);
assert(result2.content.includes("nonexistent_tool"), "Error mentions the tool name");

// ---------------------------------------------------------------------------
// Test 12: execute() - abort before start
// ---------------------------------------------------------------------------
console.log("\n--- Test 12: execute() - abort before start ---");

const abortController = new AbortController();
abortController.abort();  // Abort immediately

let toolWasCalled = false;
const reg7 = new ToolRegistry();
reg7.register(makeTool("should_not_run", "auto_approve", {
  executeFn: async () => {
    toolWasCalled = true;
    return { type: "text", content: "should not see this" };
  },
}));

const result3 = await reg7.execute(
  "should_not_run",
  {},
  makeContext({ abort_signal: abortController.signal }),
);

assert(result3.type === "error", "Aborted tool returns error type");
assert(result3.content.includes("interrupted"), "Error mentions interruption");
assert(toolWasCalled === false, "Tool execute function was NOT called");

// ---------------------------------------------------------------------------
// Test 13: execute() - tool throws exception
// ---------------------------------------------------------------------------
console.log("\n--- Test 13: execute() - tool throws exception ---");

const reg8 = new ToolRegistry();
reg8.register(makeTool("exploder", "auto_approve", {
  executeFn: async () => {
    throw new Error("kaboom!");
  },
}));

const result4 = await reg8.execute("exploder", {}, makeContext());
assert(result4.type === "error", "Thrown exception returns error type");
assert(result4.content.includes("kaboom!"), `Error contains exception message (got '${result4.content}')`);
assert(result4.content.includes("Tool execution failed"), "Error has prefix");

// ---------------------------------------------------------------------------
// Test 14: execute() - tool throws non-Error
// ---------------------------------------------------------------------------
console.log("\n--- Test 14: execute() - tool throws non-Error ---");

const reg9 = new ToolRegistry();
reg9.register(makeTool("string_thrower", "auto_approve", {
  executeFn: async () => {
    throw "a string error";
  },
}));

const result5 = await reg9.execute("string_thrower", {}, makeContext());
assert(result5.type === "error", "Non-Error throw returns error type");
assert(result5.content.includes("a string error"), "Error contains the thrown string");

// ---------------------------------------------------------------------------
// Test 15: execute() passes context to tool
// ---------------------------------------------------------------------------
console.log("\n--- Test 15: execute() passes context to tool ---");

let capturedContext: ToolContext | null = null;
const reg10 = new ToolRegistry();
reg10.register(makeTool("context_checker", "auto_approve", {
  executeFn: async (_input: any, ctx: ToolContext) => {
    capturedContext = ctx;
    return { type: "text", content: "ok" };
  },
}));

const ctx = makeContext({ session_id: "my-session" });
await reg10.execute("context_checker", {}, ctx);

assert(capturedContext !== null, "Context was passed to tool");
assert(capturedContext!.session_id === "my-session", "session_id passed correctly");

// ---------------------------------------------------------------------------
// Test 16: Singleton pattern
// ---------------------------------------------------------------------------
console.log("\n--- Test 16: Singleton pattern ---");

resetToolRegistry();  // Start fresh

const singleton1 = getToolRegistry();
const singleton2 = getToolRegistry();
assert(singleton1 === singleton2, "getToolRegistry() returns same instance");

singleton1.register(makeTool("singleton_test"));
assert(singleton2.has("singleton_test"), "Tool registered via ref1 visible via ref2");

// Reset creates a new instance
resetToolRegistry();
const singleton3 = getToolRegistry();
assert(singleton3 !== singleton1, "After reset, getToolRegistry() returns NEW instance");
assert(singleton3.has("singleton_test") === false, "New instance has no tools");
assert(singleton3.count === 0, "New instance count is 0");

// ---------------------------------------------------------------------------
// Test 17: execute() - tool returns ErrorToolResult directly
// ---------------------------------------------------------------------------
console.log("\n--- Test 17: execute() - tool returns ErrorToolResult ---");

const reg11 = new ToolRegistry();
reg11.register(makeTool("graceful_error", "auto_approve", {
  executeFn: async () => ({
    type: "error",
    content: "File not found: /foo/bar",
  }),
}));

const result6 = await reg11.execute("graceful_error", {}, makeContext());
assert(result6.type === "error", "Graceful error returns error type");
assert(result6.content === "File not found: /foo/bar", "Error content preserved as-is");

// ---------------------------------------------------------------------------
// Test 18: getApiDefinitions() preserves schema details
// ---------------------------------------------------------------------------
console.log("\n--- Test 18: getApiDefinitions() preserves schema details ---");

const reg12 = new ToolRegistry();
reg12.register({
  name: "complex_tool",
  description: "A tool with complex schema",
  input_schema: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command" },
      timeout: { type: "integer", description: "Timeout in ms", default: 5000 },
      verbose: { type: "boolean", description: "Verbose output" },
    },
    required: ["command"],
  },
  permission: "ask_user",
  execute: async () => ({ type: "text", content: "done" }),
});

const [apiDef] = reg12.getApiDefinitions();
assert(apiDef.name === "complex_tool", "API def name preserved");
assert(apiDef.description === "A tool with complex schema", "API def description preserved");
assert(Object.keys(apiDef.input_schema.properties).length === 3, "All 3 properties preserved");
assert(apiDef.input_schema.required?.length === 1, "Required array preserved");
assert(apiDef.input_schema.required?.[0] === "command", "Required field is 'command'");
assert(apiDef.input_schema.properties.timeout.default === 5000, "Default value preserved");
assert(apiDef.input_schema.properties.timeout.type === "integer", "Integer type preserved");

// ---------------------------------------------------------------------------
// Test 19: registerExtension() records ownership metadata
// ---------------------------------------------------------------------------
console.log("\n--- Test 19: registerExtension() records ownership metadata ---");

const reg13 = new ToolRegistry();
reg13.registerExtension(
  {
    id: "test.extension",
    version: "0.1.0",
    displayName: "Test Extension",
    capabilities: ["test"],
    surfaces: ["agent"],
    tools: [
      {
        name: "extension_echo",
        description: "Extension echo",
        input_schema: makeTool("extension_echo").input_schema,
        permission: "auto_approve",
        capabilities: ["test.echo"],
        surfaces: ["tool.invoke"],
      },
    ],
  },
  [makeTool("extension_echo")],
);

assert(reg13.has("extension_echo"), "Extension tool is registered");
assert(reg13.getExtension("test.extension")?.displayName === "Test Extension", "Extension manifest is stored");

const metadata = reg13.getMetadata("extension_echo");
assert(metadata?.extensionId === "test.extension", "Tool metadata records extension id");
assert(metadata?.capabilities?.join(",") === "test,test.echo", "Tool metadata merges capabilities");
assert(metadata?.surfaces?.join(",") === "agent,tool.invoke", "Tool metadata merges surfaces");

// ---------------------------------------------------------------------------
// Test 20: surface and manifest projections
// ---------------------------------------------------------------------------
console.log("\n--- Test 20: surface and manifest projections ---");

const toolInvokeTools = reg13.getToolsBySurface("tool.invoke");
assert(toolInvokeTools.length === 1, `One tool.invoke tool (got ${toolInvokeTools.length})`);
assert(toolInvokeTools[0]?.name === "extension_echo", "tool.invoke projection returns extension_echo");

const projectedManifests = reg13.getManifestProjection("tool.invoke");
assert(projectedManifests.length === 1, `One projected manifest (got ${projectedManifests.length})`);
assert(projectedManifests[0]?.id === "test.extension", "Manifest projection returns test.extension");

// ---------------------------------------------------------------------------
// Test 21: unregisterExtension() removes owned tools
// ---------------------------------------------------------------------------
console.log("\n--- Test 21: unregisterExtension() removes owned tools ---");

const removedExtension = reg13.unregisterExtension("test.extension");
assert(removedExtension === true, "unregisterExtension() returns true for existing extension");
assert(reg13.has("extension_echo") === false, "Extension tool is removed");
assert(reg13.getMetadata("extension_echo") === undefined, "Extension tool metadata is removed");
assert(reg13.getExtension("test.extension") === undefined, "Extension manifest is removed");

// ---------------------------------------------------------------------------
// Test 22: standalone re-registration detaches previous extension owner
// ---------------------------------------------------------------------------
console.log("\n--- Test 22: standalone re-registration detaches previous owner ---");

const reg14 = new ToolRegistry();
reg14.registerExtension(
  {
    id: "test.owner",
    version: "0.1.0",
    displayName: "Test Owner",
    tools: [
      {
        name: "owned_tool",
        description: "Owned tool",
        input_schema: makeTool("owned_tool").input_schema,
        permission: "auto_approve",
        surfaces: ["agent"],
      },
    ],
  },
  [makeTool("owned_tool")],
);
reg14.register(makeTool("owned_tool", "ask_user"));

assert(reg14.get("owned_tool")?.permission === "ask_user", "Standalone tool overwrites extension tool");
assert(reg14.getMetadata("owned_tool") === undefined, "Standalone overwrite clears extension metadata");
assert(reg14.unregisterExtension("test.owner") === true, "Previous extension can still be unregistered");
assert(reg14.has("owned_tool"), "Standalone overwrite survives previous owner uninstall");

// ---------------------------------------------------------------------------
// Test 23: extension-to-extension overwrite removes stale surface projection
// ---------------------------------------------------------------------------
console.log("\n--- Test 23: extension overwrite removes stale projection ---");

const reg16 = new ToolRegistry();
reg16.registerExtension(
  {
    id: "test.old-owner",
    version: "0.1.0",
    displayName: "Old Owner",
    surfaces: ["tool.invoke"],
    tools: [
      {
        name: "shared_tool",
        description: "Shared tool",
        input_schema: makeTool("shared_tool").input_schema,
        permission: "auto_approve",
        surfaces: ["tool.invoke"],
      },
    ],
  },
  [makeTool("shared_tool")],
);

reg16.registerExtension(
  {
    id: "test.new-owner",
    version: "0.1.0",
    displayName: "New Owner",
    surfaces: ["gemini.live"],
    tools: [
      {
        name: "shared_tool",
        description: "Shared tool replacement",
        input_schema: makeTool("shared_tool").input_schema,
        permission: "ask_user",
        surfaces: ["gemini.live"],
      },
    ],
  },
  [makeTool("shared_tool", "ask_user")],
);

assert(reg16.getMetadata("shared_tool")?.extensionId === "test.new-owner", "New extension owns overwritten tool");
assert(reg16.get("shared_tool")?.permission === "ask_user", "Overwritten tool implementation is active");

const oldProjection = reg16.getManifestProjection("tool.invoke").map((manifest) => manifest.id);
assert(!oldProjection.includes("test.old-owner"), "Old owner no longer appears in stale tool.invoke projection");

const newProjection = reg16.getManifestProjection("gemini.live").map((manifest) => manifest.id);
assert(newProjection.includes("test.new-owner"), "New owner appears in gemini.live projection");

assert(reg16.unregisterExtension("test.old-owner") === true, "Old owner can still be unregistered");
assert(reg16.has("shared_tool"), "Unregistering old owner does not remove new owner's tool");

// ---------------------------------------------------------------------------
// Test 24: built-in tools register through bundled extension manifest
// ---------------------------------------------------------------------------
console.log("\n--- Test 24: built-in tools use bundled extension manifest ---");

const reg15 = new ToolRegistry();
registerBuiltinTools(reg15);

assert(reg15.getExtension(builtinToolsExtensionManifest.id)?.id === builtinToolsExtensionManifest.id, "Built-in extension manifest is stored");
assert(reg15.count === builtinToolsExtensionManifest.tools?.length, `Built-in tool count matches manifest (got ${reg15.count})`);
assert(reg15.getMetadata("bash")?.extensionId === builtinToolsExtensionManifest.id, "Built-in bash tool has extension owner");
assert(reg15.getToolsBySurface("agent").length === reg15.count, "All built-in tools are exposed on agent surface");

const builtinApiDef = reg15.getApiDefinitions().find((def) => def.name === "bash") as any;
assert(builtinApiDef !== undefined, "Built-in bash API definition exists");
assert(builtinApiDef.extensionId === undefined, "Built-in API definition does not expose extension metadata");

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${"=".repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"=".repeat(60)}`);

if (failed > 0) {
  process.exit(1);
}
