// =============================================================================
// Gateway Agent Session Manager
//
// Manages per-session AgentLoop instances. Each session key gets its own
// agent loop with its own conversation history. Loops are created on first
// message and reused for subsequent messages.
//
// Pattern: a proven per-session agent routing.
// =============================================================================

import { AgentLoop } from "../agent/loop.js";
import type { LLMProvider } from "../agent/provider.js";
import { createProvider } from "../agent/provider-factory.js";
import { normalizeProviderModels } from "../agent/model-compat.js";
import { ToolRegistry } from "../tools/registry.js";
import { registerBuiltinTools } from "../tools/builtin.js";
import type { HawkyConfig, StreamEvent } from "../agent/types.js";
import { SessionManager, listSessions, deleteSessionFile, deleteSessionMeta, loadSessionMeta, renameSessionStorage, updateSessionMeta } from "../storage/session.js";
import { deleteTaskStore, renameTaskStore, resetAllTaskStores } from "../tools/task_global.js";
import type { PermissionResolver } from "../agent/tool_executor.js";
import type { GatewayServer } from "./server.js";
import { createWsPermissionResolver } from "./ws-permission.js";
import { createSubsystemLogger } from "../logging/index.js";
import { getMcpServerManager } from "../mcp/server-manager.js";
import { loadPermissionsSync } from "../storage/permissions.js";
import { updateConfig, resetConfig, loadConfig, saveConfig } from "../storage/config.js";
import { getBackgroundAgentStates } from "../tools/agent.js";
import type { HeartbeatService } from "./heartbeat.js";
import { ExternalAgentRuntime } from "./external-agent-runtime.js";
import type { SessionRuntimeKind } from "../storage/session.js";

const log = createSubsystemLogger("gateway/sessions");
const VALID_PROVIDERS = new Set(["anthropic", "vertex", "openai", "openai_compatible"]);

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface AgentSession {
  sessionKey: string;
  loop: AgentLoop;
  registry: ToolRegistry;
  sessionManager: SessionManager;
  createdAt: number;
  runtimeKind: SessionRuntimeKind;
  workingDirectory: string;
  externalRuntime?: ExternalAgentRuntime;
}

// -----------------------------------------------------------------------------
// Agent Session Manager
// -----------------------------------------------------------------------------

export class AgentSessionManager {
  private sessions = new Map<string, AgentSession>();
  private provider: LLMProvider;
  private config: HawkyConfig;
  private workingDirectory: string;
  private server: GatewayServer | null;
  /** When true, all tools auto-approve (--dangerously-skip-permissions) */
  readonly dangerouslySkipPermissions: boolean;
  private heartbeat: HeartbeatService | null = null;
  private _swapping = false;

  /** True while a provider swap is in progress. Checked by lanes.ts to block new turns. */
  get swapping(): boolean { return this._swapping; }

  constructor(opts: {
    provider: LLMProvider;
    config: HawkyConfig;
    workingDirectory: string;
    server?: GatewayServer;
    dangerouslySkipPermissions?: boolean;
  }) {
    this.provider = opts.provider;
    this.config = opts.config;
    this.workingDirectory = opts.workingDirectory;
    this.server = opts.server ?? null;
    this.dangerouslySkipPermissions = opts.dangerouslySkipPermissions ?? false;
  }

  setHeartbeat(hb: HeartbeatService): void {
    this.heartbeat = hb;
  }

  getActiveProvider(): LLMProvider {
    return this.provider;
  }

