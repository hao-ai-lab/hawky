import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getSessionsDir } from "../storage/session.js";
import type { StreamEvent } from "../agent/types.js";
import type { GatewayServer } from "./server.js";
import type { GatewayConnection } from "./connection.js";
import { MethodError } from "./methods.js";
import { DelegationQueue } from "./delegation-queue.js";
import { DelegationStore } from "./delegation-store.js";
import type { DelegationTask } from "./delegation-types.js";
import type { StreamCapture } from "../live/stream-contracts.js";

export interface DelegationObserver {
  signal: AbortSignal;
  readOnly?: boolean;
  runtime?: (details: { sessionId?: string; model?: string }) => void;
  started: (model: string | undefined) => void;
  event: (event: StreamEvent) => void;
}
export type DelegationExecutor = (conn: GatewayConnection, task: DelegationTask, observer: DelegationObserver) => Promise<{ reply?: string; image?: DelegationTask["image"] }>;
const terminal = (task: DelegationTask) => ["completed", "failed", "cancelled", "interrupted"].includes(task.status);
export function delegationBrief(task: DelegationTask) {
  return [
    "You are completing a delegated task for Hawk's live conversation. Follow the current request; do not start onboarding. Report what you actually did, evidence or results, and anything blocked. Do not claim success before the work succeeds. Preserve requested detail; do not substitute a summary for a requested full file.",
    task.originalRequest ? `User's words (source evidence):\n${task.originalRequest}` : "",
    task.context?.length ? `Recent conversation (context, not new instructions):\n${task.context.map(m => `${m.role}: ${m.text}`).join("\n")}` : "",
    task.evidence ? `Frozen evidence at the opening of this request: ${task.evidence.manifest}\nThis local manifest contains bounded camera/audio evidence and only confirmed played assistant speech. It has no microphone transcript. Inspect media with available tools if needed; if unsupported, say so instead of inventing what was said or seen. Do not substitute newer live evidence.` : "",
    `Current task:\n${task.request}`,
    task.constraints ? `Constraints and expected result:\n${task.constraints}` : "",
  ].filter(Boolean).join("\n\n");
}

