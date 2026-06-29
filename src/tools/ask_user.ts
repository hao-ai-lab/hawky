// =============================================================================
// Ask User Tool
//
// Presents a question to the user and waits for their response. Supports
// free-form text input, single-select, and multi-select options.
//
// The tool emits an AskUserRequestEvent and blocks until the UI layer
// delivers an AskUserResponseEvent via resolveAskUser(). The agent loop
// stays in the same turn while waiting, preserving context.
// =============================================================================

import type {
  ToolDefinition,
  ToolContext,
  ToolResult,
  AskUserRequestEvent,
  AskUserResponseEvent,
  StreamEvent,
} from "../agent/types.js";

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const SOMETHING_ELSE_OPTION = "Something else (type your answer)";

// -----------------------------------------------------------------------------
// Input type
// -----------------------------------------------------------------------------

interface AskUserInput {
  question: string;
  options?: string[];
  multi_select?: boolean;
}

// -----------------------------------------------------------------------------
// Pending request registry
//
// When the tool emits a question, it stores a Promise resolver here.
// The agent loop or UI calls resolveAskUser() to deliver the answer.
// -----------------------------------------------------------------------------

/**
 * Pending state for ask_user requests, keyed by requestId. Beyond the
 * resolver pair, we record sessionKey + dialog payload so that a late-
 * joining client (a second browser tab opened AFTER the question was
 * broadcast, the iPhone after a screen-on, a TUI re-attaching) can ask
 * the gateway "is anything pending in session X?" via the extended
 * `session.currentTurn` RPC and render the dialog without having
 * received the original broadcast event.
 */
interface PendingAskUserState {
  resolve: (answer: string[]) => void;
  reject: (err: Error) => void;
  sessionKey: string;
  question: string;
  /** Options as displayed (after dedup + "Something else" auto-add). */
  options: string[];
  multi_select: boolean;
}

const pendingRequests = new Map<string, PendingAskUserState>();

/**
 * Deliver the user's response to a pending ask_user request.
 * Called by the agent loop or UI layer when the user answers.
 */
export function resolveAskUser(requestId: string, selected: string[]): void {
  const pending = pendingRequests.get(requestId);
  if (pending) {
    pendingRequests.delete(requestId);
    pending.resolve(selected);
  }
}

/**
 * Reject a pending ask_user request (e.g., on abort/cancel).
 */
export function rejectAskUser(requestId: string, reason: string): void {
  const pending = pendingRequests.get(requestId);
  if (pending) {
    pendingRequests.delete(requestId);
    pending.reject(new Error(reason));
  }
}

/**
 * Check if there's a pending request (useful for testing).
 */
export function hasPendingAskUser(requestId: string): boolean {
  return pendingRequests.has(requestId);
}

/**
 * Look up the pending ask_user request for a given session, if any.
 * Used by `session.currentTurn` so a late-joining client can hydrate
 * its `pendingAskUser` state and render the dialog without having
 * received the original broadcast.
 *
 * If the agent loop ever supports multiple parallel ask_user calls in
 * the same session (it doesn't today — only one tool runs at a time),
 * this returns the FIRST one found.
 */
export function getPendingAskUserForSession(
  sessionKey: string,
): { requestId: string; question: string; options: string[]; multi_select: boolean } | null {
  for (const [requestId, p] of pendingRequests) {
    if (p.sessionKey === sessionKey) {
      return {
        requestId,
        question: p.question,
        options: p.options,
        multi_select: p.multi_select,
      };
    }
  }
  return null;
}

/**
 * Clear all pending requests (for testing cleanup).
 */
export function clearPendingAskUser(): void {
  for (const [id, pending] of pendingRequests) {
    pending.reject(new Error("Cleared"));
  }
  pendingRequests.clear();
}

// -----------------------------------------------------------------------------
// ID generation
// -----------------------------------------------------------------------------

let requestCounter = 0;

function generateRequestId(): string {
  return `ask_${Date.now()}_${++requestCounter}`;
}

// -----------------------------------------------------------------------------
// Core logic (exported for testing)
// -----------------------------------------------------------------------------

