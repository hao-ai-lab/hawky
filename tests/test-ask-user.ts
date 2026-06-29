// =============================================================================
// Tests for ask_user tool
//
// Tests use the resolveAskUser() API to simulate user responses, just like
// the agent loop or UI layer would in production.
// =============================================================================

import { afterEach, describe, expect, test } from "bun:test";
import {
  executeAskUser,
  askUserToolDefinition,
  resolveAskUser,
  rejectAskUser,
  hasPendingAskUser,
  clearPendingAskUser,
  getPendingAskUserForSession,
} from "../src/tools/ask_user.js";
import { getToolRegistry, resetToolRegistry } from "../src/tools/registry.js";
import type {
  ToolContext,
  ToolResult,
  StreamEvent,
  AskUserRequestEvent,
} from "../src/agent/types.js";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

afterEach(() => {
  clearPendingAskUser();
  resetToolRegistry();
});

function ctx(overrides?: Partial<ToolContext>): ToolContext {
  return {
    session_id: "s",
    working_directory: "/tmp",
    abort_signal: new AbortController().signal,
    emit: () => {},
    ...overrides,
  };
}

/**
 * Run ask_user and auto-respond when the event is emitted.
 * Returns both the tool result and the emitted event.
 */
async function askAndRespond(
  input: { question: string; options?: string[]; multi_select?: boolean },
  response: string[],
  overrides?: Partial<ToolContext>,
): Promise<{ result: ToolResult; event: AskUserRequestEvent }> {
  let emittedEvent: AskUserRequestEvent | null = null;

  const context = ctx({
    emit: (evt: StreamEvent) => {
      if (evt.type === "ask_user_request") {
        emittedEvent = evt;
        // Simulate user responding after a microtask
        queueMicrotask(() => resolveAskUser(evt.id, response));
      }
    },
    ...overrides,
  });

  const result = await executeAskUser(input, context);
  return { result, event: emittedEvent! };
}

// =============================================================================
// Input validation
// =============================================================================

describe("Input validation", () => {
  test("empty question returns error", async () => {
    const { result } = await askAndRespond({ question: "" }, []);
    expect(result.type).toBe("error");
    expect(result.content).toContain("Missing required parameter: question");
  });

  test("whitespace-only question returns error", async () => {
    const { result } = await askAndRespond({ question: "   " }, []);
    expect(result.type).toBe("error");
    expect(result.content).toContain("Missing required parameter: question");
  });

  test("pre-aborted signal returns error without emitting", async () => {
    const controller = new AbortController();
    controller.abort();
    let emitted = false;
    const result = await executeAskUser(
      { question: "test?" },
      ctx({ abort_signal: controller.signal, emit: () => { emitted = true; } }),
    );
    expect(result.type).toBe("error");
    expect(result.content).toContain("aborted");
    expect(emitted).toBe(false);
  });
});

// =============================================================================
// Free-form questions (no options)
// =============================================================================

describe("Free-form questions", () => {
  test("emits event with empty options for free-form question", async () => {
    const { result, event } = await askAndRespond(
      { question: "What is your name?" },
      ["Alice"],
    );
    expect(result.type).toBe("text");
    expect(result.content).toBe("Alice");
    expect(event.question).toBe("What is your name?");
    expect(event.options).toEqual([]);
    expect(event.multi_select).toBe(false);
  });

  test("question is trimmed", async () => {
    const { event } = await askAndRespond(
      { question: "  trimmed question?  " },
      ["yes"],
    );
    expect(event.question).toBe("trimmed question?");
  });

  test("empty response returns no-answer message", async () => {
    const { result } = await askAndRespond(
      { question: "Anything?" },
      [],
    );
    expect(result.type).toBe("text");
    expect(result.content).toBe("(No answer provided)");
  });
});

// =============================================================================
// Single-select with options
// =============================================================================

