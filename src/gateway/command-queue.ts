// =============================================================================
// Command Queue
//
// Lane-based FIFO queue with async pump. Each lane has independent concurrency
// control. Tasks within a lane are serialized (or run up to maxConcurrent).
// Different lanes run in parallel.
//
// Pattern: a proven command-queue.ts — proven at 200K+ users.
// =============================================================================

import { createSubsystemLogger } from "../logging/index.js";
import type { QueueEntry, LaneState, EnqueueOptions } from "./types.js";
import { CommandLane, GatewayDrainingError, CommandLaneClearedError } from "./types.js";

const log = createSubsystemLogger("gateway/queue");

// -----------------------------------------------------------------------------
// Global state
// -----------------------------------------------------------------------------

const lanes = new Map<string, LaneState>();
let gatewayDraining = false;
let nextTaskId = 1;

// -----------------------------------------------------------------------------
// Lane state management
// -----------------------------------------------------------------------------

function getLaneState(lane: string): LaneState {
  const existing = lanes.get(lane);
  if (existing) return existing;

  const created: LaneState = {
    lane,
    queue: [],
    activeTaskIds: new Set(),
    maxConcurrent: 1,
    generation: 0,
  };
  lanes.set(lane, created);
  return created;
}

// -----------------------------------------------------------------------------
// Pump — recursive drain, no timers
// -----------------------------------------------------------------------------

function completeTask(state: LaneState, taskId: number, taskGeneration: number): boolean {
  // Ignore stale completions (from before resetAllLanes)
  if (taskGeneration !== state.generation) return false;
  state.activeTaskIds.delete(taskId);
  return true;
}

function drainLane(lane: string): void {
  const state = lanes.get(lane);
  if (!state) return;

  while (state.activeTaskIds.size < state.maxConcurrent && state.queue.length > 0) {
    const entry = state.queue.shift()!;
    const taskId = nextTaskId++;
    const taskGeneration = state.generation;
    state.activeTaskIds.add(taskId);

    // Check if entry has been waiting too long
    if (entry.onWait) {
      const waitMs = Date.now() - entry.enqueuedAt;
      if (waitMs > entry.warnAfterMs) {
        try {
          entry.onWait(waitMs, state.queue.length);
        } catch {
          // onWait callback errors are non-fatal
        }
      }
    }

    void (async () => {
      try {
        const result = await entry.task();
        if (completeTask(state, taskId, taskGeneration)) {
          drainLane(lane);
        }
        entry.resolve(result);
      } catch (err) {
        if (completeTask(state, taskId, taskGeneration)) {
          drainLane(lane);
        }
        entry.reject(err);
      }
    })();
  }
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

/**
 * Enqueue a task to run in the specified lane.
 * Returns a Promise that resolves/rejects when the task completes.
 */
export function enqueueCommandInLane<T>(
  lane: string,
  task: () => Promise<T>,
  opts?: EnqueueOptions,
): Promise<T> {
  if (gatewayDraining) {
    return Promise.reject(new GatewayDrainingError());
  }

  const cleaned = lane.trim() || CommandLane.Main;
  const state = getLaneState(cleaned);

  return new Promise<T>((resolve, reject) => {
    state.queue.push({
      task: task as () => Promise<unknown>,
      resolve: resolve as (value: unknown) => void,
      reject,
      enqueuedAt: Date.now(),
      warnAfterMs: opts?.warnAfterMs ?? 2_000,
      onWait: opts?.onWait,
    });

    log.debug("enqueued", {
      lane: cleaned,
      depth: state.queue.length + state.activeTaskIds.size,
    });

    drainLane(cleaned);
  });
}

/**
 * Shorthand: enqueue to a named CommandLane.
 */
export function enqueueCommand<T>(
  lane: CommandLane,
  task: () => Promise<T>,
  opts?: EnqueueOptions,
): Promise<T> {
  return enqueueCommandInLane(lane, task, opts);
}

/**
 * Get the number of queued + active tasks in a lane.
 */
export function getQueueSize(lane: string): number {
  const state = lanes.get(lane);
  if (!state) return 0;
  return state.queue.length + state.activeTaskIds.size;
}

/**
 * Get the total queue size across all lanes.
 */
export function getTotalQueueSize(): number {
  let total = 0;
  for (const state of lanes.values()) {
    total += state.queue.length + state.activeTaskIds.size;
  }
  return total;
}

/**
 * Get the number of active (executing) tasks in a lane.
 */
export function getActiveCount(lane: string): number {
  const state = lanes.get(lane);
  if (!state) return 0;
  return state.activeTaskIds.size;
}

/**
 * Set the max concurrent tasks for a lane.
 */
export function setCommandLaneConcurrency(lane: string, maxConcurrent: number): void {
  const state = getLaneState(lane);
  state.maxConcurrent = Math.max(1, maxConcurrent);
  // Pump in case we increased concurrency and there's queued work
  drainLane(lane);
}

/**
 * Clear all queued (not active) entries in a lane.
 * Active tasks continue running. Queued entries are rejected with CommandLaneClearedError.
 * Returns the number of cleared entries.
 */
export function clearCommandLane(lane: string): number {
  const state = lanes.get(lane);
  if (!state) return 0;

  const removed = state.queue.length;
  const pending = state.queue.splice(0);
  for (const entry of pending) {
    entry.reject(new CommandLaneClearedError(lane));
  }
  return removed;
}

/**
 * Mark the gateway as draining. New enqueueCommand calls will be rejected.
 */
export function markGatewayDraining(): void {
  gatewayDraining = true;
  log.info("gateway draining — rejecting new work");
}

/**
 * Check if gateway is draining.
 */
export function isGatewayDraining(): boolean {
  return gatewayDraining;
}

/**
 * Wait for all active tasks to complete (across all lanes).
 * Queued tasks will also be drained (they'll execute and complete).
 * Returns { drained: true } if all tasks completed, or { drained: false } on timeout.
 */
export function waitForActiveTasks(timeoutMs: number): Promise<{ drained: boolean }> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;

    const check = () => {
      let totalActive = 0;
      for (const state of lanes.values()) {
        totalActive += state.activeTaskIds.size + state.queue.length;
      }
      if (totalActive === 0) {
        resolve({ drained: true });
        return;
      }
      if (Date.now() >= deadline) {
        resolve({ drained: false });
        return;
      }
      setTimeout(check, 50);
    };

    check();
  });
}

/**
 * Reset all lanes. Used for in-process restart.
 * Bumps generation to ignore stale completions. Clears active task IDs.
 * Preserves queued entries and re-drains them.
 */
export function resetAllLanes(): void {
  const toDrain: string[] = [];

  for (const state of lanes.values()) {
    state.generation++;
    state.activeTaskIds.clear();
    if (state.queue.length > 0) {
      toDrain.push(state.lane);
    }
  }

  gatewayDraining = false;

  // Re-drain lanes that had queued work
  for (const lane of toDrain) {
    drainLane(lane);
  }
}

/**
 * Get all lane names (for testing/monitoring).
 */
export function getLaneNames(): string[] {
  return Array.from(lanes.keys());
}

/**
 * Reset global state. For testing only.
 */
export function resetCommandQueue(): void {
  lanes.clear();
  gatewayDraining = false;
  nextTaskId = 1;
}