export async function executeAskUser(
  input: AskUserInput,
  context: ToolContext,
): Promise<ToolResult> {
  try {
    return await executeAskUserInner(input, context);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "Cleared") {
      return { type: "error", content: "Question cancelled." };
    }
    return { type: "error", content: `ask_user failed: ${msg}` };
  }
}

async function executeAskUserInner(
  input: AskUserInput,
  context: ToolContext,
): Promise<ToolResult> {
  const { question, options, multi_select } = input;

  // --- Pre-abort check ---
  if (context.abort_signal.aborted) {
    return { type: "error", content: "Question cancelled: operation was aborted." };
  }

  // --- Validate ---
  const trimmedQuestion = typeof question === "string" ? question.trim() : "";
  if (!trimmedQuestion) {
    return { type: "error", content: "Missing required parameter: question" };
  }

  // --- Build display options ---
  const isMultiSelect = multi_select === true;
  let displayOptions: string[] = [];

  if (options && Array.isArray(options) && options.length > 0) {
    // Filter out empty/non-string, deduplicate
    displayOptions = [...new Set(options.filter(o => typeof o === "string" && o.trim()))];
    // Auto-add "Something else" escape hatch (only if there are real options)
    if (displayOptions.length > 0 && !displayOptions.includes(SOMETHING_ELSE_OPTION)) {
      displayOptions.push(SOMETHING_ELSE_OPTION);
    }
  }

  // --- Create request and emit event ---
  const requestId = generateRequestId();

  const event: AskUserRequestEvent = {
    type: "ask_user_request",
    id: requestId,
    tool_use_id: "", // Will be set by agent loop; tool doesn't know its own tool_use_id
    question: trimmedQuestion,
    options: displayOptions,
    multi_select: isMultiSelect,
  };

  // Create the Promise that blocks until the user responds
  const responsePromise = new Promise<string[]>((resolve, reject) => {
    pendingRequests.set(requestId, {
      resolve,
      reject,
      sessionKey: context.session_id,
      question: trimmedQuestion,
      options: displayOptions,
      multi_select: isMultiSelect,
    });
  });

  // Wire abort signal to reject the pending request
  const onAbort = () => rejectAskUser(requestId, "Question cancelled by user.");
  if (context.abort_signal.aborted) {
    pendingRequests.delete(requestId);
    return { type: "error", content: "Question cancelled: operation was aborted." };
  }
  context.abort_signal.addEventListener("abort", onAbort, { once: true });

  // Emit the question event
  try {
    context.emit(event);
  } catch (err) {
    pendingRequests.delete(requestId);
    context.abort_signal.removeEventListener("abort", onAbort);
    throw err;
  }

  // --- Wait for user response ---
  let selected: string[];
  try {
    selected = await responsePromise;
  } finally {
    context.abort_signal.removeEventListener("abort", onAbort);
  }

  // --- Format result ---
  if (selected.length === 0) {
    return { type: "text", content: "(No answer provided)" };
  }

  const answer = selected.length === 1
    ? selected[0]
    : selected.map((s, i) => `${i + 1}. ${s}`).join("\n");

  return {
    type: "text",
    content: answer,
    metadata: {
      request_id: requestId,
      selected,
      had_options: displayOptions.length > 0,
      multi_select: isMultiSelect,
    },
  };
}

// -----------------------------------------------------------------------------
// Tool Definition
// -----------------------------------------------------------------------------

export const askUserToolDefinition: ToolDefinition<AskUserInput> = {
  name: "ask_user",
  description:
    "Ask the user a question and wait for their response. Use this when you need " +
    "clarification, confirmation, or the user's choice between options. " +
    "Without options, the user can type a free-form answer. " +
    'With options, the user picks from the list (a "Something else" option is auto-added). ' +
    "Set multi_select=true to allow picking multiple options.",
  input_schema: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description: "The question to ask the user.",
      },
      options: {
        type: "array",
        description: "Optional list of choices. If omitted, user types a free-form answer.",
        items: { type: "string", description: "An option label." },
      },
      multi_select: {
        type: "boolean",
        description: "If true, user can select multiple options. Default: false.",
      },
    },
    required: ["question"],
  },
  permission: "auto_approve",
  execute: executeAskUser as any,
};
