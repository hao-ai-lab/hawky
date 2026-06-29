// =============================================================================
// Bash Tool
//
// Executes shell commands with streaming output, timeout, and cancellation.
// Uses Bun.spawn for process management.
// =============================================================================

import type {
  ToolDefinition,
  ToolContext,
  ToolResult,
} from "../agent/types.js";
import type { NodeRegistry } from "../gateway/node-registry.js";

// Injected node registry for host="node" routing
let _nodeRegistry: NodeRegistry | null = null;

/** Set the node registry reference. Called at gateway startup. */
export function setBashNodeRegistry(registry: NodeRegistry): void {
  _nodeRegistry = registry;
}

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 120_000; // 2 minutes
const MAX_TIMEOUT_MS = 600_000;     // 10 minutes hard cap
const MAX_OUTPUT_CHARS = 30_000;    // 30KB truncation limit
const MAX_OUTPUT_LINES = 1_000;     // 1000 lines truncation limit

// -----------------------------------------------------------------------------
// Input type
// -----------------------------------------------------------------------------

interface BashToolInput {
  command: string;
  timeout_ms?: number;
  description?: string;
  /** Where to execute: "auto" (local gateway, default), "gateway" (force local), "node" (remote node host). */
  host?: "auto" | "gateway" | "node";
  /** Target node name or ID when host="node". Auto-selects if only one node connected. */
  node?: string;
}

// -----------------------------------------------------------------------------
// Core execution function (exported for testing)
// -----------------------------------------------------------------------------

export interface BashExecOptions {
  command: string;
  timeout_ms?: number;
  working_directory: string;
  abort_signal: AbortSignal;
  /** Called for each line of stdout/stderr */
  on_output?: (line: string, stream_type: "stdout" | "stderr") => void;
}

export interface BashExecResult {
  stdout: string;
  stderr: string;
  exit_code: number | null;
  timed_out: boolean;
  truncated: boolean;
}

export async function executeBash(opts: BashExecOptions): Promise<BashExecResult> {
  const timeoutMs = Math.min(
    opts.timeout_ms ?? DEFAULT_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
  );

  // Check abort before spawning
  if (opts.abort_signal.aborted) {
    return {
      stdout: "",
      stderr: "",
      exit_code: null,
      timed_out: false,
      truncated: false,
    };
  }

  const proc = Bun.spawn(["bash", "-c", opts.command], {
    cwd: opts.working_directory,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });

  let timedOut = false;
  let killed = false;

  // Timeout handler
  const timer = setTimeout(() => {
    timedOut = true;
    killed = true;
    proc.kill("SIGTERM");
    // Force kill after 2s grace period
    setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch {}
    }, 2000);
  }, timeoutMs);

  // Abort handler
  const onAbort = () => {
    if (!killed) {
      killed = true;
      proc.kill("SIGTERM");
      setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch {}
      }, 2000);
    }
  };
  opts.abort_signal.addEventListener("abort", onAbort, { once: true });

  // Read stdout and stderr concurrently with line buffering
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  let truncated = false;

  async function readStream(
    stream: ReadableStream<Uint8Array> | null,
    lines: string[],
    streamType: "stdout" | "stderr",
    charCounter: { value: number },
  ) {
    if (!stream) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const text = decoder.decode(value, { stream: true });
        const chunks = (buffer + text).split("\n");
        buffer = chunks.pop() || ""; // Keep incomplete line

        for (const line of chunks) {
          // Check truncation limits
          if (charCounter.value + line.length + 1 > MAX_OUTPUT_CHARS || lines.length >= MAX_OUTPUT_LINES) {
            truncated = true;
            lines.push(`... [output truncated at ${MAX_OUTPUT_CHARS} characters / ${MAX_OUTPUT_LINES} lines]`);
            // Drain remaining without storing
            try { while (!(await reader.read()).done) {} } catch {}
            return;
          }

          lines.push(line);
          charCounter.value += line.length + 1;
          opts.on_output?.(line, streamType);
        }
      }

      // Flush remaining buffer
      if (buffer.length > 0 && !truncated) {
        if (charCounter.value + buffer.length <= MAX_OUTPUT_CHARS && lines.length < MAX_OUTPUT_LINES) {
          lines.push(buffer);
          charCounter.value += buffer.length;
          opts.on_output?.(buffer, streamType);
        } else {
          truncated = true;
          lines.push(`... [output truncated]`);
        }
      }
    } catch (err) {
      // Stream may be destroyed on kill, that's ok
      if (!killed) {
        lines.push(`[stream error: ${err instanceof Error ? err.message : String(err)}]`);
      }
    }
  }

  const stdoutCharCounter = { value: 0 };
  const stderrCharCounter = { value: 0 };

  // Read both streams concurrently, then wait for process exit
  await Promise.all([
    readStream(proc.stdout, stdoutLines, "stdout", stdoutCharCounter),
    readStream(proc.stderr, stderrLines, "stderr", stderrCharCounter),
  ]);

  const exitCode = await proc.exited;

  clearTimeout(timer);
  opts.abort_signal.removeEventListener("abort", onAbort);

  return {
    stdout: stdoutLines.join("\n"),
    stderr: stderrLines.join("\n"),
    exit_code: killed ? null : exitCode,
    timed_out: timedOut,
    truncated,
  };
}

