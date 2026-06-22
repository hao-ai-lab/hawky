// =============================================================================
// useRealtime — the Live engine for the web-ios app (#681)
//
// Reproduces the iOS Live session pipeline in the browser, reusing the proven
// flow from web/'s LiveLab: gateway boot context → BYOK-aware realtime client
// secret (live.openaiClientSecret) → WebRTC peer connection to OpenAI Realtime
// → mic/voice + camera frame loop → transcript of user/assistant/system/tool
// entries. Exposes iOS-style phases so the Live screen can render the FaceTime
// stage states (idle / connecting / connected / paused / failed).
//
// Kept as a hook so the screen component stays presentational.
// =============================================================================

import { useCallback, useEffect, useRef, useState } from "react";
import { useSocketStore } from "./socket-store";
import { byokParam } from "./byok";
import { getUserMediaSafe, mediaUnavailableReason } from "./media";
import { useLiveSettings, cadenceFps } from "./live-settings";
import { useSessionStore } from "./session-store";
import {
  PERSON_MODEL_TOOLS,
  type PersonModelToolName,
} from "../../../src/identity/person/tool-contract";

export type LivePhase = "idle" | "connecting" | "connected" | "paused" | "failed";

export type TranscriptKind = "user" | "assistant" | "system" | "tool" | "warning";

/** Tool-call status, drives the bubble color (iOS: purple→green/red). */
export type ToolStatus = "running" | "ok" | "error";

export interface TranscriptEntry {
  id: string;
  kind: TranscriptKind;
  text: string;
  at: string;
  /** For kind === "tool": the call's lifecycle status + timing. */
  toolStatus?: ToolStatus;
  /** Result/error detail shown under the tool name when finished. */
  toolDetail?: string;
  /** Wall-clock ms the call took (set when finished). */
  toolMs?: number;
  /** A `data:` image URL to render with this entry (e.g. a generated chart). */
  imageData?: string;
  /** A human title for the image artifact (e.g. the chart title). */
  imageTitle?: string;
}

/** A generated visual artifact (e.g. a chart) — collected in the side panel,
 *  chronologically, and openable in the zoom lightbox. */
export interface Artifact {
  id: string;
  src: string; // data: URL
  title: string;
  at: string;
}

/** Derive the chronological artifact list from a transcript (every tool entry
 *  that produced an image). Order = transcript order = chronological. */
export function artifactsFromTranscript(entries: TranscriptEntry[]): Artifact[] {
  return entries
    .filter((e) => e.imageData)
    .map((e) => ({ id: e.id, src: e.imageData as string, title: e.imageTitle || e.text || "Chart", at: e.at }));
}

const DEFAULT_PROMPT =
  "You are Hawk, a concise, friendly realtime assistant. Use the camera and " +
  "microphone context when relevant, answer briefly, and delegate durable or " +
  "long-running work to the Hawk backend tool.";

const BACKEND_TOOL = {
  type: "function",
  name: "session_send_message",
  description:
    "Send a concise request or context packet to the Hawk backend agent for durable work, tool use, memory, files, or longer reasoning.",
  parameters: {
    type: "object",
    properties: {
      message: { type: "string", description: "The message to send to the backend Hawk session." },
    },
    required: ["message"],
    additionalProperties: false,
  },
};

const WEB_PERSON_TOOL_NAMES = new Set<PersonModelToolName>([
  "identify_person",
  "list_people",
  "recall_person",
  "update_person_profile",
]);
const WEB_PERSON_TOOLS = PERSON_MODEL_TOOLS.filter((tool) => WEB_PERSON_TOOL_NAMES.has(tool.name));

// Share the current camera frame to Slack. The browser captures the live video
// frame and attaches it as image_base64 before forwarding to tool.invoke — the
// model only chooses the destination/caption, never the image bytes.
const SEND_PHOTO_TOOL = {
  type: "function",
  name: "send_photo",
  description:
    "Send a photo of what the camera currently sees to Slack. Call this when the user asks to share, send, or post a picture of what's in front of them. The current camera frame is captured and uploaded automatically — do NOT provide the image. Optionally set `to` (a #channel, person, or user id) and a `comment`; with no `to` it goes to the user's own Slack DM.",
  parameters: {
    type: "object",
    properties: {
      to: { type: "string", description: "Optional destination: \"#channel\", a channel/user id, or a person's name. Omit for the user's own DM." },
      comment: { type: "string", description: "Optional caption to post with the photo." },
    },
    required: [],
    additionalProperties: false,
  },
};

// Render a chart from data the model supplies. The result is an image shown in
// the conversation and mirrored in the side panel. The model gathers/derives
// the numbers (its own knowledge or via the backend) and passes them as series.
const GENERATE_CHART_TOOL = {
  type: "function",
  name: "generate_chart",
  description:
    "Draw a chart/graph from data when the user asks to see, plot, visualize, or compare statistics or numbers. YOU supply the data points as `series` (gather or recall the numbers first). Supports bar, line, pie, doughnut, scatter. The chart image appears in the conversation automatically.",
  parameters: {
    type: "object",
    properties: {
      type: { type: "string", enum: ["bar", "line", "pie", "doughnut", "scatter"], description: "Chart type. Default bar; line for trends, pie/doughnut for parts of a whole." },
      title: { type: "string", description: "Chart title." },
      labels: { type: "array", items: { type: "string" }, description: "Category/x-axis labels, one per data point (e.g. [\"Q1\",\"Q2\",\"Q3\"])." },
      series: {
        type: "array",
        description: "Data series. Each item: { label?: string, data: number[], color?: string }. data is aligned with labels. For pie/doughnut use one series.",
        items: {
          type: "object",
          properties: {
            label: { type: "string", description: "Series name (legend)." },
            data: { type: "array", items: { type: "number" }, description: "Numbers to plot." },
            color: { type: "string", description: "Optional hex color." },
          },
          required: ["data"],
          additionalProperties: false,
        },
      },
      xLabel: { type: "string", description: "Optional x-axis title." },
      yLabel: { type: "string", description: "Optional y-axis title." },
    },
    required: ["series"],
    additionalProperties: false,
  },
};

