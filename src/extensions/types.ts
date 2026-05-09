import type { PermissionLevel, ToolInputSchema } from "../agent/types.js";

export type ExtensionSurface =
  | "agent"
  | "tool.invoke"
  | "frontend.boot_context"
  | "openai.realtime"
  | "gemini.live"
  | "ios.live"
  | "web.slash"
  | "mcp";

export interface ExtensionToolDescriptor {
  name: string;
  description: string;
  input_schema: ToolInputSchema;
  permission: PermissionLevel;
  capabilities?: string[];
  surfaces?: ExtensionSurface[];
  promptHints?: string[];
  frontendMetadata?: Record<string, unknown>;
}

export interface ExtensionManifest {
  id: string;
  version: string;
  displayName: string;
  description?: string;
  capabilities?: string[];
  surfaces?: ExtensionSurface[];
  tools?: ExtensionToolDescriptor[];
  frontendTools?: ExtensionFrontendToolContribution[];
  permissionPolicy?: Record<string, unknown>;
  promptHints?: string[];
  frontendMetadata?: Record<string, unknown>;
  runtimeDependencies?: string[];
  lifecycleHooks?: string[];
}

export interface ExtensionFrontendToolContribution<TDefinition = unknown> {
  surface: ExtensionSurface;
  role: "frontend" | "backend";
  definition: TDefinition;
}

export interface ToolRegistrationMetadata {
  extensionId?: string;
  capabilities?: string[];
  surfaces?: ExtensionSurface[];
}
