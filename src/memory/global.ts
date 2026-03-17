// =============================================================================
// Global Memory Index Accessor
//
// Singleton MemoryIndex shared between tools and startup.
// =============================================================================

import { MemoryIndex } from "./index.js";

let globalIndex: MemoryIndex | null = null;

/** Get (or create) the global MemoryIndex.
 *  If the singleton already exists but was created without key/sessions config,
 *  it is recreated with the new parameters. This handles the case where
 *  tools/memory.ts creates the singleton before gateway startup provides
 *  the full config. */
export function getGlobalMemoryIndex(
  workspacePath?: string,
  openaiApiKey?: string,
  dbPath?: string,
  sessionsPath?: string,
): MemoryIndex {
  // Recreate if called with config that the existing singleton lacks
  if (globalIndex && (openaiApiKey || sessionsPath)) {
    const needsRecreate =
      (openaiApiKey && !globalIndex.hasEmbeddingProvider()) ||
      (sessionsPath && !globalIndex.hasSessionsPath());
    if (needsRecreate) {
      globalIndex.close();
      globalIndex = null;
    }
  }

  if (!globalIndex) {
    globalIndex = new MemoryIndex({
      workspacePath,
      enableWatcher: true,
      openaiApiKey,
      dbPath,
      sessionsPath,
    });
  }
  return globalIndex;
}

/** Close and reset (for testing). */
export function resetGlobalMemoryIndex(): void {
  globalIndex?.close();
  globalIndex = null;
}
