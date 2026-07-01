// =============================================================================
// Hawky Core Types
//
// Single type system that matches Anthropic API format (snake_case) with
// extra fields for our agent loop and UI. No conversion needed between
// persistence, API, and UI layers.
// =============================================================================

// -----------------------------------------------------------------------------
// Stream Events - Real-time events emitted by the agent loop to the UI
// -----------------------------------------------------------------------------

export type StreamEventType =
  | "text"                // Assistant text delta (streaming tokens)
  | "thinking"            // Extended thinking delta
  | "tool_use_start"      // Tool invocation begins (shows tool name + params)
  | "tool_streaming"      // Live tool output (e.g., bash stdout line-by-line)
  | "tool_result"         // Tool execution completed
  | "permission_request"  // Waiting for user to approve/deny a tool
  | "permission_result"   // User approved/denied
  | "ask_user_request"    // Tool asks user a question, waits for answer
  | "ask_user_response"   // User's answer to an ask_user question
  | "error"               // Error occurred
  | "done"                // Agent turn complete
  | "cancel"              // Agent was cancelled
  | "queue_message"       // User message queued (agent is busy)
  | "system_message"      // System info (compaction, heartbeat, etc.)
  | "user_committed";     // User message just appended to history; carries the committed index

export interface TextStreamEvent {
  type: "text";
  content: string;         // Text delta (not the full text, just the new chunk)
  replace?: boolean;       // Replace the current streaming text with content
}

export interface ThinkingStreamEvent {
  type: "thinking";
  content: string;         // Thinking delta
}

export interface ToolUseStartEvent {
  type: "tool_use_start";
  tool_use_id: string;
  name: string;
  input: Record<string, unknown>;
  /** Why this tool was auto-approved (undefined if user was prompted) */
  approvalReason?: "auto_approve" | "safe_command" | "always_allowed" | "allow_all" | "accept_edits" | "allow_directory" | "config_allow";
  /** Batch ID — tools in the same Promise.all share this ID for visual grouping */
  batchId?: string;
  /** Total number of tools in this batch */
  batchSize?: number;
}

export interface ToolStreamingEvent {
  type: "tool_streaming";
  tool_use_id: string;
  stream_type: "stdout" | "stderr";
  content: string;         // A line of output
}

export interface ToolResultEvent {
  type: "tool_result";
  tool_use_id: string;
  name: string;
  content: string;         // Text result sent to API
  display_content?: string; // Rich content for UI only (not sent to API)
  is_error: boolean;
  metadata?: Record<string, unknown>; // Tool-specific metadata (e.g., diff data for edit_file)
}

export interface PermissionRequestEvent {
  type: "permission_request";
  id: string;              // Unique ID for this permission request
  tool_use_id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  /** Context-aware suggestions (e.g., "switch to acceptEdits", "allow edits in folder") */
  suggestions?: PermissionSuggestion[];
  /**
   * A suggested rule pattern to attach to "allow always". Used by the
   * frontend to power the "Allow `<pattern>` always" button — clicking
   * it sends the pattern back via `permission.resolve` so the cache
   * stores it as a rule rather than an exact-match grant. The
   * suggestion is computed by `suggestRulePattern` on the backend so
   * the web/TUI dialogs don't need to re-implement the heuristic.
   */
  suggestedPattern?: string;
}

export interface PermissionResultEvent {
  type: "permission_result";
  id: string;              // Matches the permission request ID
  decision: "allow_once" | "allow_always" | "allow_all" | "accept_edits" | "allow_directory" | "deny";
}

export interface ErrorStreamEvent {
  type: "error";
  content: string;
  code?: string;           // e.g., "api_error", "tool_error", "max_iterations"
}

export interface DoneStreamEvent {
  type: "done";
  usage?: TokenUsage;
  /** Accumulated session cost estimate (USD). */
  sessionCostUSD?: number;
  /** Billed token counts for ONLY the last API call of this turn — distinct
   *  from `usage` which is cumulative for the session. Drives the debug
   *  footer that shows what the last call billed (and whether caching
   *  helped). */
  lastTurnUsage?: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  /** Cost in USD for that last call alone, computed from lastTurnUsage. */
  lastTurnCostUSD?: number;
}

