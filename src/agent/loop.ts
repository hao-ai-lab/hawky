// =============================================================================
// Agent Loop
//
// The heart of the system: user message → API call → tool execution → repeat.
//
// Design:
// - Imperative while loop (like COCO/nanobot, not event subscription)
// - Sequential permission → parallel tool execution (COCO pattern)
// - Clean phase boundaries for future hooks
// - In-memory conversation history (persistence added in 3.5)
// =============================================================================

import type {
  ChatMessage,
  ContentBlock,
  ToolContext,
  ToolUseRequest,
  TokenUsage,
  StreamEvent,
  StreamEventCallback,
  HawkyConfig,
  TextContentBlock,
  ToolUseContentBlock,
  ToolResultContentBlock,
  ThinkingContentBlock,
  ImageContentBlock,
} from "./types.js";
import type {
  LLMProvider,
  LLMStreamEvent,
  LLMStreamRequest,
} from "./provider.js";
import { LLMError } from "./provider.js";
import type { ToolRegistry } from "../tools/registry.js";
import { StreamEventEmitter } from "./stream.js";
import { buildSystemPrompt, buildPerTurnReminders, formatMessagesForApi } from "./context.js";
import { applyCacheBreakpoints } from "./prompt-cache.js";
import { sanitizeHistoryImages } from "./image-sanitize.js";
import { sanitizeHistoryDocuments } from "./document-sanitize.js";
import { sanitizeCombinedAttachmentBudget } from "./combined-attachment-budget.js";
import { peekTaskStore } from "../tools/task_global.js";
import { loadAllSkills } from "../skills/loader.js";
import { applySkillEnvOverrides } from "../skills/env.js";
import { truncateToolResult } from "./normalize.js";
import { LoopGuard } from "./loop_guard.js";
import { getCostTracker, calculateCost } from "./cost-tracker.js";
import {
  executeTools,
  PermissionCache,
  type PermissionResolver,
  type ToolCallResult,
} from "./tool_executor.js";
import { createSubsystemLogger } from "../logging/index.js";
import { getContextWindowTokens } from "./context-window.js";

const log = createSubsystemLogger("agent/loop");

/**
 * Stop reasons under which it is safe to execute any tool_use blocks the
 * model emitted alongside. The provider type declares stop_reason as an
 * arbitrary `string | null`, so we treat tool execution as an explicit
 * allowlist rather than "anything not obviously unsafe":
 *   - "tool_use"       — normal case, model signaled it's handing off.
 *   - "end_turn"       — Vertex/Anthropic sometimes close the stream at a
 *                        block boundary after a tool_use with end_turn set.
 *   - "max_tokens"     — similar cut-at-boundary quirk we've seen.
 *   - "stop_sequence"  — custom stop token fired; tool blocks so far are
 *                        fully-formed. Running them matches end_turn.
 *
 * Anything else with pending tool_use (pause_turn, refusal, any future
 * provider-specific value) is treated as an error path: synthesize
 * is_error tool_results to keep the assistant/tool_result invariant,
 * emit done, and break — no side effects in an unknown terminal state.
 */
const SAFE_TOOL_STOP_REASONS: ReadonlySet<string> = new Set([
  "tool_use",
  "end_turn",
  "max_tokens",
  "stop_sequence",
]);

// -----------------------------------------------------------------------------
// Agent Loop
// -----------------------------------------------------------------------------

export interface AgentLoopOptions {
  provider: LLMProvider;
  registry: ToolRegistry;
  config: HawkyConfig;
  working_directory: string;
  permissionResolver?: PermissionResolver;
  custom_instructions?: string;
  /** Session key for this loop (used by tools that need session context) */
  session_key?: string;
  /** Broadcast function for sending events to connected clients (gateway mode). */
  broadcastToSession?: (sessionKey: string, event: string, payload: unknown) => void;
}

export class AgentLoop {
  private provider: LLMProvider;
  private registry: ToolRegistry;
  private config: HawkyConfig;
  private workingDirectory: string;
  private permissionResolver: PermissionResolver | null;
  private sessionKey: string;
  private customInstructions?: string;
  private broadcastToSession?: (sessionKey: string, event: string, payload: unknown) => void;

