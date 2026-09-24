import type { DelegationTask } from "../../../src/gateway/delegation-types";
import { PERSON_MODEL_TOOLS, type PersonModelToolName } from "../../../src/identity/person/tool-contract";

export const COCKTAIL_INSTRUCTIONS = "\n\nCOCKTAIL PARTY MODE: People may appear on camera. Stay silent about the camera feed unless the user asks or introduces someone. If the user asks who someone is, call identify_person, then answer once with the matched name plus relevant facts/recaps. If identify_person returns an identity candidate and the user explicitly verifies the person's name, call confirm_identity_candidate with that candidate_id and name; if the user says it is wrong or should not be remembered, call reject_identity_candidate. If someone new introduces themselves and you have a person id, call update_person_profile to remember their name and add stated facts or a one-line recap. Use list_people or recall_person when the user asks what you know about people. Do not proactively greet known people just because a face appears.";

export const isFinishedTask = (task: DelegationTask) => ["completed", "failed", "cancelled", "interrupted"].includes(task.status);

export type LivePhase = "idle" | "connecting" | "restoring" | "connected" | "paused" | "failed";

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
  delegation?: DelegationTask;
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

export const BACKEND_TOOL = {
  type: "function",
  name: "session_send_message",
  description:
    "Send a concise request or context packet to the Hawk backend agent for durable work, tool use, memory, files, or longer reasoning. Briefly acknowledge before calling when useful. Completion arrives automatically; do not poll task status.",
  parameters: {
    type: "object",
    properties: {
      message: { type: "string", description: "The precise task. Preserve full-file versus summary requests and all corrections." },
      execution: { type: "string", enum: ["serial", "read_only"], description: "Use read_only for independent reads/searches so two tasks can run concurrently. Read-only jobs cannot modify files or run commands. Otherwise use serial." },
      depends_on: { type: "array", items: { type: "string" }, description: "IDs of tasks that must complete first." },
      continue_task: { type: "string", description: "Continue this task's backend conversation; omit for unrelated work." },
      constraints: { type: "string", description: "Constraints and evidence required to consider the task complete." },
    },
    required: ["message"],
    additionalProperties: false,
  },
};

export const BACKEND_CONTROL_TOOL = {
  type: "function", name: "session_task_control",
  description: "List or check backend task status only when the user asks about progress. Never poll: completion arrives automatically. Cancel work only when asked, or revise after a user correction. Stopping speech does not cancel backend work.",
  parameters: { type: "object", properties: {
    action: { type: "string", enum: ["list", "status", "cancel", "revise"] },
    task_id: { type: "string", description: "Task ID from a delegation result; required except for list." },
    message: { type: "string", description: "For revise: the complete corrected task." },
  }, required: ["action"], additionalProperties: false },
};

export const WEB_PERSON_TOOL_NAME_LIST = [
  "identify_person",
  "list_people",
  "recall_person",
  "update_person_profile",
  "confirm_identity_candidate",
  "reject_identity_candidate",
] as const satisfies readonly PersonModelToolName[];
export const WEB_PERSON_TOOL_NAMES = new Set<PersonModelToolName>(WEB_PERSON_TOOL_NAME_LIST);
export const WEB_PERSON_TOOLS = PERSON_MODEL_TOOLS.filter((tool) => WEB_PERSON_TOOL_NAMES.has(tool.name));

// Share the current camera frame to Slack. The browser captures the live video
// frame and attaches it as image_base64 before forwarding to tool.invoke — the
// model only chooses the destination/caption, never the image bytes.
export const SEND_PHOTO_TOOL = {
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
export const GENERATE_CHART_TOOL = {
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

export interface BrokerResponse {
  ok?: boolean;
  error?: string;
  model?: string;
  client_secret?: { value?: string } | string;
}

// Marker prefixing a persisted tool record (stored as an assistant turn so the
// gateway accepts it; decoded back into a tool bubble on history load).
export const TOOL_MARKER = "⁣TOOL⁣"; // invisible separators — won't show if ever rendered raw

export function entryId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** A short, friendly label for a tool-call bubble (no raw JSON args). */
export function toolLabel(name: string, args: Record<string, any>): string {
  if (name === "session_send_message") {
    const m = typeof args.message === "string" ? args.message.trim() : "";
    return m ? `Delegating: ${m}` : "Delegating to backend";
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
  if (name === "confirm_identity_candidate") return "Confirm person";
  if (name === "reject_identity_candidate") return "Reject person";
  return name;
}

export function personRpcMethod(name: PersonModelToolName): string {
  switch (name) {
    case "identify_person": return "person.identify_current_frame";
    case "list_people": return "person.list";
    case "recall_person": return "person.recall";
    case "update_person_profile": return "person.update_profile";
    case "confirm_identity_candidate": return "person.confirm_candidate";
    case "reject_identity_candidate": return "person.reject_candidate";
  }
}

export function personToolDetail(name: PersonModelToolName, result: Record<string, any>): string {
  if (name === "identify_person") {
    return result.found && result.person?.name ? `Matched ${result.person.name}.` : (result.message ?? "No matching person.");
  }
  if (name === "list_people") return `${Array.isArray(result.people) ? result.people.length : 0} people.`;
  if (name === "recall_person") {
    return result.found && result.person?.name ? `Found ${result.person.name}.` : "No matching person.";
  }
  if (name === "update_person_profile") return result.person?.name ? `Updated ${result.person.name}.` : "Updated person.";
  if (name === "confirm_identity_candidate") return result.person?.name ? `Confirmed ${result.person.name}.` : "Confirmed person.";
  if (name === "reject_identity_candidate") return "Rejected candidate.";
  return result.ok === false && typeof result.error === "string" ? result.error : "ok";
}

/** Build the realtime turn_detection block. `staySilent` sets create_response
 *  to false so the model LISTENS without replying (Stay Silent mode). */
export function buildTurnDetection(
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

export function fmtTime(ts?: string): string {
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
export function isNoiseText(text: string): boolean {
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
          const t = JSON.parse(rawText.slice(TOOL_MARKER.length)) as { label: string; status: ToolStatus; detail?: string; ms?: number; image?: string; imageTitle?: string; delegation?: DelegationTask };
          out.push({ id: entryId(), kind: "tool", text: t.label, at, toolStatus: t.status, toolDetail: t.detail, toolMs: t.ms, imageData: t.image, imageTitle: t.imageTitle, delegation: t.delegation });
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

export function clientSecretValue(r: BrokerResponse): string {
  if (typeof r.client_secret === "string") return r.client_secret;
  return r.client_secret?.value ?? "";
}

export function safeJSON(raw: string): Record<string, any> | null {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

