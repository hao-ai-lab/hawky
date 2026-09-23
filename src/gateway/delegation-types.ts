/** Shared, serializable delegation state. Execution and delivery are independent. */
export type DelegationState = "queued" | "cancelling" | "running" | "needs_input" | "completed" | "failed" | "cancelled" | "interrupted";
export type DelegationRuntime = "native" | "codex" | "claude";
export interface DelegationEvent {
  seq: number;
  at: number;
  type: string;
  data?: unknown;
}
export interface DelegationTask {
  id: string;
  ownerSession: string;
  backendSession: string;
  runtime: DelegationRuntime;
  readOnly?: boolean;
  dependsOn?: string[];
  continues?: string;
  model?: string;
  runtimeSessionId?: string;
  authentication?: "provider_config" | "cli_managed";
  request: string;
  originalRequest?: string;
  constraints?: string;
  context?: Array<{ role: "user" | "assistant"; text: string }>;
  brief?: string;
  supersedes?: string;
  validity?: "current" | "superseded";
  delivery?: "pending" | "generated" | "played" | "displayed" | "interrupted";
  deliveryResponseId?: string;
  input?: { id: string; kind: "permission" | "question"; prompt: string; detail?: unknown };
  cancelRequestedAt?: number;
  status: DelegationState;
  createdAt: number;
  startedAt?: number;
  firstOutputAt?: number;
  completedAt?: number;
  result?: string;
  preview?: string;
  image?: { base64?: string; media_type?: string };
  error?: string;
  events: DelegationEvent[];
}
