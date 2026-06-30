// =============================================================================
// Global Memory Index Accessor
//
// Singleton MemoryIndex shared between tools and startup.
// =============================================================================

import { MemoryIndex } from "./index.js";

let globalIndex: MemoryIndex | null = null;
let globalIndexConfig: MemoryIndexConfig | null = null;

type MemoryIndexConfig = {
  workspacePath?: string;
  openaiApiKey?: string;
  dbPath?: string;
  sessionsPath?: string | null;
};

function hasConfigChange(current: MemoryIndexConfig, requested: MemoryIndexConfig): boolean {
  return (
    (requested.workspacePath !== undefined && requested.workspacePath !== current.workspacePath) ||
    (requested.openaiApiKey !== undefined && requested.openaiApiKey !== current.openaiApiKey) ||
    (requested.dbPath !== undefined && requested.dbPath !== current.dbPath) ||
    (requested.sessionsPath !== undefined && requested.sessionsPath !== current.sessionsPath)
  );
}

/** Get (or create) the global MemoryIndex.
 *  If callers provide identity-affecting config that differs from the existing
 *  singleton, the index is recreated instead of silently reusing a database or
 *  workspace from an earlier runtime context.
 */
export function getGlobalMemoryIndex(
  workspacePath?: string,
  openaiApiKey?: string,
  dbPath?: string,
  sessionsPath?: string | null,
): MemoryIndex {
  const requestedConfig: MemoryIndexConfig = {
    workspacePath,
    openaiApiKey,
    dbPath,
    sessionsPath,
  };

  if (globalIndex && globalIndexConfig && hasConfigChange(globalIndexConfig, requestedConfig)) {
    globalIndex.close();
    globalIndex = null;
    globalIndexConfig = null;
  }

  if (!globalIndex) {
    globalIndex = new MemoryIndex({
      workspacePath,
      enableWatcher: true,
      openaiApiKey,
      dbPath,
      sessionsPath,
    });
    globalIndexConfig = requestedConfig;
  }
  return globalIndex;
}

/** Close and reset (for testing). */
export function resetGlobalMemoryIndex(): void {
  globalIndex?.close();
  globalIndex = null;
  globalIndexConfig = null;
}