describe("Single-select options", () => {
  test("options are passed through with auto-added Something else", async () => {
    const { result, event } = await askAndRespond(
      { question: "Pick a color:", options: ["Red", "Blue", "Green"] },
      ["Blue"],
    );
    expect(result.type).toBe("text");
    expect(result.content).toBe("Blue");
    expect(event.options).toEqual(["Red", "Blue", "Green", "Something else (type your answer)"]);
    expect(event.multi_select).toBe(false);
  });

  test("Something else is not duplicated if already in options", async () => {
    const { event } = await askAndRespond(
      { question: "Pick:", options: ["A", "Something else (type your answer)"] },
      ["A"],
    );
    expect(event.options).toEqual(["A", "Something else (type your answer)"]);
  });

  test("empty strings in options are filtered out", async () => {
    const { event } = await askAndRespond(
      { question: "Pick:", options: ["A", "", "  ", "B"] },
      ["A"],
    );
    expect(event.options).toEqual(["A", "B", "Something else (type your answer)"]);
  });

  test("duplicate options are deduplicated", async () => {
    const { event } = await askAndRespond(
      { question: "Pick:", options: ["A", "B", "A", "B"] },
      ["A"],
    );
    expect(event.options).toEqual(["A", "B", "Something else (type your answer)"]);
  });

  test("user selects Something else and types custom answer", async () => {
    const { result } = await askAndRespond(
      { question: "Pick a framework:", options: ["React", "Vue"] },
      ["Svelte"],
    );
    expect(result.type).toBe("text");
    expect(result.content).toBe("Svelte");
  });
});

// =============================================================================
// Multi-select
// =============================================================================

describe("Multi-select options", () => {
  test("multi_select flag is passed to event", async () => {
    const { event } = await askAndRespond(
      { question: "Pick languages:", options: ["TypeScript", "Python", "Rust"], multi_select: true },
      ["TypeScript", "Rust"],
    );
    expect(event.multi_select).toBe(true);
  });

  test("multiple selections formatted as numbered list", async () => {
    const { result } = await askAndRespond(
      { question: "Pick languages:", options: ["TS", "PY", "RS"], multi_select: true },
      ["TS", "RS"],
    );
    expect(result.type).toBe("text");
    expect(result.content).toBe("1. TS\n2. RS");
  });

  test("single selection in multi_select mode returns plain text", async () => {
    const { result } = await askAndRespond(
      { question: "Pick:", options: ["A", "B"], multi_select: true },
      ["A"],
    );
    expect(result.type).toBe("text");
    expect(result.content).toBe("A");
  });

  test("multi_select defaults to false", async () => {
    const { event } = await askAndRespond(
      { question: "Pick:", options: ["A"] },
      ["A"],
    );
    expect(event.multi_select).toBe(false);
  });
});

// =============================================================================
// Metadata
// =============================================================================

describe("Result metadata", () => {
  test("result includes metadata for option-based question", async () => {
    const { result } = await askAndRespond(
      { question: "Pick:", options: ["A", "B"], multi_select: true },
      ["A", "B"],
    );
    const m = (result as any).metadata;
    expect(m).toBeDefined();
    expect(m.selected).toEqual(["A", "B"]);
    expect(m.had_options).toBe(true);
    expect(m.multi_select).toBe(true);
    expect(typeof m.request_id).toBe("string");
  });

  test("result includes metadata for free-form question", async () => {
    const { result } = await askAndRespond(
      { question: "Name?" },
      ["Bob"],
    );
    const m = (result as any).metadata;
    expect(m.had_options).toBe(false);
    expect(m.multi_select).toBe(false);
    expect(m.selected).toEqual(["Bob"]);
  });
});

// =============================================================================
// Pending request lifecycle
// =============================================================================

describe("Pending request lifecycle", () => {
  test("request is pending until resolved", async () => {
    let capturedId = "";
    const context = ctx({
      emit: (evt: StreamEvent) => {
        if (evt.type === "ask_user_request") {
          capturedId = evt.id;
        }
      },
    });

    const promise = executeAskUser({ question: "test?" }, context);

    // Should be pending
    expect(hasPendingAskUser(capturedId)).toBe(true);

    // Resolve it
    resolveAskUser(capturedId, ["answer"]);
    const result = await promise;

    // Should no longer be pending
    expect(hasPendingAskUser(capturedId)).toBe(false);
    expect(result.type).toBe("text");
    expect(result.content).toBe("answer");
  });

  test("resolveAskUser with unknown id is a no-op", () => {
    // Should not throw
    resolveAskUser("nonexistent", ["test"]);
  });

  test("rejectAskUser cancels the pending request", async () => {
    let capturedId = "";
    const context = ctx({
      emit: (evt: StreamEvent) => {
        if (evt.type === "ask_user_request") {
          capturedId = evt.id;
          queueMicrotask(() => rejectAskUser(capturedId, "User cancelled"));
        }
      },
    });

    const result = await executeAskUser({ question: "test?" }, context);
    expect(result.type).toBe("error");
    expect(result.content).toContain("User cancelled");
  });

  test("clearPendingAskUser rejects all pending requests", async () => {
    const promises: Promise<ToolResult>[] = [];

    for (let i = 0; i < 3; i++) {
      const context = ctx({ emit: () => {} });
      promises.push(executeAskUser({ question: `q${i}?` }, context));
    }

    clearPendingAskUser();

    const results = await Promise.all(promises);
    for (const r of results) {
      expect(r.type).toBe("error");
      expect(r.content).toContain("cancelled");
    }
  });
});

