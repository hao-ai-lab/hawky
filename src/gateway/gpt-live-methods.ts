import { loadConfig } from "../storage/config.js";
import { selectRealtimeApiKey, enforceRealtimeMintQuota } from "./live-realtime-broker.js";
import { MethodError } from "./methods.js";
import type { GatewayConnection } from "./connection.js";
import type { GatewayServer } from "./server.js";
import type { DelegationService } from "./delegation-methods.js";
import { GptLiveCoordinator } from "../live/gpt-live-coordinator.js";
import { routeLiveDelegation } from "../live/gpt-live-router.js";
import type { ConversationTurn } from "../live/contracts.js";

export function gptLiveConfig(p: any) {
  if (p.model !== "gpt-live-1") throw new MethodError("INVALID_REQUEST", "Unsupported GPT-Live model");
  if (typeof p.instructions !== "string" || p.instructions.length > 20000) throw new MethodError("INVALID_REQUEST", "Invalid instructions");
  if (!Array.isArray(p.history) || p.history.length > 110 || p.history.some((t: any) => !["user", "assistant"].includes(t.role) || typeof t.text !== "string") || JSON.stringify(p.history).length > 40000)
    throw new MethodError("INVALID_REQUEST", "Invalid conversation context");
  return { model: "gpt-live-1", store: false, instructions: p.instructions,
    audio: { output: { voice: ["marin", "cedar"].includes(p.voice) ? p.voice : "marin" } },
    delegation: { type: "client" },
    input: p.history.map((t: ConversationTurn) => ({ type: "message", role: t.role, content: [{ type: t.role === "user" ? "input_text" : "output_text", text: t.text }] })),
  };
}
export function registerGptLiveMethods(server: GatewayServer, tasks: DelegationService,
  persist: (sessionKey: string, turn: ConversationTurn) => void) {
  type Session = { owner: string; ownerSession: string; socket: WebSocket; coordinator: GptLiveCoordinator; lease: ReturnType<typeof setTimeout>; closed: boolean; close: () => Promise<void> };
  const active = new Map<string, Session>();
  const owner = (c: GatewayConnection) => c.deviceTokenId ?? "local";
  function get(c: GatewayConnection, p: any) {
    const session = active.get(p?.id);
    if (!session || session.owner !== owner(c) || session.ownerSession !== p.ownerSession) throw new MethodError("NOT_FOUND", "Live connection not found");
    return session;
  }
  tasks.subscribe((conn, task) => {
    for (const session of active.values()) if (session.owner === owner(conn) && session.ownerSession === task.ownerSession) session.coordinator.update(task);
  });
  server.registerMethod("live.gpt.create", async (conn, raw) => {
    const p = raw as any;
    if (!p || typeof p.ownerSession !== "string" || !p.ownerSession.trim() || !["native", "codex", "claude"].includes(p.runtime) || typeof p.sdp !== "string" || !p.sdp.startsWith("v=0") || p.sdp.length > 100000)
      throw new MethodError("INVALID_REQUEST", "Invalid Live connection request");
    const config = gptLiveConfig(p);
    const selection = selectRealtimeApiKey(p, loadConfig().api_keys?.openai);
    if (!selection.apiKey) throw new MethodError("UNAVAILABLE", "GPT-Live needs an OpenAI API key in BYOK settings or on this gateway.");
    if (!selection.byokApiKey) enforceRealtimeMintQuota(`gpt-live:${owner(conn)}:${conn.clientId}`);
    for (const session of active.values()) if (session.owner === owner(conn) && session.ownerSession === p.ownerSession) await session.close();
    const response = await fetch("https://api.openai.com/v1/live/sessions", {
      method: "POST", signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Bearer ${selection.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ session: config, transport: { type: "webrtc", sdp: p.sdp } }),
    });
    const data = await response.json() as any;
    if (!response.ok) throw new MethodError("UPSTREAM_ERROR", data.error?.message ?? `GPT-Live returned HTTP ${response.status}`);
    const id = data.session?.id;
    if (typeof id !== "string" || typeof data.transport?.sdp !== "string") throw new MethodError("UPSTREAM_ERROR", "GPT-Live returned an invalid connection");
    conn.bindSession(p.ownerSession);
    const BunSocket = WebSocket as unknown as { new(url: string, options: Bun.WebSocketOptions): WebSocket };
    const socket = new BunSocket(`wss://api.openai.com/v1/live/sessions/${encodeURIComponent(id)}/attach`, {
      headers: { Authorization: `Bearer ${selection.apiKey}` },
    });
    const send = (event: Record<string, unknown>) => {
      if (socket.readyState !== WebSocket.OPEN) throw new Error("GPT-Live control connection is unavailable");
      socket.send(JSON.stringify(event));
    };
    const error = (message: string) => server.broadcastToSession(p.ownerSession, "live.gpt.error", { id, message });
    const coordinator = new GptLiveCoordinator({ id, history: p.history, runtime: p.runtime, bridge: p.bridge !== false, send, error,
      persist: turn => persist(p.ownerSession, turn),
      route: (snapshot, signal) => routeLiveDelegation(selection.apiKey, snapshot, AbortSignal.any([signal, AbortSignal.timeout(20000)])),
      tasks: {
        list: () => tasks.list(conn, p.ownerSession),
        submit: params => tasks.submit(conn, { ...params, ownerSession: p.ownerSession }).task,
        cancel: taskId => tasks.cancel(conn, { id: taskId, ownerSession: p.ownerSession }),
        revise: (taskId, message, revisionId) => tasks.revise(conn, { id: taskId, message, revisionId, ownerSession: p.ownerSession }),
        injected: (taskId, eventId) => tasks.delivery(conn, { id: taskId, ownerSession: p.ownerSession, state: "injected", responseId: eventId }),
      },
    });
    let closeResolve: (() => void) | undefined;
    const session: Session = { owner: owner(conn), ownerSession: p.ownerSession, socket, coordinator,
      lease: setTimeout(() => void session.close(), 45000), closed: false,
      close: async () => {
        if (session.closed) return;
        session.closed = true; clearTimeout(session.lease); coordinator.close(); active.delete(id);
        if (socket.readyState === WebSocket.OPEN) {
          await new Promise<void>(resolve => {
            const timer = setTimeout(resolve, 2500);
            closeResolve = () => { clearTimeout(timer); resolve(); };
            socket.send(JSON.stringify({ type: "session.close" }));
          });
        }
        socket.close();
      },
    };
    active.set(id, session);
    socket.addEventListener("message", event => {
      try {
        const e = JSON.parse(String(event.data));
        if (e.type === "session.closed") { closeResolve?.(); void session.close(); }
        else if (!e.type?.includes("audio")) coordinator.observe(e); // Never archive reflected PCM or credentials.
      } catch (e) { error(e instanceof Error ? e.message : String(e)); }
    });
    socket.addEventListener("close", () => {
      closeResolve?.();
      if (!session.closed) { error("GPT-Live control connection closed. Reconnect to restore task updates."); void session.close(); }
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("GPT-Live control connection timed out")), 12000);
        socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
        socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Could not attach GPT-Live control connection")); }, { once: true });
      });
      // Browser enables the mic only after this control connection has attached.
      return { id, sdp: data.transport.sdp, model: "gpt-live-1" };
    } catch (e) { await session.close(); throw e; }
  });
  server.registerMethod("live.gpt.ready", (conn, p: any) => { get(conn, p).coordinator.restore(); return { ok: true }; });
  server.registerMethod("live.gpt.heartbeat", (conn, p: any) => {
    const s = get(conn, p); clearTimeout(s.lease); s.lease = setTimeout(() => void s.close(), 45000); return { ok: true };
  });
  server.registerMethod("live.gpt.text", (conn, p: any) => {
    const session = get(conn, p);
    if (typeof p.text !== "string" || !p.text.trim() || p.text.length > 8000) throw new MethodError("INVALID_REQUEST", "A message of 1–8000 characters is required");
    // Acknowledge receipt promptly. Interpretation and task results arrive asynchronously.
    void session.coordinator.typed(p.text).catch(e => server.broadcastToSession(p.ownerSession, "live.gpt.error", { id: p.id, message: String(e) }));
    return { ok: true };
  });
  server.registerMethod("live.gpt.close", async (conn, p: any) => { await get(conn, p).close(); return { ok: true }; });
}
