// =============================================================================
// Live Transcription — realtime mic transcription view (web demo, #681).
//
// Web parity for the iOS "GPTRDemo" tab: stream the microphone to the OpenAI
// Realtime API and render a live, timestamped transcript. Audio-only (no video,
// no spoken responses) — purely speech-to-text.
//
// Reuses the same proven plumbing as LiveLab: a gateway-minted (BYOK-aware)
// realtime client secret + a WebRTC peer connection, with the session configured
// for input transcription only. This avoids a second, divergent realtime
// transport in the demo.
// =============================================================================

import { useEffect, useRef, useState } from "react";
import { useSocketStore } from "../store/socket-store";
import { byokParam } from "../lib/byok";
import { getUserMediaSafe, mediaUnavailableReason } from "../lib/media";

type Status = "idle" | "connecting" | "connected" | "error";

interface Segment {
  id: string;
  text: string;
  at: string;
}

interface BrokerResponse {
  ok?: boolean;
  error?: string;
  model?: string;
  client_secret?: { value?: string } | string;
}

// A transcription-only model; the broker validates against /^gpt-realtime/ and
// falls back to a safe default for anything else, so this stays robust.
const MODEL = "gpt-realtime-2";

function segId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function clientSecretValue(response: BrokerResponse): string {
  if (typeof response.client_secret === "string") return response.client_secret;
  return response.client_secret?.value ?? "";
}

