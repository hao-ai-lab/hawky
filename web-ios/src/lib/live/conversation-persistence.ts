import { useCallback, useRef, type RefObject } from "react";
import { useSessionStore } from "../session-store";
import { TOOL_MARKER, type ToolStatus } from "../realtime-tools";
import type { CameraArchive } from "../camera-archive";
import type { DelegationTask } from "../../../../src/gateway/delegation-types";

/** Serial persistence is independent of provider transport. A failed flush keeps
 * unsaved turns queued; snapshots must cross this barrier before reconnecting.
 */
export function useConversationPersistence(rpc: (method: string, params?: unknown) => Promise<unknown>,
  liveSessionKeyRef: RefObject<string>, cameraArchiveRef: RefObject<CameraArchive | null>) {
  // Persist Live conversation turns to the backend session (so they show in
  // session.list message count + reload via session.history). Batched + flushed
  // shortly after, to avoid an RPC per word. Only user/assistant turns.
  const pendingTurnsRef = useRef<Array<{ sessionKey: string; role: "user" | "assistant"; text: string; timestamp: string }>>([]);
  const flushInFlightRef = useRef<Promise<boolean> | null>(null);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persistTurn = useCallback((role: "user" | "assistant", text: string, identity?: { responseId: string; itemId?: string; contentIndex: number }) => {
    const t = text.trim();
    if (!t) return;
    // Auto-title the session from its first user message (ChatGPT-style).
    cameraArchiveRef.current?.record("message.completed", { role, text: t, ...identity });
    if (role === "user") void useSessionStore.getState().maybeAutoTitle(liveSessionKeyRef.current, t);
    pendingTurnsRef.current.push({ sessionKey: liveSessionKeyRef.current, role, text: t, timestamp: new Date().toISOString() });
    if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    flushTimerRef.current = setTimeout(() => { void flushTurns(); }, 1200);
  }, []);

  // Persist a tool-call record so it survives in history. The gateway only
  // accepts user/assistant turns, so we encode the tool as an assistant message
  // with a marker that mapHistoryToTranscript decodes back into a tool bubble.
  const persistTool = useCallback((label: string, status: ToolStatus, detail: string, ms: number, imageData?: string, imageTitle?: string, delegation?: DelegationTask) => {
    // Charts persist into history by embedding the data: URL in the marker. Cap
    // the size so a huge image can't bloat the session (it still shows live).
    const image = imageData && imageData.length <= 600_000 ? imageData : undefined;
    pendingTurnsRef.current.push({
      sessionKey: liveSessionKeyRef.current,
      role: "assistant",
      text: `${TOOL_MARKER}${JSON.stringify({ label, status, detail, ms, image, imageTitle: image ? imageTitle : undefined, delegation })}`,
      timestamp: new Date().toISOString(),
    });
    if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    flushTimerRef.current = setTimeout(() => { void flushTurns(); }, 1200);
  }, []);
  const flushTurns = useCallback(async (): Promise<boolean> => {
    const previous = flushInFlightRef.current ?? Promise.resolve(true);
    const job = previous.then(async (saved) => {
      if (!saved) return false;
      while (pendingTurnsRef.current.length) {
        const key = pendingTurnsRef.current[0].sessionKey;
        const boundary = pendingTurnsRef.current.findIndex(turn => turn.sessionKey !== key);
        const batch = pendingTurnsRef.current.splice(0, boundary < 0 ? pendingTurnsRef.current.length : boundary);
        try {
          await rpc("session.appendMessages", { sessionKey: key, messages: batch.map(({ sessionKey: _, ...turn }) => turn) });
          void useSessionStore.getState().fetchSessions();
        } catch {
          pendingTurnsRef.current.unshift(...batch);
          return false;
        }
      }
      return true;
    });
    flushInFlightRef.current = job;
    try { return await job; }
    finally { if (flushInFlightRef.current === job) flushInFlightRef.current = null; }
  }, [rpc]);
  return { persistTurn, persistTool, flushTurns };
}
