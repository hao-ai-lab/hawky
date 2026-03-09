// =============================================================================
// Tool Registry
//
// Stores tool definitions, looks them up by name, executes them safely,
// and exports them in Anthropic API format.
//
// Uses a singleton pattern: getToolRegistry() returns the shared instance.
// =============================================================================

import type {
  ToolDefinition,
  ToolResult,
  ToolContext,
  AnthropicToolDefinition,
} from "../agent/types.js";
import type {
  ExtensionManifest,
  ExtensionSurface,
  ExtensionToolDescriptor,
  ToolRegistrationMetadata,
} from "../extensions/types.js";

interface RegisteredExtension {
  manifest: ExtensionManifest;
  toolNames: Set<string>;
}

/**
 * Registry for tool definitions.
 *
 * Responsibilities:
 * - Store tool definitions in a Map for O(1) lookup
 * - Execute tools with consistent error handling, abort checking, and timing
 * - Export tool definitions in Anthropic API format (stripped of internal fields)
 */
export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();
  private toolMetadata = new Map<string, ToolRegistrationMetadata>();
  private extensions = new Map<string, RegisteredExtension>();

  /**
   * Register a single tool. Overwrites if a tool with the same name exists.
   */
  register(tool: ToolDefinition, metadata: ToolRegistrationMetadata = {}): void {
    this.detachToolFromPreviousExtension(tool.name, metadata.extensionId);
    this.tools.set(tool.name, tool);
    if (this.hasMetadata(metadata)) {
      this.toolMetadata.set(tool.name, {
        extensionId: metadata.extensionId,
        capabilities: metadata.capabilities ? [...metadata.capabilities] : undefined,
        surfaces: metadata.surfaces ? [...metadata.surfaces] : undefined,
      });
    } else {
      this.toolMetadata.delete(tool.name);
    }
  }

  /**
   * Register multiple tools at once.
   */
  registerAll(tools: ToolDefinition[], metadata: ToolRegistrationMetadata = {}): void {
    for (const tool of tools) {
      this.register(tool, metadata);
    }
  }

  /**
   * Register tools owned by an extension manifest.
   *
   * This preserves the existing flat tool lookup while adding enough ownership
   * metadata for future install/uninstall and surface-specific projections.
   */
  registerExtension(manifest: ExtensionManifest, tools: ToolDefinition[]): void {
    this.unregisterExtension(manifest.id);

    const toolNames = new Set<string>();
    this.extensions.set(manifest.id, { manifest, toolNames });

    for (const tool of tools) {
      const descriptor = manifest.tools?.find((candidate) => candidate.name === tool.name);
      const metadata = this.metadataFromManifest(manifest, descriptor);
      this.register(tool, metadata);
      toolNames.add(tool.name);
    }
  }

  /**
   * Look up a tool by name.
   */
  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /**
   * Return registration metadata for a tool, if it was registered by an extension.
   */
  getMetadata(name: string): ToolRegistrationMetadata | undefined {
    const metadata = this.toolMetadata.get(name);
    if (!metadata) return undefined;
    return {
      extensionId: metadata.extensionId,
      capabilities: metadata.capabilities ? [...metadata.capabilities] : undefined,
      surfaces: metadata.surfaces ? [...metadata.surfaces] : undefined,
    };
  }

  /**
   * Return a registered extension manifest by id.
   */
  getExtension(id: string): ExtensionManifest | undefined {
    return this.extensions.get(id)?.manifest;
  }

  /**
   * Return all registered extension manifests.
   */
  getExtensions(): ExtensionManifest[] {
    return Array.from(this.extensions.values()).map((entry) => entry.manifest);
  }

  /**
   * Check if a tool is registered.
   */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * Get all registered tools.
   */
  getAll(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  /**
   * Return tools that declared a surface such as agent, tool.invoke, or ios.live.
   */
  getToolsBySurface(surface: ExtensionSurface): ToolDefinition[] {
    return Array.from(this.tools.values()).filter((tool) => {
      const surfaces = this.toolMetadata.get(tool.name)?.surfaces;
      return surfaces?.includes(surface) ?? false;
    });
  }

  /**
   * Return extension manifests relevant to a projection target.
   */
  getManifestProjection(surface: ExtensionSurface): ExtensionManifest[] {
    return Array.from(this.extensions.values())
      .filter((extension) => this.extensionContributesToSurface(extension, surface))
      .map((extension) => extension.manifest);
  }

  /**
   * Number of registered tools.
   */
  get count(): number {
    return this.tools.size;
  }

  /**
   * Get tool definitions in Anthropic API format.
   * Strips internal fields (execute, permission) — only keeps
   * name, description, and input_schema.
   */
  getApiDefinitions(): AnthropicToolDefinition[] {
    return Array.from(this.tools.values()).map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema,
    }));
  }

  /**
   * Execute a tool by name with consistent error handling.
   *
   * This is the single execution point for all tool calls. It handles:
   * - Tool-not-found (returns error result instead of throwing)
   * - Abort-before-start (checks signal before executing)
   * - Exception wrapping (catches thrown errors, converts to ErrorToolResult)
   * - Timing (logs execution duration)
   *
   * The agent loop's three-phase processing (permissions → parallel execution
   * → post-processing) still lives in the loop. This method handles the
   * low-level "call the function safely" part.
   */
  async execute(
    name: string,
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);

    if (!tool) {
      return { type: "error", content: `Unknown tool: ${name}` };
    }

    // Check if already aborted before starting
    if (context.abort_signal.aborted) {
      return { type: "error", content: "Tool execution was interrupted" };
    }

    try {
      const result = await tool.execute(input as any, context);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { type: "error", content: `Tool execution failed: ${message}` };
    }
  }

  /**
   * Remove a single tool by name. Returns true if removed.
   */
  unregister(name: string): boolean {
    this.detachToolFromPreviousExtension(name);
    this.toolMetadata.delete(name);
    return this.tools.delete(name);
  }

  /**
   * Remove all tools owned by an extension manifest. Returns true if removed.
   */
  unregisterExtension(extensionId: string): boolean {
    const extension = this.extensions.get(extensionId);
    if (!extension) return false;

    for (const toolName of extension.toolNames) {
      this.tools.delete(toolName);
      this.toolMetadata.delete(toolName);
    }

    this.extensions.delete(extensionId);
    return true;
  }

  /**
   * Remove all registered tools.
   */
  clear(): void {
    this.tools.clear();
    this.toolMetadata.clear();
    this.extensions.clear();
  }

  private detachToolFromPreviousExtension(toolName: string, nextExtensionId?: string): void {
    const previousExtensionId = this.toolMetadata.get(toolName)?.extensionId;
    if (!previousExtensionId || previousExtensionId === nextExtensionId) return;

    const previousExtension = this.extensions.get(previousExtensionId);
    previousExtension?.toolNames.delete(toolName);
  }

  private extensionContributesToSurface(
    extension: RegisteredExtension,
    surface: ExtensionSurface,
  ): boolean {
    const { manifest, toolNames } = extension;
    const ownedToolDescriptors = (manifest.tools ?? []).filter((tool) => toolNames.has(tool.name));
    if (ownedToolDescriptors.some((tool) => tool.surfaces?.includes(surface))) {
      return true;
    }
    if (toolNames.size > 0 && manifest.surfaces?.includes(surface)) {
      return true;
    }
    if (manifest.frontendTools?.some((tool) => tool.surface === surface)) {
      return true;
    }

    const hasToolContributions = (manifest.tools?.length ?? 0) > 0;
    const hasFrontendContributions = (manifest.frontendTools?.length ?? 0) > 0;
    return !hasToolContributions && !hasFrontendContributions && (manifest.surfaces?.includes(surface) ?? false);
  }

  private metadataFromManifest(
    manifest: ExtensionManifest,
    descriptor: ExtensionToolDescriptor | undefined,
  ): ToolRegistrationMetadata {
    return {
      extensionId: manifest.id,
      capabilities: this.mergeUnique(manifest.capabilities, descriptor?.capabilities),
      surfaces: this.mergeUnique(manifest.surfaces, descriptor?.surfaces),
    };
  }

  private mergeUnique<T>(first?: T[], second?: T[]): T[] | undefined {
    const merged = [...(first ?? []), ...(second ?? [])];
    return merged.length > 0 ? Array.from(new Set(merged)) : undefined;
  }

  private hasMetadata(metadata: ToolRegistrationMetadata): boolean {
    return Boolean(
      metadata.extensionId ||
        metadata.capabilities?.length ||
        metadata.surfaces?.length,
    );
  }
}

// -----------------------------------------------------------------------------
// Singleton
// -----------------------------------------------------------------------------

let _registry: ToolRegistry | null = null;

/**
 * Get the shared ToolRegistry instance (created on first access).
 */
export function getToolRegistry(): ToolRegistry {
  if (!_registry) {
    _registry = new ToolRegistry();
  }
  return _registry;
}

/**
 * Reset the shared ToolRegistry instance (for testing).
 */
export function resetToolRegistry(): void {
  _registry = null;
}
