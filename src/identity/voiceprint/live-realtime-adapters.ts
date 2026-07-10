/**
 * Provider-adapter seam for live-voice realtime ingestion (A11).
 *
 * This module is THE extension point for adding new realtime / ASR providers.
 * Each adapter normalizes a provider's raw event vocabulary into the small
 * internal {@link CanonicalLiveVoiceEvent} form defined in
 * `live-realtime-canonical.ts` (`speech_started` / `speech_stopped` /
 * `transcript_completed` / `audio_artifact`). The canonical applier in
 * `live-realtime-events.ts` then runs the tracker-facing join logic uniformly,
 * so provider behavior stays consistent across backends.
 *
 * Adding a provider is data-driven: implement a
 * {@link LiveVoiceRealtimeProviderAdapter} that maps the provider's fields to a
 * canonical event, register it in {@link LIVE_VOICE_PROVIDER_ADAPTERS}, and (if
 * it needs field aliases) list them in `aliases`. No new dependencies, no
 * tracker changes.
 *
 * OpenAI is the DEFAULT and byte-for-byte unchanged: {@link openaiLiveVoiceAdapter}
 * is a faithful port of the original extraction logic and stays first in the
 * registry, so `auto` dispatch resolves exactly as it did before this seam
 * existed. {@link geminiLiveVoiceAdapter} (Google Gemini / Vertex "Live API")
 * and {@link nativeLiveVoiceAdapter} (already-normalized `voice.*` events) prove
 * the seam is generic.
 */

import type { SpeechTurn } from "./contracts.js";
import type { CanonicalLiveVoiceEvent } from "./live-realtime-canonical.js";

/**
 * The result of an adapter recognizing (or not) a raw event.
 *  - a {@link CanonicalLiveVoiceEvent}: recognized + extracted successfully.
 *  - `"missing_required_field"`: the adapter OWNS this event type but a required
 *    field (id/offset) is missing — dispatch stops and reports the field fault.
 *  - `null`: the adapter does not recognize the event at all (try the next one).
 */
export type LiveVoiceAdapterResult =
  | CanonicalLiveVoiceEvent
  | "missing_required_field"
  | null;

/**
 * A provider adapter is a pure function that normalizes a raw realtime/ASR event
 * into the {@link CanonicalLiveVoiceEvent} vocabulary. {@link toCanonical} returns
 * `null` when the adapter does not recognize the event (dispatch tries the next
 * adapter).
 *
 * Adapters are data-driven and dependency-free: they only read the raw event's
 * own fields. They never touch tracker state — join resolution lives in the
 * canonical applier, which keeps provider behavior uniform.
 */
export interface LiveVoiceRealtimeProviderAdapter {
  readonly id: string;
  /** Provider hint values this adapter answers to (besides its `id`). */
  readonly aliases?: readonly string[];
  toCanonical(event: Record<string, unknown>): LiveVoiceAdapterResult;
}

/** Provider hint carried on the event / RPC params. `auto` walks the registry. */
export type LiveVoiceRealtimeProviderHint = string;

// --- Shared field-extraction helpers (data-driven, dependency-free) ----------

