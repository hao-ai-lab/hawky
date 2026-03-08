// =============================================================================
// StreamEvent Emitter
//
// A typed event emitter for the agent loop to communicate with the UI.
// Supports multiple subscribers and provides an AsyncGenerator interface
// for consuming events.
// =============================================================================

import type { StreamEvent, StreamEventCallback } from "./types.js";

/**
 * Typed event emitter for StreamEvents.
 *
 * Usage:
 *   const emitter = new StreamEventEmitter();
 *
 *   // Subscribe to events
 *   const unsub = emitter.subscribe((event) => console.log(event));
 *
 *   // Emit events
 *   emitter.emit({ type: "text", content: "hello" });
 *
 *   // Unsubscribe
 *   unsub();
 */
export class StreamEventEmitter {
  private subscribers = new Set<StreamEventCallback>();

  /**
   * Subscribe to stream events.
   * @returns Unsubscribe function.
   */
  subscribe(callback: StreamEventCallback): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  /**
   * Emit a stream event to all subscribers.
   */
  emit(event: StreamEvent): void {
    for (const callback of this.subscribers) {
      try {
        callback(event);
      } catch (err) {
        // Don't let a subscriber error break the emitter.
        // Log but don't propagate.
        console.error("[StreamEventEmitter] Subscriber threw:", err);
      }
    }
  }

  /**
   * Number of active subscribers.
   */
  get subscriberCount(): number {
    return this.subscribers.size;
  }

  /**
   * Remove all subscribers.
   */
  clear(): void {
    this.subscribers.clear();
  }
}

/**
 * Create an AsyncGenerator that yields StreamEvents from an emitter.
 *
 * This is useful for consuming events in a for-await loop:
 *
 *   for await (const event of streamEvents(emitter, signal)) {
 *     console.log(event);
 *     if (event.type === "done" || event.type === "cancel") break;
 *   }
 *
 * The generator automatically unsubscribes when:
 * - The consumer breaks out of the loop
 * - The AbortSignal fires
 * - A "done" or "cancel" event is emitted
 */
export async function* streamEvents(
  emitter: StreamEventEmitter,
  signal?: AbortSignal,
): AsyncGenerator<StreamEvent> {
  // Buffer for events that arrive between yields
  const buffer: StreamEvent[] = [];
  let resolve: (() => void) | null = null;
  let done = false;

  const unsub = emitter.subscribe((event) => {
    buffer.push(event);
    // Wake up the consumer if it's waiting
    if (resolve) {
      resolve();
      resolve = null;
    }
  });

  const onAbort = () => {
    done = true;
    if (resolve) {
      resolve();
      resolve = null;
    }
  };

  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    while (true) {
      // Drain the buffer first (even if done is set, yield what we have)
      while (buffer.length > 0) {
        const event = buffer.shift()!;
        yield event;

        // Terminal events end the generator
        if (event.type === "done" || event.type === "cancel" || event.type === "error") {
          return;
        }
      }

      // After draining, check if we should stop
      if (done) break;

      // Wait for the next event or abort
      await new Promise<void>((r) => {
        resolve = r;
      });
    }
  } finally {
    unsub();
    signal?.removeEventListener("abort", onAbort);
  }
}