  /**
   * Swap the live LLM provider without restarting the gateway.
   * Validate-then-commit: createProvider throws before any mutation.
   * Blocked while any session or background agent is mid-turn.
   */
  swapProvider(spec: {
    provider: string;
    active_profile?: string;
    model?: string;
    openai_base_url?: string;
  }): { ok: true } | { ok: false; error: string } {
    if (this._swapping) return { ok: false, error: "another swap in progress" };
    if (!VALID_PROVIDERS.has(spec.provider)) {
      return { ok: false, error: `provider must be one of: ${[...VALID_PROVIDERS].join(", ")}` };
    }
    this._swapping = true;
    try {
      // Refuse if any session loop is running
      for (const [id, session] of this.sessions) {
        if (session.loop.isRunning()) {
          return { ok: false, error: `session ${id} has an in-flight turn — wait or cancel` };
        }
      }
      // Refuse if any background agent is running
      for (const agent of getBackgroundAgentStates()) {
        if (agent.status === "running") {
          return { ok: false, error: `background agent ${agent.id} is running — wait for it to finish` };
        }
      }

      // Build candidate config in-memory
      const candidate: HawkyConfig = JSON.parse(JSON.stringify(this.config));
      candidate.provider = spec.provider as HawkyConfig["provider"];
      if (spec.model !== undefined) {
        candidate.model = spec.model;
      }
      if (spec.openai_base_url !== undefined) {
        candidate.openai_base_url = spec.openai_base_url;
      }
      if (spec.active_profile && candidate.openai_compatible) {
        candidate.openai_compatible.active_profile = spec.active_profile;
      } else if (spec.active_profile) {
        candidate.openai_compatible = { active_profile: spec.active_profile, profiles: {} };
      }
      const normalizedCandidate = normalizeProviderModels(candidate);

      // Validate — throws if config is bad (e.g. unknown profile, missing key)
      let newProvider: LLMProvider;
      try {
        newProvider = createProvider(normalizedCandidate);
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }

      // Persist
      const updates: Record<string, unknown> = { provider: spec.provider };
      if (spec.model !== undefined) {
        updates.model = spec.model;
      }
      if (spec.openai_base_url !== undefined) {
        updates.openai_base_url = spec.openai_base_url;
      }
      if (spec.active_profile) {
        updates.openai_compatible = { active_profile: spec.active_profile };
      }
      if (updates.model !== normalizedCandidate.model) {
        updates.model = normalizedCandidate.model;
      }
      if (normalizedCandidate.heartbeat?.model !== this.config.heartbeat?.model) {
        updates.heartbeat = { model: normalizedCandidate.heartbeat?.model ?? null };
      }
      updateConfig(updates);
      resetConfig();
      Object.assign(this.config, loadConfig());

      // Push fresh config into heartbeat
      this.heartbeat?.updateConfig(this.config);

      // Swap provider (after all mutations succeed)
      this.provider = newProvider;
      for (const session of this.sessions.values()) {
        session.loop.setProvider(newProvider);
      }

      return { ok: true };
    } finally {
      this._swapping = false;
    }
  }

  addProfile(params: {
    name: string;
    base_url: string;
    api_key?: string;
    api_key_env?: string;
    model?: string;
    overwrite?: boolean;
  }): { ok: true } | { ok: false; error: string } {
    const { name, base_url, api_key, api_key_env, model, overwrite } = params;
    if (!name) return { ok: false, error: "name is required" };
    if (!base_url) return { ok: false, error: "base_url is required" };

    const existing = this.config.openai_compatible?.profiles?.[name];
    if (existing && !overwrite) {
      return { ok: false, error: `profile "${name}" already exists; pass overwrite: true to replace it` };
    }

    const profile: Record<string, unknown> = { base_url };
    if (api_key) profile.api_key = api_key;
    if (api_key_env) profile.api_key_env = api_key_env;
    if (model) profile.model = model;

    updateConfig({ openai_compatible: { profiles: { [name]: profile } } });
    resetConfig();
    this.config = loadConfig();
    this.heartbeat?.updateConfig(this.config);
    return { ok: true };
  }

