import { VenusAdapter } from "../live/providers/venus.js";
import { JoyAIAdapter } from "../live/providers/joyai.js";
import { loadConfig } from "../storage/config.js";
import { GeminiLiveAdapter } from "../live/providers/gemini.js";
import type { StreamAdapter, StreamEvent, StreamInput, StreamOptions, StreamTaskUpdate } from "../live/stream-contracts.js";
import type { ConversationTurn } from "../live/contracts.js";
import type { GatewayServer } from "./server.js";
import type { GatewayConnection } from "./connection.js";
import type { DelegationService } from "./delegation-methods.js";
import type { DelegationTask } from "./delegation-types.js";
import { MethodError } from "./methods.js";
import { enforceRealtimeMintQuota } from "./live-realtime-broker.js";

const terminal = (t: DelegationTask) => ["completed", "failed", "cancelled", "interrupted"].includes(t.status);
const state = (t: DelegationTask): StreamTaskUpdate => ({ task_id: t.id, request: t.request, status: t.status, validity: t.validity,
  result: t.result?.slice(0, 12000), error: t.error, completedAt: t.completedAt, delivery: t.delivery, deliveryResponseId: t.deliveryResponseId });
export function validateStreamCreate(p: any) {
  if (!p || typeof p.id !== "string" || !/^[\w-]{8,80}$/.test(p.id) ||
    typeof p.ownerSession !== "string" || !p.ownerSession.trim() || p.ownerSession.length > 200 ||
    !["native", "codex", "claude"].includes(p.runtime) ||
    typeof p.model !== "string" || !/^(gemini-[\w.-]*live[\w.-]*|realtime-venus-omni|joyai-vl-interaction)$/.test(p.model) ||
    (p.gemini_api_key !== undefined && (typeof p.gemini_api_key !== "string" || p.gemini_api_key.length > 500)) ||
    typeof p.instructions !== "string" || p.instructions.length > 20000 ||
    !Array.isArray(p.history) || p.history.length > 110 ||
    p.history.some((t: any) => !t || !["user", "assistant"].includes(t.role) || typeof t.text !== "string") ||
    JSON.stringify(p.history).length > 40000)
    throw new MethodError("INVALID_REQUEST", "Invalid streaming provider connection");
}
export function validateStreamInput(i: any): asserts i is StreamInput {
  if (!i || typeof i !== "object") throw new MethodError("INVALID_REQUEST", "Missing media input");
  if (i.type === "audio" || i.type === "image") {
    const limit = i.type === "audio" ? 90000 : 400000;
    if (typeof i.data !== "string" || !i.data.length || i.data.length > limit || !/^[A-Za-z0-9+/]+={0,2}$/.test(i.data) ||
      (i.type === "audio" && Buffer.from(i.data, "base64").length % 2 !== 0) ||
      (i.type === "image" && !Number.isFinite(i.at))) throw new MethodError("INVALID_REQUEST", "Invalid or oversized media packet");
  } else if (i.type === "text") {
    if (typeof i.text !== "string" || !i.text.trim() || i.text.length > 8000) throw new MethodError("INVALID_REQUEST", "Text must contain 1–8000 characters");
  } else if (i.type === "mic") {
    if (typeof i.enabled !== "boolean") throw new MethodError("INVALID_REQUEST", "Invalid microphone state");
  } else if (i.type === "playback") {
    if (typeof i.id !== "string" || i.id.length > 200 || typeof i.played !== "boolean") throw new MethodError("INVALID_REQUEST", "Invalid playback receipt");
  } else throw new MethodError("INVALID_REQUEST", "Unknown streaming input");
}

/** Authenticated gateway owns keys, task execution and provider lifetimes.
 * Media goes only to the originating connection, never session broadcasts. */
