// =============================================================================
// Memory Screen — workspace memory viewer/editor (web-ios).
//
// Mirrors iOS LiveMemoryTestingView / the memory tiers: lists workspace files
// (SOUL.md, IDENTITY.md, MEMORY.md + memory/daily logs) via workspace.list,
// opens one with workspace.read, and saves edits with workspace.write.
// =============================================================================

import { useCallback, useEffect, useState } from "react";
import { useSocketStore } from "../lib/socket-store";
import { Header } from "../components/Header";
import { Icon } from "../components/Icon";

interface WorkspaceFile { name: string; path: string; editable: boolean; size: number }

export function MemoryScreen() {
  const rpc = useSocketStore((s) => s.rpc);
  const status = useSocketStore((s) => s.status);
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<WorkspaceFile | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = (await rpc("workspace.list", {})) as { files: WorkspaceFile[] };
      setFiles(r.files ?? []);
    } catch { setFiles([]); }
    finally { setLoading(false); }
  }, [rpc]);

  useEffect(() => { if (status === "connected") void load(); else setLoading(false); }, [status, load]);

  if (selected) return <FileView file={selected} onBack={() => setSelected(null)} />;

  const tiers = files.filter((f) => !f.path.startsWith("memory/"));
  const daily = files.filter((f) => f.path.startsWith("memory/"));

  return (
    <div className="flex h-full flex-col">
      <Header title="Memory" action={{ label: loading ? "…" : "Refresh", onClick: () => void load(), disabled: status !== "connected" }} />
      <div className="flex-1 overflow-y-auto px-4 pb-24 pt-4 md:pb-4">
        <div className="mx-auto max-w-2xl space-y-6">
          {status !== "connected" ? (
            <Empty body="Connect to the gateway to view memory." />
          ) : loading && files.length === 0 ? (
            <Empty body="Loading…" />
          ) : files.length === 0 ? (
            <Empty body="No memory files yet." />
          ) : (
            <>
              <FileGroup title="Core memory" files={tiers} onPick={setSelected} />
              {daily.length > 0 && <FileGroup title="Daily logs" files={daily} onPick={setSelected} />}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function FileGroup({ title, files, onPick }: { title: string; files: WorkspaceFile[]; onPick: (f: WorkspaceFile) => void }) {
  if (files.length === 0) return null;
  return (
    <div>
      <h2 className="mb-1.5 px-1 text-[11px] font-semibold uppercase tracking-wider text-white/40">{title}</h2>
      <ul className="overflow-hidden rounded-card bg-paper divide-y divide-white/8">
        {files.map((f) => (
          <li key={f.path}>
            <button onClick={() => onPick(f)} className="pressable flex w-full items-center justify-between px-4 py-3 text-left">
              <span className="font-mono text-sm text-white">{f.name}</span>
              <span className="flex items-center gap-2 text-xs text-white/40">{f.size}B <Icon name="chevronRight" className="h-4 w-4" /></span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function FileView({ file, onBack }: { file: WorkspaceFile; onBack: () => void }) {
  const rpc = useSocketStore((s) => s.rpc);
  const [content, setContent] = useState("");
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const r = (await rpc("workspace.read", { path: file.path })) as { content?: string };
        if (active) { setContent(r.content ?? ""); setDraft(r.content ?? ""); }
      } catch { if (active) setContent("(failed to read)"); }
      finally { if (active) setLoading(false); }
    })();
    return () => { active = false; };
  }, [file.path, rpc]);

  const save = async () => {
    setSaving(true);
    try { await rpc("workspace.write", { path: file.path, content: draft }); setContent(draft); setEditing(false); }
    catch { /* ignore */ }
    finally { setSaving(false); }
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b border-white/10 px-3 py-3">
        <button onClick={onBack} aria-label="Back" className="pressable grid h-8 w-8 place-items-center rounded-full hover:bg-white/10">
          <Icon name="chevronLeft" className="h-5 w-5 text-white/70" />
        </button>
        <h1 className="flex-1 truncate font-mono text-sm">{file.name}</h1>
        {file.editable && (editing ? (
          <button onClick={() => void save()} disabled={saving} className="pressable rounded-pill px-3 py-1.5 text-sm font-semibold text-accent disabled:opacity-40">{saving ? "Saving…" : "Save"}</button>
        ) : (
          <button onClick={() => setEditing(true)} className="pressable rounded-pill px-3 py-1.5 text-sm text-accent">Edit</button>
        ))}
      </header>
      <div className="flex-1 overflow-y-auto p-4 pb-24 md:pb-4">
        {loading ? <Empty body="Loading…" /> : editing ? (
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)}
            className="mx-auto block h-full max-w-2xl w-full resize-none rounded-card bg-paper p-4 font-mono text-sm text-white outline-none focus:ring-1 focus:ring-accent" />
        ) : (
          <pre className="mx-auto max-w-2xl whitespace-pre-wrap break-words font-mono text-sm text-white/85">{content || "(empty)"}</pre>
        )}
      </div>
    </div>
  );
}

function Empty({ body }: { body: string }) {
  return <div className="grid min-h-[200px] place-items-center text-center text-sm text-white/50">{body}</div>;
}
