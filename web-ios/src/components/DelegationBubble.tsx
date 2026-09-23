import type { DelegationTask } from "../../../src/gateway/delegation-types";

export function DelegationBubble({ task }: { task: DelegationTask }) {
  const duration = task.completedAt ? `${((task.completedAt - task.createdAt) / 1000).toFixed(1)}s` : "";
  return <details className="my-2 w-full max-w-2xl rounded-card border border-white/15 bg-white/5 p-3">
    <summary className="cursor-pointer text-sm">
      <span className="font-medium">Backend task</span>
      <span className="ml-2 text-white/60">{task.status} {duration}</span>
      <span className="mt-1 block truncate text-white/70">{task.request}</span>
    </summary>
    <div className="mt-3 space-y-3 break-words text-xs">
      <p>{task.runtime} · {task.model || "Model reported by runtime when available"}</p>
      <div><strong>Request</strong><p className="mt-1 whitespace-pre-wrap">{task.request}</p></div>
      <p className="text-white/50">Task: {task.id}<br />Session: {task.backendSession}</p>
      <ol className="max-h-64 space-y-2 overflow-y-auto">
        {task.events.filter(e => e.type !== "agent.text").map(e => <li key={e.seq}>
          <span className="text-white/60">+{((e.at - task.createdAt) / 1000).toFixed(1)}s · {e.type}</span>
          {e.data != null && <pre className="whitespace-pre-wrap break-words font-mono text-[11px]">{JSON.stringify(e.data, null, 2)}</pre>}
        </li>)}
      </ol>
      {task.result && <div><strong>Backend answer</strong><p className="mt-1 whitespace-pre-wrap">{task.result}</p></div>}
      {task.error && <p role="alert" className="text-danger">{task.error}</p>}
      {task.status === "completed" && <p className="text-white/50">Backend turn finished. This does not confirm the answer has been spoken.</p>}
    </div>
  </details>;
}