export interface CancelStreamEvent {
  type: "cancel";
  content: string;         // e.g., "Request cancelled by user"
}

export interface AskUserRequestEvent {
  type: "ask_user_request";
  id: string;              // Unique request ID (for correlating response)
  tool_use_id: string;
  question: string;
  options: string[];       // Display options (includes auto-added meta-options)
  multi_select: boolean;
}

export interface AskUserResponseEvent {
  type: "ask_user_response";
  id: string;              // Matches the request ID
  selected: string[];      // Selected option(s) or free-form text
}

export interface QueueMessageEvent {
  type: "queue_message";
  content: string;         // The queued user message
  position: number;        // Queue position (1-based)
}

export interface SystemMessageEvent {
  type: "system_message";
  content: string;
  subtype?: "compaction" | "heartbeat" | "info";
}

/** Fired exactly once per turn, the moment the user message is appended to
 *  the agent loop's history. Carries the message's absolute index so a
 *  client that just optimistically rendered the user bubble can stamp it
 *  with the correct backendIndex without polling or re-fetching history. */
export interface UserCommittedStreamEvent {
  type: "user_committed";
  message_index: number;
}

export type StreamEvent =
  | TextStreamEvent
  | ThinkingStreamEvent
  | ToolUseStartEvent
  | ToolStreamingEvent
  | ToolResultEvent
  | PermissionRequestEvent
  | PermissionResultEvent
  | AskUserRequestEvent
  | AskUserResponseEvent
  | ErrorStreamEvent
  | DoneStreamEvent
  | CancelStreamEvent
  | QueueMessageEvent
  | SystemMessageEvent
  | UserCommittedStreamEvent;

/** Timestamped wrapper used internally for ordering */
export interface TimestampedStreamEvent {
  event: StreamEvent;
  timestamp_ms: number;
}

// -----------------------------------------------------------------------------
// Token Usage
// -----------------------------------------------------------------------------

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  /** Context window size for the model (tokens). */
  context_window_tokens?: number;
  /** Percentage of context window used (0-100). Based on input_tokens + cache_read + cache_creation. */
  context_usage_percent?: number;
}

// -----------------------------------------------------------------------------
// Tool System
// -----------------------------------------------------------------------------

export type PermissionLevel = "auto_approve" | "ask_user" | "always_approve";

/** Permission mode — controls how aggressively tools are auto-approved.
 *  Matches Claude Code's permission modes (subset we implement). */
export type PermissionMode = "default" | "accept-edits" | "bypass";

/** Suggestion offered alongside a permission prompt (e.g., "Allow edits in this folder"). */
export type PermissionSuggestion =
  | { type: "setMode"; mode: PermissionMode }
  | { type: "addDirectory"; directory: string };

export interface ToolInputSchema {
  type: "object";
  properties: Record<string, ToolSchemaProperty>;
  required?: string[];
}

export interface ToolSchemaProperty {
  type: "string" | "number" | "boolean" | "integer" | "array" | "object";
  description: string;
  default?: unknown;
  enum?: unknown[];
  items?: ToolSchemaProperty;
}

/**
 * Definition of a tool that the agent can invoke.
 *
 * The `permission` field is the DEFAULT policy. It can be overridden
 * per-session by the PermissionManager (e.g., "allow always" for bash,
 * or session-wide "approve all").
 */
export interface ToolDefinition<TInput = Record<string, unknown>> {
  name: string;
  description: string;
  input_schema: ToolInputSchema;
  execute: (input: TInput, context: ToolContext) => Promise<ToolResult>;
  /** Default permission level. Can be overridden per-session. */
  permission: PermissionLevel;
}

/**
 * Context passed to tool execution functions.
 */
