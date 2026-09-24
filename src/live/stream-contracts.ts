import type { ConversationTurn } from "./contracts.js";

export type StreamProvider = "gemini-live" | "venus" | "joyai";
export interface StreamTaskUpdate {
  task_id: string; request: string; status: string; validity?: string;
  result?: string; error?: string; completedAt?: number;
  delivery?: string; deliveryResponseId?: string;
}
export type StreamDelivery = "injected" | "generated" | "played" | "interrupted";
/** Gateway-private evidence, frozen by the provider at a native request boundary.
 * Media is never copied into task broadcasts or diagnostic events. */
export interface StreamCapture {
  at: number; inputSequence: number; history: ConversationTurn[];
  audio: Array<{ sequence: number; start: number; end: number; data: string }>;
  images: Array<{ sequence: number; at: number; data: string }>;
}
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
  delegate?: (id: string, request: string, capture: StreamCapture) => Promise<StreamTaskUpdate>;
  delivery?: (taskId: string, responseId: string, state: StreamDelivery) => void;
}
/** Protocol implementations own turn boundaries and notification scheduling. */
export interface StreamAdapter {
  start(): Promise<void>;
  input(input: StreamInput): void | Promise<void>;
  context(text: string, announce: boolean): void;
  taskUpdate?(task: StreamTaskUpdate, restored?: boolean): void;
  /** Safe metadata for troubleshooting; never raw media, prompts or keys. */
  diagnostics?(): Record<string, unknown>;
  close(): void | Promise<void>;
}
