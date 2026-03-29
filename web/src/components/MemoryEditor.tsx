// =============================================================================
// Memory Editor
//
// File browser for workspace memory files. Shows a list of workspace files
// (MEMORY.md, SOUL.md, etc.) and daily logs. Tapping a file opens it in
// MemoryFileView for viewing (rendered markdown) or editing (textarea).
// =============================================================================

import { useState, useEffect } from "react";
import { useSocketStore } from "../store/socket-store";
import { MemoryFileView } from "./MemoryFileView";

interface WorkspaceFile {
  name: string;
  path: string;
  editable: boolean;
  size: number;
}

export function MemoryEditor({ onClose }: { onClose: () => void }) {
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedFile, setSelectedFile] = useState<WorkspaceFile | null>(null);
  const rpc = useSocketStore((s) => s.rpc);
  const status = useSocketStore((s) => s.status);

  // Fetch file list
  useEffect(() => {
    if (status !== "connected") return;

    setLoading(true);
    void (async () => {
      try {
        const result = (await rpc("workspace.list", {})) as { files: WorkspaceFile[] };
        setFiles(result.files);
      } catch {
        setFiles([]);
      } finally {
        setLoading(false);
      }
    })();
  }, [status, rpc]);

  // If a file is selected, show the file view
  if (selectedFile) {
    return (
      <MemoryFileView
        path={selectedFile.path}
        editable={selectedFile.editable}
        onBack={() => setSelectedFile(null)}
      />
    );
  }

  // Separate workspace files from daily logs
  const workspaceFiles = files.filter((f) => !f.path.startsWith("memory/"));
  const dailyLogs = files.filter((f) => f.path.startsWith("memory/"));

  return (
    <div className="flex flex-col h-full">
      {/* File list */}
      <div className="flex-1 overflow-y-auto" data-testid="memory-file-list">
        {loading ? (
          <div className="flex items-center justify-center h-32 text-gray-400">
            Loading...
          </div>
        ) : files.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-gray-400">
            No workspace files found
          </div>
        ) : (
          <>
            {/* Workspace files */}
            {workspaceFiles.length > 0 && (
              <div className="px-3 py-2">
                <p className="text-xs font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wider px-1 mb-1">
                  Workspace
                </p>
                {workspaceFiles.map((file) => (
                  <FileRow key={file.path} file={file} onClick={() => setSelectedFile(file)} />
                ))}
              </div>
            )}

            {/* Daily logs */}
            {dailyLogs.length > 0 && (
              <div className="px-3 py-2">
                <p className="text-xs font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wider px-1 mb-1">
                  Daily Logs
                </p>
                {dailyLogs.map((file) => (
                  <FileRow key={file.path} file={file} onClick={() => setSelectedFile(file)} />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function FileRow({ file, onClick }: { file: WorkspaceFile; onClick: () => void }) {
  const sizeStr = file.size < 1024
    ? `${file.size} B`
    : file.size < 1024 * 1024
      ? `${(file.size / 1024).toFixed(1)} KB`
      : `${(file.size / (1024 * 1024)).toFixed(1)} MB`;

  const isDaily = file.path.startsWith("memory/");

  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-2 px-2 py-2 rounded-md text-left hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
    >
      <span className="text-sm shrink-0">
        {isDaily ? "📅" : file.editable ? "📝" : "📄"}
      </span>
      <span className="text-sm text-gray-700 dark:text-gray-300 flex-1 truncate">
        {file.name}
      </span>
      {!file.editable && (
        <span className="text-xs text-gray-400" title="Read-only">🔒</span>
      )}
      <span className="text-xs text-gray-400 dark:text-gray-500 shrink-0">
        {sizeStr}
      </span>
    </button>
  );
}
