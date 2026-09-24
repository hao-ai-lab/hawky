import type { ConversationTurn } from "./contracts.js";

export type StreamProvider = "gemini-live" | "venus" | "joyai";
export type StreamInput =
  | { type: "audio"; data: string }
  | { type: "image"; data: string; at: number }
  | { type: "text"; text: string }
  | { type: "mic"; enabled: boolean }
  | { type: "playback"; id: string; played: boolean };
export type StreamEvent =
  | { type: "caption"; id: string; role: "user" | "assistant"; text: string; final: boolean }
  | { type: "audio"; id: string; data: string; rate: number }
  | { type: "interrupt" }
  | { type: "diagnostic"; detail: Record<string, unknown> }
  | { type: "info"; message: string }
  | { type: "warning"; message: string }
  | { type: "error"; message: string };
export interface StreamOptions {
  id: string; model: string; instructions: string; history: ConversationTurn[];
  voice?: string; bridge: boolean;
  emit: (event: StreamEvent) => void;
  tool: (id: string, name: string, args: Record<string, unknown>) => Promise<unknown>;
}
/** Protocol implementations own turn boundaries and notification scheduling. */
export interface StreamAdapter {
  start(): Promise<void>;
  input(input: StreamInput): void | Promise<void>;
  context(text: string, announce: boolean): void;
  /** Safe metadata for troubleshooting; never raw media, prompts or keys. */
  diagnostics?(): Record<string, unknown>;
  close(): void | Promise<void>;
}