// =============================================================================
// Abort signal
// =============================================================================

describe("Abort signal", () => {
  test("abort during wait cancels the question", async () => {
    const controller = new AbortController();
    const context = ctx({
      abort_signal: controller.signal,
      emit: (evt: StreamEvent) => {
        if (evt.type === "ask_user_request") {
          // Abort after question is emitted
          queueMicrotask(() => controller.abort());
        }
      },
    });

    const result = await executeAskUser({ question: "test?" }, context);
    expect(result.type).toBe("error");
    expect(result.content).toContain("cancelled");
  });

  test("abort cleans up pending request", async () => {
    const controller = new AbortController();
    let capturedId = "";
    const context = ctx({
      abort_signal: controller.signal,
      emit: (evt: StreamEvent) => {
        if (evt.type === "ask_user_request") {
          capturedId = evt.id;
          queueMicrotask(() => controller.abort());
        }
      },
    });

    await executeAskUser({ question: "test?" }, context);
    expect(hasPendingAskUser(capturedId)).toBe(false);
  });
});

// =============================================================================
// Event emission
// =============================================================================

describe("Event emission", () => {
  test("emits exactly one ask_user_request event", async () => {
    const events: StreamEvent[] = [];
    const { result } = await askAndRespond(
      { question: "Color?", options: ["Red", "Blue"] },
      ["Red"],
    );

    // askAndRespond captures the event already — let's verify via a separate path
    let count = 0;
    const context = ctx({
      emit: (evt: StreamEvent) => {
        if (evt.type === "ask_user_request") {
          count++;
          resolveAskUser(evt.id, ["ok"]);
        }
      },
    });

    await executeAskUser({ question: "test?" }, context);
    expect(count).toBe(1);
  });

  test("event has correct structure", async () => {
    const { event } = await askAndRespond(
      { question: "Pick:", options: ["A", "B"], multi_select: true },
      ["A"],
    );
    expect(event.type).toBe("ask_user_request");
    expect(typeof event.id).toBe("string");
    expect(event.id.startsWith("ask_")).toBe(true);
    expect(event.question).toBe("Pick:");
    expect(event.options).toContain("A");
    expect(event.options).toContain("B");
    expect(event.multi_select).toBe(true);
  });

  test("emit failure cleans up pending request", async () => {
    let capturedId = "";
    const context = ctx({
      session_id: "session-emit-failure",
      emit: (evt: StreamEvent) => {
        if (evt.type === "ask_user_request") {
          capturedId = evt.id;
        }
        throw new Error("emit failed");
      },
    });

    const result = await executeAskUser({ question: "test?" }, context);
    expect(result.type).toBe("error");
    expect(result.content).toContain("emit failed");
    expect(hasPendingAskUser(capturedId)).toBe(false);
    expect(getPendingAskUserForSession("session-emit-failure")).toBeNull();
  });
});

// =============================================================================
// Tool definition and registry
// =============================================================================

describe("Tool definition and registry", () => {
  test("tool definition has correct shape", () => {
    expect(askUserToolDefinition.name).toBe("ask_user");
    expect(askUserToolDefinition.permission).toBe("auto_approve");
    expect(askUserToolDefinition.input_schema.required).toEqual(["question"]);
    expect(askUserToolDefinition.input_schema.properties.question).toBeDefined();
    expect(askUserToolDefinition.input_schema.properties.options).toBeDefined();
    expect(askUserToolDefinition.input_schema.properties.multi_select).toBeDefined();
  });

  test("permission is auto_approve (asking the user IS the approval)", () => {
    expect(askUserToolDefinition.permission).toBe("auto_approve");
  });

  test("registry integration works", async () => {
    const reg = getToolRegistry();
    reg.register(askUserToolDefinition);

    const context = ctx({
      emit: (evt: StreamEvent) => {
        if (evt.type === "ask_user_request") {
          queueMicrotask(() => resolveAskUser(evt.id, ["registry works"]));
        }
      },
    });

    const r = await reg.execute("ask_user", { question: "test?" }, context);
    expect(r.type).toBe("text");
    expect(r.content).toBe("registry works");
  });
});