interface BrokerResponse {
  ok?: boolean;
  error?: string;
  model?: string;
  client_secret?: { value?: string } | string;
}

// Marker prefixing a persisted tool record (stored as an assistant turn so the
// gateway accepts it; decoded back into a tool bubble on history load).
const TOOL_MARKER = "⁣TOOL⁣"; // invisible separators — won't show if ever rendered raw

function entryId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Derive the separate backend channel a Live session delegates to, so the
 *  agent's internal turns don't pollute the user's conversation. */
function bridgeKey(liveKey: string): string {
  return `${liveKey}-bridge`;
}

/** A short, friendly label for a tool-call bubble (no raw JSON args). */
function toolLabel(name: string, args: Record<string, any>): string {
  if (name === "session_send_message") {
    const m = typeof args.message === "string" ? args.message.trim() : "";
    const short = m.length > 60 ? m.slice(0, 60) + "…" : m;
    return short ? `Delegating: ${short}` : "Delegating to backend";
  }
  if (name === "send_photo") {
    const to = typeof args.to === "string" && args.to.trim() ? args.to.trim() : "Slack DM";
    return `Sending photo → ${to}`;
  }
  if (name === "generate_chart") {
    const t = typeof args.title === "string" && args.title.trim() ? args.title.trim() : (typeof args.type === "string" ? `${args.type} chart` : "chart");
    return `Charting: ${t}`;
  }
  if (name === "identify_person") return "Identify person";
  if (name === "list_people") return "List people";
  if (name === "recall_person") return `Recall ${typeof args.name === "string" ? args.name : "person"}`;
  if (name === "update_person_profile") return "Update person";
  return name;
}

function personRpcMethod(name: PersonModelToolName): string {
  switch (name) {
    case "identify_person": return "person.identify_current_frame";
    case "list_people": return "person.list";
    case "recall_person": return "person.recall";
    case "update_person_profile": return "person.update_profile";
    case "confirm_identity_candidate": return "person.confirm_candidate";
    case "reject_identity_candidate": return "person.reject_candidate";
  }
}

function personToolDetail(name: PersonModelToolName, result: Record<string, any>): string {
  if (name === "identify_person") {
    return result.found && result.person?.name ? `Matched ${result.person.name}.` : (result.message ?? "No matching person.");
  }
  if (name === "list_people") return `${Array.isArray(result.people) ? result.people.length : 0} people.`;
  if (name === "recall_person") {
    return result.found && result.person?.name ? `Found ${result.person.name}.` : "No matching person.";
  }
  if (name === "update_person_profile") return result.person?.name ? `Updated ${result.person.name}.` : "Updated person.";
  return result.ok === false && typeof result.error === "string" ? result.error : "ok";
}

/** Build the realtime turn_detection block. `staySilent` sets create_response
 *  to false so the model LISTENS without replying (Stay Silent mode). */
function buildTurnDetection(
  s: { turnDetection: string; semanticEagerness: string; vadThreshold: number; prefixPaddingMs: number; silenceMs: number },
  staySilent: boolean,
  interrupt: boolean,
): Record<string, unknown> | null {
  if (s.turnDetection === "manual") return null;
  if (s.turnDetection === "semantic_vad") {
    return { type: "semantic_vad", eagerness: s.semanticEagerness, create_response: !staySilent, interrupt_response: interrupt };
  }
  return {
    type: "server_vad",
    threshold: s.vadThreshold,
    prefix_padding_ms: s.prefixPaddingMs,
    silence_duration_ms: s.silenceMs,
    create_response: !staySilent,
    interrupt_response: interrupt,
  };
}

function fmtTime(ts?: string): string {
  if (!ts) return "";
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString();
}

/**
 * Flatten session.history messages (role + content blocks) into transcript
 * entries for the Live view. Text blocks → user/assistant bubbles; tool_use →
 * a finished (ok) tool bubble; tool_result is folded into its tool entry's
 * detail. Internal/empty blocks are skipped.
 */
/** Text that is backend/agent plumbing, not part of the user's conversation. */
function isNoiseText(text: string): boolean {
  const t = text.trim();
  return (
    t.startsWith("[From web-ios Live]") ||
    t.startsWith("[From desktop Live") ||
    t.startsWith("[No remote nodes") ||
    t.startsWith("<system-reminder>") ||
    t.includes("workspace/memory/") ||
    t.startsWith("[After completing the task")
  );
}

