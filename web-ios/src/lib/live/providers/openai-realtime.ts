import type { LiveSettings } from "../../live-settings";
import { buildTurnDetection } from "../../realtime-tools";

/** OpenAI Realtime wire format; GPT-Live never consumes these commands. */
export function realtimeSessionConfig(settings: LiveSettings, instructions: string,
  tools: unknown[], replyMode: string, staySilent: boolean): Record<string, unknown> {
  const wantAudio = replyMode === "audio";
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
  return session;
}
export async function connectRealtime(sdp: string, token: string): Promise<string> {
  const response = await fetch("https://api.openai.com/v1/realtime/calls", {
    method: "POST", body: sdp, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/sdp" },
  });
  if (!response.ok) throw new Error(`OpenAI Realtime call failed (HTTP ${response.status})`);
  return response.text();
}
