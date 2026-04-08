// =============================================================================
// Agent Tool
//
// Spawns a child agent for delegated work. Two modes:
//   - Sync (default): parent waits for child result
//   - Async (run_in_background=true): fire-and-forget, result on next turn
//
// Child gets parent's conversation history (fork-style) + delegation prompt.
// Runs in headless mode — tools requiring permission are denied.
// Sub-agents cannot re-fork (detected via FORK_GUARD_MARKER).
//
// Sync: runs inside parent's tool executor (no lane involvement)
// Async: detached Promise in gateway event loop (no lane, free-floating I/O)
// =============================================================================

import type {
  ToolDefinition,
  ToolContext,
  ToolResult,
  ChatMessage,
  HawkyConfig,
} from "../agent/types.js";
import type { LLMProvider } from "../agent/provider.js";
import type { ToolRegistry } from "./registry.js";
import { AgentLoop } from "../agent/loop.js";
import { createSubsystemLogger } from "../logging/index.js";
import { getPrompt } from "../prompts/index.js";

const log = createSubsystemLogger("tools/agent");

const MAX_TURNS_PER_AGENT = 25;

// -----------------------------------------------------------------------------
// Background agent tracking
// -----------------------------------------------------------------------------

export interface BackgroundAgentInfo {
  id: string;
  description: string;
  startedAt: number;
  status: "running" | "completed" | "failed";
  result?: string;
  error?: string;
  durationMs?: number;
}

// Per-session background agent tracking to prevent cross-session data leaks
const backgroundAgentsBySession = new Map<string, Map<string, BackgroundAgentInfo>>();
let nextAgentId = 1;

function generateAgentId(): string {
  return `agent_${nextAgentId++}`;
}

function getSessionAgents(sessionKey: string): Map<string, BackgroundAgentInfo> {
  let agents = backgroundAgentsBySession.get(sessionKey);
  if (!agents) {
    agents = new Map();
    backgroundAgentsBySession.set(sessionKey, agents);
  }
  return agents;
}

/** Peek at completed background agents without removing them. */
export function peekCompletedAgents(sessionKey: string): BackgroundAgentInfo[] {
  const agents = backgroundAgentsBySession.get(sessionKey);
  if (!agents) return [];
  const completed: BackgroundAgentInfo[] = [];
  for (const agent of agents.values()) {
    if (agent.status !== "running") {
      completed.push(agent);
    }
  }
  return completed;
}

/** Drain completed background agents for a specific session (removes them). */
export function drainCompletedAgents(sessionKey?: string): BackgroundAgentInfo[] {
  const completed: BackgroundAgentInfo[] = [];
  if (sessionKey) {
    const agents = backgroundAgentsBySession.get(sessionKey);
    if (agents) {
      for (const [id, agent] of agents) {
        if (agent.status !== "running") {
          completed.push(agent);
          agents.delete(id);
        }
      }
    }
  } else {
    // Drain all sessions (for testing/cleanup)
    for (const agents of backgroundAgentsBySession.values()) {
      for (const [id, agent] of agents) {
        if (agent.status !== "running") {
          completed.push(agent);
          agents.delete(id);
        }
      }
    }
  }
  return completed;
}

/** Get all background agent states across all sessions (for status display). */
export function getBackgroundAgentStates(): BackgroundAgentInfo[] {
  const all: BackgroundAgentInfo[] = [];
  for (const agents of backgroundAgentsBySession.values()) {
    all.push(...agents.values());
  }
  return all;
}

// -----------------------------------------------------------------------------
// Tool input
// -----------------------------------------------------------------------------

interface AgentToolInput {
  prompt: string;
  description?: string;
  run_in_background?: boolean;
}

// -----------------------------------------------------------------------------
// Build delegation prompt
// -----------------------------------------------------------------------------

function buildDelegationPrompt(prompt: string, description?: string): string {
  // Fixed header lives in the prompt registry (#512); the trailing blank line is
  // part of the template so concatenation stays byte-identical.
  const lines: string[] = getPrompt("subagent.delegation").split("\n");
  if (description) {
    lines.push(`Task: ${description}`);
    lines.push("");
  }
  lines.push(prompt);
  return lines.join("\n");
}

// -----------------------------------------------------------------------------
// Execute
// -----------------------------------------------------------------------------