export function mapHistoryToTranscript(
  messages: Array<{ role: string; content: unknown; timestamp?: string }>,
): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  for (const msg of messages) {
    const at = fmtTime(msg.timestamp);
    const blocks = Array.isArray(msg.content)
      ? msg.content
      : typeof msg.content === "string"
        ? [{ type: "text", text: msg.content }]
        : [];
    for (const raw of blocks) {
      const b = (raw ?? {}) as Record<string, any>;
      if (b.type !== "text" || typeof b.text !== "string" || !b.text.trim()) continue;
      const rawText = b.text.trim();

      // A persisted tool record → restore the tool bubble (with its status, and
      // its image if it carried one, e.g. a chart).
      if (rawText.startsWith(TOOL_MARKER)) {
        try {
          const t = JSON.parse(rawText.slice(TOOL_MARKER.length)) as { label: string; status: ToolStatus; detail?: string; ms?: number; image?: string; imageTitle?: string };
          out.push({ id: entryId(), kind: "tool", text: t.label, at, toolStatus: t.status, toolDetail: t.detail, toolMs: t.ms, imageData: t.image, imageTitle: t.imageTitle });
        } catch { /* ignore a malformed marker */ }
        continue;
      }

      // Plain user/assistant text. Drop bridge/system plumbing noise and any
      // raw backend tool blocks (which only exist in the separate bridge
      // channel, but guard anyway), plus consecutive duplicate turns.
      if (isNoiseText(rawText)) continue;
      const kind = msg.role === "user" ? "user" : "assistant";
      const prev = out[out.length - 1];
      if (prev && prev.kind === kind && prev.text === rawText) continue;
      out.push({ id: entryId(), kind, text: rawText, at });
    }
  }
  return out;
}

function clientSecretValue(r: BrokerResponse): string {
  if (typeof r.client_secret === "string") return r.client_secret;
  return r.client_secret?.value ?? "";
}