export interface ToolContext {
  session_id: string;
  working_directory: string;
  abort_signal: AbortSignal;
  /** Emit streaming events (e.g., bash stdout lines) during tool execution */
  emit: (event: StreamEvent) => void;
  /** True when running in headless mode (heartbeat/cron) */
  headless?: boolean;
  /**
   * Per-run skill env vars, merged over process.env for subprocesses that need
   * them (the bash tool). Kept per-run (not written to the global process.env)
   * so concurrent sessions can't leak each other's skill secrets.
   */
  skillEnv?: Record<string, string>;
}

/**
 * Result returned by a tool execution.
 *
 * `content` is what gets sent to the Claude API as the tool result.
 * `display_content` is optional richer content for the UI only.
 */
export type ToolResult = TextToolResult | ImageToolResult | DocumentToolResult | ErrorToolResult;

export interface TextToolResult {
  type: "text";
  content: string;
  /** Rich formatted content for UI display only (not sent to API) */
  display_content?: string;
  /** Metadata (e.g., exit code for bash, bytes written for write_file) */
  metadata?: Record<string, unknown>;
}

/** Tool result containing an image for the model to visually inspect. */
/** Tool result containing an image for the model to visually inspect. */
export interface ImageToolResult {
  type: "image";
  /** Short text description for UI display (e.g., "Image: screenshot.png (image/png, 93KB)") */
  content: string;
  /** Base64-encoded image data for the API. */
  base64: string;
  /** MIME type (e.g., "image/png"). */
  media_type: string;
  /** Additional images (e.g., multiple monitors). All sent to the model. */
  extra_images?: Array<{ base64: string; media_type: string }>;
  display_content?: string;
  metadata?: Record<string, unknown>;
}

/** Tool result containing a document (e.g. PDF) for the model to read. */
export interface DocumentToolResult {
  type: "document";
  /** Short text description for UI display (e.g., "PDF: report.pdf (2.1MB)") */
  content: string;
  /** Base64-encoded document data for the API. */
  base64: string;
  /** MIME type. Currently only "application/pdf" is supported by the Anthropic API. */
  media_type: string;
  /** Optional document title — surfaced to the model as part of the block. */
  title?: string;
  display_content?: string;
  metadata?: Record<string, unknown>;
}

export interface ErrorToolResult {
  type: "error";
  content: string;
  display_content?: string;
  metadata?: Record<string, unknown>;
}

/**
 * A pending tool call extracted from the Claude API response.
 */
