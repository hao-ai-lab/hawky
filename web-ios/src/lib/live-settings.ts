// =============================================================================
// Live settings — the full iOS Live settings set, persisted to localStorage and
// shared between the Live screen and the Settings screen. Mirrors the nine iOS
// sections (Provider, Response, Conversation, Recording, Model Configuration,
// Turn Detection, Tools, Hawk Bridge, Inputs). Browser-applicable controls
// drive the realtime session; the rest are stored faithfully (some are
// iPhone-only and shown disabled with a note).
// =============================================================================

import { create } from "zustand";

export const REALTIME_MODELS = [
  "gpt-realtime-2",
  "gpt-realtime-mini-2025-12-15",
  "gpt-realtime-mini-2025-10-06",
  "gpt-realtime-mini",
  "gpt-realtime-2025-08-28",
  "gpt-realtime-1.5",
  "gpt-realtime",
] as const;

export const VOICES = ["marin", "cedar", "alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse"] as const;
export const NOISE_REDUCTION = ["none", "near_field", "far_field"] as const;
export const TRANSCRIBE_MODELS = ["gpt-4o-mini-transcribe", "gpt-4o-transcribe", "whisper-1"] as const;
export const TURN_DETECTION = ["server_vad", "semantic_vad", "manual"] as const;
export const SEMANTIC_EAGERNESS = ["auto", "low", "medium", "high"] as const;
export const BARGE_IN = ["interrupt", "let_finish", "full_duplex"] as const;
export const REASONING_EFFORT = ["none", "low", "medium", "high", "xhigh"] as const;
export const TOOL_CHOICE = ["auto", "none", "required"] as const;
export const MAX_TOKENS_MODE = ["unlimited", "custom"] as const;
export const VISUAL_CADENCE = ["off", "0.2", "0.5", "1", "custom"] as const;
export const CAMERA_POSITION = ["front", "back"] as const;
export const BRIDGE_SESSION_MODE = ["temporary", "fixed", "active_chat"] as const;
export const BRIDGE_FEED_MODE = ["on_demand", "follow_stream"] as const;
export const OPENING_BEHAVIOR = ["silent", "first_contact", "every_session"] as const;

export interface LiveSettings {
  // Provider / model
  model: string;
  // Response
  responseModality: "audio" | "text";
  voice: string;
  noiseReduction: (typeof NOISE_REDUCTION)[number];
  userTranscript: boolean;        // input transcription on
  assistantTranscript: boolean;   // output transcription on
  transcribeModel: string;
  showSystemMessages: boolean;
  // Model configuration
  maxTokensMode: (typeof MAX_TOKENS_MODE)[number];
  maxTokens: number;              // when custom
  reasoningEffort: (typeof REASONING_EFFORT)[number];
  toolChoice: (typeof TOOL_CHOICE)[number];
  parallelToolCalls: boolean;
  // Turn detection
  turnDetection: (typeof TURN_DETECTION)[number];
  vadThreshold: number;           // 0..1
  prefixPaddingMs: number;        // 0..2000
  silenceMs: number;              // 100..2000
  semanticEagerness: (typeof SEMANTIC_EAGERNESS)[number];
  bargeIn: (typeof BARGE_IN)[number];
  // Behavioral modes (input section)
  speakOnlyWhenSpokenTo: boolean;
  cocktailParty: boolean;
  safetyCheck: boolean;           // iPhone-only pipeline (shown, noted)
  visualDedup: boolean;
  systemPrompt: string;
  // Inputs
  visualCadence: (typeof VISUAL_CADENCE)[number];
  customFps: number;              // when cadence=custom
  cameraPosition: (typeof CAMERA_POSITION)[number];
  // Hawk bridge
  backendBridge: boolean;
  bridgeRequired: boolean;
  bridgeSessionMode: (typeof BRIDGE_SESSION_MODE)[number];
  bridgeFeedMode: (typeof BRIDGE_FEED_MODE)[number];
  openingBehavior: (typeof OPENING_BEHAVIOR)[number];
}

export const DEFAULT_LIVE_SETTINGS: LiveSettings = {
  model: "gpt-realtime-2",
  responseModality: "audio",
  voice: "marin",
  noiseReduction: "far_field",
  userTranscript: true,
  assistantTranscript: true,
  transcribeModel: "gpt-4o-mini-transcribe",
  showSystemMessages: true,
  maxTokensMode: "unlimited",
  maxTokens: 4096,
  reasoningEffort: "low",
  toolChoice: "auto",
  parallelToolCalls: true,
  turnDetection: "server_vad",
  vadThreshold: 0.5,
  prefixPaddingMs: 300,
  silenceMs: 500,
  semanticEagerness: "auto",
  bargeIn: "interrupt",
  speakOnlyWhenSpokenTo: false,
  cocktailParty: false,
  safetyCheck: false,
  visualDedup: false,
  systemPrompt:
    "You are Hawk, a concise, friendly realtime assistant. Use the camera and " +
    "microphone context when relevant, answer briefly, and delegate durable or " +
    "long-running work to the Hawk backend tool.",
  visualCadence: "0.2",
  customFps: 1,
  cameraPosition: "front",
  backendBridge: true,
  bridgeRequired: false,
  bridgeSessionMode: "active_chat",
  bridgeFeedMode: "on_demand",
  openingBehavior: "first_contact",
};

const KEY = "hawky-ios-live-settings";

function load(): LiveSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULT_LIVE_SETTINGS, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return { ...DEFAULT_LIVE_SETTINGS };
}

interface LiveSettingsStore extends LiveSettings {
  set: <K extends keyof LiveSettings>(key: K, value: LiveSettings[K]) => void;
  reset: () => void;
}

export const useLiveSettings = create<LiveSettingsStore>((set, get) => ({
  ...load(),
  set: (key, value) => {
    set({ [key]: value } as Partial<LiveSettingsStore>);
    try { localStorage.setItem(KEY, JSON.stringify(extract(get()))); } catch { /* ignore */ }
  },
  reset: () => {
    set({ ...DEFAULT_LIVE_SETTINGS });
    try { localStorage.setItem(KEY, JSON.stringify(DEFAULT_LIVE_SETTINGS)); } catch { /* ignore */ }
  },
}));

/** The cadence setting as a frames-per-second number (0 = off). */
export function cadenceFps(s: LiveSettings): number {
  if (s.visualCadence === "off") return 0;
  if (s.visualCadence === "custom") return s.customFps;
  return Number(s.visualCadence);
}

/** Pull just the LiveSettings fields (no actions) for persistence. */
export function extract(s: LiveSettings): LiveSettings {
  const src = s as unknown as Record<string, unknown>;
  const o: Record<string, unknown> = {};
  for (const k of Object.keys(DEFAULT_LIVE_SETTINGS)) o[k] = src[k];
  return o as unknown as LiveSettings;
}
