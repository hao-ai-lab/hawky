/** Shared, serializable delegation state. Execution and delivery are independent. */
export type DelegationState = "queued" | "running" | "needs_input" | "completed" | "failed" | "cancelled" | "interrupted";
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
  model?: string;
  request: string;
  originalRequest?: string;
  status: DelegationState;
  createdAt: number;
  startedAt?: number;
  firstOutputAt?: number;
  completedAt?: number;
  result?: string;
  image?: { base64?: string; media_type?: string };
  error?: string;
  events: DelegationEvent[];
}
