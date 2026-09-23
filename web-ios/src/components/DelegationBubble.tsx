import type { DelegationTask } from "../../../src/gateway/delegation-types";
import { useState } from "react";
import { useSocketStore } from "../lib/socket-store";

export function DelegationBubble({ task, image, onImageClick }: { task: DelegationTask; image?: string; onImageClick?: () => void }) {
  const rpc = useSocketStore(s => s.rpc);
  const [error, setError] = useState("");
  const [correction, setCorrection] = useState("");
  const [answer, setAnswer] = useState("");
  async function respond(decision?: string) {
    try { await rpc("delegation.respond", { ownerSession: task.ownerSession, id: task.id, inputId: task.input?.id, decision, answer }); setError(""); }
    catch (e) { setError(String(e)); }
  }
  async function control(action: "cancel" | "revise") {
    try {
      await rpc(`delegation.${action}`, { ownerSession: task.ownerSession, id: task.id, message: correction, revisionId: crypto.randomUUID() });
      setError(""); setCorrection("");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }
  const duration = task.completedAt ? `${((task.completedAt - task.createdAt) / 1000).toFixed(1)}s` : "";
  return <details className="my-2 w-full max-w-2xl rounded-card border border-white/15 bg-white/5 p-3">
    <summary className="cursor-pointer text-sm">
      <span className="font-medium">Backend task</span>
      <span className="ml-2 text-white/60">{task.status} {duration}</span>
      <span className="mt-1 block truncate text-white/70">{task.request}</span>
    </summary>
    <div className="mt-3 space-y-3 break-words text-xs">
      <p>{task.runtime} · {task.model || "Model reported by runtime when available"}</p>
      <p>{task.authentication === "cli_managed" ? "Authentication managed by the local CLI" : "Authentication from the gateway provider configuration"}</p>
      {task.runtimeSessionId && <p>Runtime conversation: {task.runtimeSessionId}</p>}
      <div><strong>Request</strong><p className="mt-1 whitespace-pre-wrap">{task.request}</p></div>
      {task.originalRequest && <div><strong>Your words</strong><p className="whitespace-pre-wrap">{task.originalRequest}</p></div>}
      {task.brief && <details><summary className="cursor-pointer">Exact backend brief</summary><pre className="whitespace-pre-wrap">{task.brief}</pre></details>}
      <p className="text-white/50">Task: {task.id}<br />Session: {task.backendSession}</p>
      <p>Result: {task.validity ?? "current"} · Delivery: {task.delivery ?? "pending"}</p>
      {task.input && <div className="rounded border border-amber-400/40 p-3">
        <strong>{task.input.prompt}</strong>
        <pre className="whitespace-pre-wrap">{JSON.stringify(task.input.detail, null, 2)}</pre>
        {task.input.kind === "permission" ? <div className="flex gap-4">
          <button onClick={() => void respond("allow_once")}>Allow once</button><button onClick={() => void respond("deny")}>Deny</button>
        </div> : <form onSubmit={e => { e.preventDefault(); void respond(); }}>
          <input aria-label="Answer backend question" className="rounded bg-black/20 p-2" value={answer} onChange={e => setAnswer(e.target.value)} /><button className="p-2">Answer</button>
        </form>}
      </div>}
      {["queued", "running", "needs_input"].includes(task.status) && <button className="rounded border border-white/25 px-3 py-2" onClick={() => void control("cancel")}>Cancel task</button>}
      {task.validity !== "superseded" && <form onSubmit={e => { e.preventDefault(); void control("revise"); }} className="flex gap-2">
        <input aria-label="Corrected task" className="min-w-0 flex-1 rounded bg-black/20 p-2" value={correction} onChange={e => setCorrection(e.target.value)} placeholder="Write the corrected task…" />
        <button disabled={!correction.trim()} className="rounded border border-white/25 px-3 py-2 disabled:opacity-40">Revise task</button>
      </form>}
      {error && <p role="alert">{error}</p>}
      <ol className="max-h-64 space-y-2 overflow-y-auto">
        {task.events.filter(e => e.type !== "agent.text").map(e => <li key={e.seq}>
          <span className="text-white/60">+{((e.at - task.createdAt) / 1000).toFixed(1)}s · {e.type}</span>
          {e.data != null && <pre className="whitespace-pre-wrap break-words font-mono text-[11px]">{JSON.stringify(e.data, null, 2)}</pre>}
        </li>)}
      </ol>
      {task.result && <div><strong>Backend answer</strong><p className="mt-1 whitespace-pre-wrap">{task.result}</p></div>}
      {image && <button aria-label="Zoom backend image" onClick={onImageClick}><img src={image} alt="Backend result" className="max-h-64 rounded object-contain" /></button>}
      {task.error && <p role="alert" className="text-danger">{task.error}</p>}
      {task.status === "completed" && <p className="text-white/50">Backend turn finished. This does not confirm the answer has been spoken.</p>}
    </div>
  </details>;
}
