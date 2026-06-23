import { useEffect, useMemo, useRef, useState } from "react";
import { useSocketStore } from "../store/socket-store";
import { useSessionStore } from "../store/session-store";
import { byokParam } from "../lib/byok";
import { getUserMediaSafe, mediaUnavailableReason } from "../lib/media";

type LabStatus = "idle" | "connecting" | "connected" | "stopping" | "error";

type LabEvent = {
  id: string;
  kind: "status" | "user" | "assistant" | "tool" | "error";
  text: string;
  timestamp: string;
};

type BootContextResponse = {
  context?: string;
  sources?: string[];
  warnings?: string[];
  first_contact?: { active?: boolean };
};

type BrokerResponse = {
  ok?: boolean;
  error?: string;
  model?: string;
  client_secret?: { value?: string } | string;
};

const MODEL = "gpt-realtime-2";
const DEFAULT_PROMPT =
  "You are Hawky Live, a concise realtime frontend agent running in a desktop browser test harness. Answer briefly, use the camera/mic context when relevant, and delegate durable or long-running work to the Hawky backend tool.";

const BACKEND_TOOL = {
  type: "function",
  name: "session_send_message",
  description: "Send a concise request or context packet to the Hawky backend agent for durable work, tool use, memory, files, or longer reasoning.",
  parameters: {
    type: "object",
    properties: {
      message: {
        type: "string",
        description: "The message to send to the backend Hawky session.",
      },
      frontend_delivery: {
        type: "string",
        enum: ["silent_context", "summarize_when_done", "urgent"],
        description: "How the browser realtime agent should treat the backend response.",
      },
    },
    required: ["message"],
    additionalProperties: false,
  },
};

