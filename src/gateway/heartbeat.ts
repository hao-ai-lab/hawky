// =============================================================================
// Heartbeat Service
//
// Timer-driven background agent session on the gateway. Periodically reads
// ~/.hawky/HEARTBEAT.md, uses a virtual tool call (Phase 1) to decide
// skip/run, then executes tasks in an isolated session (Phase 2).
//
// Design decisions:
// - Virtual tool call for decision (Nanobot pattern, not HEARTBEAT_OK token)
// - Always-isolated session (heartbeat:main)
// - Framework-enforced active hours (no wasted API calls)
// - System event queue drained on each tick (scaffolding for cron bridge)
//
// Pattern: a proven heartbeat-runner.ts + Nanobot's heartbeat/service.py
// =============================================================================

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { getConfigDir } from "../storage/config.js";

import type { AgentSessionManager, AgentSession } from "./agent-sessions.js";
import type { GatewayServer } from "./server.js";
import type { HawkyConfig, ChatMessage } from "../agent/types.js";
import { WorkspaceManager } from "../storage/workspace.js";
import { HeartbeatWake } from "./heartbeat-wake.js";
import { WakePriority } from "./types.js";
import type { WakeResult } from "./types.js";
import { isWithinActiveHours } from "./heartbeat-active-hours.js";
import type { ActiveHoursConfig } from "./heartbeat-active-hours.js";
import { drainSystemEvents } from "./system-events.js";
import type { SystemEvent } from "./system-events.js";
import {
  HEARTBEAT_DECISION_TOOL,
  buildHeartbeatSystemPrompt,
  buildHeartbeatUserMessage,
  isHeartbeatContentEffectivelyEmpty,
  parseHeartbeatDecision,
  buildConsolidationSystemPrompt,
  buildConsolidationUserMessage,
  buildDistillationSystemPrompt,
  buildDistillationUserMessage,
  buildNodeContextPrefix,
} from "./heartbeat-prompt.js";
import { extractSessionText } from "../memory/session-extract.js";
import { getSessionsDir } from "../storage/session.js";
import { executeInSession } from "./lanes.js";
import { CommandLane } from "./types.js";
import { createSubsystemLogger } from "../logging/index.js";
import { createProvider } from "../agent/provider-factory.js";
import { triggerAgentTurn, sanitizeDeliveredText, relayToBoundChannels } from "./agent-turn.js";
import { broadcastNotification } from "./notification.js";
import { deliver } from "./delivery.js";

const log = createSubsystemLogger("gateway/heartbeat");

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

// Defaults derive from the configured Hawky root (honors HAWKY_HOME).
const defaultHeartbeatFile = (): string => join(getConfigDir(), "workspace", "HEARTBEAT.md");
const defaultHeartbeatStateFile = (): string => join(getConfigDir(), "heartbeat-state.json");
const HEARTBEAT_SESSION_KEY = "heartbeat:main";
const CONSOLIDATION_SESSION_KEY = "heartbeat:consolidation";
const DISTILLATION_SESSION_KEY = "heartbeat:distillation";
const DISTILLATION_TEXT_CAP = 50_000; // Max chars of session text in distillation prompt

// Patterns that indicate the heartbeat found nothing actionable
const TRIVIAL_PATTERNS = [
  /^\s*HEARTBEAT_OK\s*$/i,
  /^\s*nothing\s+to\s+report\s*$/i,
  /^\s*all\s+(clear|good|ok)\s*[.!]?\s*$/i,
];
const MIN_ACTIONABLE_LENGTH = 20; // summaries shorter than this are likely trivial

/** Check if a heartbeat result is trivial (not worth delivering to the user). */
function isHeartbeatResultTrivial(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < MIN_ACTIONABLE_LENGTH) return true;
  return TRIVIAL_PATTERNS.some((p) => p.test(trimmed));
}

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface HeartbeatConfig {
  enabled: boolean;
  intervalMs: number;
  model?: string;
  keepRecentMessages: number;
  activeHours?: ActiveHoursConfig;
  consolidation: {
    enabled: boolean;
    daysToReview: number;
    frequencyMs: number;
  };
  distillation: {
    enabled: boolean;
    frequencyMs: number;
    minNewMessages: number;
  };
  /** Session to proactively deliver heartbeat findings to. Default: "web:general". Empty string disables. */
  deliveryTarget: string;
}

export interface HeartbeatStatus {
  enabled: boolean;
  lastRunAt: number | null;
  lastStatus: "ran" | "skipped" | "failed" | null;
  lastReason?: string;
  lastSummary?: string;
  lastDurationMs?: number;
  nextRunAt: number | null;
  alertCount: number;
  running: boolean;
  activeHoursStart?: string;
  lastConsolidatedAt: number | null;
  lastDistilledAt: number | null;
}

// Broadcast event payloads
export interface HeartbeatStartedEvent {
  type: "heartbeat.started";
  timestamp: number;
}