  removeProfile(name: string): { ok: true } | { ok: false; error: string } {
    if (!name) return { ok: false, error: "name is required" };
    const active = this.config.openai_compatible?.active_profile;
    if (active === name) {
      return { ok: false, error: `cannot remove the active profile "${name}"; switch first with /provider <other>` };
    }
    const profiles = { ...(this.config.openai_compatible?.profiles ?? {}) };
    if (!profiles[name]) return { ok: false, error: `profile "${name}" not found` };
    delete profiles[name];
    // Use saveConfig (not updateConfig/deepMerge) so deleted profile key is not re-added.
    const full: HawkyConfig = { ...this.config };
    full.openai_compatible = { ...(this.config.openai_compatible ?? {}), profiles };
    saveConfig(full);
    resetConfig();
    this.config = loadConfig();
    this.heartbeat?.updateConfig(this.config);
    return { ok: true };
  }

  renameProfile(oldName: string, newName: string): { ok: true } | { ok: false; error: string } {
    if (!oldName || !newName) return { ok: false, error: "old and new names are required" };
    const profiles = this.config.openai_compatible?.profiles ?? {};
    const profile = profiles[oldName];
    if (!profile) return { ok: false, error: `profile "${oldName}" not found` };
    if (profiles[newName]) return { ok: false, error: `profile "${newName}" already exists` };

    const updatedProfiles = { ...profiles, [newName]: profile };
    delete updatedProfiles[oldName];
    const active = this.config.openai_compatible?.active_profile;
    const newActive = active === oldName ? newName : active;
    // Use saveConfig (not updateConfig/deepMerge) so deleted old-name key is not re-added.
    const full: HawkyConfig = { ...this.config };
    full.openai_compatible = { ...(this.config.openai_compatible ?? {}), profiles: updatedProfiles, active_profile: newActive };
    saveConfig(full);
    resetConfig();
    this.config = loadConfig();
    this.heartbeat?.updateConfig(this.config);
    return { ok: true };
  }

