import { randomUUID } from "node:crypto";
import type { ConversationTurn } from "./contracts.js";
import { GptLiveTranscript, type LiveCaption } from "./gpt-live-transcript.js";
import type { LiveRoute, RoutingSnapshot } from "./gpt-live-router.js";
import type { DelegationTask, DelegationRuntime } from "../gateway/delegation-types.js";

export interface LiveTaskPort {
  list(): DelegationTask[];
  submit(params: Record<string, unknown>): DelegationTask;
  cancel(id: string): DelegationTask;
  revise(id: string, message: string, revisionId: string): DelegationTask;
  injected(id: string, eventId: string): void;
}
const finished = (t: DelegationTask) => ["completed", "failed", "cancelled", "interrupted"].includes(t.status);
// <=500 UTF-8 bytes is also safely below the 500-token protocol limit, including CJK.
export function liveSnippet(text: string, bytes = 440): string {
  let result = "", size = 0;
  for (const char of text) { size += new TextEncoder().encode(char).length; if (size > bytes) return result + "…"; result += char; }
  return result;
}
/** One server-side owner dispatches tasks and injects updates. Browser events are
 * captions only. Backend execution survives this connection's disposal.
 */
export class GptLiveCoordinator {
  readonly transcript: GptLiveTranscript;
  private closed = false;
  private startedAt = Date.now();
  private submitted = new Set<string>();
  private heardUser = false;
  private seen = new Set<string>();
  private pending = new Map<string, DelegationTask>();
  private delivered = new Set<string>();
  private acknowledgements = new Map<string, string>();
  private bindings = new Map<string, string>();
  private timer?: ReturnType<typeof setTimeout>;
  private flushTimer?: ReturnType<typeof setTimeout>;
  private requests: Array<{ id: string; at: number }> = [];
  private routing = false;
  private abort = new AbortController();
  constructor(private options: {
    id: string; runtime: DelegationRuntime; history: ConversationTurn[]; bridge: boolean;
    send: (event: Record<string, unknown>) => void;
    tasks: LiveTaskPort;
    route: (snapshot: RoutingSnapshot, signal: AbortSignal) => Promise<LiveRoute>;
    persist: (caption: LiveCaption) => void;
    error: (message: string) => void;
  }) {
    this.transcript = new GptLiveTranscript(options.id, () => {}, options.persist);
  }
  observe(e: any) {
    if (this.closed) return;
    if (e.type === "session.output_transcript.delta" && !this.heardUser) return;
    if (this.transcript.accept(e)) {
      clearTimeout(this.flushTimer); this.flushTimer = setTimeout(() => this.transcript.flush(), 2000);
      if (e.type === "session.input_transcript.delta") {
        this.heardUser = true;
        this.schedule();
        for (const task of this.pending.values()) this.deliver(task, true);
        this.pending.clear();
      }
    }
    if (e.type === "session.delegation.created" && e.delegation?.id && !this.seen.has(e.delegation.id)) {
      this.seen.add(e.delegation.id);
      this.requests.push({ id: e.delegation.id, at: Date.now() }); this.schedule();
    }
    if (e.type === "session.commentary.appended" || e.type === "session.thinking.appended") {
      const task = this.acknowledgements.get(e.client_event_id);
      if (task) { this.options.tasks.injected(task, e.client_event_id); this.acknowledgements.delete(e.client_event_id); }
    }
    if (e.type === "error") this.options.error(e.error?.message ?? "GPT-Live rejected an update");
  }
  restore() {
    // Historical tasks inform the model but do not announce themselves on reconnect.
    for (const task of this.options.tasks.list().filter(t => t.validity !== "superseded").slice(-12)) this.deliver(task, false);
  }
  update(task: DelegationTask) {
    if (this.closed) return;
    if (task.validity === "superseded") {
      this.pending.delete(task.id);
      this.append("thinking", `Task ${task.id} is superseded. Ignore its previous result.`, this.bindings.get(task.id));
    } else if (finished(task) && !this.delivered.has(task.id)) {
      if (!this.heardUser) this.pending.set(task.id, task);
      else this.deliver(task, true);
    } else if (task.status === "needs_input") {
      this.append("thinking", `Task needs user input in its task card: ${liveSnippet(task.input?.prompt ?? "")}`, this.bindings.get(task.id));
    }
  }
  async typed(text: string) {
    if (this.closed || !text.trim() || text.length > 8000) throw new Error("A message of 1–8000 characters is required");
    this.heardUser = true;
    this.append("thinking", `User typed (reference data; backend is handling it): ${liveSnippet(text, 350)}`);
    for (const task of this.pending.values()) this.deliver(task, true);
    this.pending.clear();
    // Treat typed input exactly as user evidence; it still runs through task routing.
    this.transcript.accept({ type: "session.input_transcript.delta", event_id: randomUUID(), delta: text, start_ms: Date.now() - this.startedAt, end_ms: Date.now() - this.startedAt });
    this.transcript.flush();
    this.requests.push({ id: "", at: Date.now() });
    await this.routeNext();
  }
  close() {
    this.closed = true; clearTimeout(this.timer); clearTimeout(this.flushTimer);
    this.abort.abort(); this.transcript.flush();
  }
  private schedule() {
    if (!this.requests.length || this.routing) return;
    clearTimeout(this.timer);
    // Briefly allow late transcript fragments; never block forever on a network pause.
    this.timer = setTimeout(() => void this.routeNext(), Math.max(0, Math.min(700, 2500 - (Date.now() - this.requests[0].at))));
  }
  private async routeNext() {
    if (this.closed || this.routing || !this.requests.length) return;
    this.routing = true;
    const request = this.requests.shift()!;
    let actionsApplied = 0;
    try {
      if (!this.options.bridge) { this.append("commentary", "The backend bridge is disabled. No task was started.", request.id); return; }
      let route: LiveRoute | undefined;
      let context: ConversationTurn[] = [];
      for (let attempt = 0; attempt < 3; attempt++) {
        const revision = this.transcript.userRevision;
        context = [...this.options.history, ...this.transcript.snapshot()].slice(-20);
        if (!context.some(t => t.role === "user" && t.text.trim())) throw new Error("No user transcript available for this task. Please repeat the request.");
        route = await this.options.route({ conversation: context, tasks: this.options.tasks.list() }, this.abort.signal);
        if (this.closed) return;
        if (revision === this.transcript.userRevision) break;
        route = undefined; // A correction arrived while interpreting; never execute the stale plan.
      }
      if (!route) throw new Error("The request changed while being interpreted. Please finish the request and try again.");
      const current = new Map(this.options.tasks.list().map(t => [t.id, t]));
      // Validate the entire plan before performing any action.
      for (const action of route.actions) {
        if (!["submit", "cancel", "revise", "status"].includes(action.action)) throw new Error("Unknown task action");
        if ((action.action !== "submit" || action.taskId) && !current.has(action.taskId)) throw new Error("The referenced task is unavailable. Please choose it in the task card.");
        if (["submit", "revise"].includes(action.action) && (!action.request.trim() || action.request.length > 32000)) throw new Error("The task request is incomplete");
      }
      if (route.clarification) { this.append("commentary", route.clarification, request.id); return; }
      for (const action of route.actions) {
        const fingerprint = `${this.transcript.userRevision}:${JSON.stringify(action)}`;
        if (this.submitted.has(fingerprint)) continue;
        this.submitted.add(fingerprint);
        let task: DelegationTask;
        if (action.action === "cancel") task = this.options.tasks.cancel(action.taskId);
        else if (action.action === "revise") task = this.options.tasks.revise(action.taskId, action.request, randomUUID());
        else if (action.action === "status") task = current.get(action.taskId)!;
        else task = this.options.tasks.submit({ id: randomUUID(), message: action.request, runtime: this.options.runtime,
          originalRequest: context.filter(t => t.role === "user").slice(-3).map(t => t.text).join("\n"), context,
          execution: action.readOnly ? "read_only" : "serial", continueTask: action.taskId || undefined });
        actionsApplied++;
        if (request.id) this.bindings.set(task.id, request.id);
        if (action.action === "status") this.deliver(task, true, true);
        else this.append("thinking", `Task ${task.id}: ${task.status}. ${liveSnippet(task.request, 220)}. Completion will arrive automatically; do not poll.`, request.id);
      }
    } catch (error) {
      if (!this.closed) {
        const message = error instanceof Error ? error.message : String(error);
        this.options.error(message); this.append("commentary", `${actionsApplied ? "Some task actions succeeded, but the next action failed" : "No new task was started"}: ${liveSnippet(message, 300)}`, request.id);
      }
    } finally { this.routing = false; this.schedule(); }
  }
  private deliver(task: DelegationTask, speak: boolean, force = false) {
    if (this.closed || task.validity === "superseded" || (!force && speak && this.delivered.has(task.id))) return;
    const result = task.result || task.error || task.request;
    const content = `Backend task ${task.status}. ${liveSnippet(result, 330)}${result.length > 330 ? " Full details are in its task card." : ""}`;
    const id = this.append(speak ? "commentary" : "thinking", content, this.bindings.get(task.id));
    if (speak && finished(task)) { this.delivered.add(task.id); this.acknowledgements.set(id, task.id); }
  }
  private append(kind: "thinking" | "commentary", content: string, delegation?: string) {
    const event_id = randomUUID();
    this.options.send({ type: `session.${kind}.append`, event_id, delegation_id: delegation || null, content: liveSnippet(content, 480) });
    return event_id;
  }
}