export interface HeartbeatCompletedEvent {
  type: "heartbeat.completed";
  timestamp: number;
  status: "ran" | "skipped" | "failed";
  reason?: string;
  summary?: string;
  durationMs: number;
  alertCount: number;
  nextRunAt: number | null;
  activeHoursStart?: string;
}

// -----------------------------------------------------------------------------
// Heartbeat Service
// -----------------------------------------------------------------------------

export class HeartbeatService {
  private sessions: AgentSessionManager;
  private server: GatewayServer;
  private config: HeartbeatConfig;
  private fullConfig: HawkyConfig;
  private wake: HeartbeatWake;
  private intervalTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private heartbeatFilePath: string;
  private stateFilePath: string;
  private memorySchedulerOwnsMemory: boolean;
  private consolidationInFlight = false;
  private distillationInFlight = false;
  /** Per-session byte offsets for distillation (shared with flush). */
  private sessionOffsets: Record<string, number> = {};

  // Status tracking (enabled is set in constructor from config)
  private status: HeartbeatStatus = {
    enabled: false,
    lastRunAt: null,
    lastStatus: null,
    nextRunAt: null,
    alertCount: 0,
    running: false,
    lastConsolidatedAt: null,
    lastDistilledAt: null,
  };

  constructor(opts: {
    sessions: AgentSessionManager;
    server: GatewayServer;
    config: HawkyConfig;
    /** Override heartbeat file path (for testing). Default: ~/.hawky/workspace/HEARTBEAT.md */
    heartbeatFilePath?: string;
    /** Override state file path (for testing). Default: ~/.hawky/heartbeat-state.json */
    stateFilePath?: string;
    /** #653: production gateway memory automation supersedes heartbeat memory phases. */
    memorySchedulerOwnsMemory?: boolean;
  }) {
    this.sessions = opts.sessions;
    this.server = opts.server;
    this.fullConfig = opts.config;
    this.heartbeatFilePath = opts.heartbeatFilePath ?? defaultHeartbeatFile();
    this.stateFilePath = opts.stateFilePath ?? defaultHeartbeatStateFile();
    this.memorySchedulerOwnsMemory = opts.memorySchedulerOwnsMemory ?? false;

    // Derive heartbeat-specific config from full config
    this.config = HeartbeatService.resolveConfig(opts.config, {
      memorySchedulerOwnsMemory: this.memorySchedulerOwnsMemory,
    });
    this.status.enabled = this.config.enabled;

    // Restore persisted state (survives gateway restart)
    this.loadState();

    // Create wake scheduler with our handler
    this.wake = new HeartbeatWake(() => this.executeHeartbeat());
  }

  // ---------------------------------------------------------------------------
  // Config resolution
  // ---------------------------------------------------------------------------

