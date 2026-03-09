// =============================================================================
// Built-in Tool Registration
//
// Registers all built-in tools with a ToolRegistry instance.
// =============================================================================

import type { ToolDefinition } from "../agent/types.js";
import type { ExtensionManifest } from "../extensions/types.js";
import { ToolRegistry } from "./registry.js";
import { bashToolDefinition } from "./bash.js";
import { readFileToolDefinition } from "./read_file.js";
import { writeFileToolDefinition } from "./write_file.js";
import { editFileToolDefinition } from "./edit_file.js";
import { globToolDefinition } from "./glob.js";
import { grepToolDefinition } from "./grep.js";
import { webFetchToolDefinition } from "./web_fetch.js";
import { webSearchToolDefinition } from "./web_search.js";
import { askUserToolDefinition } from "./ask_user.js";
import { memoryGetToolDefinition, memorySearchToolDefinition } from "./memory.js";
import { taskCreateToolDefinition, taskUpdateToolDefinition } from "./task.js";
import { cronToolDefinition } from "./cron.js";
import { agentToolDefinition } from "./agent.js";
import { nodesToolDefinition } from "./nodes.js";
import { channelSendToolDefinition } from "./channel_send.js";
import { sendMessageToolDefinition } from "./send_message.js";
import { summarizeSessionToolDefinition } from "./summarize_session.js";
import { slackListMembersToolDefinition } from "./slack_list_members.js";
import { memoryAppendToolDefinition } from "./memory_append.js";
import { generateChartToolDefinition } from "./generate_chart.js";
import {
  faceIdentifyToolDefinition,
  faceEnrollToolDefinition,
  faceUpdateToolDefinition,
  facePeopleToolDefinition,
  faceClearToolDefinition,
  assessHazardToolDefinition,
} from "./face_recognize.js";

// ToolDefinition<SpecificInput> → ToolDefinition<Record<string, unknown>> requires
// double cast because the generic parameter is contravariant on `execute`.
const tools: ToolDefinition[] = [
  bashToolDefinition,
  readFileToolDefinition,
  writeFileToolDefinition,
  editFileToolDefinition,
  globToolDefinition,
  grepToolDefinition,
  webFetchToolDefinition,
  webSearchToolDefinition,
  faceIdentifyToolDefinition,
  faceEnrollToolDefinition,
  faceUpdateToolDefinition,
  facePeopleToolDefinition,
  faceClearToolDefinition,
  assessHazardToolDefinition,
  askUserToolDefinition,
  memoryGetToolDefinition,
  memorySearchToolDefinition,
  taskCreateToolDefinition,
  taskUpdateToolDefinition,
  cronToolDefinition,
  agentToolDefinition,
  nodesToolDefinition,
  channelSendToolDefinition,
  sendMessageToolDefinition,
  summarizeSessionToolDefinition,
  slackListMembersToolDefinition,
  memoryAppendToolDefinition,
  generateChartToolDefinition,
] as unknown as ToolDefinition[];

export const builtinToolsExtensionManifest: ExtensionManifest = {
  id: "core.builtin.tools",
  version: "0.1.0",
  displayName: "Built-in Tools",
  description: "Core tools bundled with the agent runtime.",
  capabilities: ["tools.builtin"],
  surfaces: ["agent"],
  tools: tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.input_schema,
    permission: tool.permission,
    surfaces: ["agent"],
  })),
};

/**
 * Register all built-in tools with the given registry.
 */
export function registerBuiltinTools(registry: ToolRegistry): void {
  registry.registerExtension(builtinToolsExtensionManifest, tools);
}