// =============================================================================
// Edge cases
// =============================================================================

describe("Edge cases", () => {
  test("options with only empty strings treated as free-form", async () => {
    const { event } = await askAndRespond(
      { question: "Name?", options: ["", "  "] },
      ["Alice"],
    );
    expect(event.options).toEqual([]);
  });

  test("non-array options treated as free-form", async () => {
    const { event } = await askAndRespond(
      { question: "Name?", options: "not an array" as any },
      ["Bob"],
    );
    expect(event.options).toEqual([]);
  });

  test("non-string items in options are filtered", async () => {
    const { event } = await askAndRespond(
      { question: "Pick:", options: ["A", 123 as any, null as any, "B"] },
      ["A"],
    );
    expect(event.options).toEqual(["A", "B", "Something else (type your answer)"]);
  });

  test("top-level catch handles unexpected errors", async () => {
    const bad: any = {
      session_id: "t",
      working_directory: "/tmp",
      emit: () => {},
      get abort_signal(): AbortSignal {
        throw new Error("context exploded");
      },
    };
    const r = await executeAskUser({ question: "test?" }, bad);
    expect(r.type).toBe("error");
    expect(r.content).toContain("context exploded");
  });
});

// =============================================================================
// getPendingAskUserForSession — late-join recovery
// =============================================================================

describe("getPendingAskUserForSession (late-join lookup)", () => {
  test("returns null when nothing is pending for that session", () => {
    expect(getPendingAskUserForSession("s")).toBeNull();
  });

  test("returns the pending payload while a request is open, then null after resolve", async () => {
    // The agent's ask_user broadcast can fire BEFORE a particular client
    // has subscribed (a 2nd browser tab opened later, the iPhone after a
    // screen-on). That client needs to learn what the agent is blocked
    // on so it can render the dialog. session.currentTurn calls this
    // helper to surface the payload; resolving the request must clear
    // it so subsequent late-joins don't see a stale prompt.
    let emitted: AskUserRequestEvent | null = null;
    const context = ctx({
      session_id: "session-late-join",
      emit: (evt) => {
        if (evt.type === "ask_user_request") {
          emitted = evt;
        }
      },
    });
    const promise = executeAskUser(
      { question: "Pick one", options: ["a", "b"], multi_select: false },
      context,
    );

    // Yield so the tool can emit the event and register the pending entry.
    await new Promise((r) => queueMicrotask(() => r(undefined)));
    expect(emitted).not.toBeNull();

    const pending = getPendingAskUserForSession("session-late-join");
    expect(pending).not.toBeNull();
    expect(pending!.requestId).toBe(emitted!.id);
    expect(pending!.question).toBe("Pick one");
    expect(pending!.options).toContain("a");
    expect(pending!.options).toContain("b");
    expect(pending!.multi_select).toBe(false);

    // A different session sees nothing.
    expect(getPendingAskUserForSession("other")).toBeNull();

    // Resolving clears the entry.
    resolveAskUser(emitted!.id, ["a"]);
    await promise;
    expect(getPendingAskUserForSession("session-late-join")).toBeNull();
  });

  test("clears on rejection too (so an aborted turn doesn't leave stale state)", async () => {
    let emitted: AskUserRequestEvent | null = null;
    const context = ctx({
      session_id: "session-abort",
      emit: (evt) => {
        if (evt.type === "ask_user_request") emitted = evt;
      },
    });
    const promise = executeAskUser({ question: "k?" }, context);
    await new Promise((r) => queueMicrotask(() => r(undefined)));
    expect(getPendingAskUserForSession("session-abort")).not.toBeNull();
    rejectAskUser(emitted!.id, "Cancelled");
    await promise;
    expect(getPendingAskUserForSession("session-abort")).toBeNull();
  });
});
