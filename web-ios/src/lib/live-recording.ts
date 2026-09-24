export type LiveRecording = { liveSessionId: string; startedAt: string };
type Rpc = (method: string, params: unknown) => Promise<unknown>;
const key = (conversation: string) => `hawky-active-recording:${conversation}`;
export function hasLiveRecording(conversation: string) {
  try { return localStorage.getItem(key(conversation)) !== null; } catch { return false; }
}

/** Store identity before the first RPC: reloading or a lost reply must not
 * allocate a second folder. Only explicit Stop clears this pointer. */
export async function openLiveRecording(rpc: Rpc, sessionKey: string): Promise<LiveRecording & { resumed: boolean; messages?: Array<{ role: "user" | "assistant"; text: string }> }> {
  let previous: LiveRecording | null = null;
  try { previous = JSON.parse(localStorage.getItem(key(sessionKey)) ?? "null"); } catch { /* invalid local state */ }
  if (previous && (!/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z_[a-f0-9]{8}$/.test(previous.liveSessionId) || !Number.isFinite(Date.parse(previous.startedAt)))) previous = null;
  const startedAt = new Date().toISOString();
  const recording = previous ?? { startedAt, liveSessionId: `${startedAt.replace(/:/g, "-")}_${crypto.randomUUID().slice(0, 8)}` };
  localStorage.setItem(key(sessionKey), JSON.stringify(recording));
  const result = await rpc("realtime.archive.start", { ...recording, sessionKey }) as { closed?: boolean; messages?: Array<{ role: "user" | "assistant"; text: string }> };
  if (result.closed) {
    clearLiveRecording(sessionKey, recording.liveSessionId);
    return openLiveRecording(rpc, sessionKey);
  }
  return { ...recording, resumed: previous !== null, messages: result.messages };
}

export function clearLiveRecording(sessionKey: string, liveSessionId: string) {
  try {
    const active = JSON.parse(localStorage.getItem(key(sessionKey)) ?? "null");
    if (active?.liveSessionId === liveSessionId) localStorage.removeItem(key(sessionKey));
  } catch { /* nothing to clear */ }
}