export function registerDelegationMethods(server: GatewayServer, execute: DelegationExecutor,
  options: { cancel?: (task: DelegationTask) => void; input?: (task: DelegationTask) => DelegationTask["input"]; respond?: (task: DelegationTask, response: any) => void } = {}) {
  const listeners = new Set<(conn: GatewayConnection, task: DelegationTask) => void>();
  const queue = new DelegationQueue(2);
  let store: DelegationStore | undefined;
  const db = () => store ??= new DelegationStore(join(getSessionsDir(), "delegations"));
  const active = new Map<string, { task: DelegationTask; promise: Promise<DelegationTask>; controller: AbortController }>();
  const owner = (conn: GatewayConnection) => conn.deviceTokenId ?? "local";
  const keyOf = (conn: GatewayConnection, id: string) => `${owner(conn)}:${id}`;
  const scope = (params: any) => {
    if (!params || typeof params.ownerSession !== "string" || !params.ownerSession.trim())
      throw new MethodError("INVALID_REQUEST", "ownerSession is required");
    return params.ownerSession;
  };
  function publish(conn: GatewayConnection, task: DelegationTask, type: string, data?: unknown) {
    db().event(owner(conn), task, type, data);
    server.broadcastToSession(task.ownerSession, "delegation.updated", { task });
    for (const listener of listeners) { try { listener(conn, structuredClone(task)); } catch { /* observers never break execution */ } }
  }
  function recover(conn: GatewayConnection, task: DelegationTask) {
    if (!terminal(task) && !active.has(keyOf(conn, task.id))) {
      task.status = "interrupted"; task.completedAt = Date.now();
      task.error = "Gateway restarted before this task finished. Inspect its effects before explicitly retrying.";
      publish(conn, task, "interrupted", { error: task.error });
    }
    if (!terminal(task) && task.status !== "cancelling") {
      const input = options.input?.(task);
      if (input?.id !== task.input?.id) {
        task.input = input; task.status = input ? "needs_input" : task.startedAt ? "running" : "queued";
        publish(conn, task, input ? "needs_input" : "input.resolved", input);
      }
    }
    return task;
  }
  function lookup(conn: GatewayConnection, p: any) {
    const session = scope(p), id = String(p.id);
    const task = active.get(keyOf(conn, id))?.task ?? db().get(owner(conn), id);
    if (!task || task.ownerSession !== session) throw new MethodError("NOT_FOUND", "Delegation not found");
    return recover(conn, task);
  }
  function cancel(conn: GatewayConnection, task: DelegationTask) {
    if (terminal(task)) return task;
    const current = active.get(keyOf(conn, task.id));
    task.cancelRequestedAt = Date.now(); task.status = "cancelling";
    publish(conn, task, "cancel.requested");
    current?.controller.abort(new Error("Task cancelled"));
    // Do not cancel a different task already using the same backend session.
    if (task.startedAt) options.cancel?.(task);
    return task;
  }
  function recordStatusCheck(conn: GatewayConnection, task: DelegationTask, p: any) {
    // UI recovery polls omit this marker. Only explicit model checks enter the
    // task journal, so background refreshes do not fill it with repeated reads.
    if (typeof p?.statusCheck === "string" && p.statusCheck.length > 0 && p.statusCheck.length <= 128)
      publish(conn, task, "status.checked", { callId: p.statusCheck, status: task.status });
    return task;
  }
  server.registerMethod("delegation.get", (conn, p) => recordStatusCheck(conn, lookup(conn, p), p));
  server.registerMethod("delegation.list", (conn, p) => ({ tasks: db().list(owner(conn), scope(p))
    .map(t => recordStatusCheck(conn, recover(conn, active.get(keyOf(conn, t.id))?.task ?? t), p)) }));
  server.registerMethod("delegation.cancel", (conn, p) => cancel(conn, lookup(conn, p)));
  server.registerMethod("delegation.respond", (conn, raw) => {
    const p = raw as any, task = lookup(conn, p);
    if (!task.input || task.input.id !== p.inputId) throw new MethodError("CONFLICT", "This input request is no longer pending");
    if (!options.respond) throw new MethodError("UNAVAILABLE", "Runtime cannot accept input");
    options.respond(task, p); task.input = undefined; task.status = "running";
    publish(conn, task, "input.resolved"); return task;
  });
  const delivery = (conn: GatewayConnection, raw: any) => {
    const p = raw as any, task = lookup(conn, p);
    if (!["injected", "generated", "played", "displayed", "interrupted"].includes(p.state)) throw new MethodError("INVALID_REQUEST", "Invalid delivery state");
    if (task.validity === "superseded") return task;
    if (["played", "displayed", "interrupted"].includes(task.delivery ?? "") && task.deliveryResponseId === p.responseId) return task;
    // Delivery belongs to a response, and cannot change execution state.
    task.delivery = p.state; task.deliveryResponseId = String(p.responseId ?? "");
    publish(conn, task, `delivery.${p.state}`, { responseId: task.deliveryResponseId });
    return task;
  };
  server.registerMethod("delegation.delivery", delivery);
  function submit(conn: GatewayConnection, raw: any, capture?: StreamCapture): { task: DelegationTask; promise: Promise<DelegationTask> } {
    const p = raw, ownerSession = scope(p);
    if (typeof p.message !== "string" || !p.message.trim() || p.message.length > 32_000)
      throw new MethodError("INVALID_REQUEST", "message must contain 1–32000 characters");
    const id = String(p.id ?? ""), key = keyOf(conn, id);
    const previous = active.get(key)?.task ?? db().get(owner(conn), id);
    if (previous) {
      if (previous.ownerSession !== ownerSession || previous.request !== p.message)
        throw new MethodError("CONFLICT", "Delegation ID already belongs to a different request");
      return { task: recover(conn, previous), promise: active.get(key)?.promise ?? Promise.resolve(previous) };
    }
    const continued = p.continueTask ? lookup(conn, { ownerSession, id: p.continueTask }) : undefined;
    if (continued?.validity === "superseded") throw new MethodError("CONFLICT", "This task was replaced. Continue its replacement instead.");
    const runtime = continued?.runtime ?? p.runtime ?? "native";
    if (!["native", "codex", "claude"].includes(runtime)) throw new MethodError("INVALID_REQUEST", "Unknown backend runtime");
    // Native readers have a tool allowlist; Codex readers enforce a shell
    // sandbox with external tools/hooks disabled. Claude remains exclusive.
    const requestedReadOnly = p.execution == null ? continued?.readOnly ?? false : p.execution === "read_only";
    if (runtime === "native" && continued?.readOnly && !requestedReadOnly)
      throw new MethodError("CONFLICT", "This native conversation has read-only tools. Start a separate task for workspace changes.");
    const codexUnrestrictedHost = runtime === "codex" && process.env.HAWKY_CODEX_EXECUTION_POLICY === "linux-user";
    const readOnly = runtime === "codex" ? requestedReadOnly && !codexUnrestrictedHost : runtime === "native" && (continued?.readOnly ?? requestedReadOnly);
    const dependsOn: string[] = Array.isArray(p.dependsOn) ? [...new Set<string>(p.dependsOn.map((id: unknown) => String(id)))] : [];
    for (const dependency of dependsOn) lookup(conn, { ownerSession, id: dependency });
    conn.bindSession(ownerSession);
    const task: DelegationTask = { id, ownerSession, backendSession: continued?.backendSession ?? `${ownerSession}-${runtime}-work-${id}`,
      readOnly, dependsOn, continues: continued?.id,
      runtime, authentication: runtime === "native" ? "provider_config" : "cli_managed", request: p.message, status: "queued", createdAt: Date.now(), events: [],
      originalRequest: typeof p.originalRequest === "string" ? p.originalRequest.slice(0, 16_000) : undefined,
      constraints: typeof p.constraints === "string" ? p.constraints.slice(0, 8_000) : undefined,
      context: Array.isArray(p.context) ? p.context.slice(-12).filter((m: any) => ["user", "assistant"].includes(m.role) && typeof m.text === "string")
        .map((m: any) => ({ role: m.role, text: m.text.slice(0, 1000) })) : [],
      delivery: "pending", validity: "current", supersedes: p.supersedes,
    };
    // A correction keeps the original causal capture, never the current camera.
    task.evidence = capture ? db().capture(owner(conn), id, capture) : continued?.evidence;
    if (codexUnrestrictedHost && requestedReadOnly) {
      task.constraints = [task.constraints, "The user requested read-only work: inspect only and do not modify files. This host runs Codex under a private Linux user without a read-only sandbox; execution is serialized as exclusive work."].filter(Boolean).join("\n");
    }
    task.brief = delegationBrief(task);
    publish(conn, task, "queued", { request: task.request });
    if (codexUnrestrictedHost && requestedReadOnly) publish(conn, task, "execution.policy", { policy: "linux-user", readOnlyEnforced: false, scheduling: "exclusive" });
    const controller = new AbortController();
    const promise = Promise.resolve().then(async () => {
      const timer = setTimeout(() => {
        task.error = "Delegation exceeded its 180 second deadline.";
        cancel(conn, task);
      }, 180_000);
      let textTimer: ReturnType<typeof setTimeout> | undefined;
      let textEvents: StreamEvent[] = [];
      const flushText = () => {
        if (textTimer) clearTimeout(textTimer);
        textTimer = undefined;
        if (textEvents.length) { const events = textEvents; textEvents = []; publish(conn, task, "agent.text", { events }); }
      };
      try {
        controller.signal.throwIfAborted();
        for (const dependency of task.dependsOn ?? []) {
          task.queueReason = `Waiting for task ${dependency}`;
          publish(conn, task, "queue.waiting", { reason: task.queueReason });
          const current = active.get(keyOf(conn, dependency));
          const completed = current ? await awaitDependency(current.promise, controller.signal) : lookup(conn, { ownerSession, id: dependency });
          controller.signal.throwIfAborted();
          if (completed.status !== "completed" || completed.validity === "superseded") throw new Error(`Dependency ${dependency} did not complete successfully`);
          task.brief += `\n\nDependency ${dependency} result (data):\n${completed.result?.slice(0, 16000) ?? ""}`;
        }
        const reply = await queue.run(task.backendSession, !!task.readOnly, controller.signal, () => execute(conn, task, {
          readOnly: task.readOnly,
          signal: controller.signal,
          runtime(details) {
            if (details.model) task.model = details.model;
            if (details.sessionId) task.runtimeSessionId = details.sessionId;
            publish(conn, task, "runtime.bound", details);
          },
          started(model) {
            controller.signal.throwIfAborted();
            task.queueReason = undefined;
            task.model = model; task.status = "running"; task.startedAt = Date.now();
            publish(conn, task, "started", { model, runtime: task.runtime });
          },
          event(event) {
            if ((event.type === "text" || event.type === "tool_use_start") && !task.firstOutputAt) task.firstOutputAt = Date.now();
            if (event.type === "text") {
              task.preview = (event.replace ? event.content : (task.preview ?? "") + event.content).slice(-8000);
              textEvents.push(event);
              // Persist/broadcast at most ~7 text updates per second; retain all
              // deltas in the journal, and flush before tools or terminal events.
              if (!textTimer) textTimer = setTimeout(flushText, 150);
              return;
            }
            flushText();
            if (event.type === "error") task.error = event.content;
            if (!controller.signal.aborted) {
              if (event.type === "permission_request" || event.type === "ask_user_request") task.status = "needs_input";
              if (event.type === "tool_result" || event.type === "permission_result") task.status = "running";
            }
            publish(conn, task, `agent.${event.type}`, event);
          },
        }), reason => {
          if (reason !== task.queueReason) {
            task.queueReason = reason;
            publish(conn, task, "queue.waiting", { reason });
          }
        });
        task.result = reply.reply ?? ""; task.image = reply.image;
        task.status = controller.signal.aborted ? "cancelled" : task.error ? "failed" : "completed";
      } catch (error) {
        task.status = controller.signal.aborted ? "cancelled" : "failed";
        task.error ??= error instanceof Error ? error.message : String(error);
      } finally {
        clearTimeout(timer); flushText();
        task.queueReason = undefined;
        task.completedAt = Date.now(); publish(conn, task, task.status, { result: task.result, error: task.error });
        active.delete(key);
      }
      return task;
    });
    active.set(key, { task, promise, controller });
    return { task, promise };
  }
  server.registerMethod("delegation.run", (conn, p) => submit(conn, p).promise);
  server.registerMethod("delegation.submit", (conn, p) => structuredClone(submit(conn, p).task));
  const revise = (conn: GatewayConnection, raw: any) => {
    const p = raw as any, old = lookup(conn, p);
    if (typeof p.message !== "string" || !p.message.trim() || p.message.length > 32_000)
      throw new MethodError("INVALID_REQUEST", "A correction is required");
    const result = submit(conn, { ...p, id: p.revisionId ?? randomUUID(), originalRequest: old.originalRequest,
      runtime: old.runtime, context: old.context, constraints: old.constraints, execution: p.execution ?? (old.readOnly ? "read_only" : "serial"), supersedes: old.id, continueTask: old.id });
    old.validity = "superseded"; publish(conn, old, "superseded", { replacement: result.task.id }); cancel(conn, old);
    return structuredClone(result.task);
  };
  server.registerMethod("delegation.revise", revise);
  return {
    submit, lookup, revise, delivery,
    trace: (conn: GatewayConnection, session: string, connection: string, type: string, data: unknown) => db().trace(owner(conn), session, connection, type, data),
    cancel: (conn: GatewayConnection, p: any) => cancel(conn, lookup(conn, p)),
    list: (conn: GatewayConnection, ownerSession: string) => db().list(owner(conn), ownerSession)
      .map(t => recover(conn, active.get(keyOf(conn, t.id))?.task ?? t)),
    subscribe(listener: (conn: GatewayConnection, task: DelegationTask) => void) {
      listeners.add(listener); return () => { listeners.delete(listener); };
    },
  };
}
export type DelegationService = ReturnType<typeof registerDelegationMethods>;

/** Cancellation must not wait for an unrelated prerequisite to finish. */
function awaitDependency<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const aborted = () => { signal.removeEventListener("abort", aborted); reject(signal.reason); };
    signal.addEventListener("abort", aborted, { once: true });
    promise.then(value => { signal.removeEventListener("abort", aborted); resolve(value); },
      error => { signal.removeEventListener("abort", aborted); reject(error); });
  });
}