// -----------------------------------------------------------------------------
// Node host execution — route bash command to a remote node
// -----------------------------------------------------------------------------

async function executeOnNode(input: BashToolInput, context: ToolContext): Promise<ToolResult> {
  if (!_nodeRegistry) {
    return { type: "error", content: "Node registry not available. Is the gateway running?" };
  }

  // Check abort before dispatching to node
  if (context.abort_signal.aborted) {
    return { type: "error", content: "Command was interrupted before dispatch" };
  }

  const nodes = _nodeRegistry.listConnected();
  if (nodes.length === 0) {
    return { type: "error", content: "No node hosts connected. Start a node host with: hawky node" };
  }

  // Resolve target node
  let targetNodeId: string | null = null;
  if (input.node) {
    // Match by nodeId first (exact), then by name (case-insensitive)
    const exactId = nodes.find((n) => n.nodeId === input.node);
    if (exactId) {
      targetNodeId = exactId.nodeId;
    } else {
      const lower = input.node.toLowerCase();
      const nameMatches = nodes.filter((n) => n.name.toLowerCase() === lower);
      if (nameMatches.length === 1) {
        targetNodeId = nameMatches[0].nodeId;
      } else if (nameMatches.length > 1) {
        return { type: "error", content: `Multiple nodes with name "${input.node}". Use the node ID instead.` };
      } else {
        return { type: "error", content: `Node "${input.node}" not found. Available: ${nodes.map((n) => n.name).join(", ")}` };
      }
    }
  } else if (nodes.length === 1) {
    targetNodeId = nodes[0].nodeId;
  } else {
    return {
      type: "error",
      content: `Multiple nodes connected. Specify 'node' parameter. Available: ${nodes.map((n) => n.name).join(", ")}`,
    };
  }

  // Invoke system.run on the node — race with abort signal
  const invokePromise = _nodeRegistry.invoke(targetNodeId, "system.run", {
    command: ["bash", "-c", input.command],
    timeoutMs: input.timeout_ms,
  }, input.timeout_ms);

  // Race invoke against abort signal so cancellation takes effect
  // Race invoke against abort signal so the UI unblocks on cancel.
  // NOTE: cancellation is local only — the remote process continues
  // until its timeout. Full end-to-end cancel is tracked as a follow-up.
  const abortPromise = new Promise<{ ok: false; error: string }>((resolve) => {
    if (context.abort_signal.aborted) {
      resolve({ ok: false, error: "Cancelled locally. The remote command may still be running on the node until its timeout." });
      return;
    }
    context.abort_signal.addEventListener("abort", () => {
      resolve({ ok: false, error: "Cancelled locally. The remote command may still be running on the node until its timeout." });
    }, { once: true });
  });

  const result = await Promise.race([invokePromise, abortPromise]);

  if (!result.ok) {
    return { type: "error", content: result.error ?? "Node invoke failed" };
  }

  const payload = result.payload as { stdout?: string; stderr?: string; exitCode?: number; timedOut?: boolean } | undefined;
  if (!payload) {
    return { type: "text", content: "(no output)" };
  }

  // Format output same as local bash
  let output = payload.stdout ?? "";
  if (payload.stderr) {
    output = output ? `${output}\n\nstderr:\n${payload.stderr}` : `stderr:\n${payload.stderr}`;
  }

  const descSuffix = input.description ? ` (${input.description})` : "";
  const nodeName = nodes.find((n) => n.nodeId === targetNodeId)?.name ?? targetNodeId;

  if (payload.timedOut) {
    return { type: "error", content: `Command on node "${nodeName}" timed out${descSuffix}` };
  }

  if (payload.exitCode !== 0) {
    const exitInfo = payload.exitCode != null ? ` (exit code ${payload.exitCode})` : "";
    return {
      type: "error",
      content: `Command on node "${nodeName}"${descSuffix} failed${exitInfo}:\n${output || "(no output)"}`,
      display_content: output || "(no output)",
      metadata: { exit_code: payload.exitCode, node: nodeName },
    };
  }

  return {
    type: "text",
    content: output || "(no output)",
    display_content: output || "(no output)",
    metadata: { exit_code: 0, node: nodeName },
  };
}