  static resolveConfig(
    config: HawkyConfig,
    opts: { memorySchedulerOwnsMemory?: boolean } = {},
  ): HeartbeatConfig {
    const hb = config.heartbeat;
    const memorySchedulerOwnsMemory = opts.memorySchedulerOwnsMemory === true;
    return {
      enabled: hb.enabled,
      intervalMs: (hb.interval_minutes ?? 30) * 60_000,
      model: hb.model,
      keepRecentMessages: hb.keep_recent_messages ?? 8,
      activeHours: hb.active_hours
        ? {
            start: hb.active_hours.start ?? "08:00",
            end: hb.active_hours.end ?? "22:00",
            timezone: hb.active_hours.timezone,
          }
        : undefined,
      consolidation: {
        enabled: memorySchedulerOwnsMemory ? false : (hb.consolidation_enabled ?? false),
        daysToReview: hb.consolidation_days ?? 3,
        frequencyMs: (hb.consolidation_frequency_hours ?? 24) * 3_600_000,
      },
      distillation: {
        enabled: memorySchedulerOwnsMemory ? false : (hb.distillation_enabled ?? false),
        frequencyMs: (hb.distillation_frequency_hours ?? 6) * 3_600_000,
        minNewMessages: hb.distillation_min_new_messages ?? 10,
      },
      deliveryTarget: hb.delivery_target ?? "web:general",
    };
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Start the heartbeat timer. First tick fires after one full interval.
   */
  start(): void {
    if (!this.config.enabled) {
      log.info("heartbeat disabled in config");
      return;
    }

    // Ensure HEARTBEAT.md exists (simple onboarding)
    this.ensureHeartbeatFile();

    this.stopped = false;
    this.armInterval();
    log.info("heartbeat started", {
      intervalMs: this.config.intervalMs,
      activeHours: this.config.activeHours,
      heartbeatFile: this.heartbeatFilePath,
    });
  }

  /**
   * Stop the heartbeat timer and cancel pending wakes.
   */
  stop(): void {
    this.stopped = true;
    this.consolidationInFlight = false;
    if (this.intervalTimer !== null) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
    this.wake.stop();
    this.status.nextRunAt = null;
    log.info("heartbeat stopped");
  }

  /**
   * Request an immediate heartbeat execution.
   */
  requestNow(reason?: string): void {
    this.wake.requestNow({
      reason: reason ?? "manual",
      priority: WakePriority.Action,
    });
  }

  /**
   * Update config at runtime (live reload).
   */
  updateConfig(config: HawkyConfig): void {
    const wasEnabled = this.config.enabled;
    this.fullConfig = config;
    this.config = HeartbeatService.resolveConfig(config, {
      memorySchedulerOwnsMemory: this.memorySchedulerOwnsMemory,
    });

    if (!this.config.enabled && wasEnabled) {
      this.stop();
    } else if (this.config.enabled && !wasEnabled) {
      this.start();
    } else if (this.config.enabled) {
      // Re-arm with new interval
      this.stop();
      this.stopped = false;
      this.armInterval();
    }

    log.info("heartbeat config updated", {
      enabled: this.config.enabled,
      intervalMs: this.config.intervalMs,
    });
  }

  /**
   * Get current heartbeat status.
   */
  getStatus(): HeartbeatStatus {
    return {
      ...this.status,
      enabled: this.config.enabled, // Override from live config (may differ from initial)
      activeHoursStart: this.config.activeHours?.start,
    };
  }

  /**
   * Check if the heartbeat is currently running a turn.
   */
  isRunning(): boolean {
    return this.status.running;
  }

  // ---------------------------------------------------------------------------
  // Internal: Timer
  // ---------------------------------------------------------------------------

  private armInterval(): void {
    if (this.intervalTimer !== null) {
      clearInterval(this.intervalTimer);
    }

    this.status.nextRunAt = Date.now() + this.config.intervalMs;

    this.intervalTimer = setInterval(() => {
      this.status.nextRunAt = Date.now() + this.config.intervalMs;
      this.wake.requestNow({
        reason: "interval",
        priority: WakePriority.Interval,
      });
    }, this.config.intervalMs);
  }

  // ---------------------------------------------------------------------------
  // Internal: Main execution handler (called by HeartbeatWake)
  // ---------------------------------------------------------------------------

  async executeHeartbeat(): Promise<WakeResult> {
    if (this.stopped) {
      return { status: "skipped", reason: "stopped" };
    }

    const startMs = Date.now();
    this.status.running = true;

    // Broadcast started event
    this.server.broadcast("heartbeat.started", {
      type: "heartbeat.started",
      timestamp: startMs,
    } satisfies HeartbeatStartedEvent);

    try {
      const result = await this.runOnce();

      this.status.lastRunAt = startMs;
      this.status.lastStatus = result.status;
      this.status.lastReason = result.reason;
      this.status.lastSummary = result.summary;
      this.status.lastDurationMs = Date.now() - startMs;
      if (result.status === "ran") {
        this.status.alertCount++;
      }

      // Broadcast skip notification to heartbeat session so TUI shows it
      if (result.status === "skipped") {
        const time = new Date(startMs).toLocaleTimeString();
        this.server.broadcastToSession(
          HEARTBEAT_SESSION_KEY,
          "agent.system_message",
          {
            type: "system_message",
            content: `[${time}] Heartbeat skipped: ${result.reason ?? "nothing to do"}`,
            subtype: "heartbeat",
          },
        );
      }

      // Broadcast completed event
      this.server.broadcast("heartbeat.completed", {
        type: "heartbeat.completed",
        timestamp: Date.now(),
        status: result.status,
        reason: result.reason,
        summary: result.summary,
        durationMs: Date.now() - startMs,
        alertCount: this.status.alertCount,
        nextRunAt: this.status.nextRunAt,
        activeHoursStart: this.config.activeHours?.start,
      } satisfies HeartbeatCompletedEvent);

      log.info("heartbeat tick", {
        status: result.status,
        reason: result.reason,
        durationMs: Date.now() - startMs,
      });

      return { status: result.status, reason: result.reason };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);

      this.status.lastRunAt = startMs;
      this.status.lastStatus = "failed";
      this.status.lastReason = reason;
      this.status.lastDurationMs = Date.now() - startMs;

      this.server.broadcast("heartbeat.completed", {
        type: "heartbeat.completed",
        timestamp: Date.now(),
        status: "failed",
        reason,
        durationMs: Date.now() - startMs,
        alertCount: this.status.alertCount,
        nextRunAt: this.status.nextRunAt,
        activeHoursStart: this.config.activeHours?.start,
      } satisfies HeartbeatCompletedEvent);

      log.error("heartbeat failed", { error: reason });
      return { status: "skipped", reason };
    } finally {
      this.status.running = false;

      // Phase 3: Session distillation — extract facts from un-flushed sessions
      // into daily logs. Runs before consolidation so daily logs are fresh.
      if (
        !this.stopped &&
        !this.distillationInFlight &&
        isWithinActiveHours(this.config.activeHours) &&
        this.shouldRunDistillation()
      ) {
        this.distillationInFlight = true;

        void this.runDistillationPhase()
          .catch((err) => {
            log.warn("session distillation failed (non-fatal)", {
              error: err instanceof Error ? err.message : String(err),
            });
          })
          .finally(() => {
            this.distillationInFlight = false;
          });
      }

      // Phase 4: Memory consolidation — independent of Phase 1/2 outcome.
      // Fire-and-forget: don't block the wake handler. If we awaited here,
      // HeartbeatWake's running flag would stay true while consolidation
      // waits for CommandLane.Main, suppressing all future heartbeat ticks.
      // The consolidationInFlight flag prevents duplicate launches across ticks.
      if (
        !this.stopped &&
        !this.consolidationInFlight &&
        isWithinActiveHours(this.config.activeHours) &&
        this.shouldRunConsolidation()
      ) {
        this.consolidationInFlight = true;

        void this.runConsolidationPhase()
          .catch((err) => {
            log.warn("memory consolidation failed (non-fatal)", {
              error: err instanceof Error ? err.message : String(err),
            });
          })
          .finally(() => {
            this.consolidationInFlight = false;
          });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Internal: Single heartbeat execution
  // ---------------------------------------------------------------------------

  private async runOnce(): Promise<{
    status: "ran" | "skipped";
    reason?: string;
    summary?: string;
  }> {
    // Check active hours
    if (!isWithinActiveHours(this.config.activeHours)) {
      return { status: "skipped", reason: "quiet-hours" };
    }

    // Read HEARTBEAT.md
    const heartbeatContent = this.readHeartbeatFile();
    const systemEvents = drainSystemEvents(HEARTBEAT_SESSION_KEY);
    const hasExternalEvents = systemEvents.length > 0;

    // If no HEARTBEAT.md content AND no system events → skip
    if (
      (heartbeatContent === null || isHeartbeatContentEffectivelyEmpty(heartbeatContent)) &&
      !hasExternalEvents
    ) {
      return { status: "skipped", reason: "no-tasks" };
    }

    // Phase 1: Decision call (virtual tool)
    const decision = await this.runDecisionPhase(
      heartbeatContent ?? "",
      systemEvents,
    );

    if (decision.action === "skip") {
      return {
        status: "skipped",
        reason: decision.reason ?? "agent-skip",
      };
    }

    // Phase 2: Execute tasks in isolated session
    // Prefix with instruction to always re-execute (don't skip because history shows prior results)
    const rawTasks = decision.tasks ?? heartbeatContent ?? "";
    const tasks = `[Heartbeat check — always execute the tasks below fresh, even if you did them before. Report current results, not cached ones.]\n\n${rawTasks}`;
    const { summary, fullSummary } = await this.runExecutionPhase(tasks);

    // Phase 2.5: Proactive delivery — insert findings into target session
    // as an assistant message (no second LLM call).
    // Skip delivery for trivial results (HEARTBEAT_OK, empty, very short).
    if (this.config.deliveryTarget && fullSummary && !isHeartbeatResultTrivial(fullSummary)) {
      this.deliverToTarget(fullSummary);
    }

    return {
      status: "ran",
      reason: decision.reason,
      summary,
    };
  }

  // ---------------------------------------------------------------------------
  // Phase 1: Decision (virtual tool call)
  // ---------------------------------------------------------------------------

  private async runDecisionPhase(
    heartbeatContent: string,
    systemEvents: SystemEvent[],
  ): Promise<{ action: "skip" | "run"; tasks?: string; reason?: string }> {
    const model = this.config.model ?? this.fullConfig.model;

    // Route through the shared provider factory so heartbeat uses the
    // same backend (Anthropic direct or Vertex AI) as the main gateway.
    const provider = createProvider(this.fullConfig);

    // Load workspace context for informed decision-making
    const workspace = new WorkspaceManager();
    const bootstrapFiles = workspace.loadBootstrapFiles({
      maxCharsPerFile: 5_000,  // Lighter than full agent context
      maxCharsTotal: 15_000,   // Keep Phase 1 cheap
      mainSession: false,
    });

    const systemPrompt = buildHeartbeatSystemPrompt(bootstrapFiles);
    const userMessage = buildHeartbeatUserMessage(
      heartbeatContent,
      systemEvents,
    );

    // Stream the decision call, accumulating tool call input from partial JSON deltas.
    // The provider emits: tool_use_start → tool_use_input_delta* → content_block_stop
    let toolName: string | null = null;
    let toolInputJson = "";

    for await (const event of provider.stream(
      {
        model,
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: "user", content: userMessage }],
        tools: [
          {
            name: HEARTBEAT_DECISION_TOOL.name,
            description: HEARTBEAT_DECISION_TOOL.description,
            input_schema: HEARTBEAT_DECISION_TOOL.input_schema,
          },
        ],
      },
    )) {
      if (event.type === "tool_use_start") {
        toolName = (event as any).name;
        toolInputJson = "";
      } else if (event.type === "tool_use_input_delta") {
        toolInputJson += (event as any).partial_json ?? "";
      }
    }

    // Parse accumulated tool call
    if (toolName === HEARTBEAT_DECISION_TOOL.name && toolInputJson) {
      try {
        const input = JSON.parse(toolInputJson) as Record<string, unknown>;
        return parseHeartbeatDecision(input);
      } catch {
        log.warn("heartbeat decision: failed to parse tool input JSON", {
          toolInputJson: toolInputJson.slice(0, 200),
        });
      }
    }

    // No tool call found — maybe the model responded with text.
    // Default to skip (permissive — don't crash)
    log.warn("heartbeat decision: no tool call found, defaulting to skip", {
      toolName,
    });
    return { action: "skip", reason: "no-tool-call" };
  }

  // ---------------------------------------------------------------------------
  // Phase 2: Execute tasks in isolated session
  // ---------------------------------------------------------------------------

  private async runExecutionPhase(tasks: string): Promise<{ summary: string; fullSummary: string }> {
    // Broadcast a timestamp header so the TUI shows when this heartbeat ran
    const timeStr = new Date().toLocaleTimeString();
    this.server.broadcastToSession(
      HEARTBEAT_SESSION_KEY,
      "agent.system_message",
      {
        type: "system_message",
        content: `[${timeStr}] Heartbeat running...`,
        subtype: "heartbeat",
      },
    );

    // Build node context so the heartbeat agent knows what devices
    // are available for checks (e.g., frontmost.app, screenshot).
    const nodes = this.server.nodeRegistry.listConnected().map((n) => ({
      name: n.name, platform: n.platform, commands: n.commands,
    }));
    const nodePrefix = buildNodeContextPrefix(nodes);

    const result = await triggerAgentTurn(
      {
        sessionKey: HEARTBEAT_SESSION_KEY,
        message: nodePrefix + tasks,
        lane: CommandLane.Main,
        origin: "heartbeat",
      },
      { sessions: this.sessions, server: this.server },
    );

    // Re-throw so runOnce() reports the tick as "failed", not "ran"
    if (result.status === "error") {
      throw new Error(result.error ?? "heartbeat execution failed");
    }

    return { summary: result.summary, fullSummary: result.fullSummary };
  }

  // ---------------------------------------------------------------------------
  // Phase 2.5: Proactive delivery to target session
  // ---------------------------------------------------------------------------

  /**
   * Deliver heartbeat findings to the configured target session.
   *
   * Display-only: broadcasts a `notification.received` event so connected
   * clients can render the heartbeat summary as an inline notification
   * card — distinct from agent speech, and explicitly NOT inserted into
   * the target session's conversation history. This keeps the target
   * session's context clean for the user's actual work; the model never
   * sees heartbeat output unless the user copies it into the input
   * themselves.
   *
   * The summary is scrubbed once via `sanitizeDeliveredText` and the
   * cleaned body is shared across all three delivery surfaces — in-app
   * card, OS push, and bound external channels (Slack DM, etc.). If the
   * payload was entirely scratchpad (`<system-reminder>` blocks the
   * model emitted as a private note), we suppress every surface uniformly
   * rather than letting the raw original leak to push or Slack.
   */
  private deliverToTarget(summary: string): void {
    // Single source of truth for the visible body — sanitize here so push
    // and Slack-bound mirrors can't show content that the in-app card
    // intentionally suppressed.
    const cleaned = sanitizeDeliveredText(summary);
    if (!cleaned) {
      log.debug("heartbeat delivery skipped — body empty after scrubbing");
      return;
    }

    const sessionKey = this.config.deliveryTarget;

    // 1. In-app notification card. broadcastNotification re-applies the
    //    sanitizer, but `cleaned` is already idempotent so this is a no-op
    //    second pass — kept for that helper's own contract.
    broadcastNotification(
      { sessionKey, origin: "heartbeat", title: "Heartbeat Update", body: cleaned },
      { server: this.server },
    );

    // 2. OS push (iOS / PWA banner) — uses the same cleaned body, capped
    //    at the banner-friendly length. Skipped automatically when cleaned
    //    is empty thanks to the early return above.
    deliver({
      config: { mode: "push" },
      title: "Hawky: Heartbeat Update",
      message: cleaned.length > 500 ? cleaned.slice(0, 500) + "..." : cleaned,
      sessionKey,
    });

    // 3. Bound external channels (Slack DMs bound to web:general, etc.).
    //    The pre-display-only proactive path called this implicitly via
    //    deliverToSession; the new card-only path doesn't, so we re-add
    //    it explicitly so users with Slack-bound sessions still see
    //    heartbeat updates on Slack.
    relayToBoundChannels({ sessionKey, text: cleaned, origin: "heartbeat" });
  }

  // ---------------------------------------------------------------------------
  // Phase 3: Memory consolidation
  // ---------------------------------------------------------------------------

  /**
   * Check whether memory consolidation should run this tick.
   * Returns true if: enabled AND (never run before OR frequency elapsed).
   */
  private shouldRunConsolidation(): boolean {
    if (!this.config.consolidation.enabled) return false;
    if (this.status.lastConsolidatedAt === null) return true;
    return Date.now() - this.status.lastConsolidatedAt >= this.config.consolidation.frequencyMs;
  }

  /**
   * Run memory consolidation: read recent daily logs, promote durable facts
   * to MEMORY.md, clean stale entries.
   *
   * Uses a dedicated silent session (no TUI broadcast). The consolidation
   * instructions are prepended to the user message — the agent follows them
   * in headless mode without workspace system-prompt interference.
   */
  private async runConsolidationPhase(): Promise<void> {
    const workspace = new WorkspaceManager();
    const workspacePath = workspace.getWorkspacePath();
    const memoryMdPath = join(workspacePath, "MEMORY.md");

    // Collect recent daily logs
    const allLogs = workspace.listDailyLogs();
    const recentLogs = allLogs.slice(-this.config.consolidation.daysToReview);

    // No logs → skip. Don't advance lastConsolidatedAt so that logs created
    // later today still trigger consolidation on the next tick.
    if (recentLogs.length === 0) {
      log.info("memory consolidation skipped (no daily logs)");
      return;
    }

    const dailyLogEntries = recentLogs.map((filename) => {
      const date = filename.replace(".md", "");
      const content = workspace.readFile(`memory/${filename}`) ?? "";
      return { date, content };
    });

    // Combine system instructions + data into a single user message.
    // The consolidation agent operates headless; system prompt from workspace
    // files is fine — consolidation instructions override at the message level.
    const systemInstructions = buildConsolidationSystemPrompt();
    const dataMessage = buildConsolidationUserMessage(dailyLogEntries, memoryMdPath);
    const fullMessage = `${systemInstructions}\n\n---\n\n${dataMessage}`;

    log.info("memory consolidation starting", {
      logsReviewed: recentLogs.length,
      dates: recentLogs.map((f) => f.replace(".md", "")),
    });

    // Consolidation uses its own session and only reads daily logs + writes MEMORY.md.
    // Runs on Cron lane to avoid blocking user chat on Main lane.
    await executeInSession(
      CONSOLIDATION_SESSION_KEY,
      CommandLane.Cron,
      async () => {
        const session = this.sessions.getOrCreate(CONSOLIDATION_SESSION_KEY);

        const prevLength = session.loop.getHistory().length;
        await session.loop.sendMessage(fullMessage, { headless: true });

        // Persist new messages
        const history = session.loop.getHistory();
        const newMessages = history.slice(prevLength);
        for (const msg of newMessages) {
          session.sessionManager.appendMessage(msg);
        }

        // NOTE: No history trimming for consolidation either.
      },
    );

    this.status.lastConsolidatedAt = Date.now();
    this.saveState();
    log.info("memory consolidation completed", {
      logsReviewed: recentLogs.length,
    });
  }

  // ---------------------------------------------------------------------------
  // Phase 3: Session distillation
  // ---------------------------------------------------------------------------

  private shouldRunDistillation(): boolean {
    if (!this.config.distillation.enabled) return false;
    if (this.status.lastDistilledAt === null) return true;
    return Date.now() - this.status.lastDistilledAt >= this.config.distillation.frequencyMs;
  }

  /**
   * Distill un-flushed sessions into daily logs.
   * Scans recent session files, extracts new content since last distillation,
   * and runs an LLM turn to write durable facts to memory/YYYY-MM-DD.md.
   */
  private async runDistillationPhase(): Promise<void> {
    const sessionsDir = getSessionsDir();
    if (!existsSync(sessionsDir)) {
      log.info("session distillation skipped (no sessions directory)");
      return;
    }

    const workspace = new WorkspaceManager();
    const workspacePath = workspace.getWorkspacePath();

    // Scan for recently modified session files (last 7 days)
    const cutoff = Date.now() - 7 * 86_400_000;
    const candidates = this.findRecentSessionFiles(sessionsDir, cutoff);

    if (candidates.length === 0) {
      log.info("session distillation skipped (no recent sessions)");
      this.status.lastDistilledAt = Date.now();
      this.saveState();
      return;
    }

    // Extract new content from each session
    const sessionsToDistill: Array<{ path: string; text: string; newOffset: number }> = [];

    for (const filePath of candidates) {
      const offset = this.sessionOffsets[filePath] ?? 0;
      try {
        const result = await extractSessionText(filePath, offset);

        if (result.messageCount < this.config.distillation.minNewMessages) {
          continue; // Not enough new content
        }

        // Cap text length to prevent token overflow.
        // When capped, DON'T advance offset to full byteLength — only advance
        // proportionally to the text actually included, so the remainder is
        // retried on the next cycle.
        let text: string;
        let newOffset: number;
        if (result.text.length > DISTILLATION_TEXT_CAP) {
          text = result.text.slice(0, DISTILLATION_TEXT_CAP) + "\n[... truncated ...]";
          // Estimate byte offset proportional to text consumed
          const ratio = DISTILLATION_TEXT_CAP / result.text.length;
          newOffset = offset + Math.floor((result.byteLength - offset) * ratio);
          log.info("session text capped for distillation", {
            file: filePath,
            totalChars: result.text.length,
            cappedChars: DISTILLATION_TEXT_CAP,
            remainderRetried: true,
          });
        } else {
          text = result.text;
          newOffset = result.byteLength;
        }

        sessionsToDistill.push({ path: filePath, text, newOffset });
      } catch (err) {
        log.warn("failed to extract session text", {
          file: filePath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (sessionsToDistill.length === 0) {
      log.info("session distillation skipped (no sessions with enough new messages)");
      this.status.lastDistilledAt = Date.now();
      this.saveState();
      return;
    }

    // Combine all session texts
    const combinedText = sessionsToDistill
      .map((s) => `--- Session: ${s.path} ---\n${s.text}`)
      .join("\n\n");

    const systemInstructions = buildDistillationSystemPrompt();
    const dataMessage = buildDistillationUserMessage(combinedText, workspacePath);
    const fullMessage = `${systemInstructions}\n\n---\n\n${dataMessage}`;

    log.info("session distillation starting", {
      sessions: sessionsToDistill.length,
      totalChars: combinedText.length,
    });

    await executeInSession(
      DISTILLATION_SESSION_KEY,
      CommandLane.Cron,
      async () => {
        const session = this.sessions.getOrCreate(DISTILLATION_SESSION_KEY);
        const prevLength = session.loop.getHistory().length;
        await session.loop.sendMessage(fullMessage, { headless: true });

        // Persist new messages
        const history = session.loop.getHistory();
        const newMessages = history.slice(prevLength);
        for (const msg of newMessages) {
          session.sessionManager.appendMessage(msg);
        }
      },
    );

    // Advance offsets AFTER successful LLM turn — if sendMessage fails,
    // offsets stay at previous values so content is retried next cycle.
    for (const s of sessionsToDistill) {
      this.sessionOffsets[s.path] = s.newOffset;
    }

    this.status.lastDistilledAt = Date.now();
    this.saveState();
    log.info("session distillation completed", {
      sessions: sessionsToDistill.length,
    });
  }

  // Maintenance session directories to exclude from distillation.
  // These contain internal prompts/responses that would contaminate memory.
  private static readonly EXCLUDED_SESSION_DIRS = new Set([
    "heartbeat",  // heartbeat:main, heartbeat:consolidation, heartbeat:distillation
    "cron",       // cron job sessions (already distilled via buildCronDistillationPrefix)
  ]);

  /**
   * Recursively find .jsonl session files modified after cutoff.
   * Excludes maintenance sessions (heartbeat/*, cron/*) to prevent
   * internal prompts from being distilled into user memory.
   */
  private findRecentSessionFiles(dir: string, cutoffMs: number, isRoot = true): string[] {
    const results: string[] = [];
    try {
      for (const entry of readdirSync(dir)) {
        if (entry === "meta.json" || entry === ".last-session" || entry.endsWith(".bak")) continue;
        const absPath = join(dir, entry);
        try {
          const stat = statSync(absPath);
          if (stat.isDirectory()) {
            // Skip maintenance session directories at the top level
            if (isRoot && HeartbeatService.EXCLUDED_SESSION_DIRS.has(entry)) continue;
            results.push(...this.findRecentSessionFiles(absPath, cutoffMs, false));
          } else if (entry.endsWith(".jsonl") && stat.mtimeMs >= cutoffMs) {
            results.push(absPath);
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
    return results;
  }

  /**
   * Update the distillation byte offset for a session file.
   * Called by memory-flush when a session is flushed, so distillation
   * won't re-process content that flush already handled.
   */
  updateSessionOffset(sessionFilePath: string, byteOffset: number): void {
    this.sessionOffsets[sessionFilePath] = byteOffset;
    this.saveState();
  }

  // ---------------------------------------------------------------------------
  // Session history trimming
  // ---------------------------------------------------------------------------

  /**
   * Trim the consolidation session history to keepRecentMessages.
   */
  private trimConsolidationHistory(session: AgentSession): void {
    this.trimSessionHistoryBounded(session, CONSOLIDATION_SESSION_KEY);
  }

  /**
   * Trim session history to keepRecentMessages, respecting tool-call boundaries.
   * We don't orphan a tool_result without its preceding tool_use.
   */
  private trimSessionHistory(session: AgentSession): void {
    this.trimSessionHistoryBounded(session, HEARTBEAT_SESSION_KEY);
  }

  private trimSessionHistoryBounded(session: AgentSession, sessionKey: string): void {
    const max = this.config.keepRecentMessages;
    const history = session.loop.getHistory();

    if (history.length <= max) return;

    // Find the cut point: walk back from the desired start
    let cutIndex = history.length - max;

    // Ensure we don't cut in the middle of a tool call pair.
    // A tool_result at cutIndex would be orphaned without its tool_use.
    // Walk forward until we find a clean boundary (user or assistant-with-text message).
    while (cutIndex < history.length) {
      const msg = history[cutIndex];
      if (msg.role === "user") break;
      if (msg.role === "assistant") {
        // Check if it starts with text (not a tool_use continuation)
        const firstBlock = msg.content?.[0];
        if (!firstBlock || (firstBlock as any).type !== "tool_result") break;
      }
      cutIndex++;
    }

    if (cutIndex > 0 && cutIndex < history.length) {
      const trimmed = history.slice(cutIndex);
      session.loop.setHistory(trimmed);

      // Also rewrite the JSONL file to persist the trimmed history.
      // Without this, gateway restart would reload the full untrimmed history.
      session.sessionManager.rewriteMessages(trimmed, this.fullConfig.model);

      log.debug("session history trimmed", {
        sessionKey,
        before: history.length,
        after: trimmed.length,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // State persistence (survives gateway restart)
  // ---------------------------------------------------------------------------

  /**
   * Load persisted heartbeat state from disk.
   * Currently only persists lastConsolidatedAt.
   */
  private loadState(): void {
    try {
      if (!existsSync(this.stateFilePath)) return;
      const raw = readFileSync(this.stateFilePath, "utf-8");
      const data = JSON.parse(raw) as Record<string, unknown>;
      if (typeof data.lastConsolidatedAt === "number") {
        this.status.lastConsolidatedAt = data.lastConsolidatedAt;
      }
      if (typeof data.lastDistilledAt === "number") {
        this.status.lastDistilledAt = data.lastDistilledAt;
      }
      if (data.sessionOffsets && typeof data.sessionOffsets === "object" && data.sessionOffsets !== null) {
        this.sessionOffsets = data.sessionOffsets as Record<string, number>;
      }
    } catch {
      // Non-fatal — start fresh if state file is corrupt or unreadable
    }
  }

  /**
   * Save heartbeat state to disk.
   */
  private saveState(): void {
    try {
      const dir = dirname(this.stateFilePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      const data = JSON.stringify({
        lastConsolidatedAt: this.status.lastConsolidatedAt,
        lastDistilledAt: this.status.lastDistilledAt,
        sessionOffsets: this.sessionOffsets,
      });
      // Atomic write: temp file → rename (matches cron-store pattern).
      // Prevents corrupt state file if process crashes mid-write.
      const tmp = `${this.stateFilePath}.${process.pid}.tmp`;
      writeFileSync(tmp, data, "utf-8");
      renameSync(tmp, this.stateFilePath);
    } catch (err) {
      log.warn("failed to save heartbeat state", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ---------------------------------------------------------------------------
  // HEARTBEAT.md reader
  // ---------------------------------------------------------------------------

  /**
   * Read HEARTBEAT.md from disk. Returns null if file doesn't exist.
   */
  private readHeartbeatFile(): string | null {
    try {
      if (!existsSync(this.heartbeatFilePath)) return null;
      return readFileSync(this.heartbeatFilePath, "utf-8");
    } catch {
      return null;
    }
  }

  /**
   * Ensure HEARTBEAT.md exists. If missing, copy from template.
   * This is the simple onboarding — a full wizard lives in Part 11.
   */
  private ensureHeartbeatFile(): void {
    if (existsSync(this.heartbeatFilePath)) {
      // Check if it has actionable content
      const content = this.readHeartbeatFile();
      if (content && isHeartbeatContentEffectivelyEmpty(content)) {
        log.info(
          "HEARTBEAT.md exists but has no actionable tasks — heartbeat will skip until you add tasks",
          { path: this.heartbeatFilePath },
        );
      }
      return;
    }

    // Copy template
    try {
      const templateDir = new URL("../templates", import.meta.url).pathname;
      const templatePath = join(templateDir, "HEARTBEAT.md");
      if (existsSync(templatePath)) {
        const dir = dirname(this.heartbeatFilePath);
        mkdirSync(dir, { recursive: true });
        const template = readFileSync(templatePath, "utf-8");
        writeFileSync(this.heartbeatFilePath, template, { flag: "wx" }); // exclusive — don't overwrite
        log.info("created HEARTBEAT.md from template", {
          path: this.heartbeatFilePath,
        });
      } else {
        // No template available — create minimal file
        const dir = dirname(this.heartbeatFilePath);
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          this.heartbeatFilePath,
          "# Heartbeat Tasks\n\n## Active Tasks\n\n<!-- Add periodic tasks here -->\n",
          { flag: "wx" },
        );
        log.info("created minimal HEARTBEAT.md", {
          path: this.heartbeatFilePath,
        });
      }
    } catch (err) {
      // Non-fatal — heartbeat will just skip if file doesn't exist
      log.warn("could not create HEARTBEAT.md", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------

export { HEARTBEAT_SESSION_KEY, CONSOLIDATION_SESSION_KEY };