export function registerLiveStreamMethods(server: GatewayServer, tasks: DelegationService,
  persist: (key: string, turn: ConversationTurn) => void,
  factory?: (options: StreamOptions, params: any) => StreamAdapter) {
  type Session = { conn: GatewayConnection; ownerSession: string; adapter: StreamAdapter; lease: ReturnType<typeof setTimeout>;
    closed: boolean; closing: boolean; closePromise?: Promise<void>; seen: Set<string>; completed: Set<string>; history: ConversationTurn[]; close: () => Promise<void> };
  const active = new Map<string, Session>();
  server.registerConnectionCleanup(async conn => {
    await Promise.allSettled([...active.values()].filter(s => s.conn === conn).map(s => s.close()));
  });
  const get = (conn: GatewayConnection, p: any) => {
    const s = active.get(p?.id);
    if (!s || s.conn !== conn || s.ownerSession !== p.ownerSession || s.closed || s.closing) throw new MethodError("NOT_FOUND", "Live connection not found");
    return s;
  };
  tasks.subscribe((_conn, task) => {
    for (const s of active.values()) {
      if (s.closed || s.ownerSession !== task.ownerSession || (s.conn.deviceTokenId ?? "local") !== (_conn.deviceTokenId ?? "local")) continue;
      if (s.adapter.taskUpdate) { s.adapter.taskUpdate({ ...state(task), result: task.result }); continue; }
      if (task.validity === "superseded") { s.adapter.context(`Task ${task.id} is superseded; ignore its old result.`, false); continue; }
      if (!terminal(task) || s.completed.has(task.id)) continue;
      s.completed.add(task.id); s.adapter.context(JSON.stringify(state(task)), true);
    }
  });
  server.registerMethod("live.stream.create", async (conn, raw) => {
    const p = raw as any; validateStreamCreate(p);
    if (active.has(p.id)) throw new MethodError("CONFLICT", "Connection ID already exists");
    const isGemini = p.model.startsWith("gemini-");
    const key = p.gemini_api_key || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || loadConfig().api_keys.gemini;
    if (!factory && isGemini && (typeof key !== "string" || !key.trim())) throw new MethodError("UNAVAILABLE", "Gemini Live needs a Gemini API key in Live settings or on the gateway.");
    if (!(isGemini && p.gemini_api_key)) enforceRealtimeMintQuota(`stream:${conn.deviceTokenId ?? "local"}:${conn.clientId}`);
    for (const s of active.values()) if (s.conn === conn && s.ownerSession === p.ownerSession) await s.close();
    let session: Session;
    const emit = (event: StreamEvent) => {
      if (session?.closed) return;
      if (event.type === "caption" && event.final && event.text.trim() && !session.seen.has(event.id)) {
        session.seen.add(event.id); const turn = { role: event.role, text: event.text };
        session.history.push(turn); session.history = session.history.slice(-30); persist(p.ownerSession, turn);
      }
      const delivered = conn.sendEvent({ type: "event", event: "live.stream.event", payload: { connectionId: p.id, ownerSession: p.ownerSession, ...event } });
      // An audio packet rejected by transport cannot be called played. Release
      // its drain fence and stop this broken connection rather than accumulate.
      if (!delivered && session && !session.closing) void session.close();
      if (event.type === "error" && session && !session.closing) void session.close();
    };
    const calls = new Map<string, Promise<unknown>>();
    const tool = (id: string, name: string, args: Record<string, unknown>) => {
      if (calls.has(id)) return calls.get(id)!;
      const result = Promise.resolve().then(() => {
        if (session.closed || !p.bridge) throw new Error("Backend bridge is unavailable");
        const scope = { ownerSession: p.ownerSession };
        if (name === "session_send_message") {
          const t = tasks.submit(conn, { ...scope, id: `${p.id}-${id}`.slice(0, 180), message: args.message, runtime: p.runtime,
            execution: args.execution, continueTask: args.continue_task, dependsOn: args.depends_on, constraints: args.constraints,
            originalRequest: session.history.filter(t => t.role === "user").slice(-3).map(t => t.text).join("\n"), context: session.history.slice(-12) }).task;
          return state(t);
        }
        if (name !== "session_task_control") throw new Error("Unknown tool");
        if (args.action === "list") return tasks.list(conn, p.ownerSession).map(state);
        const q = { ...scope, id: args.task_id };
        if (args.action === "status") return state(tasks.lookup(conn, q));
        if (args.action === "cancel") return state(tasks.cancel(conn, q));
        if (args.action === "revise") return state(tasks.revise(conn, { ...q, message: args.message, revisionId: `${p.id}-${id}` }));
        throw new Error("Unknown task action");
      });
      calls.set(id, result); return result;
    };
    const options: StreamOptions = { ...p, bridge: p.bridge === true, emit, tool,
      delegate: async (id, message, capture) => {
        if (session.closed || session.closing || !p.bridge) throw new Error("Backend bridge is unavailable");
        const task = tasks.submit(conn, { id: `${p.id}-${id}`, ownerSession: p.ownerSession, message, runtime: p.runtime, execution: "serial",
          originalRequest: capture.history.filter(t => t.role === "user").map(t => t.text).join("\n"), context: capture.history,
          constraints: "The result returns to a voice conversation. Lead with a concise, natural spoken answer in the request's language. Preserve any full detail explicitly requested. Do not include internal task IDs or claim the answer was already spoken.",
        }, capture).task;
        return { ...state(task), result: task.result };
      },
      delivery: (taskId, responseId, state) => {
        if (!session.closed) tasks.delivery(conn, { ownerSession: p.ownerSession, id: taskId, responseId, state });
      },
    };
    const joy = loadConfig().live_providers?.joyai;
    const adapter: StreamAdapter = factory ? factory(options, p) : isGemini ? new GeminiLiveAdapter(options, key) : p.model === "joyai-vl-interaction" ? new JoyAIAdapter(options, {
      ...joy, url: process.env.HAWKY_JOYAI_URL || joy?.url || "http://127.0.0.1:8070",
      asr_url: process.env.HAWKY_JOYAI_ASR_URL || joy?.asr_url,
      tts_url: process.env.HAWKY_JOYAI_TTS_URL || joy?.tts_url,
    }) : new VenusAdapter(options, {
      url: process.env.HAWKY_VENUS_URL || loadConfig().live_providers?.venus?.url || "http://127.0.0.1:8033",
      apiKey: process.env.HAWKY_VENUS_API_KEY || loadConfig().live_providers?.venus?.api_key,
    });
    session = { conn, ownerSession: p.ownerSession, adapter, closed: false, closing: false, seen: new Set(), completed: new Set(), history: [...p.history],
      lease: setTimeout(() => void session.close(), 45000),
      close: () => {
        if (session.closePromise) return session.closePromise;
        session.closing = true; clearTimeout(session.lease);
        return session.closePromise = Promise.resolve().then(() => adapter.close()).finally(() => { session.closed = true; active.delete(p.id); });
      },
    };
    active.set(p.id, session); conn.bindSession(p.ownerSession);
    try {
      const previous = tasks.list(conn, p.ownerSession);
      previous.filter(terminal).forEach(t => session.completed.add(t.id));
      await adapter.start();
      if (session.closed) throw new Error("Connection was stopped during startup");
      if (previous.length && p.bridge) {
        if (adapter.taskUpdate) for (const task of previous) adapter.taskUpdate({ ...state(task), result: task.result }, true);
        else adapter.context(`Restored task states. Use silently; do not announce on reconnect:\n${JSON.stringify(previous.slice(-15).map(state))}`, false);
      }
      return { id: p.id, model: p.model };
    } catch (error) { await session.close(); throw error; }
  });
  server.registerMethod("live.stream.input", async (conn, raw) => {
    const p = raw as any, s = get(conn, p); validateStreamInput(p.input);
    await s.adapter.input(p.input); return { ok: true };
  });
  server.registerMethod("live.stream.heartbeat", (conn, p: any) => {
    const s = get(conn, p); clearTimeout(s.lease); s.lease = setTimeout(() => void s.close(), 45000);
    return { ok: true, diagnostics: s.adapter.diagnostics?.() };
  });
  server.registerMethod("live.stream.close", async (conn, p) => { await get(conn, p).close(); return { ok: true }; });
}