  /**
   * Live-reload the config object every AgentLoop already holds a reference to.
   *
   * AgentLoop reads `this.config.model`, `this.config.max_tokens`, etc. on
   * every turn (see src/agent/loop.ts). Those are shared references with
   * this.config, which in turn is the same object index.ts passed in at
   * gateway start (gwConfig). Mutating in place means an open chat picks
   * up model/max_tokens changes made through the Settings panel on its
   * very next API call — no gateway restart required. This mirrors the
   * live refresh the heartbeat service already has.
   *
   * Per-session overrides (effort, custom working_directory) are NOT
   * touched — callers that want those should use the dedicated RPCs
   * (config.effort) that write directly to the loop instance.
   */
  updateConfig(newConfig: HawkyConfig): void {
    // Rebuild the LLM provider if the provider type or relevant provider config changed.
    const providerChanged = newConfig.provider !== this.config.provider;
    const nextProvider = newConfig.provider ?? "anthropic";
    const currentProvider = this.config.provider ?? "anthropic";
    const openaiKeyChanged =
      nextProvider === "openai" &&
      newConfig.api_keys?.openai !== this.config.api_keys?.openai;
    const openaiBaseUrlChanged =
      nextProvider === "openai" &&
      newConfig.openai_base_url !== this.config.openai_base_url;
    const compatKeyChanged =
      nextProvider === "openai_compatible" &&
      newConfig.api_keys?.openai !== this.config.api_keys?.openai;
    const compatActiveProfileChanged =
      nextProvider === "openai_compatible" &&
      newConfig.openai_compatible?.active_profile !== this.config.openai_compatible?.active_profile;
    const compatProfilesChanged =
      nextProvider === "openai_compatible" &&
      JSON.stringify(newConfig.openai_compatible?.profiles ?? {}) !==
        JSON.stringify(this.config.openai_compatible?.profiles ?? {});
    if (
      providerChanged ||
      openaiKeyChanged ||
      openaiBaseUrlChanged ||
      compatKeyChanged ||
      compatActiveProfileChanged ||
      compatProfilesChanged
    ) {
      try {
        const newProvider = createProvider(newConfig);
        this.provider = newProvider;
        // Propagate to every active AgentLoop so the next turn uses the
        // correct provider without requiring a gateway restart.
        for (const session of this.sessions.values()) {
          session.loop.setProvider(newProvider);
        }
        log.info("provider rebuilt after config change", {
          from: currentProvider,
          to: nextProvider,
        });
      } catch (err) {
        log.warn("provider rebuild failed; keeping existing provider", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    Object.assign(this.config, newConfig);
  }

  /**
   * Derive a deterministic sessionId from a sessionKey.
   * This ensures the same JSONL file is used across gateway restarts.
   */
  private sessionIdFromKey(sessionKey: string): string {
    // Folder-based: "web:general" → "web/general", "cron:hn-digest" → "cron/hn-digest"
    return sessionKey.replace(":", "/").replace(/[^a-zA-Z0-9_/.-]/g, "-");
  }

  /**
   * Get or create an agent session for the given session key.
   * Creates a new AgentLoop + ToolRegistry + SessionManager on first access.
   * If a JSONL file exists for this session (e.g., after gateway restart),
   * loads history from disk into the new AgentLoop.
   *
   * @param sessionKey - Session key (e.g., "tui:main", "web:tab-abc")
   * @param workingDirectory - Override working directory for this session (from client's cwd)
   */
  getOrCreate(sessionKey: string, workingDirectory?: string, runtimeKind?: SessionRuntimeKind): AgentSession {
    const existing = this.sessions.get(sessionKey);
    if (existing) return existing;

    const cwd = workingDirectory ?? this.workingDirectory;
    const meta = loadSessionMeta();
    const existingRuntime = meta[sessionKey]?.runtimeKind;
    const resolvedRuntime: SessionRuntimeKind = existingRuntime ?? runtimeKind ?? "native";

    // Create fresh tool registry with all built-in tools + MCP tools
    const registry = new ToolRegistry();
    registerBuiltinTools(registry);

    // Inject MCP tools from connected servers
    const mcpTools = getMcpServerManager().getAllTools();
    if (mcpTools.length > 0) {
      registry.registerAll(mcpTools);
    }

    // Create WS-based permission resolver for this session
    const permissionResolver = this.server
      ? createWsPermissionResolver(sessionKey, this.server, cwd)
      : undefined;

    // Create agent loop
    const loop = new AgentLoop({
      provider: this.provider,
      registry,
      config: this.config,
      working_directory: cwd,
      permissionResolver,
      session_key: sessionKey,
      broadcastToSession: this.server
        ? (sk, evt, payload) => this.server!.broadcastToSession(sk, evt, payload)
        : undefined,
    });

    // Create session persistence with deterministic ID (survives gateway restart)
    const sessionId = this.sessionIdFromKey(sessionKey);
    const sessionManager = new SessionManager(sessionId);

    // Try to reload from disk (gateway restart recovery)
    const existingData = sessionManager.loadSession();
    if (existingData && existingData.messages.length > 0) {
      loop.setHistory(existingData.messages);
      if (existingData.permissionCache) {
        loop.getPermissionCache().restore(existingData.permissionCache);
      }
      log.info("session restored from disk", {
        sessionKey,
        messageCount: existingData.messages.length,
      });
    } else {
      // New session — initialize the JSONL file
      sessionManager.initSession(this.config.model, cwd);
      log.info("session created", { sessionKey, runtimeKind: resolvedRuntime });
    }

    if (!existingRuntime || existingRuntime !== resolvedRuntime) {
      updateSessionMeta(sessionKey, { runtimeKind: resolvedRuntime });
    }

    // Always load global persistent permissions (synchronous — must be ready
    // before the first tool call). Merges with any session-local cache above.
    const globalPerms = loadPermissionsSync();
    if (globalPerms) {
      const cache = loop.getPermissionCache();
      // Merge: global tool-level permissions
      for (const tool of globalPerms.always_allowed) {
        cache.recordDecision(tool, "allow_always");
      }
      // Merge: global command-level allowlist (bash exact commands)
      if (globalPerms.allowed_commands) {
        for (const [tool, cmds] of Object.entries(globalPerms.allowed_commands)) {
          for (const cmd of cmds) {
            cache.recordDecision(tool, "allow_command", { command: cmd });
          }
        }
      }
      if (globalPerms.allow_all) {
        cache.recordDecision("*", "allow_all");
      }
      // Pattern rules accumulated from "Allow `<pattern>` always"
      // decisions in prior sessions. Tool name "*" is a placeholder —
      // the rule itself encodes the real tool name.
      for (const rule of globalPerms.rules ?? []) {
        cache.recordDecision("*", "allow_always", undefined, rule);
      }
      log.debug("global permissions applied", {
        sessionKey,
        always_allowed: globalPerms.always_allowed,
        allowed_commands: globalPerms.allowed_commands,
        rules: globalPerms.rules,
      });
    }

    // Gateway-level bypass: --dangerously-skip-permissions
    // Uses forceBypass which survives cache.reset() (e.g., /new command)
    if (this.dangerouslySkipPermissions) {
      loop.getPermissionCache().setForceBypass(true);
    }

    // Simplified permission contract (issue #453): every session defaults to
    // bypass so tools auto-approve without prompting. This sidesteps the
    // unreliable per-session permission.mode RPC from iOS — the mode is applied
    // at session creation instead of depending on a network round-trip. Sessions
    // restored from disk in bypass already reflect this; calling it again is
    // idempotent. To restore prompting, change the mode via the permission.mode
    // RPC (which clears allow_all), or remove this block.
    {
      const cache = loop.getPermissionCache();
      cache.recordDecision("*", "allow_all");
      cache.setMode("bypass");
    }

    // Restore per-session effort from meta.json (survives gateway restart)
    const sessionMeta = meta[sessionKey];
    if (sessionMeta?.effort) {
      loop.effort = sessionMeta.effort;
    }

    const session: AgentSession = {
      sessionKey,
      loop,
      registry,
      sessionManager,
      createdAt: Date.now(),
      runtimeKind: resolvedRuntime,
      workingDirectory: cwd,
      externalRuntime: resolvedRuntime === "native" ? undefined : new ExternalAgentRuntime(),
    };

    this.sessions.set(sessionKey, session);

    // Notify all connected clients that the session list changed.
    // Only broadcast for genuinely new sessions (not restored from disk)
    // to avoid broadcast storms from session.resolve/chat.send on existing sessions.
    if (this.server && !existingData) {
      // Auto-subscribe web clients (those already in the subscription registry)
      // so they receive per-session events for the new session.
      for (const conn of this.server.getConnections().values()) {
        const subs = this.server.subscriptions.getSubscribedSessions(conn.connId);
        if (subs.size > 0) {
          this.server.subscriptions.subscribe(conn.connId, sessionKey);
        }
      }
      this.server.broadcast("session.updated", { sessionKey });
    }

    return session;
  }

  /** Get an existing session (returns undefined if not found). */
  get(sessionKey: string): AgentSession | undefined {
    return this.sessions.get(sessionKey);
  }

  /** Check if a session exists. */
  has(sessionKey: string): boolean {
    return this.sessions.has(sessionKey);
  }

  /** Get all active session keys. */
  keys(): string[] {
    return Array.from(this.sessions.keys());
  }

  /** Get the number of active sessions. */
  get size(): number {
    return this.sessions.size;
  }

  /** List recent sessions from disk (includes inactive sessions). */
  listPersisted(limit = 20, opts?: { includeArchived?: boolean }): ReturnType<typeof listSessions> {
    return listSessions(limit, opts);
  }

  /**
   * Evict a session from memory and delete its JSONL file + metadata.
   * Returns true if the session was found and deleted.
   */
  deleteSession(sessionKey: string): boolean {
    const sessionId = this.sessionIdFromKey(sessionKey);

    // Dispose the old loop's task-store bridge before dropping. Without
    // this, the loop's store listener keeps firing broadcasts under the
    // deleted sessionKey (stale/ghost task.update events).
    const existing = this.sessions.get(sessionKey);
    existing?.loop.dispose();
    existing?.externalRuntime?.cancel();

    // Remove from in-memory map
    this.sessions.delete(sessionKey);

    // Delete JSONL file from disk
    const fileDeleted = deleteSessionFile(sessionId);

    // Remove metadata entry
    deleteSessionMeta(sessionKey);

    // Drop the per-session task store from the in-memory registry so
    // a deleted session's tasks don't linger for the process lifetime.
    deleteTaskStore(sessionKey);

    log.info("session deleted", { sessionKey, sessionId, fileDeleted });
    return fileDeleted;
  }

  /**
   * Evict a session from memory only (no disk changes).
   * Used when the session file has been deleted externally
   * (manual cleanup or reaper) but the in-memory entry persists.
   * Also drops the in-memory task store and disposes the loop's
   * task-store bridge so recreating the same sessionKey later starts
   * fresh, without ghost tasks / reminder content / stale broadcast
   * listeners from the evicted session.
   */
  evict(sessionKey: string): void {
    const existing = this.sessions.get(sessionKey);
    existing?.loop.dispose();
    existing?.externalRuntime?.cancel();
    this.sessions.delete(sessionKey);
    deleteTaskStore(sessionKey);
    log.info("session evicted from memory", { sessionKey });
  }

  /**
   * Rename a session's identity from `oldKey` to `newKey`. Renames the JSONL
   * file, re-keys meta.json, moves subscriptions, and evicts the in-memory
   * AgentSession so the next access recreates it under the new key.
   *
   * Callers (session.rename RPC) are responsible for updating cron jobs,
   * session bindings, and broadcasting `session.renamed`. Throws if the
   * session is mid-turn, if the new key collides, or if the source file
   * is missing.
   */
  rename(oldKey: string, newKey: string): void {
    if (oldKey === newKey) return;

    const existing = this.sessions.get(oldKey);
    if (existing?.loop.isRunning()) {
      throw new Error("session is mid-turn; try again after it finishes");
    }
    if (this.sessions.has(newKey)) {
      throw new Error(`session already exists: ${newKey}`);
    }

    renameSessionStorage(oldKey, newKey);
    // Carry the in-memory task store with the rename.
    renameTaskStore(oldKey, newKey);
    // Detach the old loop's task-store bridge BEFORE the new loop
    // wires its own. Without this, two listeners end up on the same
    // store: the old one broadcasts under `oldKey` (stale), the new
    // one under `newKey` — every subsequent mutation fires twice and
    // the old key leaks broadcasts to clients reusing it later.
    existing?.loop.dispose();
    existing?.externalRuntime?.cancel();

    if (this.server?.subscriptions) {
      this.server.subscriptions.rename(oldKey, newKey);
    }

    // Rebind any live GatewayConnections still bound to oldKey. Many RPCs
    // (chat.send, session.history, session.currentTurn, …) default to
    // conn.sessionKey when the caller omits it, and broadcastToSession()
    // treats conn.sessionKey as a legacy delivery binding. Without this,
    // a follow-up request from a bound client would target oldKey and
    // `getOrCreate(oldKey)` would silently fork history into a fresh
    // empty session.
    if (this.server?.getConnections) {
      for (const conn of this.server.getConnections().values()) {
        if (conn.sessionKey === oldKey) conn.bindSession(newKey);
      }
    }

    this.sessions.delete(oldKey);

    log.info("session renamed", { oldKey, newKey });
  }

  /** Reset all sessions. For testing only. */
  reset(): void {
    // Dispose each loop's task-store bridge before clearing the map.
    // Without this, listeners outlive the loops they belong to; test
    // fixtures that reuse deterministic keys (heartbeat:main, etc.)
    // accumulate ghost bridges across runs and pin the old loops in
    // memory through the store's listener list.
    for (const session of this.sessions.values()) {
      session.loop.dispose();
      session.externalRuntime?.cancel();
    }
    this.sessions.clear();
    // Also clear the global task-store registry — leftover stores
    // would bleed task state (and their summary) into the next test
    // run that reopens the same deterministic session key. (Codex P2.)
    resetAllTaskStores();
  }
}