  private history: ChatMessage[] = [];
  private emitter = new StreamEventEmitter();
  private permissionCache = new PermissionCache();
  private abortController: AbortController | null = null;
  private running = false;
  private totalUsage: TokenUsage = { input_tokens: 0, output_tokens: 0 };
  /**
   * Gate counters for the per-turn <system-reminder> block. The reminder
   * only fires when BOTH thresholds are met, matching Claude Code's
   * TODO_REMINDER_CONFIG (src/utils/attachments.ts:254 in that source).
   * Firing on every turn caused observed stalls where the agent treated
   * the reminder as a fresh user prompt and acknowledged-without-acting;
   * gating on these counters replaces that with a cooldown.
   *
   * Start at +Infinity so a fresh session with pre-existing pending
   * tasks (reload, restart, resume) DOES fire on the very first turn.
   * - `turnsSinceLastTaskAction`: resets to 0 when a task_create or
   *   task_update tool call runs. Increments per sendMessage.
   * - `turnsSinceLastReminder`: resets to 0 when the reminder fires.
   *   Increments per sendMessage.
   */
  private turnsSinceLastTaskAction = Number.POSITIVE_INFINITY;
  private turnsSinceLastReminder = Number.POSITIVE_INFINITY;
  /** In-progress streaming text for the current turn (exposed for session.currentTurn RPC) */
  private _currentStreamingText = "";
  private _currentStreamingActive = false;
  /** Per-session effort level (not shared with other sessions) */
  private _effort: "low" | "medium" | "high" | "xhigh" | "max";

  constructor(options: AgentLoopOptions) {
    this.provider = options.provider;
    this.registry = options.registry;
    this.config = options.config;
    this.workingDirectory = options.working_directory;
    this.permissionResolver = options.permissionResolver ?? null;
    this.customInstructions = options.custom_instructions;
    this.sessionKey = options.session_key ?? "default";
    this.broadcastToSession = options.broadcastToSession;
    // Initialize from config default (per-session copy, not shared reference)
    this._effort = options.config.effort ?? "medium";
    // Task-store → WebSocket bridging is owned by the registry
    // (src/tools/task_global.ts), not per AgentLoop. That way the
    // listener attaches when the store is actually created — i.e.
    // when the first task is created — instead of eagerly on every
    // loop construction. Merely opening a task-less session (which
    // builds a loop to load history) no longer allocates a store.
  }

  /**
   * No-op today. Kept as an extension hook so callers don't have to
   * change shape if we later need per-loop teardown (e.g. flushing a
   * pending stream). Session-lifecycle paths (delete / rename / evict)
   * still call it. The task-store bridge used to live here and be
   * torn down in this method; it now lives on the registry and is
   * disposed via deleteTaskStore / renameTaskStore /
   * resetAllTaskStores.
   */
  dispose(): void {}

  get effort(): "low" | "medium" | "high" | "xhigh" | "max" { return this._effort; }
  set effort(value: "low" | "medium" | "high" | "xhigh" | "max") { this._effort = value; }

  /** Replace the LLM provider used by this loop. Takes effect on the next turn. */
  setProvider(provider: LLMProvider): void {
    this.provider = provider;
  }

  /** Get the current in-progress streaming text (for session.currentTurn RPC). */
  getCurrentTurn(): { streaming: boolean; text: string; busy: boolean } {
    return { streaming: this._currentStreamingActive, text: this._currentStreamingText, busy: this.running };
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  subscribe(callback: StreamEventCallback): () => void {
    return this.emitter.subscribe(callback);
  }

  getSessionKey(): string {
    return this.sessionKey;
  }

  isRunning(): boolean {
    return this.running;
  }

  getHistory(): ChatMessage[] {
    return [...this.history];
  }

  /** Set history (for session restore) */
  setHistory(messages: ChatMessage[]): void {
    this.history = [...messages];
  }

  /** Get the permission cache (for session persistence) */
  getPermissionCache(): PermissionCache {
    return this.permissionCache;
  }

  cancel(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.emitter.emit({ type: "cancel", content: "Cancelled by user." });
    }
  }