export interface ToolUseRequest {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * Tool definition in the format expected by the Anthropic API.
 */
/**
 * Anthropic prompt-cache marker. When present on a content block, the API
 * caches everything in the request up to and including that block for ~5
 * minutes; subsequent requests sharing that exact prefix get billed at the
 * cache_read rate (~10× cheaper than fresh input). Up to 4 markers per
 * request — see https://docs.anthropic.com/claude/docs/prompt-caching.
 */
export interface CacheControl {
  type: "ephemeral";
}

export interface AnthropicToolDefinition {
  name: string;
  description: string;
  input_schema: ToolInputSchema;
  /** Mark this tool as a cache breakpoint — see CacheControl. */
  cache_control?: CacheControl;
}

// -----------------------------------------------------------------------------
// Chat Messages - Conversation history matching Anthropic API format
// -----------------------------------------------------------------------------

export interface TextContentBlock {
  type: "text";
  text: string;
  /** If true, this block is hidden from user display (system reminders, etc.) */
  internal_only?: boolean;
  /** If set, show this in UI instead of `text` (e.g., original slash command) */
  display_text?: string;
  /** Optional prompt-cache breakpoint. See CacheControl. */
  cache_control?: CacheControl;
}

export interface ThinkingContentBlock {
  type: "thinking";
  thinking: string;
  signature?: string;
}

export interface ToolUseContentBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** A single block within a tool result's content array (for multimodal results). */
export interface ToolResultImageBlock {
  type: "image";
  source: {
    type: "base64";
    media_type: string;
    data: string;
  };
}

/** A document block inside a tool result (e.g. read_file on a .pdf). */
export interface ToolResultDocumentBlock {
  type: "document";
  source: {
    type: "base64";
    media_type: string;
    data: string;
  };
  title?: string;
}

export interface ToolResultTextBlock {
  type: "text";
  text: string;
}

/** Content of a tool result: plain string, or array of text/image/document blocks. */
export type ToolResultContent = string | Array<ToolResultTextBlock | ToolResultImageBlock | ToolResultDocumentBlock>;

export interface ToolResultContentBlock {
  type: "tool_result";
  tool_use_id: string;
  content: ToolResultContent;
  is_error?: boolean;
  /** Rich display content for UI only */
  display_content?: string;
  /** Optional prompt-cache breakpoint. See CacheControl. */
  cache_control?: CacheControl;
}

/** An image block in a user message (for user-attached images). */
export interface ImageContentBlock {
  type: "image";
  source: {
    type: "base64";
    media_type: string;
    data: string;
  };
  /** Optional prompt-cache breakpoint. See CacheControl. */
  cache_control?: CacheControl;
}

/** A document block in a user message (for user-attached PDFs). */
export interface DocumentContentBlock {
  type: "document";
  source: {
    type: "base64";
    media_type: string;
    data: string;
  };
  title?: string;
  /** Optional prompt-cache breakpoint. See CacheControl. */
  cache_control?: CacheControl;
}

export type ContentBlock =
  | TextContentBlock
  | ThinkingContentBlock
  | ToolUseContentBlock
  | ToolResultContentBlock
  | ImageContentBlock
  | DocumentContentBlock;

/**
 * A single message in the conversation history.
 * Matches the Anthropic API message format with extra metadata.
 */
export interface ChatMessage {
  role: "user" | "assistant";
  content: ContentBlock[];
  /** Unique message ID (for deduplication on reconnect) */
  id?: string;
  /** Timestamp when the message was created */
  timestamp?: string;
}

// -----------------------------------------------------------------------------
// Agent Service Interface - The public API of the agent core
// -----------------------------------------------------------------------------

export type StreamEventCallback = (event: StreamEvent) => void;

export interface SendMessageOptions {
  /** Skills to activate for this message */
  active_skills?: string[];
  /** Internal prefix content (system reminders, memory) */
  internal_prefix?: string;
  /** Internal suffix content */
  internal_suffix?: string;
  /** Display text override for the user message in UI */
  display_text?: string;
  /** Pre-assigned message ID (for deduplication) */
  message_id?: string;
}

/**
 * The public API for interacting with the agent.
 */
export interface AgentEventSource {
  /** Subscribe to stream events. Returns an unsubscribe function. */
  subscribe(callback: StreamEventCallback): () => void;

  /** Send a user message. Events are emitted via subscribe callback. */
  sendMessage(message: string, options?: SendMessageOptions): Promise<void>;

  /** Cancel the current agent turn. */
  cancel(): void;

  /** Respond to a permission request. */
  respondToPermission(
    request_id: string,
    decision: "allow_once" | "allow_always" | "allow_all" | "accept_edits" | "allow_directory" | "deny",
  ): void;

  /** Check if the agent is currently processing. */
  isRunning(): boolean;