// -----------------------------------------------------------------------------
// Tool execute function
// -----------------------------------------------------------------------------

async function execute(input: BashToolInput, context: ToolContext): Promise<ToolResult> {
  const { command, timeout_ms, description, host, node } = input;

  if (!command || command.trim().length === 0) {
    return { type: "error", content: "Command cannot be empty" };
  }

  // Route to node host when host="node"
  if (host === "node") {
    return executeOnNode(input, context);
  }

  const result = await executeBash({
    command,
    timeout_ms,
    working_directory: context.working_directory,
    abort_signal: context.abort_signal,
    on_output: (line, stream_type) => {
      context.emit({
        type: "tool_streaming",
        tool_use_id: "", // Will be filled by the agent loop caller
        stream_type,
        content: line,
      });
    },
  });

  // Format the description suffix
  const descSuffix = description ? ` (${description})` : "";

  if (result.timed_out) {
    return {
      type: "error",
      content: `Command \`${command}\`${descSuffix} timed out after ${timeout_ms ?? DEFAULT_TIMEOUT_MS}ms`,
    };
  }

  if (context.abort_signal.aborted) {
    return {
      type: "error",
      content: `Command \`${command}\`${descSuffix} was interrupted`,
    };
  }

  // Build output string
  let output = result.stdout;
  if (result.stderr) {
    output = output
      ? `${output}\n\nstderr:\n${result.stderr}`
      : `stderr:\n${result.stderr}`;
  }

  if (result.exit_code !== 0) {
    const exitInfo = result.exit_code !== null ? ` (exit code ${result.exit_code})` : "";
    return {
      type: "error",
      content: `Command \`${command}\`${descSuffix} failed${exitInfo}:\n${output || "(no output)"}`,
      display_content: output || "(no output)",
      metadata: {
        exit_code: result.exit_code,
        truncated: result.truncated,
      },
    };
  }

  return {
    type: "text",
    content: output || "(no output)",
    display_content: output || "(no output)",
    metadata: {
      exit_code: result.exit_code,
      truncated: result.truncated,
    },
  };
}

// -----------------------------------------------------------------------------
// Tool definition (exported for registration)
// -----------------------------------------------------------------------------

export const bashToolDefinition: ToolDefinition<BashToolInput> = {
  name: "bash",
  description:
    "Execute a shell command. The command runs in bash. " +
    "Use this for running scripts, installing packages, searching files, " +
    "or any operation that requires shell access. " +
    "Commands run in the current working directory by default (on the gateway). " +
    "Set host='node' to execute on a connected node host (user's device). " +
    "Stdout and stderr are captured and returned. " +
    "Long-running commands will time out after the specified timeout.",
  input_schema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The shell command to execute",
      },
      timeout_ms: {
        type: "integer",
        description:
          "Timeout in milliseconds. Default: 120000 (2 minutes). Max: 600000 (10 minutes).",
      },
      description: {
        type: "string",
        description:
          "Short description of what this command does. Shown in the UI.",
      },
      host: {
        type: "string",
        description:
          "Where to execute: 'auto' (local gateway, default), 'gateway' (force local), 'node' (execute on a connected node host).",
      },
      node: {
        type: "string",
        description:
          "Target node name or ID when host='node'. Auto-selects if only one node connected.",
      },
    },
    required: ["command"],
  },
  permission: "ask_user",
  execute: execute as any, // Generic type widening for ToolDefinition
};