  // No mutable headless state — headless is per-call via sendMessage options

  clearHistory(): void {
    this.history = [];
    this.permissionCache.reset();
    this.totalUsage = { input_tokens: 0, output_tokens: 0 };
    // Reset the per-turn reminder gate so a freshly-cleared conversation
    // fires the reminder on its first new turn when tasks are pending —
    // without this, stale cooldown state from the prior conversation
    // would suppress the first reminder in the new one.
    this.turnsSinceLastTaskAction = Number.POSITIVE_INFINITY;
    this.turnsSinceLastReminder = Number.POSITIVE_INFINITY;
    // Also wipe this session's task store. /new and session.clear are
    // "clean slate" from the user's perspective; without this the
    // conversation goes back to zero messages but stale tasks still
    // show up in the tray/reminders. Use peek so we don't materialize
    // a store just to clear it — if one was never created, there's
    // nothing to wipe.
    peekTaskStore(this.sessionKey)?.clear();
  }

  // ---------------------------------------------------------------------------
  // sendMessage — main entry point
  // ---------------------------------------------------------------------------

  async sendMessage(userText: string, opts?: {
    /** Headless mode: bypass permission resolver, exclude ask_user tool.
     *  Used by heartbeat/cron for background turns. */
    headless?: boolean;
    /** Image attachments to include in the user message. */
    attachments?: Array<{ base64: string; media_type: string }>;
    /** Document attachments (e.g. PDFs) to include in the user message. */
    documents?: Array<{ base64: string; media_type: string; title?: string }>;
  }): Promise<void> {
    if (this.running) {
      this.emitter.emit({
        type: "queue_message",
        content: userText,
        position: 1,
      });
      return;
    }

    this.running = true;
    this.abortController = new AbortController();

    // Inject per-skill env vars (reverted in finally block)
    let revertEnv: (() => void) | null = null;
    try {
      const skills = loadAllSkills(this.config.workspace_dir);
      revertEnv = applySkillEnvOverrides(skills, this.config.skills?.entries);
    } catch { /* skill env injection is best-effort */ }

    try {
      // Build per-turn reminders (task status, date) — but only when both
      // gating thresholds are met. See comment on the counter fields.
      //
      // Increment-before-check semantics: "turns since last X" is the
      // number of turns that have elapsed INCLUDING this one, so the
      // reminder fires every 10th turn (e.g. 1, 11, 21). With
      // +Infinity starting values the first turn always fires when
      // there are pending tasks — then the reminder counter resets to
      // 0 and must climb back to 10 before the next fire.
      // `Infinity + 1 === Infinity` so the fresh state is stable.
      this.turnsSinceLastTaskAction += 1;
      this.turnsSinceLastReminder += 1;

      const SHOULD_REMIND_TURN_THRESHOLD = 10;
      const shouldRemind =
        this.turnsSinceLastTaskAction >= SHOULD_REMIND_TURN_THRESHOLD &&
        this.turnsSinceLastReminder >= SHOULD_REMIND_TURN_THRESHOLD;

      // Scope to this session: each AgentLoop has its own sessionKey, so
      // this reads exactly the right store (eliminates the cross-session
      // contamination where tasks from session A surfaced in session B).
      // Peek (don't create) — a session with no tasks yet has no store,
      // and the reminder would be empty anyway.
      const taskStore = peekTaskStore(this.sessionKey);
      const taskSummary = taskStore?.getSummary() ?? { tasks: [], total: 0, completed: 0, in_progress: 0, pending: 0 };
      const reminder = shouldRemind
        ? buildPerTurnReminders({
            tasks: taskSummary.tasks,
            includeDate: false,
          })
        : "";

      // Reset only when the reminder actually had content to emit — the
      // gate passing with an empty reminder (no pending tasks) must NOT
      // consume the cooldown, otherwise a task that becomes pending
      // externally on the next turn would be suppressed for up to
      // another 10 turns. The task-action counter is reset independently
      // inside runLoop when a task_create / task_update tool executes.
      if (reminder.length > 0) this.turnsSinceLastReminder = 0;

      // Add user message to history (with per-turn reminder if any)
      const contentBlocks: ContentBlock[] = [];
      if (reminder) {
        contentBlocks.push({ type: "text", text: reminder, internal_only: true });
      }
      contentBlocks.push({ type: "text", text: userText });

      // Append image attachments as image content blocks
      if (opts?.attachments) {
        for (const att of opts.attachments) {
          contentBlocks.push({
            type: "image",
            source: {
              type: "base64",
              media_type: att.media_type,
              data: att.base64,
            },
          } as ImageContentBlock);
        }
      }

      // Append document attachments (PDFs) as document content blocks
      if (opts?.documents) {
        for (const doc of opts.documents) {
          contentBlocks.push({
            type: "document",
            source: {
              type: "base64",
              media_type: doc.media_type,
              data: doc.base64,
            },
            ...(doc.title ? { title: doc.title } : {}),
          });
        }
      }

      const userMessage: ChatMessage = {
        role: "user",
        content: contentBlocks,
        timestamp: new Date().toISOString(),
      };
      this.history.push(userMessage);

      // Tell subscribers the user message was just committed at this index.
      // The web UI uses this to stamp `backendIndex` on its optimistic user
      // bubble, which in turn is what gates the edit/rewind affordance —
      // without this event the pencil would only appear after the next
      // session.history fetch (typically post-turn).
      this.emitter.emit({
        type: "user_committed",
        message_index: this.history.length - 1,
      });

      await this.runLoop(opts?.headless === true);

      // NOTE: Images are NOT stripped after each turn. Instead, sanitizeHistoryImages()
      // runs before each API call and replaces oldest images with placeholders when
      // total image bytes exceed budget. This preserves multi-turn image reference
      // (model can "look at that screenshot again") while preventing size blowup.
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("agent error", { error: msg, code: errorCode(err) });
      this.emitter.emit({ type: "error", content: msg, code: errorCode(err) });
    } finally {
      this.running = false;
      this.abortController = null;
      revertEnv?.(); // Revert skill env vars
    }
  }