function optionalString(
  event: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = event[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function optionalFiniteNumber(
  event: Record<string, unknown>,
  keys: readonly string[],
): number | undefined {
  for (const key of keys) {
    const value = event[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function optionalRoute(event: Record<string, unknown>): SpeechTurn["route"] | undefined {
  return optionalString(event, ["route", "audio_route", "audioRoute"]);
}

// --- OpenAI Realtime adapter --------------------------------------------------
//
// Faithful port of the original `applyLiveVoiceRealtimeEvent` extraction. The
// field-alias lists, the item_id/response_id fallbacks, and the explicit vs soft
// id distinction are preserved verbatim so OpenAI behavior stays byte-for-byte.

const OPENAI_SPEECH_WINDOW_ID_KEYS = ["speech_window_id", "speechWindowId"] as const;
const OPENAI_ITEM_ID_KEYS = ["item_id", "itemId"] as const;
const OPENAI_TRANSCRIPT_ITEM_ID_KEYS = [
  "item_id",
  "itemId",
  "transcript_item_id",
  "transcriptItemId",
] as const;
const OPENAI_AUDIO_TRANSCRIPT_ITEM_ID_KEYS = [
  "transcript_item_id",
  "transcriptItemId",
] as const;
const OPENAI_AUDIO_ARTIFACT_ID_KEYS = [
  "audio_artifact_id",
  "audioArtifactId",
  "artifact_id",
  "artifactId",
] as const;

export const openaiLiveVoiceAdapter: LiveVoiceRealtimeProviderAdapter = {
  id: "openai",
  aliases: ["openai-realtime", "openai_realtime"],
  toCanonical(event) {
    const type = typeof event.type === "string" ? event.type : "";
    switch (type) {
      case "input_audio_buffer.speech_started": {
        const atMs = optionalFiniteNumber(event, ["audio_start_ms", "start_ms", "at_ms"]);
        if (atMs === undefined) {
          return "missing_required_field";
        }
        return {
          kind: "speech_started",
          eventType: type,
          atMs,
          speechWindowId: optionalString(event, OPENAI_SPEECH_WINDOW_ID_KEYS),
          itemId: optionalString(event, OPENAI_ITEM_ID_KEYS),
          route: optionalRoute(event),
        };
      }
      case "input_audio_buffer.speech_stopped": {
        const atMs = optionalFiniteNumber(event, ["audio_end_ms", "end_ms", "at_ms"]);
        if (atMs === undefined) {
          return "missing_required_field";
        }
        return {
          kind: "speech_stopped",
          eventType: type,
          atMs,
          speechWindowId: optionalString(event, OPENAI_SPEECH_WINDOW_ID_KEYS),
          itemId: optionalString(event, OPENAI_ITEM_ID_KEYS),
        };
      }
      case "conversation.item.input_audio_transcription.completed": {
        const transcriptItemId = optionalString(event, OPENAI_TRANSCRIPT_ITEM_ID_KEYS);
        if (!transcriptItemId) {
          return "missing_required_field";
        }
        return {
          kind: "transcript_completed",
          eventType: type,
          transcriptItemId,
          role: "user",
          text: optionalString(event, ["transcript", "text"]),
          speechWindowId: optionalString(event, OPENAI_SPEECH_WINDOW_ID_KEYS),
          itemId: optionalString(event, OPENAI_ITEM_ID_KEYS),
        };
      }
      case "response.audio_transcript.done":
      case "response.output_audio_transcript.done": {
        const transcriptItemId =
          optionalString(event, OPENAI_TRANSCRIPT_ITEM_ID_KEYS) ||
          optionalString(event, ["response_id", "responseId"]);
        if (!transcriptItemId) {
          return "missing_required_field";
        }
        return {
          kind: "transcript_completed",
          eventType: type,
          transcriptItemId,
          role: "assistant",
          text: optionalString(event, ["transcript", "text"]),
        };
      }
      case "live_recording.audio_artifact": {
        const audioArtifactId = optionalString(event, OPENAI_AUDIO_ARTIFACT_ID_KEYS);
        if (!audioArtifactId) {
          return "missing_required_field";
        }
        return {
          kind: "audio_artifact",
          eventType: type,
          audioArtifactId,
          audioPath: optionalString(event, ["audio_path", "audioPath", "path"]),
          sampleRate: optionalFiniteNumber(event, ["sample_rate", "sampleRate"]),
          route: optionalRoute(event),
          speechWindowId: optionalString(event, OPENAI_SPEECH_WINDOW_ID_KEYS),
          transcriptItemId: optionalString(event, OPENAI_AUDIO_TRANSCRIPT_ITEM_ID_KEYS),
          itemId: optionalString(event, OPENAI_ITEM_ID_KEYS),
        };
      }
      default:
        return null;
    }
  },
};

// --- Native / canonical pass-through adapter ----------------------------------
//
// For clients that already emit normalized events. Recognizes both a
// `voice.<kind>` event type namespace and a direct canonical field set. It maps
// the same explicit/soft id distinction so join semantics match every provider.

const NATIVE_SPEECH_WINDOW_ID_KEYS = ["speechWindowId", "speech_window_id"] as const;
const NATIVE_ITEM_ID_KEYS = ["itemId", "item_id"] as const;
const NATIVE_AT_MS_KEYS = ["atMs", "at_ms"] as const;

export const nativeLiveVoiceAdapter: LiveVoiceRealtimeProviderAdapter = {
  id: "native",
  aliases: ["canonical", "voice"],
  toCanonical(event) {
    const type = typeof event.type === "string" ? event.type : "";
    switch (type) {
      case "voice.speech_started": {
        const atMs = optionalFiniteNumber(event, NATIVE_AT_MS_KEYS);
        if (atMs === undefined) {
          return "missing_required_field";
        }
        return {
          kind: "speech_started",
          eventType: type,
          atMs,
          speechWindowId: optionalString(event, NATIVE_SPEECH_WINDOW_ID_KEYS),
          itemId: optionalString(event, NATIVE_ITEM_ID_KEYS),
          route: optionalRoute(event),
        };
      }
      case "voice.speech_stopped": {
        const atMs = optionalFiniteNumber(event, NATIVE_AT_MS_KEYS);
        if (atMs === undefined) {
          return "missing_required_field";
        }
        return {
          kind: "speech_stopped",
          eventType: type,
          atMs,
          speechWindowId: optionalString(event, NATIVE_SPEECH_WINDOW_ID_KEYS),
          itemId: optionalString(event, NATIVE_ITEM_ID_KEYS),
        };
      }
      case "voice.transcript_completed": {
        const transcriptItemId = optionalString(event, [
          "transcriptItemId",
          "transcript_item_id",
          ...NATIVE_ITEM_ID_KEYS,
        ]);
        if (!transcriptItemId) {
          return "missing_required_field";
        }
        const role = optionalString(event, ["role"]);
        return {
          kind: "transcript_completed",
          eventType: type,
          transcriptItemId,
          role: role === "assistant" ? "assistant" : "user",
          text: optionalString(event, ["text", "transcript"]),
          speechWindowId: optionalString(event, NATIVE_SPEECH_WINDOW_ID_KEYS),
          itemId: optionalString(event, NATIVE_ITEM_ID_KEYS),
        };
      }
      case "voice.audio_artifact": {
        const audioArtifactId = optionalString(event, [
          "audioArtifactId",
          "audio_artifact_id",
          "artifactId",
          "artifact_id",
        ]);
        if (!audioArtifactId) {
          return "missing_required_field";
        }
        return {
          kind: "audio_artifact",
          eventType: type,
          audioArtifactId,
          audioPath: optionalString(event, ["audioPath", "audio_path", "path"]),
          sampleRate: optionalFiniteNumber(event, ["sampleRate", "sample_rate"]),
          route: optionalRoute(event),
          speechWindowId: optionalString(event, NATIVE_SPEECH_WINDOW_ID_KEYS),
          transcriptItemId: optionalString(event, [
            "transcriptItemId",
            "transcript_item_id",
          ]),
          itemId: optionalString(event, NATIVE_ITEM_ID_KEYS),
        };
      }
      default:
        return null;
    }
  },
};

// --- Google Gemini / Vertex "Live API" adapter --------------------------------
//
// Based on the documented Gemini/Vertex Live API vocabulary:
//  - VAD: `activityStart` / `activityEnd` (server content activity signals).
//  - Transcription: `inputTranscription` / `outputTranscription`, each an object
//    carrying `.text` (and, for finished turns, ids on the parent message).
//  - Turn/message correlation via `turnId` / `messageId` / `itemId`.
//
// These events do not carry OpenAI-style audio offset fields, so we read the
// Live API's `timestampMs` / `startTimestampMs` / `endTimestampMs`. The adapter
// stays data-driven: it recognizes either a `type` discriminator (when a client
// re-emits Live API events with a `type`) or the native Live API field shape.

const GEMINI_TURN_ID_KEYS = ["turnId", "messageId", "itemId", "id"] as const;
const GEMINI_SPEECH_WINDOW_ID_KEYS = ["speechWindowId", "turnId", "messageId"] as const;

function geminiText(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (value && typeof value === "object") {
    const text = (value as Record<string, unknown>).text;
    if (typeof text === "string" && text.trim()) {
      return text.trim();
    }
  }
  return undefined;
}

export const geminiLiveVoiceAdapter: LiveVoiceRealtimeProviderAdapter = {
  id: "gemini",
  aliases: ["vertex", "vertex-live", "gemini-live", "google", "google-live"],
  toCanonical(event) {
    const type = typeof event.type === "string" ? event.type : "";

    // Activity start (VAD open). Match either an explicit `type` or the presence
    // of the Live API `activityStart` object.
    if (type === "activityStart" || type === "activity_start" || "activityStart" in event) {
      const source =
        (event.activityStart as Record<string, unknown> | undefined) ?? event;
      const atMs = optionalFiniteNumber(source, [
        "timestampMs",
        "startTimestampMs",
        "atMs",
      ]);
      if (atMs === undefined) {
        return "missing_required_field";
      }
      return {
        kind: "speech_started",
        eventType: type || "activityStart",
        atMs,
        speechWindowId: optionalString(source, GEMINI_SPEECH_WINDOW_ID_KEYS),
        itemId: optionalString(source, GEMINI_TURN_ID_KEYS),
        route: optionalRoute(source) ?? optionalRoute(event),
      };
    }

    if (type === "activityEnd" || type === "activity_end" || "activityEnd" in event) {
      const source = (event.activityEnd as Record<string, unknown> | undefined) ?? event;
      const atMs = optionalFiniteNumber(source, [
        "timestampMs",
        "endTimestampMs",
        "atMs",
      ]);
      if (atMs === undefined) {
        return "missing_required_field";
      }
      return {
        kind: "speech_stopped",
        eventType: type || "activityEnd",
        atMs,
        speechWindowId: optionalString(source, GEMINI_SPEECH_WINDOW_ID_KEYS),
        itemId: optionalString(source, GEMINI_TURN_ID_KEYS),
      };
    }

    // Input transcription (user speech). The Live API nests this under
    // `inputTranscription: { text }`; some clients flatten it with a `type`.
    if (type === "inputTranscription" || type === "input_transcription" || "inputTranscription" in event) {
      const source =
        (event.inputTranscription as Record<string, unknown> | undefined) ?? event;
      const transcriptItemId =
        optionalString(source, ["transcriptItemId", ...GEMINI_TURN_ID_KEYS]) ??
        optionalString(event, GEMINI_TURN_ID_KEYS);
      if (!transcriptItemId) {
        return "missing_required_field";
      }
      return {
        kind: "transcript_completed",
        eventType: type || "inputTranscription",
        transcriptItemId,
        role: "user",
        text: geminiText(event.inputTranscription) ?? geminiText(source.text) ?? geminiText(source),
        speechWindowId: optionalString(source, ["speechWindowId"]) ?? optionalString(event, ["speechWindowId"]),
        itemId: optionalString(source, GEMINI_TURN_ID_KEYS) ?? optionalString(event, GEMINI_TURN_ID_KEYS),
      };
    }

    if (type === "outputTranscription" || type === "output_transcription" || "outputTranscription" in event) {
      const source =
        (event.outputTranscription as Record<string, unknown> | undefined) ?? event;
      const transcriptItemId =
        optionalString(source, ["transcriptItemId", ...GEMINI_TURN_ID_KEYS]) ??
        optionalString(event, GEMINI_TURN_ID_KEYS);
      if (!transcriptItemId) {
        return "missing_required_field";
      }
      return {
        kind: "transcript_completed",
        eventType: type || "outputTranscription",
        transcriptItemId,
        role: "assistant",
        text: geminiText(event.outputTranscription) ?? geminiText(source.text) ?? geminiText(source),
      };
    }

    return null;
  },
};

// --- Registry + dispatch ------------------------------------------------------

/**
 * Ordered provider registry. `auto` dispatch walks it in order (OpenAI first, so
 * existing callers are byte-for-byte unchanged), returning the first non-null
 * canonicalization. Native + Gemini follow.
 */
export const LIVE_VOICE_PROVIDER_ADAPTERS: readonly LiveVoiceRealtimeProviderAdapter[] = [
  openaiLiveVoiceAdapter,
  nativeLiveVoiceAdapter,
  geminiLiveVoiceAdapter,
];

const ADAPTER_BY_KEY = buildAdapterIndex(LIVE_VOICE_PROVIDER_ADAPTERS);

function buildAdapterIndex(
  adapters: readonly LiveVoiceRealtimeProviderAdapter[],
): Map<string, LiveVoiceRealtimeProviderAdapter> {
  const index = new Map<string, LiveVoiceRealtimeProviderAdapter>();
  for (const adapter of adapters) {
    index.set(adapter.id.toLowerCase(), adapter);
    for (const alias of adapter.aliases ?? []) {
      index.set(alias.toLowerCase(), adapter);
    }
  }
  return index;
}

export function resolveLiveVoiceProviderAdapter(
  hint: LiveVoiceRealtimeProviderHint | undefined,
): LiveVoiceRealtimeProviderAdapter | undefined {
  if (!hint) {
    return undefined;
  }
  const normalized = hint.trim().toLowerCase();
  if (!normalized || normalized === "auto") {
    return undefined;
  }
  return ADAPTER_BY_KEY.get(normalized);
}

/**
 * Normalize a raw event to a canonical event using an optional provider hint.
 *
 * - An explicit, KNOWN hint selects exactly that adapter (and only it).
 * - `auto` / unspecified / unknown hint falls through the registry in order
 *   (OpenAI first), stopping at the first adapter that OWNS the event (i.e.
 *   returns a canonical event OR the `"missing_required_field"` sentinel).
 *
 * Returns `null` when no adapter recognizes the event (i.e. unsupported), and
 * the `"missing_required_field"` sentinel when an adapter owns the event type
 * but a required field (id/offset) is missing.
 */
export function canonicalizeLiveVoiceEvent(
  event: Record<string, unknown>,
  hint?: LiveVoiceRealtimeProviderHint,
): LiveVoiceAdapterResult {
  const selected = resolveLiveVoiceProviderAdapter(hint);
  if (selected) {
    return selected.toCanonical(event);
  }
  for (const adapter of LIVE_VOICE_PROVIDER_ADAPTERS) {
    const result = adapter.toCanonical(event);
    if (result !== null) {
      return result;
    }
  }
  return null;
}