function safeJSON(raw: string): Record<string, any> | null {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function LiveTranscription() {
  const rpc = useSocketStore((s) => s.rpc);
  const gatewayStatus = useSocketStore((s) => s.status);

  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [partial, setPartial] = useState<string>("");
  const [copied, setCopied] = useState(false);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const mediaRef = useRef<MediaStream | null>(null);

  const canStart = gatewayStatus === "connected" && status !== "connecting" && status !== "connected";
  const isConnected = status === "connected";

  useEffect(() => {
    return () => { void stop(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function sendRealtime(event: unknown) {
    const dc = dcRef.current;
    if (dc && dc.readyState === "open") dc.send(JSON.stringify(event));
  }

  function addSegment(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    setSegments((cur) => [...cur, { id: segId(), text: trimmed, at: new Date().toLocaleTimeString() }]);
  }

  async function start() {
    // Fail fast with a clear message when the camera/mic can't be used (e.g. the
    // page is served over plain HTTP on a non-localhost origin) — before we mint
    // a realtime secret we can't use.
    const blocked = mediaUnavailableReason();
    if (blocked) {
      setError(blocked);
      setStatus("error");
      return;
    }
    setStatus("connecting");
    setError(null);
    setSegments([]);
    setPartial("");

    try {
      const brokerPayload = (await rpc("live.openaiClientSecret", {
        ...byokParam(),
        model: MODEL,
        instructions: "Transcribe the user's speech accurately. Do not respond.",
        expires_after_seconds: 600,
      })) as BrokerResponse;
      if (brokerPayload.ok === false) throw new Error(brokerPayload.error ?? "Realtime broker failed");
      const token = clientSecretValue(brokerPayload);
      if (!token) throw new Error("Realtime broker did not return a client secret value");

      const media = await getUserMediaSafe({ audio: true, video: false });
      mediaRef.current = media;

      const pc = new RTCPeerConnection();
      pcRef.current = pc;
      media.getAudioTracks().forEach((track) => pc.addTrack(track, media));

      const dc = pc.createDataChannel("oai-events");
      dcRef.current = dc;
      dc.addEventListener("open", () => {
        // Configure for input transcription only: no audio output, server VAD
        // commits user turns and emits input_audio_transcription events.
        sendRealtime({
          type: "session.update",
          session: {
            type: "realtime",
            output_modalities: ["text"],
            audio: {
              input: {
                transcription: { model: "gpt-4o-mini-transcribe" },
                turn_detection: {
                  type: "server_vad",
                  threshold: 0.5,
                  prefix_padding_ms: 300,
                  silence_duration_ms: 600,
                  create_response: false,
                  interrupt_response: false,
                },
              },
            },
          },
        });
        setStatus("connected");
      });
      dc.addEventListener("message", (event) => handleMessage(String(event.data)));

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const sdpResponse = await fetch("https://api.openai.com/v1/realtime/calls", {
        method: "POST",
        body: offer.sdp,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/sdp" },
      });
      if (!sdpResponse.ok) {
        throw new Error(`OpenAI Realtime call failed with HTTP ${sdpResponse.status}: ${await sdpResponse.text()}`);
      }
      await pc.setRemoteDescription({ type: "answer", sdp: await sdpResponse.text() });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setStatus("error");
      await stop();
    }
  }

  async function stop() {
    setPartial("");
    dcRef.current?.close();
    dcRef.current = null;
    pcRef.current?.close();
    pcRef.current = null;
    mediaRef.current?.getTracks().forEach((track) => track.stop());
    mediaRef.current = null;
    setStatus((cur) => (cur === "error" ? "error" : "idle"));
  }

  function handleMessage(raw: string) {
    const event = safeJSON(raw);
    if (!event) return;
    const type = event.type;
    // Incremental partials (newer realtime API emits deltas for input transcription).
    if (type === "conversation.item.input_audio_transcription.delta" && typeof event.delta === "string") {
      setPartial((p) => p + event.delta);
      return;
    }
    if (type === "conversation.item.input_audio_transcription.completed" && typeof event.transcript === "string") {
      addSegment(event.transcript);
      setPartial("");
      return;
    }
    if (type === "error") {
      const message = event.error?.message ?? raw;
      setError(String(message));
    }
  }

  function copyTranscript() {
    const text = segments.map((s) => s.text).join("\n");
    if (!text) return;
    void navigator.clipboard?.writeText(text).then(
      () => { setCopied(true); setTimeout(() => setCopied(false), 1500); },
      () => {},
    );
  }

  return (
    <div className="flex flex-col h-full bg-stone-50 dark:bg-stone-950">
      <div className="flex items-center justify-between gap-3 px-6 py-3 border-b border-stone-200/60 dark:border-stone-700/40">
        <div className="flex items-center gap-2">
          <div className={`h-2.5 w-2.5 rounded-full ${isConnected ? "bg-emerald-500" : status === "error" ? "bg-red-500" : "bg-stone-300 dark:bg-stone-700"}`} />
          <span className="text-sm text-muted dark:text-muted-dark">
            {isConnected ? "Listening…" : status === "connecting" ? "Connecting…" : "Microphone transcription"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={copyTranscript}
            disabled={segments.length === 0}
            className="rounded-md border border-stone-200 dark:border-stone-700 px-3 py-1.5 text-xs text-stone-700 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 disabled:opacity-40"
          >
            {copied ? "Copied" : "Copy"}
          </button>
          {isConnected ? (
            <button onClick={() => void stop()} className="rounded-md bg-stone-900 dark:bg-stone-100 px-4 py-1.5 text-xs font-medium text-white dark:text-stone-900">
              Stop
            </button>
          ) : (
            <button
              disabled={!canStart}
              onClick={() => void start()}
              className="rounded-md bg-stone-900 disabled:bg-stone-300 dark:bg-stone-100 dark:disabled:bg-stone-700 px-4 py-1.5 text-xs font-medium text-white dark:text-stone-900"
            >
              Start
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        {error && (
          <div className="mb-4 rounded-md bg-red-50 dark:bg-red-950/40 px-3 py-2 text-xs text-red-700 dark:text-red-300">{error}</div>
        )}
        {segments.length === 0 && !partial ? (
          <div className="h-full min-h-[200px] grid place-items-center text-center text-sm text-muted dark:text-muted-dark">
            {gatewayStatus !== "connected"
              ? "Connect to the gateway, then start transcription."
              : "Press Start and speak — your words appear here in real time."}
          </div>
        ) : (
          <div className="max-w-2xl mx-auto space-y-3">
            {segments.map((s) => (
              <div key={s.id} className="rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 px-4 py-3">
                <div className="mb-1 text-[11px] uppercase text-stone-400">{s.at}</div>
                <div className="text-sm leading-relaxed text-stone-800 dark:text-stone-100">{s.text}</div>
              </div>
            ))}
            {partial && (
              <div className="rounded-lg border border-dashed border-stone-300 dark:border-stone-700 px-4 py-3 text-sm italic text-stone-500 dark:text-stone-400">
                {partial}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
