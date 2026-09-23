import { join } from "node:path";
import { getSessionsDir } from "../storage/session.js";
import type { StreamEvent } from "../agent/types.js";
import type { GatewayServer } from "./server.js";
import type { GatewayConnection } from "./connection.js";
import { MethodError } from "./methods.js";
import { DelegationStore } from "./delegation-store.js";
import type { DelegationTask } from "./delegation-types.js";

export interface DelegationObserver {
  started: (model: string | undefined) => void;
  event: (event: StreamEvent) => void;
}
export type DelegationExecutor = (conn: GatewayConnection, task: DelegationTask, observer: DelegationObserver) => Promise<{ reply?: string; image?: DelegationTask["image"] }>;

export function registerDelegationMethods(server: GatewayServer, execute: DelegationExecutor) {
  // Lazy so changing the configured state directory before startup is respected.
  let store: DelegationStore | undefined;
  const db = () => store ??= new DelegationStore(join(getSessionsDir(), "delegations"));
  const active = new Map<string, Promise<DelegationTask>>();
  const owner = (conn: GatewayConnection) => conn.deviceTokenId ?? "local";
  const scope = (params: any) => {
    if (!params || typeof params.ownerSession !== "string" || !params.ownerSession.trim())
      throw new MethodError("INVALID_REQUEST", "ownerSession is required");
    return params.ownerSession;
  };
  const lookup = (conn: GatewayConnection, p: any) => {
    const session = scope(p);
    const task = db().get(owner(conn), String(p.id));
    if (!task || task.ownerSession !== session) throw new MethodError("NOT_FOUND", "Delegation not found");
    return task;
  };
  function publish(conn: GatewayConnection, task: DelegationTask, type: string, data?: unknown) {
    db().event(owner(conn), task, type, data);
    server.broadcastToSession(task.ownerSession, "delegation.updated", { task });
  }
  server.registerMethod("delegation.get", (conn, p) => lookup(conn, p));
  server.registerMethod("delegation.list", (conn, p) => ({ tasks: db().list(owner(conn), scope(p)) }));
  server.registerMethod("delegation.run", async (conn, raw) => {
    const p = raw as any;
    const ownerSession = scope(p);
    if (typeof p.message !== "string" || !p.message.trim() || p.message.length > 32_000)
      throw new MethodError("INVALID_REQUEST", "message must contain 1–32000 characters");
    const id = String(p.id ?? "");
    const key = `${owner(conn)}:${id}`;
    const previous = db().get(owner(conn), id);
    if (previous) {
      if (previous.ownerSession !== ownerSession || previous.request !== p.message)
        throw new MethodError("CONFLICT", "Delegation ID already belongs to a different request");
      return active.get(key) ?? previous;
    }
    conn.bindSession(ownerSession);
    const task: DelegationTask = { id, ownerSession, backendSession: `${ownerSession}-bridge`,
      runtime: "native", request: p.message, status: "queued", createdAt: Date.now(), events: [] };
    publish(conn, task, "queued", { request: task.request });
    const promise = (async () => {
      try {
        const reply = await execute(conn, task, {
          started(model) {
            task.model = model; task.status = "running"; task.startedAt = Date.now();
            publish(conn, task, "started", { model, runtime: task.runtime });
          },
          event(event) {
            if ((event.type === "text" || event.type === "tool_use_start") && !task.firstOutputAt) task.firstOutputAt = Date.now();
            if (event.type === "error") task.error = event.content;
            if (event.type === "permission_request" || event.type === "ask_user_request") task.status = "needs_input";
            if (event.type === "tool_result" || event.type === "permission_result") task.status = "running";
            publish(conn, task, `agent.${event.type}`, event);
          },
        });
        task.result = reply.reply ?? "";
        task.image = reply.image;
        task.status = task.error ? "failed" : "completed";
      } catch (error) {
        task.status = "failed"; task.error = error instanceof Error ? error.message : String(error);
      } finally {
        task.completedAt = Date.now();
        publish(conn, task, task.status, { result: task.result, error: task.error });
        active.delete(key);
      }
      return task;
    })();
    active.set(key, promise);
    return promise;
  });
}