  /** Clear conversation history and start fresh. */
  clearHistory(): void;
}

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

export interface OpenAICompatibleProfile {
  base_url: string;
  api_key?: string;
  /** Environment variable name to read the API key from. */
  api_key_env?: string;
  /** Model override for this profile; falls back to top-level config.model if unset. */
  model?: string;
}

export interface HawkyConfig {
  /** API keys for external services */
  api_keys: {
    anthropic: string;
    brave_search: string;
    openai: string;
  };
  /** Anthropic API base URL (default: https://api.anthropic.com). Override for proxies. */
  api_base_url: string;
  /** Which LLM backend to use.
   *  - "anthropic" (default): direct api.anthropic.com via API key.
   *  - "vertex": Google Cloud Vertex AI via ADC. Requires `vertex.project_id`.
   *  - "openai": any OpenAI-API-compatible endpoint (vLLM/Ollama/OpenAI/Groq/etc.).
   *  - "openai_compatible": named profiles for multiple OpenAI-protocol endpoints.
   *  See deploy/VERTEX_SETUP.md for GCP setup. */
  provider?: "anthropic" | "vertex" | "openai" | "openai_compatible";
  /** Custom OpenAI-protocol base URL (e.g. "https://api.deepinfra.com/v1/openai").
   *  When unset, the SDK defaults to https://api.openai.com/v1.
   *  Set via HAWKY_OPENAI_BASE_URL env or config.json. */
  openai_base_url?: string;
  /** Multi-profile OpenAI-compatible endpoints. Only consulted when provider === "openai_compatible". */
  openai_compatible?: {
    active_profile?: string;
    profiles?: Record<string, OpenAICompatibleProfile>;
  };
  /** Vertex AI connection config. Only consulted when provider === "vertex". */
  vertex?: {
    /** GCP project ID (e.g. "hawky-prod"). Required when provider=vertex. */
    project_id: string;
    /** Vertex region. Opus 4.7 is served from the global endpoint. */
    region?: string;
  };
  /** Model to use */
  model: string;
  /** Max output tokens per API call */
  max_tokens: number;
  /** Effort level — controls how thoroughly the model responds.
   *  "low", "medium", "high" (API default), "xhigh", "max". Maps to
   *  output_config.effort. "xhigh" was added alongside claude-opus-4-7.
   *  Does not require thinking to be enabled. Default: "medium". */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Max agent loop iterations */
  max_iterations: number;
  /** Max tool result characters before truncation */
  max_tool_result_chars: number;
  /** Memory feature (#653) configuration. */
  memory?: {
    /**
     * Model used for memory distillation (session → daily log → MEMORY.md).
     * Defaults to "claude-haiku-4-5". When a Claude model, distillation uses the
     * Anthropic provider directly (api_keys.anthropic), independent of the
     * default chat provider.
     */
    distill_model?: string;
  };
  /** Workspace directory */
  workspace_dir: string;
  /** Gateway server port */
  gateway_port: number;
  /** Heartbeat configuration */
  heartbeat: {
    enabled: boolean;
    interval_minutes: number;
    /** Override model for heartbeat (cheaper model ok). Falls back to global model. */
    model?: string | null;
    /** Max recent messages to keep in heartbeat session (prevents context bloat). */
    keep_recent_messages: number;
    /** Active hours window. Heartbeats skipped outside this range. */
    active_hours: {
      start: string;
      end: string;
      timezone?: string;
    };
    /** Memory consolidation: review daily logs and promote facts to MEMORY.md. */
    consolidation_enabled?: boolean;
    /** Number of recent daily log days to review during consolidation (default: 3). */
    consolidation_days?: number;
    /** How often to run consolidation in hours (default: 24). */
    consolidation_frequency_hours?: number;
    /** Session distillation: extract facts from un-flushed sessions into daily logs. */
    distillation_enabled?: boolean;
    /** How often to run distillation in hours (default: 6). */
    distillation_frequency_hours?: number;
    /** Minimum new messages in a session before distillation runs (default: 10). */
    distillation_min_new_messages?: number;
    /** Session to proactively deliver heartbeat findings to.
     *  Default: "web:general". Set to "" to disable proactive delivery. */
    delivery_target?: string;
  };
  /** Cron scheduler configuration */
  cron?: {
    enabled?: boolean;
    max_concurrent_runs?: number;
    max_missed_on_restart?: number;
    retention?: {
      session_days?: number;
      run_log_max_lines?: number;
      run_log_max_bytes?: number;
      reaper_interval_minutes?: number;
    };
  };
  /** Memory flush: extract durable memories on /flush or token pressure. */
  memory_flush?: {
    enabled?: boolean;
    /** Context usage threshold (percentage, 0-100) to trigger flush. Default: 90. */
    threshold_percent?: number;
  };
  /** Lane concurrency limits for parallel execution. */
  concurrency?: {
    /** Max concurrent operations on the Main lane (default: 4). Controls how many sessions can have active LLM calls simultaneously. */
    main_max?: number;
    /** Max concurrent operations on the Cron lane (default: 4). */
    cron_max?: number;
    /** Max concurrent operations on the Subagent lane (default: 8). */
    subagent_max?: number;
  };
  /** MCP (Model Context Protocol) servers for external tool integration. */
  mcp_servers?: Record<string, {
    /** Transport type (default: "stdio"). */
    transport?: "stdio" | "sse";
    /** Command to spawn (stdio transport). */
    command?: string;
    /** Arguments for the command (stdio transport). */
    args?: string[];
    /** Environment variables passed to the spawned process (stdio transport). */
    env?: Record<string, string>;
    /** URL to connect to (sse transport). */
    url?: string;
    /** Permission level for all tools from this server (default: "ask_user"). */
    permission?: PermissionLevel;
  }>;
  /** Auto-compaction: LLM-powered context summarization when approaching token limits. */
  compaction?: {
    enabled?: boolean;
    /** Context usage % to trigger auto-compact (default: 95). */
    threshold_percent?: number;
    /** Context usage % to block new messages (default: 98). */
    blocking_percent?: number;
    /** Recent turns to preserve after compaction (default: 10). */
    keep_recent_turns?: number;
    /** Max consecutive failures before disabling auto-compact (default: 3). */
    max_failures?: number;
  };
  /** Push notification configuration */
  notifications?: {
    /** Contact email for VAPID (Web Push). Required to enable push notifications.
     *  Format: "mailto:you@example.com". If not set, push is silently disabled. */
    vapid_email?: string;
  };
  /** Screenshot storage settings */
  screenshots?: {
    /** Days to keep screenshot folders before pruning (default: 30) */
    retention_days?: number;
  };
  /** Opt-in feature gates for experimental surfaces. */
  experiments?: {
    /** Show Codex/Hermes agent runtime creation controls in the web UI. */
    agent_runtimes?: boolean;
  };
  /** Speech-to-text consumer pipeline. See research/stt-pipeline.md. */
  asr?: {
    enabled?: boolean;
    /** Backend id: "whisper-api" (DeepInfra), "assemblyai", or "disabled". */
    backend?: string;
    whisper_api?: {
      endpoint?: string;
      model?: string;
      api_key_env?: string;
      timeout_ms?: number;
    };
    assemblyai?: {
      endpoint?: string;
      api_key_env: string;
      timeout_ms?: number;
      poll_interval_ms?: number;
    };
    /** batch | streaming — streaming ignored until the chosen backend supports it. */
    mode?: string;
    /** Single-policy schema for now: "retry-then-dead-letter" (default). */
    failure_policy?: string;
    retry?: {
      max_attempts?: number;
      initial_ms?: number;
      multiplier?: number;
      jitter_ms?: number;
    };
    /** Optional language hint (ISO code). When unset, the backend auto-detects. */
    lang?: string;
  };
  /** Voice memo chat poster — turns asr.final into user messages in voice:* sessions. */
  chat_poster?: {
    enabled?: boolean;
    /** Override the per-node session key (defaults to `voice:<node_id>`). */
    session_id_override?: string | null;
    /** Prefix prepended to every posted memo (default: empty). */
    prefix?: string;
    /** Append a "(conf=…)" tag from the ASR backend, when reported. */
    include_confidence?: boolean;
    /** Drop transcripts that exactly match (case-insensitive, after trim) any
     *  entry. Defaults to a curated denylist of common ASR hallucinations
     *  ("Thank you.", "Thanks for watching.", etc). Pass [] to disable. */
    silence_denylist?: ReadonlyArray<string>;
    /** Drop transcripts whose mean segment confidence is below this. */
    min_confidence?: number;
    /** Drop transcripts whose media duration is below this many milliseconds. */
    min_duration_ms?: number;
    /** Inactivity window before a pending coalesce buffer flushes (ms). */
    debounce_ms?: number;
    /** Hard cap on a pending buffer's age from first event (ms). */
    flush_age_ms?: number;
    /** Hard cap on number of memos coalesced into one turn. */
    max_items?: number;
    /** Hard cap on coalesced text length (chars). */
    max_chars?: number;
  };
  /**
   * Live multimodal consumer (slice 3 of priority-stream-ingest). Subscribes
   * to `media.live.chunk` and streams frames+audio to a live-capable provider.
   * When `provider` is "none" the consumer is not registered.
   */
  live_consumer?: {
    /** "gemini-live" | "none". Default "none". */
    provider?: "gemini-live" | "none";
    /** Optional model override; null → default Gemini Live model. */
    model?: string | null;
    /** Idle reaper window per session. Default 30000ms. */
    idle_reaper_ms?: number;
    /** Dispatch Gemini-issued tool calls to memory_append/channel_send. Default true. */
    tools_enabled?: boolean;
    /** Response modalities. Default ["TEXT"]. */
    response_modalities?: Array<"TEXT" | "AUDIO">;
  };
  /** Per-skill configuration */
  skills?: {
    entries?: Record<string, import("../skills/types.js").SkillUserConfig>;
  };
  /** Logging configuration */
  logging?: {
    level?: string;
    consoleLevel?: string;
    dir?: string;
    maxFileBytes?: number;
    retentionDays?: number;
  };
  /** Gateway auth configuration */
  gateway?: {
    auth?: {
      token?: string;
    };
  };
  /** Voiceprint identity configuration. Disabled unless explicitly enabled. */
  voiceprint?: {
    live_scoring?: {
      enabled?: boolean;
      sidecar?: {
        command?: string;
        args?: string[];
        cwd?: string;
        env?: Record<string, string>;
        timeout_ms?: number;
        max_stdout_bytes?: number;
        max_stderr_bytes?: number;
      };
      owner_template?: {
        file_path?: string;
        key_path?: string;
        key_ref?: string;
        create_key_if_missing?: boolean;
      };
      allowed_audio_roots?: string[];
      consent?: {
        capture_allowed?: boolean;
        biometric_allowed?: boolean;
        memory_promotion_allowed?: boolean;
        template_learning_allowed?: boolean;
        export_allowed?: boolean;
        reason?: string;
      };
      expected_model?: {
        provider?: "external-json" | "signal-baseline" | "speechbrain" | "wespeaker" | "picovoice" | "custom";
        model_id?: string;
        modelId?: string;
        version?: string;
        notes?: string;
      };
      thresholds?: {
        owner_accept?: number;
        owner_possible?: number;
        ownerAccept?: number;
        ownerPossible?: number;
      };
      quality_thresholds?: {
        min_duration_ms?: number;
        target_duration_ms?: number;
        min_rms?: number;
        target_rms?: number;
        min_peak?: number;
        min_dynamic_range?: number;
        max_clipping_ratio?: number;
        clipping_amplitude?: number;
        max_abs_dc_offset?: number;
        minDurationMs?: number;
        targetDurationMs?: number;
        minRms?: number;
        targetRms?: number;
        minPeak?: number;
        minDynamicRange?: number;
        maxClippingRatio?: number;
        clippingAmplitude?: number;
        maxAbsDcOffset?: number;
      };
      target_sample_rate?: number;
      timeout_ms?: number;
    };
  };
  /** Channel adapters for messaging app integration (Slack, iMessage, etc.). */
  channels?: {
    slack?: {
      /** Whether the Slack adapter is enabled (default: true if tokens are set). */
      enabled?: boolean;
      /** Bot token (xoxb-...) — agent identity for sending/receiving DMs. */
      bot_token?: string;
      /** User token (xoxp-...) — act as user: read messages, send as user. */
      user_token?: string;
      /** App token (xapp-...) — Socket Mode transport (no public URL needed). */
      app_token?: string;
      /** Slack user ID for proactive DMs (e.g., heartbeat findings). */
      default_dm_user?: string;
      /** Hawky session to bind Slack bot DMs to (default: "web:general"). */
      bind_to_session?: string;
      /**
       * Footer appended to bot-identity messages posted to channels
       * (non-DM destinations). Sets expectations that the bot won't
       * respond to replies. Default references default_dm_user; pass
       * empty string to disable the footer entirely.
       */
      bot_post_footer?: string;
      /**
       * How often (minutes) to refresh the persisted Slack directory/graph
       * (users, channels, membership) used for recipient resolution and
       * member lookups. Default 60. Set 0 to disable periodic refresh
       * (it still refreshes lazily on a cold/stale read).
       */
      directory_refresh_minutes?: number;
    };
  };
  /**
   * User-editable permission rules. Evaluated in `tool_executor.executeTools`
   * before the static safe-bash allowlist, so a rule like `Bash(gog gmail
   * messages search *)` auto-approves family members of a command without
   * the user having to "allow always" each variant.
   *
   * Grammar: `ToolName(pattern)` or bare `ToolName`. Wildcards: `*` →
   * any, `\*` → literal star. Bare-tool form (no parens) matches any
   * input. Trailing `*` is optional — `Bash(git *)` matches both
   * `git add` and bare `git`.
   *
   * Precedence (in order):
   *   1. `deny[]` — short-circuits, even matches inside ask/allow win.
   *   2. `allow[]` — auto-approve, recorded reason `config_allow`.
   *   3. `ask[]` — force prompt even if the static allowlist would have
   *      passed (override safe-bash for sensitive commands).
   *   4. Fall through to the existing cache + static allowlist + prompt.
   *
   * `deny[]` does NOT loosen the dangerous-command backstop
   * (`isDangerousCommand`); that floor still rejects `rm -rf`, force-push,
   * etc. regardless of allow rules. Set explicit denies for things the
   * user wants to *add* to that floor.
   *
   * The whole `permissions` block is **skipped** when the user has
   * explicitly opted out of all prompts for the session (gateway started
   * with `--dangerously-skip-permissions`, or "allow all for this
   * session" clicked in the UI). Both are stronger opt-outs than any
   * config rule. If you want a true safety floor that survives bypass
   * mode, don't rely on config — extend `isDangerousCommand` instead.
   */
  permissions?: {
    allow?: string[];
    deny?: string[];
    ask?: string[];
  };
  /** ISO timestamp of when /setup was last completed. Used to detect first-run vs re-run. */
  setup_completed_at?: string;
  /** Ambient-intelligence feature configuration (AMBIENT_INTENTIONS=1 gated). */
  ambient?: {
    /**
     * When true (default), latent recognition and relevance gating use
     * claude-sonnet-4-6 to evaluate rolling transcript windows for background
     * needs. Transcript windows are sent to Anthropic (api.anthropic.com or
     * the configured api_base_url). Provider: Anthropic Messages API.
     * Retention: standard API log retention (model inference logs, not stored
     * by hawky). Window size: bounded by LatentHeartbeatService interval
     * (default 60 s, configurable via LATENT_HEARTBEAT_MS).
     *
     * Set to false to DISABLE latent recognition entirely: no transcript is sent
     * to any model AND there is no deterministic fallback — the recognizer and
     * relevance gate become no-ops (recognition is a nice-to-have). Privacy-safe.
     *
     * Default: true (preserves existing behavior for users with AMBIENT_INTENTIONS=1).
     */
    latent_model_processing?: boolean;
  };
  /** Media archival configuration (M0+). */
  media?: {
    /** Root directory for media files. Default: ~/.hawky/workspace/media/ */
    root?: string;
    /** Retention policy for archived media files. */
    retention?: {
      /** Days to keep audio files (default: 7). */
      audio_days?: number;
      /** Days to keep video files (default: 3). */
      video_days?: number;
    };
  };
}