async function execute(input: AgentToolInput, context: ToolContext): Promise<ToolResult> {
  const { prompt, description } = input;
  let { run_in_background } = input;

  if (!prompt || prompt.trim().length === 0) {
    return { type: "error", content: "Prompt cannot be empty" };
  }

  // Prevent re-forking
  if (context.session_id.startsWith("subagent:")) {
    return {
      type: "error",
      content: "Cannot spawn sub-agents from within a sub-agent. Complete the task directly.",
    };
  }

  // Non-interactive lanes (cron, heartbeat) have no subsequent user
  // turn driven through chat.send to pick up the background agent's
  // result. Scheduler-driven turns go through triggerAgentTurn, which
  // never calls drainCompletedAgents. Running async would leak a
  // BackgroundAgentInfo record into backgroundAgentsBySession[<key>]
  // indefinitely and — if the session is LRU-evicted while the child
  // is still working — strand the sub-agent outright. Downgrade to
  // sync. Parallel fan-out is still supported via multiple parallel
  // tool_use blocks in one turn (executeTools awaits them via
  // Promise.all), which is the kind of parallelism these lanes can
  // actually benefit from.
  const isNonInteractiveLane =
    context.session_id.startsWith("cron:") ||
    context.session_id.startsWith("heartbeat:");
  if (run_in_background && isNonInteractiveLane) {
    log.info("downgrading run_in_background to sync for non-interactive lane", {
      sessionKey: context.session_id,
      description,
    });
    run_in_background = false;
  }

  // Access parent internals via extended context
  const provider = (context as any)._provider as LLMProvider | undefined;
  const registry = (context as any)._registry as ToolRegistry | undefined;
  const config = (context as any)._config as HawkyConfig | undefined;
  const parentLoop = (context as any)._agentLoop as AgentLoop | undefined;

  if (!provider || !registry || !config) {
    return {
      type: "error",
      content: "Sub-agent requires provider, registry, and config. This is an internal error.",
    };
  }

  const parentHistory = parentLoop?.getHistory() ?? [];
  const delegationPrompt = buildDelegationPrompt(prompt, description);
  const descLabel = description ?? prompt.slice(0, 60);
  const agentId = generateAgentId();

  // Keep the agent tool in the child's registry (Claude Code pattern).
  // Fork guard rejects at call time with a clear error message.
  // Removing it causes "Unknown tool" errors that confuse the LLM into retrying.

  // Create child AgentLoop
  const childLoop = new AgentLoop({
    provider,
    registry,
    config: { ...config, max_iterations: MAX_TURNS_PER_AGENT },
    working_directory: context.working_directory,
    permissionResolver: undefined, // headless — tools requiring permission are denied
    session_key: `subagent:${context.session_id}:${agentId}`,
  });

  // Inject full parent history as context (fork-style, same as Claude Code).
  // Drop the last assistant message if it has a pending tool_use — the matching
  // tool_result hasn't been appended yet and would cause an API validation error.
  if (parentHistory.length > 0) {
    const historyForChild = [...parentHistory];
    const lastMsg = historyForChild[historyForChild.length - 1];
    if (lastMsg && lastMsg.role === "assistant") {
      const hasToolUse = lastMsg.content.some((b) => b.type === "tool_use");
      if (hasToolUse) {
        historyForChild.pop();
      }
    }
    childLoop.setHistory(historyForChild);
  }

  // Collect final text from child
  let resultText = "";
  childLoop.subscribe((event) => {
    if (event.type === "text") {
      resultText = event.replace ? event.content : resultText + event.content;
    }
  });

  // ---------------------------------------------------------------------------
  // Async path: fire-and-forget
  // ---------------------------------------------------------------------------
  if (run_in_background) {
    const bgAgent: BackgroundAgentInfo = {
      id: agentId,
      description: descLabel,
      startedAt: Date.now(),
      status: "running",
    };
    getSessionAgents(context.session_id).set(agentId, bgAgent);

    // Broadcast function for completion notifications (if available)
    const broadcast = (context as any)._broadcastToSession as
      ((sessionKey: string, event: string, payload: unknown) => void) | undefined;

    void childLoop.sendMessage(delegationPrompt, { headless: true }).then(() => {
      bgAgent.status = "completed";
      bgAgent.result = resultText || "(no output)";
      bgAgent.durationMs = Date.now() - bgAgent.startedAt;
      log.info("background agent completed", { agentId, durationMs: bgAgent.durationMs });
      // Notify TUI/web immediately so user sees completion
      broadcast?.(context.session_id, "agent.system_message", {
        type: "system_message",
        content: `Background agent ${agentId} (${descLabel}) completed in ${Math.round(bgAgent.durationMs / 1000)}s. Send a message to see the result.`,
        subtype: "info",
      });
    }).catch((err) => {
      bgAgent.status = "failed";
      bgAgent.error = err instanceof Error ? err.message : String(err);
      bgAgent.durationMs = Date.now() - bgAgent.startedAt;
      log.warn("background agent failed", { agentId, error: bgAgent.error });
      broadcast?.(context.session_id, "agent.system_message", {
        type: "system_message",
        content: `Background agent ${agentId} (${descLabel}) failed: ${bgAgent.error}`,
        subtype: "info",
      });
    });

    log.info("background agent launched", { agentId, description: descLabel });

    return {
      type: "text",
      content: `Background agent launched (${agentId}): ${descLabel}\nYou'll be notified when it completes. Continue with your current task.`,
      metadata: { agentId, status: "launched", description: descLabel },
    };
  }

  // ---------------------------------------------------------------------------
  // Sync path: await result
  // ---------------------------------------------------------------------------
  log.info("sync sub-agent starting", { agentId, description: descLabel });
  const startTime = Date.now();

  try {
    await childLoop.sendMessage(delegationPrompt, { headless: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { type: "error", content: `Sub-agent failed: ${msg}` };
  }

  const durationMs = Date.now() - startTime;
  log.info("sync sub-agent completed", { agentId, durationMs });

  return {
    type: "text",
    content: resultText || "(no output from sub-agent)",
    metadata: { agentId, durationMs, type: "subagent" },
  };
}

// -----------------------------------------------------------------------------
// Tool definition
// -----------------------------------------------------------------------------

export const agentToolDefinition: ToolDefinition<AgentToolInput> = {
  name: "agent",
  description:
    "Launch a sub-agent to handle a task. The sub-agent has access to all your tools " +
    "and sees the full conversation context.\n\n" +
    "Sync (default): you wait for the result — use when you need the output to continue.\n" +
    "Async (run_in_background=true): agent runs independently — use when you can continue without the result.\n\n" +
    "Examples:\n" +
    "- Sync: 'Summarize the test results' (need answer before responding)\n" +
    "- Async: 'Research the API docs while I fix this bug' (can work in parallel)",
  input_schema: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description: "The task for the sub-agent. Be specific.",
      },
      description: {
        type: "string",
        description: "Short (3-5 word) label for status display.",
      },
      run_in_background: {
        type: "boolean",
        description: "Run in background (fire-and-forget). Default: false.",
      },
    },
    required: ["prompt"],
  },
  permission: "auto_approve",
  execute: execute as any,
};
