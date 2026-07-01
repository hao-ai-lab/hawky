// =============================================================================
// channel.send tool
//
// Lets one agent session emit a user message into ANOTHER session's history,
// optionally triggering a headless agent turn on that target session.
//
// Used by the voice-memo proposer (voice:<node_id>) to forward actionable
// transcriptions into web chat sessions, cron-triggered summarizers, etc.
//
// Injection path mirrors chat-poster / session.fork:
//   sessions.getOrCreate(to)
//     .sessionManager.appendMessage({ role: "user", content: [{type:"text",...}] })
//     .loop.setHistory([...history, msg])
// Trigger path mirrors chat.send in src/gateway/agent-methods.ts:
//   executeInSession(to, CommandLane.Main, () => loop.sendMessage(""))
// =============================================================================

import type {
  ToolDefinition,
  ToolContext,
  ToolResult,
} from "../agent/types.js";
import type { AgentSessionManager } from "../gateway/agent-sessions.js";
import type { GatewayServer } from "../gateway/server.js";
import { executeInSession } from "../gateway/lanes.js";
import { CommandLane } from "../gateway/types.js";
import { createSubsystemLogger } from "../logging/index.js";

const log = createSubsystemLogger("tools/channel_send");

// Injected refs at gateway startup. Null in CLI/test contexts — the tool
// returns an error if invoked without injection, rather than importing the
// session manager module cycle-unsafely.
let _sessions: AgentSessionManager | null = null;
let _server: GatewayServer | null = null;

export function setChannelSendDeps(sessions: AgentSessionManager, server: GatewayServer | null): void {
  _sessions = sessions;
  _server = server;
}

export function resetChannelSendDeps(): void {
  _sessions = null;
  _server = null;
}

interface ChannelSendInput {
  to: string;
  text: string;
  trigger_run?: boolean;
}

export async function executeChannelSend(
  input: ChannelSendInput,
  _context: ToolContext,
): Promise<ToolResult> {
  const to = typeof input.to === "string" ? input.to.trim() : "";
  const text = typeof input.text === "string" ? input.text : "";
  const triggerRun = input.trigger_run === true;

  if (!to) {
    return { type: "error", content: "Missing required parameter: to (target session key)" };
  }
  if (!text.trim()) {
    return { type: "error", content: "Missing required parameter: text" };
  }
  // Sessions are "<kind>:<name>" (e.g. "web:general", "voice:abc123").
  if (!/^[a-zA-Z0-9_\-]+:[a-zA-Z0-9_\-./]+$/.test(to)) {
    return {
      type: "error",
      content: `Invalid session key "${to}". Expected format "<kind>:<name>" (e.g. "web:general").`,
    };
  }
  if (!_sessions) {
    return {
      type: "error",
      content: "channel.send is not available in this context (gateway session manager not injected).",
    };
  }

  try {
    const target = _sessions.getOrCreate(to);
    const message = {
      role: "user" as const,
      content: [{ type: "text" as const, text }],
      timestamp: new Date().toISOString(),
    };

    // Mirror chat-poster / session.fork injection path.
    const history = target.loop.getHistory();
    target.loop.setHistory([...history, message]);
    target.sessionManager.appendMessage(message);

    // Broadcast session.updated so UIs refetch.
    if (_server) {
      try {
        _server.broadcast("session.updated", { sessionKey: to });
      } catch {
        /* non-fatal */
      }
    }

    if (triggerRun) {
      // Run on the target session's lane (fire-and-forget from the caller's
      // perspective; we still await the queueing so callers see errors).
      void executeInSession(to, CommandLane.Main, async () => {
        const session = _sessions!.getOrCreate(to);
        const prevLen = session.loop.getHistory().length;
        let runStart = prevLen;
        // sendMessage appends a user message before running the loop. We already
        // persisted a synthetic user message for immediate visibility, so pop it
        // from in-memory history and let sendMessage replay it for the run.
        const current = session.loop.getHistory();
        if (
          prevLen > 0 &&
          current[prevLen - 1]?.role === "user" &&
          (current[prevLen - 1] as any).content?.[0]?.text === text
        ) {
          session.loop.setHistory(current.slice(0, prevLen - 1));
          runStart = prevLen - 1;
        }
        await session.loop.sendMessage(text, { headless: true });

        const generatedMessages = session.loop.getHistory().slice(runStart);
        let persistedCount = 0;
        for (const [index, msg] of generatedMessages.entries()) {
          const isReplayedUserMessage =
            index === 0 &&
            msg.role === "user" &&
            (msg as any).content?.[0]?.text === text;
          if (isReplayedUserMessage) continue;
          session.sessionManager.appendMessage(msg);
          persistedCount += 1;
        }

        if (persistedCount > 0 && _server) {
          try {
            _server.broadcast("session.updated", { sessionKey: to });
          } catch {
            /* non-fatal */
          }
        }
      }).catch((err) => {
        log.warn("channel.send trigger_run failed", {
          to,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    log.info("channel.send delivered", { to, chars: text.length, triggerRun });
    return {
      type: "text",
      content: `ok: delivered to ${to}${triggerRun ? " (run triggered)" : ""}`,
      metadata: { target_session: to, trigger_run: triggerRun },
    };
  } catch (err) {
    return {
      type: "error",
      content: `channel.send failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export const channelSendToolDefinition: ToolDefinition<ChannelSendInput> = {
  name: "channel_send",
  description:
    "Send a message to another Hawky session by session key. Use this to forward " +
    'actionable content from one session to another (e.g., from "voice:abc123" to ' +
    '"web:general"). Set trigger_run=true to also run the agent loop on the target ' +
    "session after appending. The target session is created if it doesn't exist.",
  input_schema: {
    type: "object",
    properties: {
      to: {
        type: "string",
        description: 'Target session key, e.g. "web:general" or "voice:abc123".',
      },
      text: {
        type: "string",
        description: "The message text to append as a user-role message on the target session.",
      },
      trigger_run: {
        type: "boolean",
        description:
          "If true, also enqueue a headless agent turn on the target session after " +
          "appending. Default: false.",
      },
    },
    required: ["to", "text"],
  },
  permission: "auto_approve",
  execute: executeChannelSend as any,
};