function safeJSON(raw: string): Record<string, any> | null {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

export interface UseRealtimeOptions {
  sessionKey: string;
  prompt?: string;
}

export function useRealtime({ sessionKey, prompt }: UseRealtimeOptions) {
  const rpc = useSocketStore((s) => s.rpc);
  const gatewayStatus = useSocketStore((s) => s.status);
  // Live settings (model, voice, prompt, VAD, reasoning, tool choice, bridge).
  const settings = useLiveSettings();
  const effectivePrompt = prompt ?? settings.systemPrompt ?? DEFAULT_PROMPT;

  const [phase, setPhase] = useState<LivePhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  // Mirror of transcript for reading the latest value inside callbacks (start()
  // captures prior turns to replay without depending on a stale closure).
  const transcriptRef = useRef<TranscriptEntry[]>([]);
  useEffect(() => { transcriptRef.current = transcript; }, [transcript]);
  // The instructions sent at connect — Cocktail Party appends to these live.
  const instructionsRef = useRef("");
  const [historyLoading, setHistoryLoading] = useState(false);
  const [micOn, setMicOn] = useState(true);
  const [cameraOn, setCameraOn] = useState(true);
  const [staySilent, setStaySilent] = useState(false);
  const [cocktailParty, setCocktailParty] = useState(false);
  const [safetyOn, setSafetyOn] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [bridgeOffline, setBridgeOffline] = useState(false);
  // Artifacts (charts) are derived from `transcript` — no separate state.
  const safetyTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastHazardRef = useRef<string>("");

  // The session key the CURRENT live session is bound to. Pinned at start() and
  // used by every async path (bridge tool chat.send, transcript persistence,
  // event handler) so they never diverge into two sessions if the active key
  // changes mid-session. Falls back to the latest sessionKey when idle.
  const liveSessionKeyRef = useRef(sessionKey);
  useEffect(() => { if (phase === "idle" || phase === "failed") liveSessionKeyRef.current = sessionKey; }, [sessionKey, phase]);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const mediaRef = useRef<MediaStream | null>(null);
  const videoElRef = useRef<HTMLVideoElement | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const frameTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const speakTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const canStart = gatewayStatus === "connected" && (phase === "idle" || phase === "failed");

  function push(kind: TranscriptKind, text: string) {
    const t = text.trim();
    if (!t) return;
    setTranscript((cur) => [...cur.slice(-200), { id: entryId(), kind, text: t, at: new Date().toLocaleTimeString() }]);
  }

  /**
   * Insert a user turn so it reads BEFORE the in-flight response's assistant
   * bubble (spoken transcripts can arrive after the model starts replying). If
   * there's no current assistant bubble, just append.
   */
  function insertUserBeforeAssistant(text: string) {
    const t = text.trim();
    if (!t) return;
    const entry: TranscriptEntry = { id: entryId(), kind: "user", text: t, at: new Date().toLocaleTimeString() };
    setTranscript((cur) => {
      const id = assistantEntryIdRef.current;
      const idx = id ? cur.findIndex((e) => e.id === id) : -1;
      if (idx >= 0) {
        const next = [...cur];
        next.splice(idx, 0, entry);
        return next.slice(-200);
      }
      return [...cur.slice(-200), entry];
    });
  }

  // Persist Live conversation turns to the backend session (so they show in
  // session.list message count + reload via session.history). Batched + flushed
  // shortly after, to avoid an RPC per word. Only user/assistant turns.
  const pendingTurnsRef = useRef<Array<{ role: "user" | "assistant"; text: string; timestamp: string }>>([]);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persistTurn = useCallback((role: "user" | "assistant", text: string) => {
    const t = text.trim();
    if (!t) return;
    // Auto-title the session from its first user message (ChatGPT-style).
    if (role === "user") void useSessionStore.getState().maybeAutoTitle(liveSessionKeyRef.current, t);
    pendingTurnsRef.current.push({ role, text: t, timestamp: new Date().toISOString() });
    if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    flushTimerRef.current = setTimeout(() => { void flushTurns(); }, 1200);
  }, []);

  // Persist a tool-call record so it survives in history. The gateway only
  // accepts user/assistant turns, so we encode the tool as an assistant message
  // with a marker that mapHistoryToTranscript decodes back into a tool bubble.
  const persistTool = useCallback((label: string, status: ToolStatus, detail: string, ms: number, imageData?: string, imageTitle?: string) => {
    // Charts persist into history by embedding the data: URL in the marker. Cap
    // the size so a huge image can't bloat the session (it still shows live).
    const image = imageData && imageData.length <= 600_000 ? imageData : undefined;
    pendingTurnsRef.current.push({
      role: "assistant",
      text: `${TOOL_MARKER}${JSON.stringify({ label, status, detail, ms, image, imageTitle: image ? imageTitle : undefined })}`,
      timestamp: new Date().toISOString(),
    });
    if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    flushTimerRef.current = setTimeout(() => { void flushTurns(); }, 1200);
  }, []);
  const flushTurns = useCallback(async () => {
    const batch = pendingTurnsRef.current;
    if (batch.length === 0) return;
    pendingTurnsRef.current = [];
    try {
      await rpc("session.appendMessages", { sessionKey: liveSessionKeyRef.current, messages: batch });
      // Refresh the session list so the message count updates in History.
      void useSessionStore.getState().fetchSessions();
    } catch {
      // Re-queue on failure so nothing is lost.
      pendingTurnsRef.current.unshift(...batch);
    }
  }, [rpc]);

  // Live-streaming assistant bubble: the id is tracked so deltas append to the
  // same entry; cleared when the response finishes. `producedText` records
  // whether the CURRENT response already emitted assistant text, so the
  // response.done fallback doesn't re-add an already-shown transcript.
  const assistantEntryIdRef = useRef<string | null>(null);
  const responseProducedTextRef = useRef(false);
  // True once the current response's assistant turn has been persisted (prevents
  // double-persist when both text.done and audio_transcript.done fire).
  const responsePersistedRef = useRef(false);
  function streamAssistant(delta: string) {
    if (!delta) return;
    responseProducedTextRef.current = true;
    setTranscript((cur) => {
      const next = [...cur];
      const id = assistantEntryIdRef.current;
      const idx = id ? next.findIndex((e) => e.id === id) : -1;
      if (idx >= 0) {
        next[idx] = { ...next[idx], text: next[idx].text + delta };
      } else {
        const newId = entryId();
        assistantEntryIdRef.current = newId;
        next.push({ id: newId, kind: "assistant", text: delta, at: new Date().toLocaleTimeString() });
      }
      return next.slice(-200);
    });
  }
  function endAssistantStream(finalText?: string) {
    const id = assistantEntryIdRef.current;
    assistantEntryIdRef.current = null;
    // Persist the assistant turn at most ONCE per response: in audio mode the API
    // can emit BOTH output_text.done and output_audio_transcript.done for the
    // same turn, which would otherwise double-persist.
    const alreadyPersisted = responsePersistedRef.current;
    if (id) {
      setTranscript((cur) => {
        const next = cur.map((e) =>
          e.id === id && typeof finalText === "string" && finalText.trim() ? { ...e, text: finalText.trim() } : e,
        );
        const entry = next.find((e) => e.id === id);
        if (entry?.text.trim() && !alreadyPersisted) {
          responsePersistedRef.current = true;
          persistTurn("assistant", entry.text);
        }
        return next;
      });
    } else if (finalText && finalText.trim() && !alreadyPersisted) {
      responseProducedTextRef.current = true;
      responsePersistedRef.current = true;
      push("assistant", finalText);
      persistTurn("assistant", finalText);
    }
  }

  const sendRealtime = useCallback((event: unknown) => {
    const dc = dcRef.current;
    if (dc && dc.readyState === "open") dc.send(JSON.stringify(event));
  }, []);

  const teardown = useCallback(() => {
    if (frameTimerRef.current) { clearInterval(frameTimerRef.current); frameTimerRef.current = null; }
    if (safetyTimerRef.current) { clearInterval(safetyTimerRef.current); safetyTimerRef.current = null; }
    dcRef.current?.close(); dcRef.current = null;
    pcRef.current?.close(); pcRef.current = null;
    mediaRef.current?.getTracks().forEach((t) => t.stop());
    mediaRef.current = null;
    if (videoElRef.current) videoElRef.current.srcObject = null;
    if (audioElRef.current) audioElRef.current.srcObject = null;
    setSpeaking(false);
    setSafetyOn(false);
  }, []);

  // Tear down on unmount.
  useEffect(() => () => teardown(), [teardown]);

  // Load the selected session's chat history into the transcript when the
  // session changes (e.g. picking one from the Hawk History menu). Skipped
  // while a live session is connecting/connected so we don't clobber it.
  useEffect(() => {
    if (gatewayStatus !== "connected") return;
    if (phase === "connecting" || phase === "connected" || phase === "paused") return;
    let active = true;
    setHistoryLoading(true);
    void (async () => {
      try {
        const res = (await rpc("session.history", { sessionKey, limit: 100 })) as {
          messages?: Array<{ role: string; content: unknown; timestamp?: string }>;
        };
        if (!active) return;
        // Artifacts are derived from the transcript, so loading history restores
        // the full chronological chart list automatically.
        setTranscript(mapHistoryToTranscript(res.messages ?? []));
      } catch {
        if (active) setTranscript([]);
      } finally {
        if (active) setHistoryLoading(false);
      }
    })();
    return () => { active = false; };
    // Only re-run when the session key (or connection) changes — NOT on phase
    // ticks, which would reload on every start/stop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey, gatewayStatus]);

  const start = useCallback(async () => {
    const blocked = mediaUnavailableReason();
    if (blocked) { setError(blocked); setPhase("failed"); push("warning", blocked); return; }

    setPhase("connecting");
    setError(null);
    setBridgeOffline(false);
    assistantEntryIdRef.current = null;
    // Pin the session key for the entire life of THIS session so every async
    // path (bridge tool, transcript persistence, boot context) uses the same one.
    liveSessionKeyRef.current = sessionKey;
    // KEEP the loaded history visible and capture it to replay into the realtime
    // model, so resuming an old session continues the prior conversation.
    const priorTurns = transcriptRef.current
      .filter((e) => (e.kind === "user" || e.kind === "assistant") && e.text.trim())
      .map((e) => ({ role: e.kind as "user" | "assistant", text: e.text.trim() }))
      .slice(-30); // cap replay so the realtime session prompt stays bounded

    try {
      // 1) Gateway boot context (memory packet) — best-effort.
      let bootContext = "";
      try {
        const boot = (await rpc("frontend.boot_context", {
          channel_id: sessionKey,
          session_key: sessionKey,
          participant_id: "web-ios",
          mode: "realtime-web",
          capabilities: [
            micOn ? "audio_input" : "audio_input_off",
            micOn ? "audio_output" : "text_output",
            cameraOn ? "visual_input" : "visual_off",
            "backend_session_bridge",
          ],
          tools: [BACKEND_TOOL],
          max_chars: 12_000,
        })) as { context?: string };
        bootContext = boot.context ?? "";
        if (bootContext) push("system", "Loaded memory context from Hawk backend.");
      } catch {
        setBridgeOffline(true);
        push("system", "Hawk backend unreachable — running without memory/tools.");
      }

      const instructions = [effectivePrompt, "", bootContext ? `# Hawk Backend Context\n${bootContext}` : ""]
        .filter(Boolean)
        .join("\n\n");
      instructionsRef.current = instructions;
      // Realtime tools: backend bridge + shared person tools. The browser attaches
      // frames privately when a person tool needs the current camera image.
      const tools = [
        ...(settings.backendBridge ? [BACKEND_TOOL] : []),
        ...WEB_PERSON_TOOLS,
        SEND_PHOTO_TOOL, GENERATE_CHART_TOOL,
      ];

      // 2) Mint a realtime client secret (BYOK-aware), using the chosen model.
      const broker = (await rpc("live.openaiClientSecret", {
        ...byokParam(),
        model: settings.model,
        instructions,
        reasoning_effort: settings.reasoningEffort,
        tool_choice: settings.toolChoice,
        expires_after_seconds: 600,
      })) as BrokerResponse;
      if (broker.ok === false) throw new Error(broker.error ?? "Realtime broker failed");
      const token = clientSecretValue(broker);
      if (!token) throw new Error("Realtime broker did not return a client secret");

      // 3) Capture mic/camera (camera position from settings).
      const media = await getUserMediaSafe({
        audio: micOn,
        video: cameraOn
          ? { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: settings.cameraPosition === "back" ? "environment" : "user" }
          : false,
      });
      mediaRef.current = media;
      if (videoElRef.current) videoElRef.current.srcObject = media;

      // 4) WebRTC peer connection to OpenAI Realtime.
      const pc = new RTCPeerConnection();
      pcRef.current = pc;
      pc.ontrack = (e) => {
        if (audioElRef.current) {
          audioElRef.current.srcObject = e.streams[0];
          void audioElRef.current.play().catch(() => {});
        }
      };
      media.getAudioTracks().forEach((t) => pc.addTrack(t, media));

      const dc = pc.createDataChannel("oai-events");
      dcRef.current = dc;
      dc.addEventListener("open", () => {
        const wantAudio = micOn && settings.responseModality === "audio";
        const interrupt = settings.bargeIn !== "let_finish";
        const session: Record<string, unknown> = {
          type: "realtime",
          instructions,
          output_modalities: [wantAudio ? "audio" : "text"],
          tools,
          tool_choice: settings.toolChoice,
          parallel_tool_calls: settings.parallelToolCalls,
          audio: {
            input: {
              ...(settings.noiseReduction !== "none" ? { noise_reduction: { type: settings.noiseReduction } } : {}),
              ...(settings.userTranscript ? { transcription: { model: settings.transcribeModel } } : {}),
              turn_detection: buildTurnDetection(settings, staySilent, interrupt),
            },
            output: { voice: settings.voice },
          },
        };
        if (settings.maxTokensMode === "custom") session.max_response_output_tokens = settings.maxTokens;
        sendRealtime({ type: "session.update", session });

        // Replay prior turns into the realtime conversation so it continues the
        // last session (without triggering a response — these are silent
        // conversation items, like iOS's history replay).
        for (const turn of priorTurns) {
          sendRealtime({
            type: "conversation.item.create",
            item: {
              type: "message",
              role: turn.role,
              content: [{ type: turn.role === "user" ? "input_text" : "output_text", text: turn.text }],
            },
          });
        }

        setPhase("connected");
        if (priorTurns.length > 0) push("system", `Resumed with ${priorTurns.length} prior turn${priorTurns.length === 1 ? "" : "s"} of context.`);
        push("system", `Connected to ${broker.model ?? settings.model}.`);
        if (cameraOn && cadenceFps(settings) > 0) startFrameLoop(cadenceFps(settings));
      });
      dc.addEventListener("message", (e) => handleMessage(String(e.data)));

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const sdpRes = await fetch("https://api.openai.com/v1/realtime/calls", {
        method: "POST",
        body: offer.sdp,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/sdp" },
      });
      if (!sdpRes.ok) throw new Error(`OpenAI Realtime call failed (HTTP ${sdpRes.status})`);
      await pc.setRemoteDescription({ type: "answer", sdp: await sdpRes.text() });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setPhase("failed");
      push("warning", msg);
      teardown();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rpc, sessionKey, micOn, cameraOn, staySilent, effectivePrompt, settings, sendRealtime, teardown]);

  const stop = useCallback(() => {
    teardown();
    setPhase("idle");
    push("system", "Session ended.");
    void flushTurns(); // persist any queued turns immediately
  }, [teardown, flushTurns]);

  function startFrameLoop(fps: number) {
    if (frameTimerRef.current) clearInterval(frameTimerRef.current);
    const intervalMs = Math.max(200, Math.round(1000 / Math.max(fps, 0.05)));
    frameTimerRef.current = setInterval(() => sendCameraFrame(), intervalMs);
  }

  function sendCameraFrame() {
    const video = videoElRef.current;
    if (!video || video.readyState < 2) return;
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = Math.max(1, Math.round((video.videoHeight / Math.max(video.videoWidth, 1)) * canvas.width));
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    sendRealtime({
      type: "conversation.item.create",
      item: { type: "message", role: "user", content: [{ type: "input_image", image_url: canvas.toDataURL("image/jpeg", 0.7) }] },
    });
  }

  // Stable identity so the memoized composer (which owns the draft) is fully
  // insulated from LiveScreen re-renders — keeps the camera from re-rendering.
  const sendText = useCallback((text: string) => {
    const t = text.trim();
    if (!t) return;
    sendRealtime({
      type: "conversation.item.create",
      item: { type: "message", role: "user", content: [{ type: "input_text", text: t }] },
    });
    sendRealtime({ type: "response.create", response: { output_modalities: [micOn ? "audio" : "text"] } });
    push("user", t);
    persistTurn("user", t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sendRealtime, micOn, persistTurn]);

  async function handleMessage(raw: string) {
    const ev = safeJSON(raw);
    if (!ev) return;
    const type = ev.type as string;

    // New response starting → reset the per-response guards.
    if (type === "response.created") {
      responseProducedTextRef.current = false;
      responsePersistedRef.current = false;
      assistantEntryIdRef.current = null;
      return;
    }

    // --- Assistant TEXT output (text modality): delta + done ---
    if (type === "response.output_text.delta" && typeof ev.delta === "string") {
      streamAssistant(ev.delta);
      return;
    }
    if (type === "response.output_text.done") {
      endAssistantStream(typeof ev.text === "string" ? ev.text : undefined);
      return;
    }

    // --- Assistant AUDIO transcript (audio modality): the spoken words. ---
    // The Realtime API emits these automatically for audio responses. Handle
    // BOTH the current (`response.output_audio_transcript.*`) and the older
    // (`response.audio_transcript.*`) event names, streaming deltas live.
    if (
      (type === "response.output_audio_transcript.delta" || type === "response.audio_transcript.delta") &&
      typeof ev.delta === "string"
    ) {
      flashSpeaking();
      if (settings.assistantTranscript) streamAssistant(ev.delta);
      return;
    }
    if (type === "response.output_audio_transcript.done" || type === "response.audio_transcript.done") {
      if (settings.assistantTranscript) endAssistantStream(typeof ev.transcript === "string" ? ev.transcript : undefined);
      return;
    }

    // Speaking indicator while audio plays.
    if (type === "response.output_audio.delta" || type === "response.audio.delta") {
      flashSpeaking();
      return;
    }

    // Fallback: only if THIS response produced no assistant text via deltas/done
    // (covers API variants that send neither), drain it from the final response.
    // Guarded by responseProducedTextRef so a normally-streamed transcript is
    // NOT shown a second time.
    if (type === "response.done" || type === "response.completed") {
      const out = ev.response?.output;
      if (!responseProducedTextRef.current && !responsePersistedRef.current && settings.assistantTranscript && Array.isArray(out)) {
        for (const item of out) {
          const content = item?.content;
          if (Array.isArray(content)) {
            for (const c of content) {
              const t = c?.transcript ?? (c?.type === "text" ? c?.text : undefined);
              if (typeof t === "string" && t.trim()) {
                responsePersistedRef.current = true;
                push("assistant", t);
                persistTurn("assistant", t);
                break;
              }
            }
          }
        }
      }
      assistantEntryIdRef.current = null;
      responseProducedTextRef.current = false;
      responsePersistedRef.current = false;
      return;
    }

    // --- User audio transcription (input): delta + completed ---
    if (type === "conversation.item.input_audio_transcription.delta" && typeof ev.delta === "string") {
      // (Optional partials — we render the completed line below to keep it tidy.)
      return;
    }
    if (type === "conversation.item.input_audio_transcription.completed" && typeof ev.transcript === "string") {
      // The user's spoken transcript often arrives AFTER the model has already
      // started replying, so a naive append puts the user line below the
      // assistant's. Insert it BEFORE the current response's assistant bubble so
      // the order reads correctly (user question, then assistant answer).
      insertUserBeforeAssistant(ev.transcript);
      persistTurn("user", ev.transcript);
      return;
    }
    if (type === "response.function_call_arguments.done") {
      await handleFunctionCall(ev);
      return;
    }
    if (type === "error") {
      const message = ev.error?.message ?? raw;
      setError(String(message));
      push("warning", String(message));
    }
  }

  function flashSpeaking() {
    setSpeaking(true);
    if (speakTimerRef.current) clearTimeout(speakTimerRef.current);
    speakTimerRef.current = setTimeout(() => setSpeaking(false), 1200);
  }

  /** Capture the current camera frame as raw base64 JPEG (for the face tools). */
  function captureFrameBase64(): string | null {
    const video = videoElRef.current;
    if (!video || video.readyState < 2) return null;
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = Math.max(1, Math.round((video.videoHeight / Math.max(video.videoWidth, 1)) * canvas.width));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.8).split(",")[1] ?? null;
  }

  async function handleFunctionCall(ev: Record<string, any>) {
    const callId = String(ev.call_id ?? "");
    const name = String(ev.name ?? "");
    const args = safeJSON(String(ev.arguments ?? "{}")) ?? {};

    // Push a RUNNING tool bubble (compact label) and remember its id so we can
    // flip it to ok (green) / error (red) when the call finishes.
    const toolEntryId = entryId();
    const startedAt = performance.now();
    setTranscript((cur) => [
      ...cur.slice(-200),
      { id: toolEntryId, kind: "tool", text: toolLabel(name, args), at: new Date().toLocaleTimeString(), toolStatus: "running" },
    ]);

    let output: Record<string, unknown>;
    let ok = true;
    let detail = "";
    let toolImage: string | undefined; // data: URL for an image result (chart)
    try {
      if (name === "session_send_message") {
        const message = typeof args.message === "string" ? args.message.trim() : "";
        if (!message) throw new Error("message is required");
        // Route the delegation to a SEPARATE bridge channel, NOT the live session,
        // so the backend agent's internal turns don't pollute the conversation.
        // chat.send now returns the agent's final reply + any image (e.g. a
        // chart) so we can surface the result here instead of a static ack.
        const bridge = (await rpc("chat.send", { sessionKey: bridgeKey(liveSessionKeyRef.current), message })) as
          { reply?: string; image?: { base64?: string; media_type?: string } };
        const reply = (bridge.reply ?? "").trim();
        if (bridge.image?.base64) {
          toolImage = `data:${bridge.image.media_type || "image/png"};base64,${bridge.image.base64}`;
        }
        // Give the realtime model the backend's actual answer so it can speak it
        // (and not keep "waiting"). Keep it bounded.
        output = { ok: true, result: reply ? reply.slice(0, 4000) : "Done.", has_chart: !!toolImage };
        detail = reply || (toolImage ? "Chart ready." : "Done.");
      } else if (WEB_PERSON_TOOL_NAMES.has(name as PersonModelToolName)) {
        const personToolName = name as PersonModelToolName;
        const toolArgs: Record<string, unknown> = { ...args, session_key: liveSessionKeyRef.current };
        if (personToolName === "identify_person") {
          const img = captureFrameBase64();
          if (!img) throw new Error("No camera frame available — turn the camera on.");
          toolArgs.image_base64 = img;
        }
        if (personToolName === "update_person_profile" && !toolArgs.id && !toolArgs.person_id) {
          const img = captureFrameBase64();
          if (img) toolArgs.image_base64 = img;
        }
        const res = (await rpc(personRpcMethod(personToolName), toolArgs)) as Record<string, any>;
        if (res.ok === false) {
          output = { ok: false, error: typeof res.error === "string" ? res.error : "person tool failed" };
          ok = false;
          detail = String(output.error);
        } else {
          output = res;
          detail = personToolDetail(personToolName, res);
        }
      } else if (name === "face_identify" || name === "face_enroll" || name === "face_update" || name === "send_photo" || name === "generate_chart") {
        // tool.invoke tools. Camera-frame ones (face_identify/face_enroll,
        // send_photo) need the current frame; generate_chart takes the agent's
        // data as-is and returns an image (the rendered chart).
        const toolArgs: Record<string, unknown> = { ...args };
        if (name === "face_identify" || name === "face_enroll" || name === "send_photo") {
          const img = captureFrameBase64();
          if (!img) throw new Error("No camera frame available — turn the camera on.");
          toolArgs.image_base64 = img;
        }
        // tool.invoke returns { ok, result } | { ok:false, error }. The gateway
        // wraps a method's return under `payload`, so the rpc() helper resolves
        // to that object directly (NOT under a `result` key). When ok:false the
        // tool failed (e.g. Slack missing_scope) — surface it, don't show green.
        const res = (await rpc("tool.invoke", { tool_name: name, args: toolArgs, session_key: liveSessionKeyRef.current })) as
          { ok?: boolean; error?: string; result?: { type?: string; content?: string; base64?: string; media_type?: string; metadata?: any } };
        const r = res.result ?? {};
        const isErr = res.ok === false || r.type === "error";
        const errText = res.error ?? r.content ?? "error";
        // An image result (e.g. a chart) → build a data: URL we can render in the
        // bubble, persist into history, and mirror in the side panel.
        if (!isErr && r.type === "image" && typeof r.base64 === "string") {
          toolImage = `data:${r.media_type || "image/png"};base64,${r.base64}`;
        }
        output = isErr ? { ok: false, error: errText } : { ok: true, ...(r.metadata ?? {}), note: r.content };
        ok = !isErr;
        detail = isErr ? errText : (r.content ?? "ok");
      } else {
        throw new Error(`Unknown tool: ${name}`);
      }
    } catch (err) {
      ok = false;
      detail = err instanceof Error ? err.message : String(err);
      output = { ok: false, error: detail };
    }

    // A title for the artifact (chart): the chart's own title, else the label.
    const imageTitle = toolImage
      ? (typeof args.title === "string" && args.title.trim() ? args.title.trim() : toolLabel(name, args))
      : undefined;
    // Flip the same bubble to its finished status + color (and attach the image
    // if the tool produced one, e.g. a chart). The side panel derives its
    // artifact list from the transcript, so no separate state to update.
    const ms = Math.round(performance.now() - startedAt);
    setTranscript((cur) => cur.map((e) =>
      e.id === toolEntryId ? { ...e, toolStatus: ok ? "ok" : "error", toolDetail: detail, toolMs: ms, imageData: toolImage, imageTitle } : e,
    ));
    // Persist the finished tool record so it appears when the session reloads
    // (carry the image + title so charts survive a history reload).
    persistTool(toolLabel(name, args), ok ? "ok" : "error", detail, ms, toolImage, imageTitle);

    sendRealtime({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: callId, output: JSON.stringify(output) },
    });
    sendRealtime({ type: "response.create", response: { output_modalities: [micOn ? "audio" : "text"] } });
  }

  // --- Live toggles that take effect mid-session ---
  const toggleMic = useCallback(() => {
    setMicOn((on) => {
      const next = !on;
      mediaRef.current?.getAudioTracks().forEach((t) => (t.enabled = next));
      return next;
    });
  }, []);

  const toggleCamera = useCallback(() => {
    setCameraOn((on) => {
      const next = !on;
      mediaRef.current?.getVideoTracks().forEach((t) => (t.enabled = next));
      return next;
    });
  }, []);

  // Stay Silent: the model LISTENS without replying. Re-sends turn_detection
  // (create_response) to the LIVE session so toggling works mid-conversation —
  // not just at connect time.
  const toggleStaySilent = useCallback(() => {
    setStaySilent((prev) => {
      const next = !prev;
      const interrupt = settings.bargeIn !== "let_finish";
      sendRealtime({
        type: "session.update",
        session: { type: "realtime", audio: { input: { turn_detection: buildTurnDetection(settings, next, interrupt) } } },
      });
      // While silent: cancel any in-flight response so it goes quiet immediately.
      if (next) sendRealtime({ type: "response.cancel" });
      push("system", next ? "Stay Silent on — listening without replying." : "Stay Silent off.");
      return next;
    });
  }, [settings, sendRealtime]);

  // Cocktail Party: instruct the realtime model to recognize & recall people
  // from the face database on demand. Pushed live via instructions update.
  const toggleCocktailParty = useCallback(() => {
    setCocktailParty((prev) => {
      const next = !prev;
      const extra = next
        ? "\n\nCOCKTAIL PARTY MODE: People may appear on camera. Stay silent about the camera feed unless the user asks or introduces someone. If the user asks who someone is, call identify_person, then answer once with the matched name plus relevant facts/recaps. If someone new introduces themselves, call update_person_profile to remember their name and add stated facts or a one-line recap. Use list_people or recall_person when the user asks what you know about people. Do not proactively greet known people just because a face appears."
        : "";
      sendRealtime({
        type: "session.update",
        session: { type: "realtime", instructions: instructionsRef.current + extra },
      });
      push("system", next ? "Cocktail Party on — recognizing people on request." : "Cocktail Party off.");
      return next;
    });
  }, [sendRealtime]);

  // Safety Check: a SILENT off-model hazard watch (like iOS). Samples camera
  // frames every few seconds, calls assess_hazard (DeepFace), and on a real
  // hazard pushes a red warning + has the model speak it once.
  const runHazardCheck = useCallback(async () => {
    const img = captureFrameBase64();
    if (!img) return;
    try {
      const res = (await rpc("tool.invoke", { tool_name: "assess_hazard", args: { image_base64: img }, session_key: liveSessionKeyRef.current })) as { result?: { metadata?: { severity?: string; warning?: string } } };
      const meta = res.result?.metadata ?? {};
      const severity = meta.severity ?? "none";
      const warning = (meta.warning ?? "").trim();
      if (severity !== "none" && warning && warning !== lastHazardRef.current) {
        lastHazardRef.current = warning;
        push("warning", warning);
        // Speak the warning once (the only time Safety talks).
        sendRealtime({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: `Say exactly this safety warning to me, verbatim and nothing else: "${warning}"` }] } });
        sendRealtime({ type: "response.create", response: { output_modalities: ["audio"] } });
      }
    } catch { /* service may be down — silently skip */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rpc, sendRealtime]);

  const toggleSafety = useCallback(() => {
    setSafetyOn((prev) => {
      const next = !prev;
      if (safetyTimerRef.current) { clearInterval(safetyTimerRef.current); safetyTimerRef.current = null; }
      if (next) {
        lastHazardRef.current = "";
        push("warning", "Safety Check on — silently watching for hazards.");
        safetyTimerRef.current = setInterval(() => { void runHazardCheck(); }, 4000);
      } else {
        push("system", "Safety Check off.");
      }
      return next;
    });
  }, [runHazardCheck]);

  return {
    // state
    phase, error, transcript, historyLoading, micOn, cameraOn, staySilent, cocktailParty, safetyOn, speaking, bridgeOffline, canStart,
    // refs (bind to <video>/<audio> in the screen)
    videoElRef, audioElRef,
    // actions
    start, stop, sendText, sendCameraFrame,
    toggleMic, toggleCamera, toggleStaySilent, toggleCocktailParty, toggleSafety,
    // test-only: drive the realtime event handler directly
    __handleMessage: handleMessage,
  };
}
