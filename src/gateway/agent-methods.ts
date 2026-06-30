// =============================================================================
// Agent RPC Method Handlers
//
// Real implementations of chat.send, chat.cancel, session.list, session.resolve,
// session.history. These wire the gateway protocol to the agent loop via the
// command queue.
//
// chat.send flow:
//   client → WebSocket → chat.send → executeInSession → AgentLoop.sendMessage
//   → stream events → broadcastToSession → all connected clients
// =============================================================================

import type { GatewayConnection } from "./connection.js";
import type { GatewayServer } from "./server.js";
import type { AgentSessionManager } from "./agent-sessions.js";
import type { StreamEvent } from "../agent/types.js";
import { getCostTracker } from "../agent/cost-tracker.js";
import { executeInSession } from "./lanes.js";
import { CommandLane } from "./types.js";
import { MethodError } from "./methods.js";
import { resolveWsPermission, getPendingPermissionForSession } from "./ws-permission.js";
import { existsSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { resolveAskUser, getPendingAskUserForSession } from "../tools/ask_user.js";
import type { PermissionDecision } from "../agent/tool_executor.js";
import type { HawkyConfig } from "../agent/types.js";
import { runMemoryFlush, resetFlushState, resolveFlushConfig, shouldTriggerFlush, hasAlreadyFlushed } from "./memory-flush.js";
import { getCronServiceRef } from "../tools/cron.js";
import { cancelPendingPermissions } from "./ws-permission.js";
import { savePermissions, loadPermissionsSync } from "../storage/permissions.js";
import { createSubsystemLogger } from "../logging/index.js";
import type { IntentionService } from "../ambient/intention-service.js";
import type { LatentService } from "../ambient/latent-service.js";
import { INTENTION_CREATE } from "../ambient/rpc.js";
import { scanLatent } from "../ambient/scan.js";
import { fireIntention } from "../ambient/fire.js";
import { WhereAdapter } from "../ambient/arm-where.js";
import { getMcpServerManager } from "../mcp/server-manager.js";
import { peekCompletedAgents, drainCompletedAgents } from "../tools/agent.js";
import {
  resolveCompactionConfig,
  shouldAutoCompact,
  compactConversation,
  createCompactionState,
  type CompactionState,
} from "../agent/compaction.js";
import type { PushService, PushSubscriptionJSON } from "./push.js";
import { WorkspaceManager, WORKSPACE_FILES } from "../storage/workspace.js";
import { updateSessionMeta, loadSessionMeta, persistLastTurnUsage, sessionKeyToId } from "../storage/session.js";
import { loadConfig } from "../storage/config.js";
import { peekTaskStore } from "../tools/task_global.js";
import type { CronStore } from "./cron-store.js";
import type { HeartbeatService } from "./heartbeat.js";
import { rewindSession, userTurnIndexToMessageIndex } from "./rewind.js";
import {
  LiveRealtimeBrokerError,
  mintOpenAIRealtimeClientSecret,
  type LiveRealtimeClientSecretParams,
} from "./live-realtime-broker.js";

const log = createSubsystemLogger("gateway/methods");

function externalAgentRuntimesEnabled(): boolean {
  return loadConfig().experiments?.agent_runtimes === true;
}

type RuntimeCapabilities = {
  streaming: boolean;
  mcp: boolean;
  attachments: boolean;
  permissions: boolean;
  usage: boolean;
  structuredHistory: boolean;
};

type ClientRuntimeKind = "native" | "codex" | "hermes" | "claude";

function capabilitiesForRuntime(runtimeKind: ClientRuntimeKind): RuntimeCapabilities {
  if (runtimeKind === "native") {
    return {
      streaming: true,
      mcp: true,
      attachments: true,
      permissions: true,
      usage: true,
      structuredHistory: true,
    };
  }
  if (runtimeKind === "codex" || runtimeKind === "claude") {
    return {
      streaming: true,
      mcp: true,
      attachments: false,
      permissions: false,
      usage: true,
      structuredHistory: false,
    };
  }
  return {
    streaming: false,
    mcp: false,
    attachments: false,
    permissions: false,
    usage: false,
    structuredHistory: false,
  };
}

/** Cron store reference for sidebar filtering. Set after cron service starts. */
let cronStoreRef: CronStore | null = null;
export function setCronStoreForSessionList(store: CronStore): void {
  cronStoreRef = store;
}

/** Heartbeat service reference for rewind (resets distillation offsets).
 *  Set after heartbeat construction; null before, which is fine — rewind
 *  just skips the offset reset and logs a warning. */
let heartbeatRef: HeartbeatService | null = null;
export function setHeartbeatForRewind(service: HeartbeatService): void {
  heartbeatRef = service;
}

/** Channel relay references for full sync (Slack, etc.). */
import type { ChannelRegistry } from "./channel.js";
import type { SessionBindingService } from "./session-binding.js";
import { relayToChannels } from "./channel-relay.js";
let channelRegistryRef: ChannelRegistry | null = null;
let sessionBindingRef: SessionBindingService | null = null;
export function setChannelRelay(registry: ChannelRegistry, bindings: SessionBindingService): void {
  channelRegistryRef = registry;
  sessionBindingRef = bindings;
}

// -----------------------------------------------------------------------------
// terminalDisarm — transition an intention to a terminal state and disarm its
// where-region. Centralises the "transition then disarm" pattern so every
// terminal path (location.auth, intention.respond, supersession, surfacing)
// goes through the same code.
// -----------------------------------------------------------------------------

/** Returns true if the transition happened, false if already in a terminal state. */
async function terminalDisarm(
  intentionId: string,
  nextState: "suppressed" | "resolved" | "arm_failed" | "superseded",
  store: import("../ambient/intention-store.js").IntentionStore,
  intentionLoop: IntentionService,
): Promise<boolean> {
  let transitioned = false;
  try {
    await store.transition(intentionId, nextState);
    transitioned = true;
  } catch {
    // Already transitioned; skip disarm but still try — may be pending-arm.
  }
  const whereAdapter = intentionLoop.getAdapter("where");
  if (whereAdapter instanceof WhereAdapter) {
    const intention = await store.get(intentionId);
    if (intention) {
      await whereAdapter.disarm(intention).catch(() => {});
    }
  }
  return transitioned;
}

// -----------------------------------------------------------------------------
// Register all agent methods on a server
// -----------------------------------------------------------------------------

export function registerAgentMethods(
  server: GatewayServer,
  sessions: AgentSessionManager,
  config?: HawkyConfig,
  pushService?: PushService,
  intentionLoop?: IntentionService,
  latentService?: LatentService,
): void {
  // Per-session compaction state (circuit breaker tracking)
  const compactionStates = new Map<string, CompactionState>();
  function getCompactionState(sessionKey: string): CompactionState {
    let state = compactionStates.get(sessionKey);
    if (!state) {
      state = createCompactionState();
      compactionStates.set(sessionKey, state);
    }
    return state;
  }

  // -------------------------------------------------------------------------
  // intention.create — structured obvious-intention write (M7, flag-gated).
  // The realtime model fills slots ({content, when}) and calls this directly;
  // we build + precision-gate + store + arm, returning {id,state} or a
  // needs_clarification bounce. Distinct from the chat.send priority:"timed"
  // string-parse path: here the slots are explicit, so no NLP guessing.
  // -------------------------------------------------------------------------
  server.registerMethod(INTENTION_CREATE, async (conn, params) => {
    if (!intentionLoop || process.env.AMBIENT_INTENTIONS !== "1") {
      throw new MethodError(
        "UNAVAILABLE",
        "Ambient intention loop is disabled (set AMBIENT_INTENTIONS=1).",
      );
    }
    // Require a bound session — an unbound connection has no user identity.
    if (!conn.sessionKey) {
      throw new MethodError("FORBIDDEN", "Unbound connection: bind a session before calling intention.create.");
    }
    const p = params as
      | { content?: string; when?: string; where?: string; timezone?: string; sessionKey?: string }
      | undefined;
    const sessionKey = p?.sessionKey ?? conn.sessionKey;
    if (!sessionKey) {
      throw new MethodError("NO_SESSION", "No session bound. Provide sessionKey in params.");
    }
    const content = p?.content?.trim();
    if (!content) {
      throw new MethodError("INVALID_REQUEST", "content is required");
    }
    conn.bindSession(sessionKey);
    const created = await intentionLoop.handleCreateIntention(
      { content, when: p?.when, where: p?.where },
      sessionKey,
      p?.timezone,
    );
    // #481 observability: surface the create outcome (esp. where arms) in the log.
    log.info("intention.create", {
      sessionKey,
      where: p?.where ?? null,
      when: p?.when ?? null,
      ok: created.ok,
      state: created.ok ? created.state : "needs_clarification",
      intentionId: created.ok ? created.intentionId : undefined,
    });
    return created;
  });

  // -------------------------------------------------------------------------
  // transcript.append — per-session transcript window append for latent recognition.
  // Params: { sessionKey?: string; turns: { role, text, ts }[] }
  // Flag-gated on AMBIENT_INTENTIONS + requires a LatentService.
  // -------------------------------------------------------------------------
  server.registerMethod("transcript.append", async (conn, params) => {
    if (!latentService || process.env.AMBIENT_INTENTIONS !== "1") {
      throw new MethodError(
        "UNAVAILABLE",
        "Ambient latent service is disabled (set AMBIENT_INTENTIONS=1).",
      );
    }
    // Require a bound session — an unbound connection has no user identity.
    if (!conn.sessionKey) {
      throw new MethodError("FORBIDDEN", "Unbound connection: bind a session before calling transcript.append.");
    }
    const p = params as
      | { sessionKey?: string; turns?: { role?: string; text?: string; ts?: string }[] }
      | undefined;
    if (p?.sessionKey !== undefined && p.sessionKey !== conn.sessionKey) {
      throw new MethodError("FORBIDDEN", "Session mismatch: transcript.append is bound to the connected session.");
    }
    const sessionKey = conn.sessionKey;
    const turns = p?.turns;
    if (!Array.isArray(turns) || turns.length === 0) {
      throw new MethodError("INVALID_REQUEST", "turns must be a non-empty array");
    }
    // HIGH-2 fix: persist the mode ALWAYS (including quiet) so that if the
    // client reconnects and calls session.resolve, quiet is restored onto the
    // connection and overrides any previously-saved ambient mode.
    // (A session that was once ambient and later goes quiet must stay quiet
    // after reconnect — persisting only non-quiet modes would restore ambient.)
    updateSessionMeta(sessionKey, { ambientMode: conn.mode });

    for (const turn of turns) {
      if (turn.role !== "user" && turn.role !== "assistant") continue;
      if (typeof turn.text !== "string" || !turn.text) continue;
      if (typeof turn.ts !== "string" || !turn.ts) continue;
      latentService.onTranscript(
        sessionKey,
        { role: turn.role, text: turn.text, ts: turn.ts },
        conn.mode,
      );
    }
    return { ok: true };
  });

  // -------------------------------------------------------------------------
  // intention.respond — confirm or decline a surfaced latent intention.
  // Params: { intentionId: string; response: "confirm" | "decline" }
  // Flag-gated on AMBIENT_INTENTIONS + requires intentionLoop + latentService.
  //
  // confirm → surfaced → resolved (the user acknowledged; the intention is done).
  // decline → surfaced → suppressed (the user rejected; content is suppressed).
  //
  // Latents are user-global, so ANY bound session may respond — not restricted
  // to the minting session. Unbound connections are rejected.
  // -------------------------------------------------------------------------
  server.registerMethod("intention.respond", async (conn, params) => {
    if (!intentionLoop || !latentService || process.env.AMBIENT_INTENTIONS !== "1") {
      throw new MethodError(
        "UNAVAILABLE",
        "Ambient intention loop is disabled (set AMBIENT_INTENTIONS=1).",
      );
    }
    // Require a bound session — latents are user-global but we must know the user.
    if (!conn.sessionKey) {
      throw new MethodError("FORBIDDEN", "Unbound connection: bind a session before calling intention.respond.");
    }
    const p = params as { intentionId?: string; response?: string } | undefined;
    const intentionId = p?.intentionId?.trim();
    if (!intentionId) {
      throw new MethodError("INVALID_REQUEST", "intentionId is required");
    }
    const response = p?.response;
    if (response !== "confirm" && response !== "decline") {
      throw new MethodError("INVALID_REQUEST", 'response must be "confirm" or "decline"');
    }

    const intention = await intentionLoop.store.get(intentionId);
    if (!intention) {
      throw new MethodError("NOT_FOUND", `Intention not found: ${intentionId}`);
    }
    // Surfaced suggestions may always be answered. Armed suggestions may only be
    // answered when a recent scan returned the id; scan_intention surfaces those
    // conversationally without the poll-driven surfaced transition.
    const scanSurfaced = intention.state === "armed" && latentService.wasScannedRecently(intentionId);
    if (intention.state !== "surfaced" && !scanSurfaced) {
      throw new MethodError(
        "INVALID_REQUEST",
        `intention.respond requires state "surfaced" or recent scan result; got "${intention.state}"`,
      );
    }

    if (response === "decline") {
      // Suppress: record the content key + transition to suppressed + disarm where-region.
      latentService.suppress(intention.content);
      await terminalDisarm(intentionId, "suppressed", intentionLoop.store, intentionLoop);
      return { ok: true, intentionId, state: "suppressed" };
    }

    // confirm: the user accepted the surfaced suggestion — resolve it and
    // disarm any where-region. Do not re-arm surfaced latents.
    await terminalDisarm(intentionId, "resolved", intentionLoop.store, intentionLoop);
    return { ok: true, intentionId, state: "resolved" };
  });

  // -------------------------------------------------------------------------
  // region.armed — device ack for a where-intention arming geocode result.
  // Params: { intentionId: string; ok: boolean; reason?: string }
  // Resolves the pending WhereAdapter ack promise for this intentionId.
  // Flag-gated on AMBIENT_INTENTIONS + requires intentionLoop.
  // -------------------------------------------------------------------------
  server.registerMethod("region.armed", async (conn, params) => {
    if (!intentionLoop || process.env.AMBIENT_INTENTIONS !== "1") {
      throw new MethodError("UNAVAILABLE", "Ambient intention loop is disabled (set AMBIENT_INTENTIONS=1).");
    }
    // #485: region reporting requires a bound session. An authenticated but
    // unbound connection must NOT be able to ack region arms for arbitrary
    // (guessable) intention IDs. Mirrors intention.respond / intention.scan.
    if (!conn.sessionKey) {
      throw new MethodError("FORBIDDEN", "Unbound connection: bind a session before calling region.armed.");
    }
    const p = params as { intentionId?: string; ok?: boolean; reason?: string } | undefined;
    const intentionId = p?.intentionId?.trim();
    if (!intentionId) {
      throw new MethodError("INVALID_REQUEST", "intentionId is required");
    }
    // Verify the reporting connection owns this intention's session.
    const intention = await intentionLoop.store.get(intentionId);
    if (!intention) {
      throw new MethodError("NOT_FOUND", `Intention not found: ${intentionId}`);
    }
    // #485: ownership is now unconditional — the bound session must match.
    if (intention.evidence.sessionKey !== conn.sessionKey) {
      throw new MethodError("FORBIDDEN", "Session mismatch: this intention belongs to a different session.");
    }
    // Resolve the pending ack via the WhereAdapter stored in the intention loop.
    const whereAdapter = intentionLoop.getAdapter("where");
    if (!whereAdapter || !(whereAdapter instanceof WhereAdapter)) {
      throw new MethodError("UNAVAILABLE", "WhereAdapter is not registered.");
    }
    const ack = { ok: p?.ok ?? false, reason: p?.reason };

    // Normal path: resolve the in-flight prepare() ack. resolveAck returns true
    // iff a live resolver was still waiting (the arm has not yet timed out). In
    // that case prepare() drives the pending_arm → armed/arm_failed transition.
    if (whereAdapter.resolveAck(intentionId, ack)) {
      log.info("region.armed (in-flight ack)", { intentionId, ok: ack.ok, reason: ack.reason ?? null });
      return { ok: true };
    }

    // #481: late-ack recovery. No live resolver means prepare() already settled —
    // the arm hit device_ack_timeout and is sitting in pending_arm (deferred). A
    // late region.armed lands here: arm it directly. This is how a hard
    // where-reminder survives the user taking longer than the arm timeout to grant
    // "Always" location auth (a multi-step OS prompt that can't finish in 10s).
    if (intention.state === "pending_arm" && whereAdapter.isPendingArm(intention)) {
      const armed = whereAdapter.armFromLateAck(intention, ack);
      if (armed) {
        try {
          await intentionLoop.store.transition(intentionId, "armed");
          // Replay any region.entered that was latched while pending_arm (Fix 2).
          const fresh = await intentionLoop.store.get(intentionId);
          if (fresh) whereAdapter.activate(fresh);
          log.info("region.armed (LATE ack recovered → armed) #481", { intentionId });
        } catch {
          // Illegal transition (race: already terminal). Leave as-is.
        }
      } else {
        // Negative late ack → device gave up; mark terminal arm_failed.
        try {
          await intentionLoop.store.transition(intentionId, "arm_failed");
        } catch { /* already transitioned */ }
        log.info("region.armed (LATE ack negative → arm_failed)", { intentionId, reason: ack.reason ?? null });
      }
    } else {
      log.info("region.armed (no live resolver, not recoverable)", { intentionId, state: intention.state, ok: ack.ok });
    }
    return { ok: true };
  });

  // -------------------------------------------------------------------------
  // region.entered — device reports region entry for an armed where-intention.
  // Params: { intentionId: string; sessionKey?: string }
  // Re-fetches the intention, verifies armed state, fires via fireIntention.
  // Flag-gated on AMBIENT_INTENTIONS + requires intentionLoop.
  // -------------------------------------------------------------------------
  server.registerMethod("region.entered", async (conn, params) => {
    if (!intentionLoop || process.env.AMBIENT_INTENTIONS !== "1") {
      throw new MethodError("UNAVAILABLE", "Ambient intention loop is disabled (set AMBIENT_INTENTIONS=1).");
    }
    // #485: region reporting requires a bound session. An unbound connection must
    // NOT be able to fire region entry for arbitrary (guessable) intention IDs.
    if (!conn.sessionKey) {
      throw new MethodError("FORBIDDEN", "Unbound connection: bind a session before calling region.entered.");
    }
    const p = params as { intentionId?: string; sessionKey?: string } | undefined;
    const intentionId = p?.intentionId?.trim();
    if (!intentionId) {
      throw new MethodError("INVALID_REQUEST", "intentionId is required");
    }
    const intention = await intentionLoop.store.get(intentionId);
    if (!intention) {
      throw new MethodError("NOT_FOUND", `Intention not found: ${intentionId}`);
    }
    // #485: ownership is now unconditional — the bound session must match.
    if (intention.evidence.sessionKey !== conn.sessionKey) {
      throw new MethodError("FORBIDDEN", "Session mismatch: this intention belongs to a different session.");
    }
    // Fix 2: if the intention is still in pending_arm (monitoring started before store reached
    // "armed"), latch the entry and replay it from activate() once the store is armed.
    if (intention.state === "pending_arm") {
      const whereAdapter = intentionLoop.getAdapter("where");
      if (whereAdapter instanceof WhereAdapter) {
        const wherePlaceTermKey = WhereAdapter.wherePlaceTermKey(intention);
        if (wherePlaceTermKey) {
          const sessionKey = intention.evidence.sessionKey;
          whereAdapter.latchPendingEntry(intentionId, () => {
            void (async () => {
              const fresh = await intentionLoop!.store.get(intentionId);
              if (!fresh || fresh.state !== "armed") return;
              // Fix 7: update location context so where.category relevance works.
              if (latentService && sessionKey) {
                const placeTerm = (fresh.trigger.all ?? []).find((t) => t.kind === "where" && (t as {place?: string}).place);
                const place = placeTerm && placeTerm.kind === "where" ? (placeTerm as {place?: string}).place : undefined;
                if (place) latentService.setLocation(sessionKey, { place });
              }
              const tk = WhereAdapter.wherePlaceTermKey(fresh);
              if (!tk) return;
              // Fix 1: pass disarmFn in the replay so replayed entries also disarm the region.
              await fireIntention(fresh, tk, {
                store: intentionLoop!.store,
                nodes: sessionKey ? intentionLoop!.nodeInvokerFor(sessionKey) : undefined,
                scoreCtx: undefined,
                disarmFn: (i) => {
                  const wa = intentionLoop!.getAdapter("where");
                  return wa ? wa.disarm(i) : Promise.resolve();
                },
              });
            })();
          });
          return { ok: true, reason: "pending_arm_latched" };
        }
      }
      return { ok: false, reason: "not_armed", state: intention.state };
    }
    if (intention.state !== "armed") {
      return { ok: false, reason: "not_armed", state: intention.state };
    }
    // Find the where term key to pass to fireIntention.
    const wherePlaceTermKey = WhereAdapter.wherePlaceTermKey(intention);
    if (!wherePlaceTermKey) {
      return { ok: false, reason: "no_where_place_term" };
    }
    const sessionKey = intention.evidence.sessionKey;
    // Fix 7: update LatentService location context so where.category relevance works.
    if (latentService && sessionKey) {
      const placeTerm = (intention.trigger.all ?? []).find((t) => t.kind === "where" && (t as {place?: string}).place);
      const place = placeTerm && placeTerm.kind === "where" ? (placeTerm as {place?: string}).place : undefined;
      if (place) latentService.setLocation(sessionKey, { place });
    }
    const result = await fireIntention(intention, wherePlaceTermKey, {
      store: intentionLoop.store,
      nodes: sessionKey ? intentionLoop.nodeInvokerFor(sessionKey) : undefined,
      scoreCtx: undefined,
      // Fix 8: disarm where-regions on surfaced.
      disarmFn: (i) => {
        const wa = intentionLoop!.getAdapter("where");
        return wa ? wa.disarm(i) : Promise.resolve();
      },
    });
    log.info("region.entered → fired", { intentionId, delivered: result.delivered, reason: result.reason ?? null });
    return { ok: result.delivered, reason: result.reason };
  });

  // -------------------------------------------------------------------------
  // location.auth — device reports location authorization status change.
  // Params: { status: "denied" | "restricted" | ... }
  // On denied/restricted: transitions all pending_arm and armed where-intentions
  // to arm_failed (auth revocation). Flag-gated on AMBIENT_INTENTIONS.
  // -------------------------------------------------------------------------
  server.registerMethod("location.auth", async (conn, params) => {
    if (!intentionLoop || process.env.AMBIENT_INTENTIONS !== "1") {
      throw new MethodError("UNAVAILABLE", "Ambient intention loop is disabled (set AMBIENT_INTENTIONS=1).");
    }
    const p = params as { status?: string } | undefined;
    if (p?.status !== "denied" && p?.status !== "restricted") {
      return { ok: true, action: "none" };
    }
    // Revoke only where-intentions belonging to the reporting session.
    const reportingSession = conn.sessionKey;
    if (!reportingSession) {
      return { ok: true, action: "none", reason: "no_session" };
    }
    const [pendingArm, armed] = await Promise.all([
      intentionLoop.store.list({ state: "pending_arm" }),
      intentionLoop.store.list({ state: "armed" }),
    ]);
    const whereIntentions = [...pendingArm, ...armed].filter((intention) =>
      intention.evidence.sessionKey === reportingSession &&
      (intention.trigger.all ?? []).some((t) => t.kind === "where"),
    );
    let revoked = 0;
    for (const intention of whereIntentions) {
      if (await terminalDisarm(intention.id, "arm_failed", intentionLoop.store, intentionLoop)) {
        revoked++;
      }
    }
    return { ok: true, action: "revoked", revoked };
  });

  // -------------------------------------------------------------------------
  // intention.scan — model-pull latent surfacing (M10, flag-gated).
  // Returns the top MAX_SCAN_RESULTS globally-armed latent intentions that match
  // the current session's context. Read-only — no state transitions.
  //
  // Mode resolution (explicit handshake is authoritative, params.mode secondary):
  //   conn.modeExplicitlySet → conn.mode (cannot be overridden by params.mode)
  //   else valid params.mode → that mode
  //   else persisted ambientMode → persisted mode
  //   else conn.mode (default/fallback)
  //
  // Bound connection: conn.sessionKey must be set; params.sessionKey (if present)
  // must equal conn.sessionKey — never binds a session inside this method.
  // -------------------------------------------------------------------------
  server.registerMethod("intention.scan", async (conn, params) => {
    if (!latentService || !intentionLoop || process.env.AMBIENT_INTENTIONS !== "1") {
      throw new MethodError(
        "UNAVAILABLE",
        "Ambient intention loop is disabled (set AMBIENT_INTENTIONS=1).",
      );
    }
    // Require a bound session — scan needs a context window.
    if (!conn.sessionKey) {
      throw new MethodError("NO_SESSION", "No session bound. Connect with a sessionKey to use intention.scan.");
    }
    const p = params as { sessionKey?: string; mode?: string } | undefined;
    // If params.sessionKey is provided it must match the bound session.
    if (p?.sessionKey && p.sessionKey !== conn.sessionKey) {
      throw new MethodError(
        "FORBIDDEN",
        "params.sessionKey does not match the bound connection session.",
      );
    }
    const sessionKey = conn.sessionKey;

    // Mode resolution: explicit handshake beats params.mode.
    const VALID_MODES = new Set(["quiet", "ambient", "directive"]);
    let mode: import("../ambient/modes.js").Mode;
    if (conn.modeExplicitlySet) {
      mode = conn.mode;
    } else if (typeof p?.mode === "string" && VALID_MODES.has(p.mode)) {
      mode = p.mode as import("../ambient/modes.js").Mode;
    } else {
      const meta = loadSessionMeta();
      mode = meta[sessionKey]?.ambientMode ?? conn.mode;
    }

    const { now, tz } = latentService.buildScanInput(sessionKey);
    const scanResult = await scanLatent({
      store: intentionLoop.store,
      latentService,
      gate: latentService.surfacingGate,
      sessionKey,
      mode,
      now,
      tz,
    });
    const scanMatches = (scanResult as { matches?: { id?: string }[] })?.matches ?? [];
    // Privacy (#484): log count + ids only — never the matched need content.
    log.info("intention.scan result", {
      sessionKey,
      mode,
      count: scanMatches.length,
      ids: scanMatches.map((m) => (m.id ?? "").slice(0, 8)),
    });
    return scanResult;
  });

  // -------------------------------------------------------------------------
  // chat.send — route message through command queue → agent loop
  // -------------------------------------------------------------------------
  server.registerMethod("chat.send", async (conn, params, srv) => {
    const p = params as {
      message?: string;
      sessionKey?: string;
      attachments?: Array<{ base64?: string; media_type?: string }>;
      documents?: Array<{ base64?: string; media_type?: string; filename?: string }>;
    } | undefined;
    if (!p?.message) {
      throw new MethodError("INVALID_REQUEST", "message is required");
    }

    // Validate image attachments (bounded per-image + total)
    const MAX_IMAGE_BYTES = 3 * 1024 * 1024; // 3MB per image (aligned with sanitizer per-image cap)
    const MAX_ATTACHMENT_COUNT = 10;
    const MAX_TOTAL_BYTES = 10 * 1024 * 1024; // 10MB total (aligned with sanitizer budget)
    const VALID_MEDIA_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
    const validatedAttachments: Array<{ base64: string; media_type: string }> = [];
    if (p.attachments && Array.isArray(p.attachments)) {
      if (p.attachments.length > MAX_ATTACHMENT_COUNT) {
        throw new MethodError("INVALID_REQUEST", `Too many attachments (${p.attachments.length}). Max ${MAX_ATTACHMENT_COUNT}.`);
      }
      let totalBytes = 0;
      for (const att of p.attachments) {
        if (!att.base64 || !att.media_type) continue;
        if (!VALID_MEDIA_TYPES.includes(att.media_type)) {
          log.warn("skipping attachment with unsupported media type", { media_type: att.media_type });
          continue;
        }
        const rawBytes = Math.ceil(att.base64.length * 3 / 4);
        if (rawBytes > MAX_IMAGE_BYTES) {
          throw new MethodError("INVALID_REQUEST", `Attachment too large (${(rawBytes / 1024 / 1024).toFixed(1)}MB). Max ${MAX_IMAGE_BYTES / 1024 / 1024}MB per image.`);
        }
        totalBytes += rawBytes;
        if (totalBytes > MAX_TOTAL_BYTES) {
          throw new MethodError("INVALID_REQUEST", `Total attachment size exceeds ${MAX_TOTAL_BYTES / 1024 / 1024}MB limit.`);
        }
        validatedAttachments.push({ base64: att.base64, media_type: att.media_type });
      }
    }

    // Validate document attachments (PDFs). Separate bucket from images so
    // a large PDF can't displace photos. Caps are measured in the SAME units
    // (base64 string length) as src/agent/document-sanitize.ts — if we
    // accepted more we'd sneak past ingress only to get trimmed or refused
    // downstream.
    const MAX_DOCUMENT_BASE64 = 27 * 1024 * 1024;          // matches MAX_SINGLE_DOCUMENT_BASE64
    const MAX_DOCUMENT_COUNT = 3;
    const MAX_DOCUMENT_TOTAL_BASE64 = 50 * 1024 * 1024;    // matches MAX_TOTAL_DOCUMENT_BASE64
    const VALID_DOCUMENT_TYPES = ["application/pdf"];
    const validatedDocuments: Array<{ base64: string; media_type: string; title?: string }> = [];
    if (p.documents && Array.isArray(p.documents)) {
      if (p.documents.length > MAX_DOCUMENT_COUNT) {
        throw new MethodError("INVALID_REQUEST", `Too many documents (${p.documents.length}). Max ${MAX_DOCUMENT_COUNT}.`);
      }
      let totalBase64 = 0;
      for (const doc of p.documents) {
        if (!doc.base64 || !doc.media_type) continue;
        if (!VALID_DOCUMENT_TYPES.includes(doc.media_type)) {
          log.warn("skipping document with unsupported media type", { media_type: doc.media_type });
          continue;
        }
        const base64Len = doc.base64.length;
        if (base64Len > MAX_DOCUMENT_BASE64) {
          const rawMb = (base64Len * 3 / 4) / 1024 / 1024;
          throw new MethodError(
            "INVALID_REQUEST",
            `Document too large (${rawMb.toFixed(1)}MB). Max ~20MB raw per document.`,
          );
        }
        totalBase64 += base64Len;
        if (totalBase64 > MAX_DOCUMENT_TOTAL_BASE64) {
          const rawMb = (totalBase64 * 3 / 4) / 1024 / 1024;
          throw new MethodError(
            "INVALID_REQUEST",
            `Total document size (${rawMb.toFixed(1)}MB raw) exceeds ~37MB per-message limit.`,
          );
        }
        validatedDocuments.push({
          base64: doc.base64,
          media_type: doc.media_type,
          ...(doc.filename ? { title: doc.filename } : {}),
        });
      }
    }

    // Combined image + document payload cap. Each bucket is budgeted
    // independently for fairness (a big PDF won't boot photos), but the
    // Anthropic request body itself has a combined size ceiling. Without
    // this check, a worst-case 10MB images + 37MB docs = 47MB raw would
    // pass ingress and fail at the API. 55MB base64 (~41MB raw) stays
    // comfortably under that ceiling.
    const MAX_COMBINED_BASE64 = 55 * 1024 * 1024;
    const combinedBase64 =
      validatedAttachments.reduce((s, a) => s + a.base64.length, 0) +
      validatedDocuments.reduce((s, d) => s + d.base64.length, 0);
    if (combinedBase64 > MAX_COMBINED_BASE64) {
      const rawMb = (combinedBase64 * 3 / 4) / 1024 / 1024;
      throw new MethodError(
        "INVALID_REQUEST",
        `Combined image + document payload (${rawMb.toFixed(1)}MB raw) exceeds the per-request limit. Remove some attachments.`,
      );
    }

    const sessionKey = p.sessionKey ?? conn.sessionKey;
    if (!sessionKey) {
      throw new MethodError("NO_SESSION", "No session bound. Provide sessionKey in params or connect with one.");
    }

    // `voice:*` sessions are read-only ASR archives. chat-poster coalesces
    // memos arriving within its debounce window into a single user-role
    // turn, which keeps trailing turns alternation-clean for fork — but the
    // archive itself never has assistant turns, so a real `chat.send` here
    // would still 400 the next Anthropic call. Users who want to chat
    // about memos fork the session into a regular one first.
    if (sessionKey.startsWith("voice:")) {
      throw new MethodError(
        "INVALID_REQUEST",
        `Cannot send to voice:* session "${sessionKey}" — the read-only voice archive is built from ASR transcripts. Fork it (session.fork) into a regular session to chat about its contents; the forked session inherits a single coalesced user turn that Anthropic will accept as the prior turn.`,
      );
    }

    // Bind connection to this session
    conn.bindSession(sessionKey);

    // Note: obvious timed intentions are no longer intercepted here. They flow
    // through the structured `intention.create` RPC (the create_intention tool),
    // not the priority:"timed" chat.send string-parse path (retired).

    // Route through command queue (session lane → global Main lane).
    // Capture usage ONLY if a `done` event actually fires — a turn that
    // errors out mid-way should not clobber the previous persisted value.
    let sawDoneEvent = false;
    let lastContextUsagePercent = 0;
    let lastInputTokens: number | null = null;
    let lastOutputTokens: number | null = null;
    let lastCacheReadTokens: number | null = null;
    let lastCacheCreationTokens: number | null = null;
    let lastSessionCostUSD: number | null = null;
    let assistantText = ""; // Accumulated for channel relay (full sync)
    // Last image a tool produced this turn (e.g. generate_chart) — returned so a
    // bridge caller (web-ios Live) can surface the chart back in its transcript.
    let lastToolImage: { base64: string; media_type: string } | null = null;

    await executeInSession(sessionKey, CommandLane.Main, async () => {
      const session = sessions.getOrCreate(sessionKey, conn.workingDirectory || undefined);

      // Subscribe to agent stream events → broadcast to all clients on this session
      const unsub = session.loop.subscribe((event: StreamEvent) => {
        srv.broadcastToSession(sessionKey, `agent.${event.type}`, event);
        // Capture usage/cost for token pressure check and meta persistence.
        // A 0% / $0 done event is a legitimate short-turn signal, not a
        // "missing" marker — zeros must be preserved, not dropped.
        if (event.type === "done") {
          sawDoneEvent = true;
          if (event.usage?.context_usage_percent != null) {
            lastContextUsagePercent = event.usage.context_usage_percent;
          }
          if (event.usage?.input_tokens != null) lastInputTokens = event.usage.input_tokens;
          if (event.usage?.output_tokens != null) lastOutputTokens = event.usage.output_tokens;
          // Cache buckets must be captured (and persisted) too — once
          // prompt caching engages, the bulk of input tokens shifts from
          // input_tokens to cache_read_input_tokens. Treating only
          // input + output as "session totals" would make every long
          // conversation look like it shrank back to ~5K of fresh input.
          if (event.usage?.cache_read_input_tokens != null) lastCacheReadTokens = event.usage.cache_read_input_tokens;
          if (event.usage?.cache_creation_input_tokens != null) lastCacheCreationTokens = event.usage.cache_creation_input_tokens;
          if ((event as any).sessionCostUSD != null) lastSessionCostUSD = (event as any).sessionCostUSD;
        }
        // Accumulate assistant text for channel relay
        if (event.type === "text") {
          assistantText = event.replace ? event.content : assistantText + event.content;
        }
      });

      try {
        // Peek at background agent completions (don't drain yet —
        // drain only after sendMessage succeeds to prevent data loss on failure).
        const pendingAgents = peekCompletedAgents(sessionKey);
        let userMessage = p.message!;
        if (pendingAgents.length > 0) {
          const notifications = pendingAgents.map((a: any) => {
            const statusText = a.status === "completed" ? "completed" : `failed: ${a.error}`;
            return `[Background agent ${a.id} (${a.description}) ${statusText} in ${Math.round((a.durationMs ?? 0) / 1000)}s]\n${a.result ?? ""}`;
          }).join("\n\n");
          userMessage = `<system-reminder>\n${notifications}\n</system-reminder>\n\n${userMessage}`;
        }

        const isExternalRuntime = session.runtimeKind !== "native" && session.externalRuntime;
        if (isExternalRuntime && !externalAgentRuntimesEnabled()) {
          throw new MethodError(
            "FORBIDDEN",
            "Experimental Codex/Hermes/Claude runtimes are disabled. Enable them in Settings > Experiments.",
          );
        }
        if (isExternalRuntime && ((p.attachments?.length ?? 0) > 0 || (p.documents?.length ?? 0) > 0)) {
          throw new MethodError(
            "INVALID_REQUEST",
            `Experimental ${session.runtimeKind} runtime is text-only and does not support images or documents yet.`,
          );
        }
        // Track history length before sendMessage so we persist ALL new messages
        // (user + assistant + tool_use + tool_result — not just the last two)
        const prevLength = session.loop.getHistory().length;

        // Broadcast the user's message to SIBLING clients (excluding the sender)
        // before the agent starts streaming. This fixes the bug where sibling
        // clients (e.g. web PWA, another tab, iPhone) would not see the user
        // bubble when another client sent a message — they had to refresh and
        // pull session.history to catch up.
        //
        // The sender is excluded via conn.connId: the sender already rendered
        // its own bubble optimistically in sendMessage, so there is no echo to
        // dedup against. This replaces an earlier flag+timestamp heuristic that
        // silently dropped sibling messages when they happened to match the
        // sender's recent text (e.g., both clients typing "ok" within 5s).
        //
        // Broadcast uses p.message (raw user text), not userMessage — the
        // latter may include an internal <system-reminder>...</system-reminder>
        // envelope added by background-agent notifications, which must not
        // leak into sibling UIs.
        //
        // Attachments mirror the shape siblings already render for their own
        // optimistic sends (SessionMessage.images / .documents):
        //   - Images carry base64 so the sibling can render the thumbnail.
        //     Bounded by the ingress caps above (3MB/image, 10MB total).
        //   - Documents are metadata only (media_type, filename, sizeBytes);
        //     PDF bytes can be ~50MB and would be wasted wire traffic — the
        //     pill only needs filename/size, matching how local history
        //     stores documents without base64.
        srv.broadcastToSession(sessionKey, "user.message", {
          type: "user.message",
          sessionKey,
          text: p.message,
          attachments: validatedAttachments.length > 0
            ? validatedAttachments.map((a) => ({ base64: a.base64, media_type: a.media_type }))
            : undefined,
          documents: validatedDocuments.length > 0
            ? validatedDocuments.map((d) => ({
                media_type: d.media_type,
                filename: d.title ?? "document",
                sizeBytes: Math.ceil(d.base64.length * 3 / 4),
              }))
            : undefined,
          timestamp: new Date().toISOString(),
          messageId: crypto.randomUUID(),
        }, conn.clientId);

        if (isExternalRuntime) {
          let result: Awaited<ReturnType<NonNullable<typeof session.externalRuntime>["sendMessage"]>>;
          try {
            result = await session.externalRuntime!.sendMessage({
              runtimeKind: session.runtimeKind as Exclude<ClientRuntimeKind, "native">,
              sessionKey,
              cwd: session.workingDirectory,
              history: session.loop.getHistory(),
              message: userMessage,
              emit: (event) => {
                srv.broadcastToSession(sessionKey, `agent.${event.type}`, event);
                if (event.type === "done") {
                  sawDoneEvent = true;
                  if (event.usage?.context_usage_percent != null) {
                    lastContextUsagePercent = event.usage.context_usage_percent;
                  }
                  if (event.usage?.input_tokens != null) lastInputTokens = event.usage.input_tokens;
                  if (event.usage?.output_tokens != null) lastOutputTokens = event.usage.output_tokens;
                  if (event.usage?.cache_read_input_tokens != null) lastCacheReadTokens = event.usage.cache_read_input_tokens;
                  if (event.usage?.cache_creation_input_tokens != null) lastCacheCreationTokens = event.usage.cache_creation_input_tokens;
                  if ((event as any).sessionCostUSD != null) lastSessionCostUSD = (event as any).sessionCostUSD;
                }
                if (event.type === "text") {
                  assistantText = event.replace ? event.content : assistantText + event.content;
                }
              },
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (message.includes("SIGTERM")) {
              srv.broadcastToSession(sessionKey, "agent.cancel", {
                type: "cancel",
                content: "Request cancelled by user",
              });
            } else {
              srv.broadcastToSession(sessionKey, "agent.error", {
                type: "error",
                content: message,
                code: "external_runtime_error",
              });
            }
            throw err;
          }
          const nextHistory = [...session.loop.getHistory(), ...result.messages];
          session.loop.setHistory(nextHistory);
          session.sessionManager.appendMessage(result.userMessage);
          srv.broadcastToSession(sessionKey, "agent.user_committed", {
            type: "user_committed",
            message_index: prevLength,
          });
          for (const msg of result.messages.slice(1)) {
            session.sessionManager.appendMessage(msg);
          }
          if (pendingAgents.length > 0) {
            drainCompletedAgents(sessionKey);
          }
        } else {
        // Bridge connections (e.g. ios-live-bridge: the realtime frontend
        // asking the background agent for help via session_send_message) have
        // no interactive UI to answer a permission dialog. Run their turns
        // headless so tools auto-approve instead of hanging forever on an
        // unanswerable permission.request — mirrors the Slack inbound path
        // (agent-turn.ts) which is also headless. Interactive web/TUI
        // connections keep the permission prompt.
        const isBridgeConn = (conn.clientPlatform ?? "").includes("bridge");
          await session.loop.sendMessage(userMessage, {
            headless: isBridgeConn,
            attachments: validatedAttachments.length > 0 ? validatedAttachments : undefined,
            documents: validatedDocuments.length > 0 ? validatedDocuments : undefined,
          });

          // Now that sendMessage succeeded, drain the completed agents
          // (safe to remove — the results are in the conversation history)
          if (pendingAgents.length > 0) {
            drainCompletedAgents(sessionKey);
          }

          // Persist all new messages added during this turn
          const history = session.loop.getHistory();
          const newMessages = history.slice(prevLength);
          for (const msg of newMessages) {
            session.sessionManager.appendMessage(msg);
          }
          // Scan this turn's tool_result blocks for an image (e.g. a chart) so a
          // bridge caller can render it. Last image wins.
          for (const msg of newMessages) {
            if (!Array.isArray(msg.content)) continue;
            for (const block of msg.content as unknown as Array<Record<string, any>>) {
              if (block?.type !== "tool_result") continue;
              const inner = block.content;
              if (!Array.isArray(inner)) continue;
              for (const ib of inner as Array<Record<string, any>>) {
                if (ib?.type === "image" && ib.source?.type === "base64" && typeof ib.source.data === "string") {
                  lastToolImage = { base64: ib.source.data, media_type: ib.source.media_type || "image/png" };
                }
              }
            }
          }
          // Persist permission cache if it has new entries
          if (session.loop.getPermissionCache().hasEntries()) {
            savePermissions(session.loop.getPermissionCache().serialize()).catch(() => {});
          }
        }
      } finally {
        unsub();
      }
    });

    // Full sync: relay assistant response to bound channels (Slack, etc.)
    // Prefix the user's input as a blockquote so the Slack thread shows
    // both sides of the conversation — otherwise Slack viewers would only
    // see the agent's replies with no context for what was asked.
    // Fire-and-forget — don't block the response to the web/TUI client.
    const userPrefix = p.message ? `> ${p.message.trim().split("\n").join("\n> ")}\n\n` : "";
    relayToChannels({
      sessionKey,
      text: assistantText ? userPrefix + assistantText : "",
      registry: channelRegistryRef,
      bindings: sessionBindingRef,
      origin: "chat.send",
    });

    // Post-turn context management: memory flush (90%) then compaction (95%).
    // These run sequentially to avoid the race where flush's temporary history
    // swap overwrites compaction's rewritten history.
    const flushConfig = config ? resolveFlushConfig(config) : null;
    const needsFlush = flushConfig?.enabled && config &&
      shouldTriggerFlush(lastContextUsagePercent, flushConfig.thresholdPercent, sessionKey);

    if (needsFlush) {
      const pressureSession = sessions.get(sessionKey);
      const pressureSnapshot = pressureSession ? pressureSession.loop.getHistory() : [];

      log.info("token pressure detected, triggering memory flush", {
        sessionKey,
        contextUsagePercent: lastContextUsagePercent,
        threshold: flushConfig!.thresholdPercent,
      });
      // Await flush so it completes before compaction runs (prevents history race).
      try {
        await runMemoryFlush({
          sessionKey,
          trigger: "pressure",
          sessions,
          config: config!,
          historySnapshot: pressureSnapshot,
          broadcastToSession: (sk, evt, payload) => server.broadcastToSession(sk, evt, payload),
        });
      } catch (err) {
        log.warn("memory flush on token pressure failed (non-fatal)", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Auto-compaction: summarize old messages when context is nearly full.
    // Runs after flush completes (if triggered) to avoid history mutation race.
    const compactionConfig = config ? resolveCompactionConfig(config) : null;
    if (compactionConfig?.enabled && config) {
      const compState = getCompactionState(sessionKey);
      if (shouldAutoCompact(lastContextUsagePercent, compactionConfig, compState)) {
        const compSession = sessions.get(sessionKey);
        if (compSession) {
          log.info("auto-compaction triggered", {
            sessionKey,
            contextUsagePercent: lastContextUsagePercent,
            threshold: compactionConfig.threshold_percent,
          });
          server.broadcastToSession(sessionKey, "compaction.started", {
            type: "compaction.started", sessionKey, timestamp: Date.now(),
          });
          try {
            const result = await compactConversation(
              compSession.loop.getHistory(),
              compSession.loop["provider"] as import("../agent/provider.js").LLMProvider,
              config.model,
              compactionConfig,
            );
            if (result) {
              compSession.loop.setHistory(result.compactedHistory);
              compSession.sessionManager.rewriteMessages(result.compactedHistory);
              compState.consecutiveFailures = 0;
              compState.lastCompactedAt = Date.now();
              server.broadcastToSession(sessionKey, "compaction.completed", {
                type: "compaction.completed", sessionKey, timestamp: Date.now(),
                messagesRemoved: result.messagesRemoved, messagesKept: result.messagesKept,
              });
              server.broadcastToSession(sessionKey, "agent.system_message", {
                type: "system_message",
                content: `Context compacted: ${result.messagesRemoved} messages summarized, ${result.messagesKept} kept.`,
                subtype: "compaction",
              });
            } else {
              server.broadcastToSession(sessionKey, "compaction.completed", {
                type: "compaction.completed", sessionKey, timestamp: Date.now(),
                skipped: true, reason: "not enough messages",
              });
            }
          } catch (err) {
            compState.consecutiveFailures++;
            log.warn("auto-compaction failed", {
              sessionKey,
              error: err instanceof Error ? err.message : String(err),
              consecutiveFailures: compState.consecutiveFailures,
            });
            server.broadcastToSession(sessionKey, "compaction.completed", {
              type: "compaction.completed", sessionKey, timestamp: Date.now(),
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
    }

    // Persist last-turn usage so the sidebar ring and footer populate on
    // cold load. Shared with triggerAgentTurn (heartbeat/cron/Slack).
    // Skip entirely if no done event fired — prevents clobbering the
    // previous value on a mid-turn failure.
    if (sawDoneEvent) {
      persistLastTurnUsage(sessionKey, {
        contextUsagePercent: lastContextUsagePercent,
        inputTokens: lastInputTokens,
        outputTokens: lastOutputTokens,
        cacheReadTokens: lastCacheReadTokens,
        cacheCreationTokens: lastCacheCreationTokens,
        sessionCostUSD: lastSessionCostUSD,
      });
    }

    return {
      completed: true,
      sessionKey,
      // The agent's final reply + any image it produced (e.g. a chart). Lets a
      // bridge caller (web-ios Live's session_send_message) surface the result
      // in its transcript instead of getting a static ack.
      reply: assistantText || "",
      ...(lastToolImage ? { image: lastToolImage } : {}),
    };
  });

  // -------------------------------------------------------------------------
  // chat.cancel — cancel the current agent turn for a session
  // -------------------------------------------------------------------------
  server.registerMethod("chat.cancel", (conn, params) => {
    const p = params as { sessionKey?: string } | undefined;
    const sessionKey = p?.sessionKey ?? conn.sessionKey;
    if (!sessionKey) {
      throw new MethodError("NO_SESSION", "No session to cancel");
    }

    const session = sessions.get(sessionKey);
    if (!session) {
      return { cancelled: false, reason: "no active session" };
    }

    if (session.loop.isRunning()) {
      session.loop.cancel();
      // Also cancel any pending permission requests for this session.
      // Without this, the permissionResolver.ask() Promise blocks the Main lane
      // until the 120s timeout, making subsequent chat.send calls queue/timeout.
      cancelPendingPermissions(sessionKey);
      return { cancelled: true, sessionKey };
    }
    if (session.externalRuntime?.cancel()) {
      return { cancelled: true, sessionKey };
    }

    return { cancelled: false, reason: "agent not running" };
  });

  // -------------------------------------------------------------------------
  // chat.rewind — truncate conversation history at a user-message boundary
  //
  // Drops state across (a) in-memory history, (b) the JSONL file, (c) per-
  // session ephemeral state (task store, background agents, compaction
  // circuit breaker), (d) memory-index chunks, (e) heartbeat distillation
  // offset, (f) sub-agent JSONL files, (g) persisted meta.json snapshots.
  // Returns a summary for UI display (droppedCount + sideEffects).
  //
  // Does NOT send a replacement message — the client is expected to follow
  // with `chat.send` for that. Keeping the two RPCs separate means the
  // client can let the user preview side effects before committing to the
  // rewind, and reusing the existing chat.send path avoids re-implementing
  // attachments / lane serialization / broadcast in two places.
  //
  // See gateway/rewind.ts for the full invalidation list + the side effects
  // we explicitly do NOT try to undo (files modified by tools, Slack
  // messages, cron jobs, etc.).
  // -------------------------------------------------------------------------
  server.registerMethod("chat.rewind", async (conn, params, srv) => {
    const p = params as {
      sessionKey?: string;
      messageIndex?: number;
      /** Alternative to messageIndex: the 0-based count of user-text
       *  messages (skipping pure tool_result-only user messages) to rewind
       *  to. Web clients should prefer this — the UI's message array index
       *  diverges from the backend history index because each tool_use is
       *  rendered as its own row. See userTurnIndexToMessageIndex. */
      userTurnIndex?: number;
    } | undefined;
    const sessionKey = p?.sessionKey ?? conn.sessionKey;
    if (!sessionKey) {
      throw new MethodError("NO_SESSION", "sessionKey is required");
    }
    // Resolve exactly one of messageIndex / userTurnIndex to a concrete
    // backend history index. Exactly one must be provided (not both, not
    // neither) — we want the RPC contract unambiguous.
    const hasMessageIndex =
      typeof p?.messageIndex === "number" &&
      Number.isInteger(p.messageIndex) &&
      p.messageIndex >= 0;
    const hasUserTurnIndex =
      typeof p?.userTurnIndex === "number" &&
      Number.isInteger(p.userTurnIndex) &&
      p.userTurnIndex >= 0;
    if (hasMessageIndex === hasUserTurnIndex) {
      throw new MethodError(
        "INVALID_REQUEST",
        "exactly one of messageIndex or userTurnIndex must be a non-negative integer",
      );
    }
    let messageIndex: number;
    if (hasMessageIndex) {
      messageIndex = p!.messageIndex as number;
    } else {
      // Resolve user-turn index against the session's in-memory history.
      // getOrCreate so a persisted-but-inactive session is hydrated first
      // (same rationale as in rewindSession itself).
      const session = sessions.getOrCreate(sessionKey);
      const resolved = userTurnIndexToMessageIndex(
        session.loop.getHistory(),
        p!.userTurnIndex as number,
      );
      if (resolved < 0) {
        throw new MethodError(
          "INVALID_REQUEST",
          `userTurnIndex ${p!.userTurnIndex} is out of range for this session`,
        );
      }
      messageIndex = resolved;
    }

    // Reset compaction circuit breaker for the session: everything the
    // breaker may have tripped on is now gone from history, so the next
    // turn should be allowed to attempt compaction fresh if it crosses
    // the 95% threshold.
    compactionStates.delete(sessionKey);

    // Serialize on the same session lane that chat.send uses. Without this,
    // rewind can race with an in-flight turn: loop.cancel() only flips the
    // abort signal — it does not wait for the running send to finish, so
    // the cancelled turn can still append a final message / persist JSONL /
    // broadcast events AFTER rewind has already truncated. Putting rewind
    // in the same lane (max concurrency 1 per session) means any queued
    // or in-flight chat.send for this session completes first, THEN rewind
    // mutates history — no races on disk or on the AgentLoop state.
    try {
      const result = await executeInSession(sessionKey, CommandLane.Main, () =>
        rewindSession(
          {
            sessions,
            server: srv,
            heartbeat: heartbeatRef ?? undefined,
            // Skip every conn of the acting client so its tab — and any
            // sibling socket the same client has open (PWA SW, reconnect
            // overlap) — doesn't race against its own broadcast.
            excludeClientId: conn.clientId,
          },
          sessionKey,
          messageIndex,
        ),
      );
      return {
        rewound: true,
        sessionKey,
        droppedCount: result.droppedCount,
        sideEffects: result.sideEffects,
      };
    } catch (err) {
      throw new MethodError(
        "INVALID_REQUEST",
        err instanceof Error ? err.message : String(err),
      );
    }
  });

  // -------------------------------------------------------------------------
  // session.list — list recent sessions (from disk)
  // -------------------------------------------------------------------------
  server.registerMethod("session.list", (_conn, params) => {
    const p = params as { limit?: number; includeArchived?: boolean } | undefined;
    const limit = p?.limit ?? 20;
    // Fetch more than requested to account for cron sessions that will be filtered out
    const persisted = sessions.listPersisted(limit * 5, { includeArchived: p?.includeArchived });
    const activeKeys = sessions.keys();
    const activeIds = new Set(activeKeys.map((key) => sessionKeyToId(key)));

    // Build lookup for persisted session metadata (for sidebar filtering)
    const persisted_map = new Map(persisted.map((s) => [s.id, s]));

    // Start with persisted sessions (from disk)
    const seen = new Set<string>();
    const result: Array<{
      id: string;
      createdAt: string;
      messageCount: number;
      active: boolean;
      displayName?: string | null;
      pinned?: boolean;
      archived?: boolean;
      contextUsagePercent?: number | null;
      sessionTokens?: { input: number; output: number; cacheRead?: number; cacheCreation?: number } | null;
      sessionCostUSD?: number | null;
      runtimeKind?: ClientRuntimeKind;
      runtimeCapabilities?: RuntimeCapabilities;
    }> = [];

    for (const s of persisted) {
      seen.add(s.id);
      result.push({
        id: s.id,
        createdAt: s.createdAt,
        messageCount: s.messageCount,
        active: activeIds.has(s.id),
        displayName: s.displayName ?? null,
        pinned: s.pinned ?? false,
        archived: s.archived ?? false,
        contextUsagePercent: s.contextUsagePercent ?? null,
        sessionTokens: s.sessionTokens ?? null,
        sessionCostUSD: s.sessionCostUSD ?? null,
        runtimeKind: s.runtimeKind ?? "native",
        runtimeCapabilities: capabilitiesForRuntime(s.runtimeKind ?? "native"),
      });
    }

    // Merge in-memory sessions that haven't been persisted yet.
    // Only include sessions created in the last 60 seconds (covers the
    // "just created, agent still running" window). Older in-memory sessions
    // without a disk file are stale (file was deleted) — evict them.
    const now = Date.now();
    const RECENT_WINDOW_MS = 60_000;
    for (const key of activeKeys) {
      const session = sessions.get(key);
      if (!session) continue;
      const id = session.sessionManager.getSessionId();
      if (seen.has(id)) continue;

      const age = now - session.createdAt;
      if (age > RECENT_WINDOW_MS) {
        // Stale in-memory session with no disk file — evict
        sessions.evict(key);
        continue;
      }

      seen.add(id);
      result.push({
        id,
        createdAt: new Date(session.createdAt).toISOString(),
        messageCount: session.loop.getHistory().length,
        active: true,
        runtimeKind: session.runtimeKind,
        runtimeCapabilities: capabilitiesForRuntime(session.runtimeKind),
      });
    }

    // Sidebar filtering: hide old orphaned cron sessions
    const CRON_VISIBILITY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
    const filtered = result.filter((s) => {
      // Derive session key from ID
      const key = s.id.includes("/") ? s.id.replace("/", ":") : s.id;

      // Only filter cron sessions
      if (!key.startsWith("cron:")) return true;

      // If cron store is available, check if job still exists
      if (cronStoreRef) {
        const jobs = cronStoreRef.getJobs();
        const cronName = key.slice(5); // "cron:hn-digest" → "hn-digest"
        const jobExists = jobs.some((j) => {
          const sanitized = j.name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9_-]/g, "");
          return sanitized === cronName || j.id === cronName;
        });
        if (jobExists) return true; // Recurring job — always show
      }

      // Orphaned cron session — show if modified within visibility window
      const persisted = persisted_map.get(s.id);
      if (persisted && persisted.lastModified > now - CRON_VISIBILITY_MS) return true;

      return false;
    });

    // Sort by most recent first, limit
    filtered.sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1));

    return { sessions: filtered.slice(0, limit) };
  });

  // -------------------------------------------------------------------------
  // session.clear — clear conversation history for /new command
  // -------------------------------------------------------------------------
  server.registerMethod("session.clear", (_conn, params) => {
    const p = params as { sessionKey?: string } | undefined;
    const sessionKey = p?.sessionKey;
    if (!sessionKey) {
      throw new MethodError("INVALID_REQUEST", "sessionKey is required");
    }

    const session = sessions.get(sessionKey);
    if (session) {
      session.loop.clearHistory();
      // Re-initialize session file (new header, fresh start)
      session.sessionManager.initSession("cleared", "/");
      // Reset flush dedup so the new session cycle can flush if needed
      resetFlushState(sessionKey);
      // Reset compaction circuit breaker for the fresh session
      compactionStates.delete(sessionKey);
      // Reset per-session cost tracker (new conversation = fresh cost counter)
      getCostTracker()?.resetSession(sessionKey);
      // Reset per-session effort to global default
      const globalEffort = config?.effort ?? "medium";
      session.loop.effort = globalEffort as any;
      // Wipe effort override AND last-turn usage so the sidebar ring +
      // chat footer don't render the previous conversation's numbers
      // on the now-empty session.
      updateSessionMeta(sessionKey, {
        effort: undefined,
        lastContextUsagePercent: undefined,
        lastSessionTokens: undefined,
        lastSessionCostUSD: undefined,
      });
      log.info("session cleared", { sessionKey });
    }
    return { cleared: true, sessionKey };
  });

  // -------------------------------------------------------------------------
  // task.list — snapshot of the current task store for a session.
  //
  // Web clients call this on session-open to seed the task chip before
  // any `task.update` WebSocket events arrive. Uses a non-creating
  // peek so opening a task-less session doesn't allocate an empty
  // store that then lingers for the gateway's lifetime — browsing
  // through many past sessions would otherwise bloat the registry
  // (Codex P2).
  // -------------------------------------------------------------------------
  server.registerMethod("task.list", (conn, params) => {
    const p = params as { sessionKey?: string } | undefined;
    const sessionKey = p?.sessionKey ?? conn.sessionKey;
    if (!sessionKey) {
      throw new MethodError("INVALID_REQUEST", "sessionKey is required");
    }
    const store = peekTaskStore(sessionKey);
    const summary = store ? store.getSummary() : {
      tasks: [],
      total: 0,
      completed: 0,
      in_progress: 0,
      pending: 0,
    };
    return { sessionKey, summary };
  });

  // -------------------------------------------------------------------------
  // session.rename — rename a channel.
  //
  // Two modes, disambiguated by which field the client sends:
  //
  // 1. Deep rename (`newKey` provided): changes the session's identity.
  //    Same-prefix only; heartbeat: and cron: are rejected because their
  //    keys are tied to external identities. Moves the JSONL file, re-keys
  //    meta.json, updates cron jobs / slack bindings / subscriptions, and
  //    evicts the in-memory AgentSession so the next access rebuilds it
  //    under the new key. Broadcasts `session.renamed` so every client
  //    (including the one that initiated the rename) can remap its state.
  //
  // 2. Display-name only (`displayName` provided, no `newKey`): writes a
  //    label into meta.json. Used for singleton/derived sessions where
  //    the key cannot change, and for programmatic callers that only
  //    want to set a label.
  // -------------------------------------------------------------------------
  server.registerMethod("session.rename", (_conn, params) => {
    const p = params as
      | { sessionKey?: string; newKey?: string; displayName?: string }
      | undefined;
    if (!p?.sessionKey) {
      throw new MethodError("INVALID_REQUEST", "sessionKey is required");
    }
    const oldKey = p.sessionKey;

    if (typeof p.newKey === "string") {
      const newKey = p.newKey.trim();
      if (newKey.length === 0) {
        throw new MethodError("INVALID_REQUEST", "newKey must not be empty");
      }
      if (newKey === oldKey) {
        return { ok: true, sessionKey: oldKey, newKey: oldKey };
      }
      const oldPrefix = oldKey.includes(":") ? oldKey.split(":", 1)[0] : "";
      const newPrefix = newKey.includes(":") ? newKey.split(":", 1)[0] : "";
      if (oldPrefix === "" || oldPrefix !== newPrefix) {
        throw new MethodError("INVALID_REQUEST", "newKey must keep the same prefix");
      }
      if (oldPrefix === "heartbeat" || oldPrefix === "cron") {
        throw new MethodError(
          "INVALID_REQUEST",
          `${oldPrefix}: sessions cannot be key-renamed; use displayName instead`,
        );
      }
      const suffix = newKey.slice(oldPrefix.length + 1);
      if (!/^[a-zA-Z0-9_.-]+$/.test(suffix)) {
        throw new MethodError(
          "INVALID_REQUEST",
          "newKey suffix must contain only letters, digits, dot, underscore, or hyphen",
        );
      }

      // Order matters: do the persistent cron rebind BEFORE the irreversible
      // storage rename. If cron save fails, nothing on disk has moved yet and
      // we can bail cleanly. If the storage rename then fails, roll the cron
      // rebind back. Pure in-memory state (bindings, flush, cost) is updated
      // last since those are cheap and best-effort anyway.
      const cronSvc = getCronServiceRef();
      let cronRebindCount = 0;
      if (cronSvc) {
        try {
          cronRebindCount = cronSvc.rebindSessionKey(oldKey, newKey);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error("cron rebind failed, aborting rename", { oldKey, newKey, error: msg });
          throw new MethodError("INTERNAL", `cron rebind failed: ${msg}`);
        }
      }

      try {
        sessions.rename(oldKey, newKey);
      } catch (err) {
        // Storage rename blew up after cron was already committed to newKey.
        // Walk the cron rebind back so jobs still point at oldKey, which is
        // where the session data actually lives.
        if (cronSvc && cronRebindCount > 0) {
          try {
            cronSvc.rebindSessionKey(newKey, oldKey);
          } catch (rollbackErr) {
            log.error("cron rollback failed — cron now inconsistent with storage", {
              oldKey, newKey,
              rollbackError: rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
            });
          }
        }
        const msg = err instanceof Error ? err.message : String(err);
        throw new MethodError("INVALID_REQUEST", msg);
      }

      // Storage + cron are consistent. In-memory propagation is best-effort.
      resetFlushState(oldKey);
      compactionStates.delete(oldKey);
      getCostTracker()?.resetSession(oldKey);
      if (sessionBindingRef) {
        sessionBindingRef.rebindAll(oldKey, newKey);
      }

      server.broadcast("session.renamed", { oldKey, newKey });
      log.info("session renamed", { oldKey, newKey, cronRebindCount });
      return { ok: true, sessionKey: oldKey, newKey };
    }

    if (typeof p.displayName !== "string") {
      throw new MethodError("INVALID_REQUEST", "displayName or newKey is required");
    }
    const name = p.displayName.trim();
    if (name.length === 0) {
      updateSessionMeta(oldKey, { displayName: undefined });
    } else {
      updateSessionMeta(oldKey, { displayName: name });
    }
    log.info("session displayName set", { sessionKey: oldKey, displayName: name || null });
    return { ok: true, sessionKey: oldKey, displayName: name || null };
  });

  // -------------------------------------------------------------------------
  // session.archive — hide a session from the default list
  // -------------------------------------------------------------------------
  server.registerMethod("session.archive", (_conn, params) => {
    const p = params as { sessionKey?: string } | undefined;
    if (!p?.sessionKey) {
      throw new MethodError("INVALID_REQUEST", "sessionKey is required");
    }
    updateSessionMeta(p.sessionKey, { archived: true });
    log.info("session archived", { sessionKey: p.sessionKey });
    return { ok: true, sessionKey: p.sessionKey };
  });

  // -------------------------------------------------------------------------
  // session.unarchive — restore an archived session to the list
  // -------------------------------------------------------------------------
  server.registerMethod("session.unarchive", (_conn, params) => {
    const p = params as { sessionKey?: string } | undefined;
    if (!p?.sessionKey) {
      throw new MethodError("INVALID_REQUEST", "sessionKey is required");
    }
    updateSessionMeta(p.sessionKey, { archived: undefined });
    log.info("session unarchived", { sessionKey: p.sessionKey });
    return { ok: true, sessionKey: p.sessionKey };
  });

  // -------------------------------------------------------------------------
  // session.delete — permanently delete a session (JSONL + metadata)
  // For cron sessions: also deletes the cron job and run log.
  // -------------------------------------------------------------------------
  server.registerMethod("session.delete", (_conn, params) => {
    const p = params as { sessionKey?: string } | undefined;
    if (!p?.sessionKey) {
      throw new MethodError("INVALID_REQUEST", "sessionKey is required");
    }
    // Clean up associated state
    resetFlushState(p.sessionKey);
    compactionStates.delete(p.sessionKey);
    getCostTracker()?.resetSession(p.sessionKey);

    // If this is a cron-backed session, also delete every cron job whose
    // runtime session key resolves to it. We remove ALL matches — multiple
    // jobs can share a session key (two `current`-target jobs in the same
    // chat, several jobs pointed at one named session). A single-match
    // earlier version of this cleanup was a regression Codex flagged:
    // remaining jobs would keep firing into an orphan thread the user
    // can't see. The lookup uses the scheduler's own resolveSessionKey()
    // path, so sanitized names ("Nightly Digest" → cron:nightly-digest)
    // also match correctly.
    if (p.sessionKey.startsWith("cron:") || p.sessionKey.startsWith("session:")) {
      try {
        const cronService = getCronServiceRef();
        if (cronService?.findJobsBySessionKey) {
          const jobs = cronService.findJobsBySessionKey(p.sessionKey);
          for (const job of jobs) {
            cronService.removeJob(job.id);
            log.info("cron job deleted with session", {
              sessionKey: p.sessionKey, jobId: job.id, jobName: job.name,
            });
          }
        }
      } catch {
        // Cron service not available — just delete the session
      }
    }

    const deleted = sessions.deleteSession(p.sessionKey);
    return { ok: true, sessionKey: p.sessionKey, deleted };
  });

  // -------------------------------------------------------------------------
  // session.pin — pin a session to the top of the list
  // -------------------------------------------------------------------------
  server.registerMethod("session.pin", (_conn, params) => {
    const p = params as { sessionKey?: string } | undefined;
    if (!p?.sessionKey) {
      throw new MethodError("INVALID_REQUEST", "sessionKey is required");
    }
    updateSessionMeta(p.sessionKey, { pinned: true });
    log.info("session pinned", { sessionKey: p.sessionKey });
    return { ok: true, sessionKey: p.sessionKey };
  });

  // -------------------------------------------------------------------------
  // session.unpin — remove pin from a session
  // -------------------------------------------------------------------------
  server.registerMethod("session.unpin", (_conn, params) => {
    const p = params as { sessionKey?: string } | undefined;
    if (!p?.sessionKey) {
      throw new MethodError("INVALID_REQUEST", "sessionKey is required");
    }
    updateSessionMeta(p.sessionKey, { pinned: undefined });
    log.info("session unpinned", { sessionKey: p.sessionKey });
    return { ok: true, sessionKey: p.sessionKey };
  });

  // -------------------------------------------------------------------------
  // session.flush — manually trigger memory flush for a session
  // Extracts durable memories from the conversation into daily logs.
  // Does NOT clear the session — conversation continues normally.
  // -------------------------------------------------------------------------
  server.registerMethod("session.flush", async (_conn, params) => {
    const p = params as { sessionKey?: string } | undefined;
    const sessionKey = p?.sessionKey ?? _conn.sessionKey;
    if (!sessionKey) {
      throw new MethodError("INVALID_REQUEST", "sessionKey is required");
    }

    const flushConfig = config ? resolveFlushConfig(config) : null;
    if (!flushConfig?.enabled || !config) {
      server.broadcastToSession(sessionKey, "flush.skipped", { type: "flush.skipped", sessionKey, reason: "disabled" });
      return { flushed: false, reason: "memory_flush disabled" };
    }

    const session = sessions.get(sessionKey);
    if (!session) {
      server.broadcastToSession(sessionKey, "flush.skipped", { type: "flush.skipped", sessionKey, reason: "no session" });
      return { flushed: false, reason: "no active session" };
    }

    const historySnapshot = session.loop.getHistory();
    if (historySnapshot.length < 4) {
      server.broadcastToSession(sessionKey, "flush.skipped", { type: "flush.skipped", sessionKey, reason: "conversation too short" });
      return { flushed: false, reason: "conversation too short" };
    }

    if (hasAlreadyFlushed(sessionKey)) {
      server.broadcastToSession(sessionKey, "flush.skipped", { type: "flush.skipped", sessionKey, reason: "already flushed" });
      return { flushed: false, reason: "already flushed" };
    }

    // Fire-and-forget — don't block the RPC response
    void runMemoryFlush({
      sessionKey,
      trigger: "flush",
      sessions,
      config,
      historySnapshot,
      broadcastToSession: (sk, evt, payload) => server.broadcastToSession(sk, evt, payload),
    }).catch((err) => {
      log.warn("manual memory flush failed (non-fatal)", {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return { flushed: true, sessionKey };
  });

  // -------------------------------------------------------------------------
  // session.compact — manually trigger context compaction for a session
  // Summarizes old messages to free context space.
  // Unlike auto-compact, this ignores the circuit breaker.
  // -------------------------------------------------------------------------
  server.registerMethod("session.compact", async (_conn, params) => {
    const p = params as { sessionKey?: string } | undefined;
    const sessionKey = p?.sessionKey ?? _conn.sessionKey;
    if (!sessionKey) {
      throw new MethodError("INVALID_REQUEST", "sessionKey is required");
    }

    const compConfig = config ? resolveCompactionConfig(config) : null;
    if (!compConfig || !config) {
      return { compacted: false, reason: "compaction not configured" };
    }

    const session = sessions.get(sessionKey);
    if (!session) {
      return { compacted: false, reason: "no active session" };
    }

    const history = session.loop.getHistory();
    if (history.length < 6) {
      server.broadcastToSession(sessionKey, "agent.system_message", {
        type: "system_message",
        content: "Not enough messages to compact.",
        subtype: "info",
      });
      return { compacted: false, reason: "conversation too short" };
    }

    // Serialize with the session lane to prevent concurrent history mutation
    // with chat.send or other session operations.
    server.broadcastToSession(sessionKey, "compaction.started", {
      type: "compaction.started", sessionKey, timestamp: Date.now(),
    });
    void executeInSession(sessionKey, CommandLane.Main, async () => {
      try {
        const freshSession = sessions.get(sessionKey);
        if (!freshSession) return;
        const result = await compactConversation(
          freshSession.loop.getHistory(),
          freshSession.loop["provider"] as import("../agent/provider.js").LLMProvider,
          config!.model,
          compConfig,
        );
        if (result) {
          freshSession.loop.setHistory(result.compactedHistory);
          freshSession.sessionManager.rewriteMessages(result.compactedHistory);
          const state = getCompactionState(sessionKey);
          state.consecutiveFailures = 0;
          state.lastCompactedAt = Date.now();
          server.broadcastToSession(sessionKey, "compaction.completed", {
            type: "compaction.completed", sessionKey, timestamp: Date.now(),
            messagesRemoved: result.messagesRemoved, messagesKept: result.messagesKept,
          });
          server.broadcastToSession(sessionKey, "agent.system_message", {
            type: "system_message",
            content: `Context compacted: ${result.messagesRemoved} messages summarized, ${result.messagesKept} kept.`,
            subtype: "compaction",
          });
        } else {
          server.broadcastToSession(sessionKey, "compaction.completed", {
            type: "compaction.completed", sessionKey, timestamp: Date.now(),
            skipped: true, reason: "not enough messages",
          });
          server.broadcastToSession(sessionKey, "agent.system_message", {
            type: "system_message",
            content: "Not enough messages to compact.",
            subtype: "info",
          });
        }
      } catch (err) {
        log.warn("manual compaction failed", {
          sessionKey,
          error: err instanceof Error ? err.message : String(err),
        });
        server.broadcastToSession(sessionKey, "compaction.completed", {
          type: "compaction.completed", sessionKey, timestamp: Date.now(),
          error: err instanceof Error ? err.message : String(err),
        });
        server.broadcastToSession(sessionKey, "agent.system_message", {
          type: "system_message",
          content: `Compaction failed: ${err instanceof Error ? err.message : String(err)}`,
          subtype: "info",
        });
      }
    }).catch(() => {});

    return { compacted: true, sessionKey };
  });

  // -------------------------------------------------------------------------
  // session.exists — check if a session exists (without creating it)
  // -------------------------------------------------------------------------
  server.registerMethod("session.exists", (_conn, params) => {
    const p = params as { sessionKey?: string } | undefined;
    const sessionKey = p?.sessionKey;
    if (!sessionKey) {
      throw new MethodError("INVALID_REQUEST", "sessionKey is required");
    }

    // Check in-memory first
    if (sessions.has(sessionKey)) {
      return { exists: true, sessionKey };
    }

    // Check on disk by deterministic file path (folder-based)
    const sessionId = sessionKey.replace(":", "/").replace(/[^a-zA-Z0-9_/.-]/g, "-");
    const sessionsDir = join(homedir(), ".hawky", "sessions");
    const filePath = join(sessionsDir, `${sessionId}.jsonl`);
    return { exists: existsSync(filePath), sessionKey };
  });

  // -------------------------------------------------------------------------
  // session.appendMessages — append plain user/assistant turns to a session's
  // history WITHOUT running the agent. Used by frontend realtime/Live clients
  // (e.g. web-ios) to persist the spoken conversation so it shows up in
  // session.list (message count) and reloads via session.history. Mirrors how
  // the fork path injects context (loop.setHistory + sessionManager.append).
  // -------------------------------------------------------------------------
  server.registerMethod("session.appendMessages", (_conn, params) => {
    const p = params as
      | { sessionKey?: string; messages?: Array<{ role?: string; text?: string; timestamp?: string }> }
      | undefined;
    const sessionKey = p?.sessionKey;
    if (!sessionKey) {
      throw new MethodError("INVALID_REQUEST", "sessionKey is required");
    }
    const incoming = p?.messages;
    if (!Array.isArray(incoming) || incoming.length === 0) {
      throw new MethodError("INVALID_REQUEST", "messages must be a non-empty array");
    }

    const built = incoming
      .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.text === "string" && m.text.trim())
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content: [{ type: "text" as const, text: m.text!.trim() }],
        timestamp: typeof m.timestamp === "string" && m.timestamp ? m.timestamp : new Date().toISOString(),
      }));
    if (built.length === 0) {
      throw new MethodError("INVALID_REQUEST", "no valid user/assistant text messages");
    }

    const session = sessions.getOrCreate(sessionKey);
    const existing = session.loop.getHistory();
    session.loop.setHistory([...existing, ...built]);
    for (const msg of built) {
      session.sessionManager.appendMessage(msg);
    }

    return { ok: true, appended: built.length, total: session.loop.getHistory().length };
  });

  // -------------------------------------------------------------------------
  // session.resolve — get or create a session by key
  // -------------------------------------------------------------------------
  server.registerMethod("session.resolve", (conn, params) => {
    const p = params as { sessionKey?: string; runtimeKind?: ClientRuntimeKind; workingDirectory?: string } | undefined;
    const sessionKey = p?.sessionKey;
    if (!sessionKey) {
      throw new MethodError("INVALID_REQUEST", "sessionKey is required");
    }
    const runtimeKind = p?.runtimeKind ?? "native";
    if (!["native", "codex", "hermes", "claude"].includes(runtimeKind)) {
      throw new MethodError("INVALID_REQUEST", "runtimeKind must be native, codex, hermes, or claude");
    }
    if (runtimeKind !== "native" && !externalAgentRuntimesEnabled()) {
      throw new MethodError(
        "FORBIDDEN",
        "Experimental Codex/Hermes/Claude runtimes are disabled. Enable them in Settings > Experiments.",
      );
    }

    const session = sessions.getOrCreate(sessionKey, p?.workingDirectory, runtimeKind);
    conn.bindSession(sessionKey);

    // HIGH-2 fix: restore persisted mode only when the client did NOT
    // explicitly provide a mode at handshake time. If the client said
    // "quiet" (or any mode) at connect, that takes precedence over any
    // saved mode — so a once-ambient session that reconnects in quiet
    // mode stays quiet.
    if (!conn.modeExplicitlySet) {
      const meta = loadSessionMeta();
      const savedMode = meta[sessionKey]?.ambientMode;
      if (savedMode) conn.mode = savedMode;
    }

    return {
      sessionKey,
      sessionId: session.sessionManager.getSessionId(),
      messageCount: session.loop.getHistory().length,
      runtimeKind: session.runtimeKind,
      runtimeCapabilities: capabilitiesForRuntime(session.runtimeKind),
    };
  });

  // -------------------------------------------------------------------------
  // session.history — get conversation history for a session
  //
  // Pagination (cursor-based): `beforeIndex` selects messages with absolute
  // position < beforeIndex. An "absolute position" is the message's index in
  // the session's append-only history array, so it remains stable even when
  // new messages arrive during browsing — no drift, no overlap.
  //
  //   { beforeIndex: undefined, limit: 100 } → most recent 100 messages
  //   { beforeIndex: 150,       limit: 100 } → messages [50, 150)
  //
  // Every message in the response includes its `index` so the client can set
  // `beforeIndex` to the oldest loaded index on the next request.
  // `hasMore` indicates whether older messages still exist beyond this window.
  // -------------------------------------------------------------------------
  server.registerMethod("session.history", (_conn, params) => {
    const p = params as { sessionKey?: string; limit?: number; beforeIndex?: number } | undefined;
    const sessionKey = p?.sessionKey;
    if (!sessionKey) {
      throw new MethodError("INVALID_REQUEST", "sessionKey is required");
    }

    // getOrCreate loads history from disk if session hasn't been accessed yet
    // (e.g., TUI reconnecting after gateway restart — session is on disk but not in memory)
    const session = sessions.getOrCreate(sessionKey);
    const history = session.loop.getHistory();
    const total = history.length;
    const limit = Math.max(0, p?.limit ?? 100);

    const endIndex = p?.beforeIndex !== undefined
      ? Math.max(0, Math.min(p.beforeIndex, total))
      : total;
    const startIndex = Math.max(0, endIndex - limit);
    const messages = history.slice(startIndex, endIndex).map((msg, i) => ({
      index: startIndex + i,
      role: msg.role,
      timestamp: msg.timestamp,
      // Send content blocks but strip internal_only fields
      content: msg.content.filter((b) => !(b as any).internal_only),
    }));

    return {
      messages,
      sessionKey,
      total,
      hasMore: startIndex > 0,
    };
  });

  // -------------------------------------------------------------------------
  // permission.resolve — client responds to a permission.request event
  // -------------------------------------------------------------------------
  server.registerMethod("permission.resolve", (_conn, params) => {
    const p = params as { requestId?: string; decision?: string; feedback?: string; pattern?: string } | undefined;
    if (!p?.requestId || !p?.decision) {
      throw new MethodError("INVALID_REQUEST", "requestId and decision are required");
    }

    const validDecisions = ["allow_once", "allow_always", "allow_command", "accept_edits", "allow_directory", "deny"];
    if (!validDecisions.includes(p.decision)) {
      throw new MethodError("INVALID_REQUEST", `Invalid decision: ${p.decision}. Must be one of: ${validDecisions.join(", ")}`);
    }

    const feedback = p.decision === "deny" && typeof p.feedback === "string" && p.feedback.trim()
      ? p.feedback.trim()
      : undefined;
    // `pattern` only applies to allow_always — the user clicked
    // "Allow `<pattern>` always" instead of "Allow this exact". The
    // gateway forwards it to the cache; an empty/missing pattern
    // falls back to the legacy exact-match grant.
    const pattern = p.decision === "allow_always" && typeof p.pattern === "string" && p.pattern.trim()
      ? p.pattern.trim()
      : undefined;
    const resolved = resolveWsPermission(p.requestId, p.decision as PermissionDecision, feedback, pattern);
    if (!resolved) {
      throw new MethodError("NOT_FOUND", `No pending permission request: ${p.requestId}`);
    }

    return { resolved: true };
  });

  // -------------------------------------------------------------------------
  // permission.bypass — toggle bypass mode for a session
  // -------------------------------------------------------------------------
  server.registerMethod("permission.bypass", (conn, params) => {
    const p = params as { enable?: boolean; sessionKey?: string } | undefined;
    const enable = p?.enable ?? true;
    const sessionKey = p?.sessionKey ?? conn.sessionKey;
    if (!sessionKey) {
      throw new MethodError("NO_SESSION", "No session bound");
    }

    // Check if gateway-level bypass is forced
    if (sessions.dangerouslySkipPermissions && !enable) {
      return {
        success: false,
        message: "Cannot disable bypass — gateway started with --dangerously-skip-permissions. Restart without the flag to restore prompts.",
      };
    }

    const session = sessions.get(sessionKey) ?? sessions.getOrCreate(sessionKey);

    const cache = session.loop.getPermissionCache();
    const broadcastModeChange = () => {
      server.broadcastToSession(sessionKey, "permission.mode.changed", {
        type: "permission.mode.changed",
        sessionKey,
        mode: cache.mode,
        forceBypass: cache.isForceBypass(),
      });
    };
    if (enable) {
      cache.recordDecision("*", "allow_all");
      broadcastModeChange();
      return { success: true, message: "⚠ Bypass mode ON — all tools auto-approved. Use /bypass-off to restore prompts." };
    } else {
      cache.reset();
      // Re-apply global persistent permissions after reset
      const globalPerms = loadPermissionsSync();
      if (globalPerms) {
        for (const tool of globalPerms.always_allowed) {
          cache.recordDecision(tool, "allow_always");
        }
        if (globalPerms.allowed_commands) {
          for (const [tool, cmds] of Object.entries(globalPerms.allowed_commands)) {
            for (const cmd of cmds) {
              cache.recordDecision(tool, "allow_command", { command: cmd });
            }
          }
        }
        for (const rule of globalPerms.rules ?? []) {
          cache.recordDecision("*", "allow_always", undefined, rule);
        }
      }
      broadcastModeChange();
      return { success: true, message: "Bypass mode OFF — permission prompts restored." };
    }
  });

  // -------------------------------------------------------------------------
  // permission.mode — get or set permission mode for a session
  // -------------------------------------------------------------------------
  server.registerMethod("permission.mode", (conn, params) => {
    const p = params as { mode?: string; sessionKey?: string } | undefined;
    const sessionKey = p?.sessionKey ?? conn.sessionKey;
    if (!sessionKey) {
      throw new MethodError("NO_SESSION", "No session bound");
    }
    const session = sessions.get(sessionKey);
    if (!session) {
      throw new MethodError("NOT_FOUND", `Session not found: ${sessionKey}`);
    }

    const cache = session.loop.getPermissionCache();
    const broadcastModeChange = () => {
      // Tell every client subscribed to the session that the mode
      // flipped. Clients use this to update their bypass indicator
      // immediately without having to re-fetch the mode on every
      // event. Always broadcasts after a successful change.
      server.broadcastToSession(sessionKey, "permission.mode.changed", {
        type: "permission.mode.changed",
        sessionKey,
        mode: cache.mode,
        forceBypass: cache.isForceBypass(),
      });
    };

    // Get current mode
    if (!p?.mode) {
      return { mode: cache.mode, forceBypass: cache.isForceBypass() };
    }

    // Set mode
    const validModes = ["default", "accept-edits", "bypass"];
    if (!validModes.includes(p.mode)) {
      throw new MethodError("INVALID_REQUEST", `Invalid mode: ${p.mode}. Must be one of: ${validModes.join(", ")}`);
    }

    // Block non-bypass mode changes when gateway-level forced bypass is active
    if (sessions.dangerouslySkipPermissions && p.mode !== "bypass") {
      return {
        mode: cache.mode,
        forceBypass: cache.isForceBypass(),
        message: "Cannot change mode — gateway started with --dangerously-skip-permissions. Restart without the flag to change modes.",
      };
    }

    if (p.mode === "bypass") {
      cache.recordDecision("*", "allow_all");
      broadcastModeChange();
      return { mode: "bypass", forceBypass: cache.isForceBypass(), message: "⚠ Bypass mode ON — all tools auto-approved." };
    }

    // Leaving bypass mode: reset allow_all and re-apply global permissions
    if (cache.isAllowAll()) {
      cache.reset();
      const globalPerms = loadPermissionsSync();
      if (globalPerms) {
        for (const tool of globalPerms.always_allowed) {
          cache.recordDecision(tool, "allow_always");
        }
        if (globalPerms.allowed_commands) {
          for (const [tool, cmds] of Object.entries(globalPerms.allowed_commands)) {
            for (const cmd of cmds) {
              cache.recordDecision(tool, "allow_command", { command: cmd });
            }
          }
        }
        for (const rule of globalPerms.rules ?? []) {
          cache.recordDecision("*", "allow_always", undefined, rule);
        }
      }
    }

    cache.setMode(p.mode as import("../agent/types.js").PermissionMode);
    broadcastModeChange();
    const modeLabel = p.mode === "accept-edits" ? "Accept Edits" : "Default";
    return { mode: p.mode, forceBypass: cache.isForceBypass(), message: `Permission mode: ${modeLabel}` };
  });

  // -------------------------------------------------------------------------
  // session.currentTurn — get in-progress streaming text + any pending
  // permission/ask_user dialog for a session.
  //
  // The pending-dialog payload is what enables late-join: a tab opened
  // AFTER the original broadcast (or another browser / iPhone) needs a
  // way to recover the dialog the agent is blocked on. switchSession on
  // the web calls this RPC and hydrates pendingPermission /
  // pendingAskUser from the response when present.
  // -------------------------------------------------------------------------
  server.registerMethod("session.currentTurn", (conn, params) => {
    const p = params as { sessionKey?: string } | undefined;
    const sessionKey = p?.sessionKey ?? conn.sessionKey;
    if (!sessionKey) throw new MethodError("NO_SESSION", "No session bound");
    const session = sessions.get(sessionKey);
    const baseTurn = session?.externalRuntime
      ? session.externalRuntime.getCurrentTurn()
      : session ? session.loop.getCurrentTurn() : { streaming: false, text: "", busy: false };
    const pendingPermission = getPendingPermissionForSession(sessionKey);
    const pendingAskUser = getPendingAskUserForSession(sessionKey);
    return {
      ...baseTurn,
      // Both fields are null when nothing is pending — the frontend
      // checks for non-null before hydrating dialog state.
      pendingPermission: pendingPermission
        ? {
            requestId: pendingPermission.requestId,
            tool: pendingPermission.dialog.toolName,
            input: pendingPermission.dialog.toolInput,
            diffPreview: pendingPermission.dialog.diffPreview,
            suggestions: pendingPermission.dialog.suggestions,
            suggestedPattern: pendingPermission.dialog.suggestedPattern,
          }
        : null,
      pendingAskUser: pendingAskUser
        ? {
            requestId: pendingAskUser.requestId,
            question: pendingAskUser.question,
            options: pendingAskUser.options,
            multi_select: pendingAskUser.multi_select,
          }
        : null,
    };
  });

  // -------------------------------------------------------------------------
  // config.effort — get or set effort level for a session
  // -------------------------------------------------------------------------
  server.registerMethod("config.effort", (conn, params) => {
    const p = params as { effort?: string; sessionKey?: string } | undefined;
    const sessionKey = p?.sessionKey ?? conn.sessionKey;
    if (!sessionKey) throw new MethodError("NO_SESSION", "No session bound");
    const session = sessions.get(sessionKey);
    if (!session) throw new MethodError("NOT_FOUND", `Session not found: ${sessionKey}`);

    if (!p?.effort) {
      return { effort: session.loop.effort, message: `Effort: ${session.loop.effort}` };
    }

    // "default" clears the per-session override, falling back to global config
    if (p.effort === "default") {
      const globalEffort = config?.effort ?? "medium";
      session.loop.effort = globalEffort as any;
      updateSessionMeta(sessionKey, { effort: undefined });
      return { effort: globalEffort, message: `Effort reset to default: ${globalEffort}` };
    }

    const valid = ["low", "medium", "high", "xhigh", "max"];
    if (!valid.includes(p.effort)) {
      throw new MethodError("INVALID_REQUEST", `Invalid effort: ${p.effort}. Must be one of: ${valid.join(", ")}, default`);
    }
    session.loop.effort = p.effort as any;
    // Persist to meta.json so it survives gateway restarts
    updateSessionMeta(sessionKey, { effort: p.effort as any });
    return { effort: p.effort, message: `Effort: ${p.effort}` };
  });

  // -------------------------------------------------------------------------
  // doctor.run — system health check (API keys, skills, gateway, network)
  //
  // Returns a structured report so web/TUI clients can render it however
  // they like. The TUI uses the same module via its /doctor command.
  // -------------------------------------------------------------------------
  server.registerMethod("doctor.run", async () => {
    const { runDoctorChecksAsync } = await import("../commands/doctor.js");
    return runDoctorChecksAsync(config?.model);
  });

  // -------------------------------------------------------------------------
  // skills.status — installed skills + readiness (eligible / authReady)
  //
  // Used by the web /skills slash command. Mirrors what the TUI's /skills
  // command displays via formatSkillStatusReport().
  // -------------------------------------------------------------------------
  server.registerMethod("skills.status", async () => {
    const { buildSkillStatusReport } = await import("../skills/status.js");
    return buildSkillStatusReport();
  });

  // -------------------------------------------------------------------------
  // live.openaiClientSecret — WebSocket-accessible Live Lab broker.
  //
  // Mirrors the HTTP /api/live/openai/client-secret endpoint without requiring
  // extra Vite HTTP proxy rules during local web development.
  // -------------------------------------------------------------------------
  server.registerMethod("live.openaiClientSecret", async (conn, params) => {
    try {
      const quotaKey = conn.deviceTokenId
        ? `device:${conn.deviceTokenId}`
        : conn.sessionKey
          ? `session:${conn.sessionKey}`
          : `client:${conn.clientId}`;
      return await mintOpenAIRealtimeClientSecret((params ?? {}) as LiveRealtimeClientSecretParams, { quotaKey });
    } catch (err) {
      if (err instanceof LiveRealtimeBrokerError) {
        throw new MethodError("UPSTREAM_ERROR", err.message);
      }
      throw err;
    }
  });

  // -------------------------------------------------------------------------
  // ask_user.resolve — client responds to an ask_user_request event
  // -------------------------------------------------------------------------
  server.registerMethod("ask_user.resolve", (_conn, params) => {
    const p = params as { requestId?: string; answers?: string[] } | undefined;
    if (!p?.requestId || !Array.isArray(p?.answers)) {
      throw new MethodError("INVALID_REQUEST", "requestId and answers[] are required");
    }

    // Resolve the pending ask_user tool request (in tools/ask_user.ts)
    resolveAskUser(p.requestId, p.answers);
    return { resolved: true };
  });

  // -------------------------------------------------------------------------
  // push.vapidKey — return the VAPID public key for client subscription
  // -------------------------------------------------------------------------
  server.registerMethod("push.vapidKey", () => {
    if (!pushService?.enabled) {
      return { enabled: false, publicKey: null };
    }
    return { enabled: true, publicKey: pushService.vapidPublicKey };
  });

  // -------------------------------------------------------------------------
  // push.subscribe — client sends its PushSubscription for push delivery
  //
  // Security: only accepts subscriptions from authenticated connections.
  // Validates endpoint is a well-known push service URL (not arbitrary HTTPS).
  // -------------------------------------------------------------------------
  server.registerMethod("push.subscribe", (conn, params) => {
    const p = params as { subscription?: PushSubscriptionJSON } | undefined;
    if (!p?.subscription?.endpoint || !p.subscription.keys?.p256dh || !p.subscription.keys?.auth) {
      throw new MethodError("INVALID_REQUEST", "subscription with endpoint and keys (p256dh, auth) is required");
    }

    if (!pushService?.enabled) {
      return { subscribed: false, reason: "push not configured" };
    }

    // Validate endpoint is a known push service (not an arbitrary URL)
    const endpoint = p.subscription.endpoint;
    try {
      const url = new URL(endpoint);
      if (url.protocol !== "https:") {
        throw new MethodError("INVALID_REQUEST", "push endpoint must use HTTPS");
      }
      // Known push service domains (Apple, Google, Mozilla, Microsoft)
      const knownPushDomains = [
        "fcm.googleapis.com",
        "updates.push.services.mozilla.com",
        "web.push.apple.com",
        "wns.windows.com",
        "push.services.mozilla.com",
      ];
      const isKnownDomain = knownPushDomains.some((d) => url.hostname === d || url.hostname.endsWith("." + d));
      if (!isKnownDomain) {
        log.warn("push subscription rejected: unknown push service domain", { hostname: url.hostname });
        throw new MethodError("INVALID_REQUEST", "push endpoint domain not recognized as a known push service");
      }
    } catch (err) {
      if (err instanceof MethodError) throw err;
      throw new MethodError("INVALID_REQUEST", "invalid push endpoint URL");
    }

    pushService.addSubscription(p.subscription);
    return { subscribed: true };
  });

  // -------------------------------------------------------------------------
  // push.unsubscribe — remove a subscription by endpoint
  // -------------------------------------------------------------------------
  server.registerMethod("push.unsubscribe", (_conn, params) => {
    const p = params as { endpoint?: string } | undefined;
    if (!p?.endpoint) {
      throw new MethodError("INVALID_REQUEST", "endpoint is required");
    }

    if (!pushService?.enabled) {
      return { unsubscribed: false, reason: "push not configured" };
    }

    const removed = pushService.removeSubscription(p.endpoint);
    return { unsubscribed: removed };
  });

  // -------------------------------------------------------------------------
  // mcp.status — list MCP servers and their tools (for /mcp command)
  // -------------------------------------------------------------------------
  server.registerMethod("mcp.status", () => {
    const manager = getMcpServerManager();
    const states = manager.getAllStates();
    return {
      servers: states.map((s) => ({
        name: s.name,
        status: s.status,
        error: s.error ?? null,
        toolCount: s.toolNames.length,
        tools: s.toolNames,
      })),
    };
  });

  // =========================================================================
  // Workspace RPCs — direct file access for the Memory Editor
  // =========================================================================

  const EDITABLE_FILES = new Set(["MEMORY.md"]);
  // Daily logs (memory/YYYY-MM-DD.md) are also editable — checked by pattern

  function isDailyLog(path: string): boolean {
    return /^memory\/\d{4}-\d{2}-\d{2}(-[a-zA-Z0-9-]+)?\.md$/.test(path);
  }

  function isEditablePath(path: string): boolean {
    if (EDITABLE_FILES.has(path)) return true;
    return isDailyLog(path);
  }

  /** Check if a path is allowed by the editor (allowlist + daily logs). */
  function isEditorAccessiblePath(path: string): boolean {
    if (EDITOR_FILES_SET.has(path)) return true;
    return isDailyLog(path);
  }

  function isValidWorkspacePath(path: string): boolean {
    // Must be .md, no traversal, no absolute paths
    if (!path.endsWith(".md")) return false;
    if (path.includes("..") || path.startsWith("/")) return false;
    return true;
  }

  // Files to show in the Memory Editor (excludes internal system files like BOOTSTRAP.md, TOOLS.md)
  const EDITOR_FILES = ["MEMORY.md", "SOUL.md", "USER.md", "IDENTITY.md", "AGENTS.md", "HEARTBEAT.md"];
  const EDITOR_FILES_SET = new Set(EDITOR_FILES);

  // -------------------------------------------------------------------------
  // workspace.list — list workspace files + daily logs
  // -------------------------------------------------------------------------
  server.registerMethod("workspace.list", () => {
    const ws = new WorkspaceManager();
    const files: Array<{ name: string; path: string; editable: boolean; size: number }> = [];

    // Top-level workspace files (excludes BOOTSTRAP.md, TOOLS.md — internal system files)
    for (const name of EDITOR_FILES) {
      if (ws.exists(name)) {
        const filePath = join(ws.getWorkspacePath(), name);
        let size = 0;
        try { size = statSync(filePath).size; } catch {}
        files.push({ name, path: name, editable: isEditablePath(name), size });
      }
    }

    // Daily logs — list all .md files in memory/ (includes YYYY-MM-DD-suffix.md)
    const memoryDir = join(ws.getWorkspacePath(), "memory");
    try {
      const memoryFiles = readdirSync(memoryDir)
        .filter((f) => f.endsWith(".md"))
        .sort()
        .reverse(); // newest first
      for (const logName of memoryFiles) {
        const logPath = `memory/${logName}`;
        if (!isDailyLog(logPath)) continue; // Only include files matching the daily log pattern
        const filePath = join(memoryDir, logName);
        let size = 0;
        try { size = statSync(filePath).size; } catch {}
        files.push({ name: logName, path: logPath, editable: true, size });
      }
    } catch {
      // memory/ directory doesn't exist — no daily logs
    }

    return { files };
  });

  // -------------------------------------------------------------------------
  // workspace.read — read a workspace file
  // -------------------------------------------------------------------------
  server.registerMethod("workspace.read", (_conn, params) => {
    const p = params as { path?: string } | undefined;
    if (!p?.path) {
      throw new MethodError("INVALID_REQUEST", "path is required");
    }
    if (!isValidWorkspacePath(p.path)) {
      throw new MethodError("INVALID_REQUEST", "invalid workspace path");
    }
    if (!isEditorAccessiblePath(p.path)) {
      throw new MethodError("INVALID_REQUEST", "file not accessible via editor");
    }

    const ws = new WorkspaceManager();
    const content = ws.readFile(p.path);
    if (content === null) {
      throw new MethodError("NOT_FOUND", `file not found: ${p.path}`);
    }

    return { content, path: p.path, editable: isEditablePath(p.path) };
  });

  // -------------------------------------------------------------------------
  // workspace.write — write to an editable workspace file
  // Note: isEditablePath is a strict subset of isEditorAccessiblePath,
  // so we don't need a separate accessibility check here.
  // -------------------------------------------------------------------------
  server.registerMethod("workspace.write", (_conn, params) => {
    const p = params as { path?: string; content?: string } | undefined;
    if (!p?.path || typeof p.content !== "string") {
      throw new MethodError("INVALID_REQUEST", "path and content are required");
    }
    if (!isValidWorkspacePath(p.path)) {
      throw new MethodError("INVALID_REQUEST", "invalid workspace path");
    }
    if (!isEditablePath(p.path)) {
      throw new MethodError("INVALID_REQUEST", `file is read-only: ${p.path}`);
    }

    const ws = new WorkspaceManager();
    ws.writeFile(p.path, p.content);
    return { ok: true, path: p.path };
  });

  // -------------------------------------------------------------------------
  // session.fork — fork a system session's last run into a new user session
  // -------------------------------------------------------------------------
  server.registerMethod("session.fork", (conn, params) => {
    const p = params as { sourceKey?: string; platform?: string } | undefined;
    const sourceKey = p?.sourceKey ?? conn.sessionKey;
    if (!sourceKey) {
      throw new MethodError("INVALID_REQUEST", "sourceKey is required");
    }

    // Only allow forking system sessions (cron, heartbeat)
    const isSystem = sourceKey.startsWith("cron:") || sourceKey.startsWith("heartbeat:");
    if (!isSystem) {
      throw new MethodError("INVALID_REQUEST", "Can only fork system sessions (cron or heartbeat)");
    }

    // Get source session history
    const source = sessions.get(sourceKey);
    if (!source) {
      throw new MethodError("NOT_FOUND", `Session not found: ${sourceKey}`);
    }
    const history = source.loop.getHistory();
    if (history.length === 0) {
      throw new MethodError("INVALID_REQUEST", "Source session has no messages to fork");
    }

    // Find last run: scan backward for the last user-role message (the cron/heartbeat prompt)
    let runStartIndex = history.length - 1;
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].role === "user") {
        // Check this is a real prompt, not a tool_result
        const firstBlock = history[i].content?.[0];
        if (firstBlock && (firstBlock as any).type !== "tool_result") {
          runStartIndex = i;
          break;
        }
      }
    }

    // Extract the last run's messages
    const lastRunMessages = history.slice(runStartIndex);

    // Build context text from the last run
    const contextParts: string[] = [];
    for (const msg of lastRunMessages) {
      if (!Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        if ((block as any).type === "text" && (block as any).text) {
          contextParts.push((block as any).text);
        }
      }
    }
    const contextText = contextParts.join("\n\n");

    // Generate new session key (with random suffix to avoid collisions)
    const platform = p?.platform ?? "web";
    const nameSlug = sourceKey.split(":").slice(1).join("-");
    const now = new Date();
    const dateStr = `${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`; // "0411"
    const suffix = Math.random().toString(36).slice(2, 6);
    const newKey = `${platform}:fork-${nameSlug}-${dateStr}-${suffix}`;

    // Create the new session and inject context
    const newSession = sessions.getOrCreate(newKey);
    const contextMessage = {
      role: "user" as const,
      content: [{ type: "text" as const, text: `[Forked from ${sourceKey}]\n\n${contextText}\n\nI'd like to follow up on the above. What questions do you have?` }],
      timestamp: new Date().toISOString(),
    };
    const existingHistory = newSession.loop.getHistory();
    newSession.loop.setHistory([...existingHistory, contextMessage]);
    newSession.sessionManager.appendMessage(contextMessage);

    // Bind the connection to the new session
    conn.bindSession(newKey);

    return { sessionKey: newKey, sourceKey, messageCount: 1 };
  });

  // -------------------------------------------------------------------------
  // gateway.swapProvider — live provider swap without gateway restart
  // -------------------------------------------------------------------------
  server.registerMethod("gateway.swapProvider", (_conn, params) => {
    const p = params as {
      provider?: string;
      active_profile?: string;
      model?: string;
      openai_base_url?: string;
    } | undefined;
    if (!p?.provider) throw new MethodError("INVALID_REQUEST", "provider is required");
    return sessions.swapProvider({
      provider: p.provider,
      active_profile: p.active_profile,
      model: p.model,
      openai_base_url: p.openai_base_url,
    });
  });

  // -------------------------------------------------------------------------
  // gateway.addProfile — add an openai_compatible profile
  // -------------------------------------------------------------------------
  server.registerMethod("gateway.addProfile", (_conn, params) => {
    const p = params as {
      name?: string;
      base_url?: string;
      api_key?: string;
      api_key_env?: string;
      model?: string;
      overwrite?: boolean;
    } | undefined;
    if (!p?.name) throw new MethodError("INVALID_REQUEST", "name is required");
    if (!p?.base_url) throw new MethodError("INVALID_REQUEST", "base_url is required");
    return sessions.addProfile({
      name: p.name,
      base_url: p.base_url,
      api_key: p.api_key,
      api_key_env: p.api_key_env,
      model: p.model,
      overwrite: p.overwrite,
    });
  });

  // -------------------------------------------------------------------------
  // gateway.removeProfile — delete an openai_compatible profile
  // -------------------------------------------------------------------------
  server.registerMethod("gateway.removeProfile", (_conn, params) => {
    const p = params as { name?: string } | undefined;
    if (!p?.name) throw new MethodError("INVALID_REQUEST", "name is required");
    return sessions.removeProfile(p.name);
  });

  // -------------------------------------------------------------------------
  // gateway.renameProfile — rename an openai_compatible profile
  // -------------------------------------------------------------------------
  server.registerMethod("gateway.renameProfile", (_conn, params) => {
    const p = params as { old?: string; new?: string } | undefined;
    if (!p?.old) throw new MethodError("INVALID_REQUEST", "old is required");
    if (!p?.new) throw new MethodError("INVALID_REQUEST", "new is required");
    return sessions.renameProfile(p.old, p.new);
  });
}