  // ---------------------------------------------------------------------------
  // Core loop
  // ---------------------------------------------------------------------------

  private async runLoop(headless = false): Promise<void> {
    const guard = new LoopGuard(this.config.max_iterations);
    const signal = this.abortController!.signal;

    while (true) {
      if (signal.aborted) break;

      const iteration = guard.nextIteration();

      // Check iteration limit
      if (guard.isOverLimit()) {
        this.emitter.emit({
          type: "error",
          content: `Reached maximum iterations (${this.config.max_iterations}). ` +
            "The agent was stopped to prevent runaway execution.",
          code: "max_iterations",
        });
        break;
      }

      // Build API request
      const systemPrompt = buildSystemPrompt({
        working_directory: this.workingDirectory,
        model: this.config.model,
        custom_instructions: this.customInstructions,
        workspace_dir: this.config.workspace_dir,
        headless,
      });

      // Sanitize images before building API payload — replace oldest images
      // with placeholders if total image bytes exceed budget. This prevents
      // accumulated screenshots/attachments from causing 413 errors.
      sanitizeHistoryImages(this.history);
      sanitizeHistoryDocuments(this.history);
      // Both per-bucket sanitizers can each leave their max — combined
      // that may still exceed the provider's request ceiling. Final pass
      // trims oldest (across buckets) until the total fits.
      sanitizeCombinedAttachmentBudget(this.history);

      // The agent normally sees the full session history — the old 50-turn
      // cap was the root of the "% never grows past 5-7" bug and is gone.
      // The countTokens-driven metric below + auto-compaction at the 95%
      // threshold are the real safety net for normal flow. Image / document
      // byte budgets are still enforced by the sanitize* calls above.
      //
      // PRE-CALL SAFETY NET: a hard message-count ceiling that's far above
      // typical use but prevents pathological context_overflow when a
      // session has somehow grown past the point where compaction can
      // help (e.g. on the very first turn after upgrade from a build that
      // had no truncation, with a JSONL of thousands of messages). Without
      // this guard a single oversized session would lock up — the API
      // rejects, no `done` event fires, post-turn auto-compaction never
      // runs, and the user is stuck.
      //
      // The cap is model-aware: it scales with the model's context window
      // so the ceiling is always meaningfully ABOVE where auto-compaction
      // (95% threshold) realistically engages. A flat 1000 was too low
      // for 1M-context models (sonnet-4-6, opus-4-7) — sessions were
      // hitting the cap at 5-10% of context, dropping oldest messages
      // every turn while compaction never had a chance. A flat 5000 was
      // too high for 200K models (haiku-4-5, unknowns) — pathologically
      // long sessions could overflow context BEFORE the cap fired.
      //
      // Formula: 1 message of headroom per 200 tokens of context window,
      // floored at 1000 for safety on small/unknown models.
      //   200K window → 1000 messages  (matches old default)
      //   1M   window → 5000 messages
      const PRE_CALL_SAFETY_MESSAGE_CAP = Math.max(
        1000,
        Math.round(getContextWindowTokens(this.config.model) / 200),
      );
      if (this.history.length > PRE_CALL_SAFETY_MESSAGE_CAP) {
        const dropped = this.history.length - PRE_CALL_SAFETY_MESSAGE_CAP;
        log.warn("pre-call safety truncation: dropping oldest messages", {
          sessionKey: this.sessionKey,
          dropped,
          newLength: PRE_CALL_SAFETY_MESSAGE_CAP,
        });
        this.history = this.history.slice(-PRE_CALL_SAFETY_MESSAGE_CAP);
      }
      const messages = formatMessagesForApi(this.history);

      // In headless mode, exclude interactive tools (ask_user) that would block
      const tools = headless
        ? this.registry.getApiDefinitions().filter((t) => t.name !== "ask_user")
        : this.registry.getApiDefinitions();

      // Build the base request, then attach prompt-cache breakpoints. We
      // mark the system prompt, the last tool, and the last message in
      // history. Without these markers the API would re-bill the full
      // conversation as fresh input on every call (~10× more expensive).
      // See src/agent/prompt-cache.ts for the placement rationale.
      const baseRequest: LLMStreamRequest = {
        model: this.config.model,
        max_tokens: this.config.max_tokens,
        messages,
        system: systemPrompt,
        ...(tools.length > 0 ? { tools } : {}),
        output_config: { effort: this._effort },
      };
      const request = applyCacheBreakpoints(baseRequest);

      // Call LLM with retry for retryable errors
      let streamResult: StreamResult;
      try {
        streamResult = await this.streamWithRetry(request, signal);
      } catch (err) {
        throw err; // Non-retryable, propagate to sendMessage catch
      }

      const { textContent, thinkingContent, toolCalls, stopReason, usage } = streamResult;

      // Accumulate usage + track cost. All four token categories are summed
      // across the session (Anthropic reports per-call values, we want the
      // session total for cost reporting and the `done` event payload).
      if (usage) {
        this.totalUsage.input_tokens += usage.input_tokens;
        this.totalUsage.output_tokens += usage.output_tokens;
        this.totalUsage.cache_read_input_tokens =
          (this.totalUsage.cache_read_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
        this.totalUsage.cache_creation_input_tokens =
          (this.totalUsage.cache_creation_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);

        // Cost tracking (per-session)
        const tracker = getCostTracker();
        if (tracker) {
          tracker.addUsage(this.config.model, usage, this.sessionKey);
        }
      }

      // Build assistant message
      const assistantContent: ContentBlock[] = [];
      if (thinkingContent) {
        assistantContent.push({ type: "thinking", thinking: thinkingContent });
      }
      if (textContent) {
        assistantContent.push({ type: "text", text: textContent });
      }
      for (const tc of toolCalls) {
        assistantContent.push({
          type: "tool_use",
          id: tc.id,
          name: tc.name,
          input: tc.input,
        });
      }

      // Reset the task-action counter whenever this iteration includes a
      // task_create / task_update tool call. Done here — at assistant-
      // message build time — rather than inside the tool executor so it
      // fires even if the tool later errors out: what matters for the
      // reminder gate is that the MODEL addressed the task state.
      if (toolCalls.some((tc) => tc.name === "task_create" || tc.name === "task_update")) {
        this.turnsSinceLastTaskAction = 0;
      }

      if (assistantContent.length > 0) {
        this.history.push({
          role: "assistant",
          content: assistantContent,
          timestamp: new Date().toISOString(),
        });
      }

      // End-of-loop conditions:
      //  1. No tool calls — model's done, emit `done` and break.
      //  2. Tool calls present but `stopReason` is outside the safe allowlist
      //     — unknown terminal state; synthesize `is_error` tool_results to
      //     keep the assistant/tool_result invariant, then done+break. No
      //     side effects under a stop reason we don't understand.
      //  3. Tool calls present AND `stopReason` is in the allowlist — fall
      //     through to executeTools. This is the Vertex/Anthropic "cut at
      //     block boundary" quirk that PR #161's executeTools try/catch
      //     couldn't cover because executeTools was never reached.
      const noToolCalls = toolCalls.length === 0;
      const stopReasonSafe = stopReason === null || SAFE_TOOL_STOP_REASONS.has(stopReason);
      if (noToolCalls || !stopReasonSafe) {
        if (!noToolCalls && !stopReasonSafe) {
          log.warn("unexpected stop_reason with pending tool calls — synthesizing error results", {
            sessionKey: this.sessionKey,
            stopReason,
            toolCallCount: toolCalls.length,
          });
          this.history.push({
            role: "user",
            content: toolCalls.map((tc) => ({
              type: "tool_result",
              tool_use_id: tc.id,
              content: `[tool execution skipped: model returned unexpected stop_reason "${stopReason}"]`,
              is_error: true,
            })),
            timestamp: new Date().toISOString(),
          });
        }
        // Compute context usage from the REAL size of what the next API
        // call would send (system + tools + full history including the
        // assistant response we just appended). This uses Anthropic's
        // count_tokens endpoint — accurate, free, no model invocation.
        // Falls back to the old per-call billed input on failure rather
        // than dropping the metric to 0 on a transient countTokens error.
        const contextWindow = getContextWindowTokens(this.config.model);
        const billedInput = (usage?.input_tokens ?? 0)
          + (usage?.cache_read_input_tokens ?? 0)
          + (usage?.cache_creation_input_tokens ?? 0);
        let contextInputTokens = billedInput;
        try {
          const counted = await this.provider.countTokens({
            model: this.config.model,
            messages: formatMessagesForApi(this.history),
            system: systemPrompt,
            ...(tools.length > 0 ? { tools } : {}),
          }, signal);
          contextInputTokens = counted.input_tokens;
        } catch (countErr) {
          log.warn("countTokens failed, falling back to billed input for metric", {
            sessionKey: this.sessionKey,
            error: countErr instanceof Error ? countErr.message : String(countErr),
          });
        }
        const usagePercent = contextWindow > 0
          ? Math.round((contextInputTokens / contextWindow) * 100)
          : 0;
        // Include session cost from the cost tracker
        const costTracker = getCostTracker();
        const sessionCostUSD = costTracker?.getSessionUsage(this.sessionKey).costUSD;
        // Per-call diagnostics for the "last turn" debug footer. `usage`
        // here is the LAST API response's billed numbers (input split into
        // non-cached / cache_read / cache_creation). The cost is computed
        // from that one call's usage — distinct from sessionCostUSD which
        // is cumulative. Lets the UI show what the most recent call cost
        // and whether prompt caching kicked in.
        const lastTurnCostUSD = usage
          ? calculateCost(this.config.model, usage)
          : undefined;
        this.emitter.emit({
          type: "done",
          usage: {
            ...this.totalUsage,
            context_window_tokens: contextWindow,
            context_usage_percent: usagePercent,
          },
          sessionCostUSD,
          lastTurnUsage: usage
            ? {
                input_tokens: usage.input_tokens,
                output_tokens: usage.output_tokens,
                cache_read_input_tokens: usage.cache_read_input_tokens,
                cache_creation_input_tokens: usage.cache_creation_input_tokens,
              }
            : undefined,
          lastTurnCostUSD,
        });
        break;
      }

      // Execute tools (three-phase)
      // Internal refs let the agent tool create child loops (sub-agent support).
      const toolContext = {
        session_id: this.sessionKey,
        working_directory: this.workingDirectory,
        abort_signal: signal,
        emit: (event: StreamEvent) => this.emitter.emit(event),
        headless,
        _agentLoop: this,
        _provider: this.provider,
        _registry: this.registry,
        _config: this.config,
        _broadcastToSession: this.broadcastToSession,
      } as ToolContext;

      // In headless mode, bypass permission resolver (auto-approve all tools)
      const effectiveResolver = headless
        ? null
        : this.permissionResolver;

      // History invariant: every tool_use in the assistant message above MUST
      // be followed by a matching tool_result in the next user message.
      // `executeTools` returns results even on per-tool errors, but CAN throw
      // (permission resolver, loop guard, unexpected tool exception). If it
      // throws, synthesize error-typed tool_results for every outstanding id
      // BEFORE rethrowing, so the persisted history stays valid. Without this,
      // the next API call fails with 400 "tool_use ids without tool_result".
      let toolResults;
      try {
        toolResults = await executeTools(
          toolCalls,
          this.registry,
          toolContext,
          this.permissionCache,
          effectiveResolver,
          guard,
          (event) => this.emitter.emit(event),
          this.config.permissions,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const syntheticResults = toolCalls.map((tc) => ({
          type: "tool_result" as const,
          tool_use_id: tc.id,
          content: `[tool execution aborted before completion: ${msg}]`,
          is_error: true,
        }));
        this.history.push({
          role: "user",
          content: syntheticResults,
          timestamp: new Date().toISOString(),
        });
        throw err;
      }

      // Build tool result message (user role per Anthropic API)
      const maxChars = this.config.max_tool_result_chars;
      const toolResultContent: ContentBlock[] = toolResults.map((tr) => {
        // Image results: send as multimodal content blocks (text + image)
        // so the model can actually see the image via its vision capability.
        if (tr.result.type === "image") {
          const imageBlocks: Array<{ type: "image"; source: { type: "base64"; media_type: string; data: string } }> = [
            {
              type: "image" as const,
              source: {
                type: "base64" as const,
                media_type: tr.result.media_type,
                data: tr.result.base64,
              },
            },
          ];
          // Include extra images (e.g., additional monitors)
          if (tr.result.extra_images) {
            for (const img of tr.result.extra_images) {
              imageBlocks.push({
                type: "image" as const,
                source: {
                  type: "base64" as const,
                  media_type: img.media_type,
                  data: img.base64,
                },
              });
            }
          }
          return {
            type: "tool_result" as const,
            tool_use_id: tr.tool_use_id,
            content: [
              { type: "text" as const, text: tr.result.content },
              ...imageBlocks,
            ],
            is_error: false,
          };
        }
        // Document results: send as text + document block so the model
        // reads the PDF natively (text + images + layout preserved).
        if (tr.result.type === "document") {
          return {
            type: "tool_result" as const,
            tool_use_id: tr.tool_use_id,
            content: [
              { type: "text" as const, text: tr.result.content },
              {
                type: "document" as const,
                source: {
                  type: "base64" as const,
                  media_type: tr.result.media_type,
                  data: tr.result.base64,
                },
                ...(tr.result.title ? { title: tr.result.title } : {}),
              },
            ],
            is_error: false,
          };
        }
        // Text/error results: plain string content
        return {
          type: "tool_result" as const,
          tool_use_id: tr.tool_use_id,
          content: truncateToolResult(tr.result.content, maxChars),
          is_error: tr.result.type === "error",
        };
      });

      this.history.push({
        role: "user",
        content: toolResultContent,
        timestamp: new Date().toISOString(),
      });

      if (signal.aborted) break;

      // Warn if approaching limit
      if (guard.isApproachingLimit()) {
        this.emitter.emit({
          type: "system_message",
          content: `Approaching iteration limit (${guard.currentIteration}/${this.config.max_iterations}).`,
          subtype: "info",
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Stream from provider and collect results
  // ---------------------------------------------------------------------------

  private async streamWithRetry(
    request: LLMStreamRequest,
    signal: AbortSignal,
    maxRetries = 2,
  ): Promise<StreamResult> {
    let lastError: LLMError | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this.streamOnce(request, signal);
      } catch (err) {
        if (err instanceof LLMError && err.retryable && attempt < maxRetries) {
          lastError = err;
          // Brief pause before retry
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
        throw err;
      }
    }

    throw lastError!;
  }

  private async streamOnce(
    request: LLMStreamRequest,
    signal: AbortSignal,
  ): Promise<StreamResult> {
    // Reset streaming state from any previous call
    this._pendingToolStart = null;

    let textContent = "";
    let thinkingContent = "";
    const toolCalls: ToolUseRequest[] = [];
    this._currentStreamingText = "";
    this._currentStreamingActive = true;
    let currentToolIndex = -1;
    let currentToolJsonParts: string[] = [];
    let stopReason: string | null = null;
    let usage: TokenUsage | null = null;

    try {
      for await (const event of this.provider.stream(request, signal)) {
        switch (event.type) {
          case "text_delta":
            textContent += event.text;
            this._currentStreamingText = textContent;
            this.emitter.emit({ type: "text", content: event.text });
            break;

          case "thinking_delta":
            thinkingContent += event.thinking;
            this.emitter.emit({ type: "thinking", content: event.thinking });
            break;

          case "tool_use_start":
            currentToolIndex = event.index;
            currentToolJsonParts = [];
            // Don't emit ToolUseStartEvent yet — tool_executor handles that
            // after permission check
            break;

          case "tool_use_input_delta":
            currentToolJsonParts.push(event.partial_json);
            break;

          case "content_block_stop": {
            // If we were accumulating a tool call, finalize it
            if (currentToolIndex >= 0 && this._pendingToolStart) {
              const jsonStr = currentToolJsonParts.join("");
              let input: Record<string, unknown> = {};
              try {
                input = jsonStr ? JSON.parse(jsonStr) : {};
              } catch {
                input = { _raw: jsonStr };
              }
              toolCalls.push({
                id: this._pendingToolStart.id,
                name: this._pendingToolStart.name,
                input,
              });
              this._pendingToolStart = null;
            }
            currentToolIndex = -1;
            currentToolJsonParts = [];
            break;
          }

          case "message_start":
            if (event.usage) {
              usage = event.usage;
            }
            break;

          case "message_delta":
            stopReason = event.stop_reason;
            if (event.usage && usage) {
              usage.output_tokens = event.usage.output_tokens;
            }
            break;

          case "message_stop":
            break;
        }

        // Also track tool_use_start for ID/name association
        if (event.type === "tool_use_start") {
          this._pendingToolStart = { id: event.id, name: event.name };
        }
      }
    } finally {
      this._currentStreamingActive = false;
    }

    return { textContent, thinkingContent, toolCalls, stopReason, usage };
  }

  // Temporary state for associating tool_use_start with content_block_stop
  private _pendingToolStart: { id: string; name: string } | null = null;
}

// -----------------------------------------------------------------------------
// Internal types
// -----------------------------------------------------------------------------

interface StreamResult {
  textContent: string;
  thinkingContent: string;
  toolCalls: ToolUseRequest[];
  stopReason: string | null;
  usage: TokenUsage | null;
}

function errorCode(err: unknown): string {
  if (err instanceof LLMError) return err.code;
  return "unknown";
}
