import { useEffect, useRef } from "react";
import type { DelegationTask } from "../../../../src/gateway/delegation-types";
import { isFinishedTask } from "../realtime-tools";
/** Task lifecycle is gateway-owned. Recovery refreshes the UI without turning
 * historical completions into new spoken announcements.
 */
export function useTaskSubscription(options: {
  sessionKey: string; connected: boolean;
  rpc: (method: string, params?: unknown) => Promise<unknown>;
  subscribe: (listener: (event: { event: string; payload?: unknown }) => void) => () => void;
  changed: (task: DelegationTask, previous?: DelegationTask) => void;
  error: (payload: any) => void;
}) {
  const tasksRef = useRef(new Map<string, DelegationTask>());
  const quietTasksRef = useRef(new Set<string>());
  const handlers = useRef(options); handlers.current = options;
  const { sessionKey, connected, rpc, subscribe } = options;
  useEffect(() => {
    tasksRef.current.clear(); quietTasksRef.current.clear();
    let disposed = false;
    const accept = (task: DelegationTask, recovered = false) => {
      if (disposed || task.ownerSession !== sessionKey) return;
      const previous = tasksRef.current.get(task.id);
      if ((previous?.events.at(-1)?.seq ?? 0) > (task.events.at(-1)?.seq ?? 0)) return;
      if (recovered && !previous && isFinishedTask(task)) quietTasksRef.current.add(task.id);
      tasksRef.current.set(task.id, task); handlers.current.changed(task, previous);
    };
    const unsubscribe = subscribe(event => {
      if (event.event === "delegation.updated") {
        const task = (event.payload as { task?: DelegationTask })?.task;
        if (task) accept(task);
      }
      if (event.event === "live.gpt.error") handlers.current.error(event.payload);
    });
    const refresh = async () => {
      try { const result = await rpc("delegation.list", { ownerSession: sessionKey }) as { tasks?: DelegationTask[] }; result.tasks?.forEach(task => accept(task, true)); }
      catch { /* Connection state is reported separately. */ }
    };
    if (connected) void refresh();
    const timer = setInterval(() => { if (connected) void refresh(); }, 2000);
    return () => { disposed = true; unsubscribe(); clearInterval(timer); };
  }, [sessionKey, connected, rpc, subscribe]);
  return { tasksRef, quietTasksRef };
}