function eventId(): string {
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

export function LiveLab() {
  const rpc = useSocketStore((s) => s.rpc);
  const gatewayStatus = useSocketStore((s) => s.status);
  const activeKey = useSessionStore((s) => s.activeKey);
  const [status, setStatus] = useState<LabStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [textInput, setTextInput] = useState("");
  const [events, setEvents] = useState<LabEvent[]>([]);
  const [bootSources, setBootSources] = useState<string[]>([]);
  const [cameraEnabled, setCameraEnabled] = useState(true);
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [frameCadence, setFrameCadence] = useState(0.2);
  const [framesSent, setFramesSent] = useState(0);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const mediaRef = useRef<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const frameTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const assistantTextRef = useRef("");

  const canStart = gatewayStatus === "connected" && status !== "connecting" && status !== "connected";
  const isConnected = status === "connected";

  const mergedInstructions = useMemo(() => {
    return prompt.trim() || DEFAULT_PROMPT;
  }, [prompt]);

  useEffect(() => {
    return () => {
      void stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function pushEvent(kind: LabEvent["kind"], text: string) {
    setEvents((current) => [
      ...current.slice(-80),
      { id: eventId(), kind, text, timestamp: new Date().toLocaleTimeString() },
    ]);
  }

  function sendRealtime(event: unknown) {
    const dc = dcRef.current;
    if (!dc || dc.readyState !== "open") {
      throw new Error("Realtime data channel is not open");
    }
    dc.send(JSON.stringify(event));
  }

  async function start() {
    // Fail fast with a clear message when camera/mic can't be used (e.g. the page
    // is served over plain HTTP on a non-localhost origin) instead of throwing an
    // opaque "Cannot read properties of undefined (reading 'getUserMedia')".
    const blocked = mediaUnavailableReason();
    if (blocked) {
      setError(blocked);
      setStatus("error");
      pushEvent("error", blocked);
      return;
    }
    setStatus("connecting");
    setError(null);
    setFramesSent(0);
    setEvents([]);
    assistantTextRef.current = "";

    try {
      const boot = await rpc("frontend.boot_context", {
        channel_id: activeKey,
        session_key: activeKey,
        participant_id: "web-live-lab",
        mode: "realtime-web",
        capabilities: [
          voiceEnabled ? "audio_input" : "audio_input_off",
          voiceEnabled ? "audio_output" : "text_output",
          cameraEnabled ? "visual_input" : "visual_off",
          "backend_session_bridge",
        ],
        tools: [BACKEND_TOOL],
        max_chars: 16_000,
      }) as BootContextResponse;
      setBootSources(boot.sources ?? []);

      const fullInstructions = [
        mergedInstructions,
        "",
        boot.context ? `# Hawky Backend Context\n${boot.context}` : "",
      ].filter(Boolean).join("\n\n");

      const brokerPayload = await rpc("live.openaiClientSecret", {
        ...byokParam(),
        model: MODEL,
        instructions: fullInstructions,
        reasoning_effort: "low",
        expires_after_seconds: 600,
      }) as BrokerResponse;
      if (brokerPayload.ok === false) {
        throw new Error(brokerPayload.error ?? "Realtime broker failed");
      }
      const token = clientSecretValue(brokerPayload);
      if (!token) throw new Error("Realtime broker did not return a client secret value");

      const media = await getUserMediaSafe({
        audio: voiceEnabled,
        video: cameraEnabled ? { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" } : false,
      });
      mediaRef.current = media;
      if (videoRef.current) videoRef.current.srcObject = media;

      const pc = new RTCPeerConnection();
      pcRef.current = pc;
      pc.ontrack = (event) => {
        if (audioRef.current) {
          audioRef.current.srcObject = event.streams[0];
          void audioRef.current.play().catch(() => {});
        }
      };
      media.getAudioTracks().forEach((track) => pc.addTrack(track, media));
      const dc = pc.createDataChannel("oai-events");
      dcRef.current = dc;
      dc.addEventListener("open", () => {
        sendRealtime({
          type: "session.update",
          session: {
            type: "realtime",
            instructions: fullInstructions,
            output_modalities: [voiceEnabled ? "audio" : "text"],
            tools: [BACKEND_TOOL],
            tool_choice: "auto",
            audio: {
              input: {
                turn_detection: {
                  type: "server_vad",
                  threshold: 0.5,
                  prefix_padding_ms: 300,
                  silence_duration_ms: 500,
                  create_response: true,
                  interrupt_response: true,
                },
              },
              output: { voice: "marin" },
            },
          },
        });
        setStatus("connected");
        pushEvent("status", `Connected ${brokerPayload.model ?? MODEL} to ${activeKey}`);
        if (cameraEnabled) startFrameLoop();
      });
      dc.addEventListener("message", (event) => {
        void handleRealtimeMessage(String(event.data));
      });

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const sdpResponse = await fetch("https://api.openai.com/v1/realtime/calls", {
        method: "POST",
        body: offer.sdp,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/sdp",
        },
      });
      if (!sdpResponse.ok) {
        throw new Error(`OpenAI Realtime call failed with HTTP ${sdpResponse.status}: ${await sdpResponse.text()}`);
      }
      await pc.setRemoteDescription({ type: "answer", sdp: await sdpResponse.text() });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setStatus("error");
      pushEvent("error", message);
      await stopMediaOnly();
    }
  }

  async function stop() {
    setStatus((current) => current === "idle" ? "idle" : "stopping");
    await stopMediaOnly();
    setStatus("idle");
    pushEvent("status", "Stopped Live Lab");
  }

  async function stopMediaOnly() {
    if (frameTimerRef.current) {
      clearInterval(frameTimerRef.current);
      frameTimerRef.current = null;
    }
    dcRef.current?.close();
    dcRef.current = null;
    pcRef.current?.close();
    pcRef.current = null;
    mediaRef.current?.getTracks().forEach((track) => track.stop());
    mediaRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    if (audioRef.current) audioRef.current.srcObject = null;
  }

  function startFrameLoop() {
    const intervalMs = Math.max(1000, Math.round(1000 / Math.max(frameCadence, 0.1)));
    frameTimerRef.current = setInterval(() => {
      try {
        sendCameraFrame();
      } catch (err) {
        pushEvent("error", err instanceof Error ? err.message : String(err));
      }
    }, intervalMs);
  }

  function sendCameraFrame() {
    const video = videoRef.current;
    if (!video || video.readyState < 2) return;
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = Math.max(1, Math.round((video.videoHeight / video.videoWidth) * canvas.width));
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const imageUrl = canvas.toDataURL("image/jpeg", 0.72);
    sendRealtime({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_image", image_url: imageUrl }],
      },
    });
    setFramesSent((n) => n + 1);
  }

  function sendText() {
    const text = textInput.trim();
    if (!text) return;
    sendRealtime({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      },
    });
    sendRealtime({
      type: "response.create",
      response: { output_modalities: [voiceEnabled ? "audio" : "text"] },
    });
    pushEvent("user", text);
    setTextInput("");
  }

  async function handleRealtimeMessage(raw: string) {
    const event = safeJSON(raw);
    if (!event) return;
    const type = event.type;
    if (type === "response.output_text.delta" && typeof event.delta === "string") {
      assistantTextRef.current += event.delta;
      return;
    }
    if (type === "response.output_text.done") {
      const text = typeof event.text === "string" ? event.text : assistantTextRef.current;
      assistantTextRef.current = "";
      if (text.trim()) pushEvent("assistant", text.trim());
      return;
    }
    if (type === "response.audio_transcript.done" && typeof event.transcript === "string") {
      pushEvent("assistant", event.transcript);
      return;
    }
    if (type === "conversation.item.input_audio_transcription.completed" && typeof event.transcript === "string") {
      pushEvent("user", event.transcript);
      return;
    }
    if (type === "response.function_call_arguments.done") {
      await handleFunctionCall(event);
      return;
    }
    if (type === "error") {
      const message = event.error?.message ?? raw;
      setError(String(message));
      pushEvent("error", String(message));
    }
  }

  async function handleFunctionCall(event: Record<string, any>) {
    const callId = String(event.call_id ?? "");
    const name = String(event.name ?? "");
    const args = safeJSON(String(event.arguments ?? "{}")) ?? {};
    pushEvent("tool", `${name} ${JSON.stringify(args)}`);

    let output: Record<string, unknown>;
    try {
      if (name !== "session_send_message") {
        throw new Error(`Unknown Live Lab tool: ${name}`);
      }
      const message = typeof args.message === "string" ? args.message.trim() : "";
      if (!message) throw new Error("message is required");
      await rpc("chat.send", {
        sessionKey: activeKey,
        message: `[From desktop Live Lab realtime agent]\n${message}`,
      });
      output = {
        ok: true,
        sessionKey: activeKey,
        note: "Message sent to the Hawky backend session. Watch the chat view for streamed progress and results.",
      };
    } catch (err) {
      output = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    sendRealtime({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(output),
      },
    });
    sendRealtime({
      type: "response.create",
      response: { output_modalities: [voiceEnabled ? "audio" : "text"] },
    });
  }

  return (
    <div className="flex-1 min-h-0 overflow-hidden bg-stone-50 dark:bg-stone-950">
      <div className="grid h-full grid-cols-1 lg:grid-cols-[minmax(360px,0.9fr)_minmax(420px,1.1fr)]">
        <section className="min-h-0 border-r border-stone-200/70 dark:border-stone-800 bg-white dark:bg-stone-900 flex flex-col">
          <div className="p-4 border-b border-stone-200/70 dark:border-stone-800">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium text-stone-800 dark:text-stone-100">Desktop Realtime</div>
                <div className="text-xs text-stone-500 dark:text-stone-400">{activeKey}</div>
              </div>
              <div className={`h-2.5 w-2.5 rounded-full ${isConnected ? "bg-emerald-500" : status === "error" ? "bg-red-500" : "bg-stone-300 dark:bg-stone-700"}`} />
            </div>
          </div>

          <div className="p-4 space-y-4 overflow-y-auto">
            <div className="aspect-video overflow-hidden rounded-lg border border-stone-200 dark:border-stone-700 bg-stone-950">
              <video ref={videoRef} autoPlay muted playsInline className="h-full w-full object-cover" />
            </div>
            <audio ref={audioRef} autoPlay />

            <div className="grid grid-cols-3 gap-2 text-xs">
              <label className="flex items-center gap-2 rounded-md border border-stone-200 dark:border-stone-700 px-2 py-2">
                <input type="checkbox" checked={voiceEnabled} disabled={isConnected} onChange={(e) => setVoiceEnabled(e.target.checked)} />
                Voice
              </label>
              <label className="flex items-center gap-2 rounded-md border border-stone-200 dark:border-stone-700 px-2 py-2">
                <input type="checkbox" checked={cameraEnabled} disabled={isConnected} onChange={(e) => setCameraEnabled(e.target.checked)} />
                Camera
              </label>
              <select
                value={frameCadence}
                disabled={isConnected}
                onChange={(e) => setFrameCadence(Number(e.target.value))}
                className="rounded-md border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-800 px-2 py-2 text-xs"
              >
                <option value={0.1}>0.1 fps</option>
                <option value={0.2}>0.2 fps</option>
                <option value={0.5}>0.5 fps</option>
                <option value={1}>1 fps</option>
              </select>
            </div>

            <textarea
              value={prompt}
              disabled={isConnected}
              onChange={(e) => setPrompt(e.target.value)}
              className="h-40 w-full resize-none rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 px-3 py-2 text-sm text-stone-800 dark:text-stone-100 focus:outline-none focus:border-stone-400 dark:focus:border-stone-500"
            />

            <div className="flex gap-2">
              {isConnected ? (
                <button onClick={() => void stop()} className="rounded-lg bg-stone-900 dark:bg-stone-100 px-4 py-2 text-sm font-medium text-white dark:text-stone-900">
                  Stop
                </button>
              ) : (
                <button disabled={!canStart} onClick={() => void start()} className="rounded-lg bg-stone-900 disabled:bg-stone-300 dark:bg-stone-100 dark:disabled:bg-stone-700 px-4 py-2 text-sm font-medium text-white dark:text-stone-900">
                  Start
                </button>
              )}
              <button disabled={!isConnected || !cameraEnabled} onClick={sendCameraFrame} className="rounded-lg border border-stone-200 dark:border-stone-700 px-4 py-2 text-sm text-stone-700 dark:text-stone-200 disabled:opacity-40">
                Frame
              </button>
            </div>

            <div className="text-xs text-stone-500 dark:text-stone-400">
              {framesSent} frames sent · {bootSources.length > 0 ? `boot context: ${bootSources.join(", ")}` : "boot context pending"}
            </div>
            {error && <div className="rounded-md bg-red-50 dark:bg-red-950/40 px-3 py-2 text-xs text-red-700 dark:text-red-300">{error}</div>}
          </div>
        </section>

        <section className="min-h-0 flex flex-col">
          <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
            {events.length === 0 ? (
              <div className="h-full grid place-items-center text-sm text-stone-500 dark:text-stone-400">
                Start a session, speak naturally, or send text below.
              </div>
            ) : events.map((event) => (
              <div key={event.id} className={`rounded-lg border px-3 py-2 text-sm ${
                event.kind === "error"
                  ? "border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
                  : event.kind === "assistant"
                    ? "border-stone-200 bg-white text-stone-800 dark:border-stone-800 dark:bg-stone-900 dark:text-stone-100"
                    : event.kind === "tool"
                      ? "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100"
                      : "border-stone-200 bg-stone-100 text-stone-700 dark:border-stone-800 dark:bg-stone-900/70 dark:text-stone-300"
              }`}>
                <div className="mb-1 text-[11px] uppercase text-stone-400">{event.kind} · {event.timestamp}</div>
                <div className="whitespace-pre-wrap leading-relaxed">{event.text}</div>
              </div>
            ))}
          </div>
          <div className="border-t border-stone-200/70 dark:border-stone-800 bg-white dark:bg-stone-900 p-3">
            <div className="flex gap-2">
              <input
                value={textInput}
                onChange={(e) => setTextInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && isConnected) {
                    e.preventDefault();
                    sendText();
                  }
                }}
                disabled={!isConnected}
                className="min-w-0 flex-1 rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-950 px-3 py-2 text-sm text-stone-800 dark:text-stone-100 focus:outline-none focus:border-stone-400 dark:focus:border-stone-500"
                placeholder={isConnected ? "Send text to the realtime agent" : "Start Live Lab first"}
              />
              <button disabled={!isConnected || !textInput.trim()} onClick={sendText} className="rounded-lg bg-stone-900 disabled:bg-stone-300 dark:bg-stone-100 dark:disabled:bg-stone-700 px-4 py-2 text-sm font-medium text-white dark:text-stone-900">
                Send
              </button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
