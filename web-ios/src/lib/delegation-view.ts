import type { DelegationTask } from "../../../src/gateway/delegation-types";
import type { TranscriptEntry } from "./useRealtime";

/** One projection for streamed updates and history restoration, including artifacts. */
export function delegationEntry(task: DelegationTask): TranscriptEntry {
  const image = task.image;
  return {
    id: task.id, kind: "tool", text: `Delegating: ${task.request}`,
    at: new Date(task.createdAt).toLocaleTimeString(), delegation: task,
    toolStatus: ["completed", "failed", "cancelled", "interrupted"].includes(task.status)
      ? task.status === "completed" ? "ok" : "error" : "running",
    toolDetail: task.error || task.result,
    imageData: image?.base64 && /^image\/(png|jpeg|webp|gif)$/.test(image.media_type ?? "")
      ? `data:${image.media_type};base64,${image.base64}` : undefined,
    imageTitle: image?.base64 ? task.request : undefined,
  };
}
