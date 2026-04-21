// =============================================================================
// Gateway Types
//
// Core types for the command queue, lane system, and heartbeat wake.
// =============================================================================

// -----------------------------------------------------------------------------
// Lane types
// -----------------------------------------------------------------------------

export const enum CommandLane {
  Main = "main",
  Cron = "cron",
  Subagent = "subagent",
}

// -----------------------------------------------------------------------------
// Queue entry
// -----------------------------------------------------------------------------

export interface QueueEntry {
  task: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  enqueuedAt: number;
  warnAfterMs: number;
  onWait?: (waitMs: number, queuedAhead: number) => void;
}

export interface LaneState {
  lane: string;
  queue: QueueEntry[];
  activeTaskIds: Set<number>;
  maxConcurrent: number;
  generation: number;
}

// -----------------------------------------------------------------------------
// Enqueue options
// -----------------------------------------------------------------------------

export interface EnqueueOptions {
  /** Warn if task waits longer than this (ms). Default: 2000 */
  warnAfterMs?: number;
  /** Called when task has been waiting in queue */
  onWait?: (waitMs: number, queuedAhead: number) => void;
}

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

export class GatewayDrainingError extends Error {
  constructor() {
    super("Gateway is shutting down — new work is not accepted");
    this.name = "GatewayDrainingError";
  }
}

export class CommandLaneClearedError extends Error {
  public readonly lane: string;
  constructor(lane: string) {
    super(`Command lane "${lane}" was cleared`);
    this.name = "CommandLaneClearedError";
    this.lane = lane;
  }
}

// -----------------------------------------------------------------------------
// Heartbeat wake types
// -----------------------------------------------------------------------------

export const enum WakePriority {
  Retry = 0,
  Interval = 1,
  Default = 2,
  Action = 3,
}

export interface WakeRequest {
  reason?: string;
  priority: WakePriority;
  queuedAt: number;
}

export interface WakeResult {
  status: "ran" | "skipped";
  reason?: string;
}

export type WakeHandler = () => Promise<WakeResult>;
