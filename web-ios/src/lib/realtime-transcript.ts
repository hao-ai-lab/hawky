/**
 * Tracks provider text on the event-handler side, before React schedules renders.
 * Each returned value is a snapshot: React updaters only render it and never
 * mutate this tracker or persist messages. Completion is emitted once per part.
 */
export interface AssistantText {
  id: string;
  at: string;
  text: string;
  responseId: string;
  itemId?: string;
  outputIndex: number;
  contentIndex: number;
  completed: boolean;
}

interface TextEvent {
  response_id?: string;
  item_id?: string;
  output_index?: number;
  content_index?: number;
}
interface ResponseState {
  parts: Map<string, AssistantText>;
  ended: boolean;
  lastEntryId: string | null;
}

export class RealtimeTranscript {
  private responses = new Map<string, ResponseState>();
  private currentId: string | null = null;
  private nextLegacyId = 0;

  get active() { return this.currentId !== null && !this.responses.get(this.currentId)?.ended; }
  get currentEntryId() { return this.active ? this.responses.get(this.currentId!)?.lastEntryId ?? null : null; }

  reset() { this.responses.clear(); this.currentId = null; }

  start(id = `legacy-${++this.nextLegacyId}`) {
    // A repeated response.created must not reset completion/deduplication state.
    if (this.responses.has(id)) return;
    this.responses.set(id, { parts: new Map(), ended: false, lastEntryId: null });
    this.currentId = id;
    // Match the UI's bounded history. Addressed events for evicted responses are
    // ignored instead of being attached to whichever response is now active.
    if (this.responses.size > 200) this.responses.delete(this.responses.keys().next().value!);
  }

  private part(event: TextEvent): AssistantText | undefined {
    if (!event.response_id && !this.currentId) this.start();
    const responseId = event.response_id ?? this.currentId!;
    const response = this.responses.get(responseId);
    if (!response || response.ended) return;
    const outputIndex = event.output_index ?? 0;
    const contentIndex = event.content_index ?? 0;
    // Item identity is authoritative; indexes support legacy events without IDs.
    const key = `${event.item_id ?? `output-${outputIndex}`}:${contentIndex}`;
    let part = response.parts.get(key) ?? [...response.parts.values()].find(p =>
      p.outputIndex === outputIndex && p.contentIndex === contentIndex && (!p.itemId || !event.item_id));
    if (!part) {
      part = { id: crypto.randomUUID(), at: new Date().toLocaleTimeString(), text: "",
        responseId, itemId: event.item_id, outputIndex, contentIndex, completed: false };
      response.parts.set(key, part);
    }
    if (!part.itemId && event.item_id) part.itemId = event.item_id;
    return part;
  }

  delta(event: TextEvent, text: string): AssistantText | undefined {
    if (!text) return;
    const part = this.part(event);
    if (!part || part.completed) return;
    part.text += text;
    this.responses.get(part.responseId)!.lastEntryId = part.id;
    return { ...part };
  }

  complete(event: TextEvent, finalText?: string): AssistantText | undefined {
    const part = this.part(event);
    if (!part || part.completed) return;
    // A final transcript may legitimately revise the preview, but only its own
    // item/content part. Keep partial text if completion has no usable text.
    const text = finalText?.trim() || part.text.trim();
    if (!text) return;
    part.text = text;
    part.completed = true;
    return { ...part };
  }

  finish(response: { id?: string; output?: Array<{ id?: string; type?: string; role?: string;
    content?: Array<{ type?: string; text?: string; transcript?: string }> }> }): AssistantText[] {
    if (!response.id && !this.currentId) this.start();
    const id = response.id ?? this.currentId!;
    const state = this.responses.get(id);
    if (!state || state.ended) return [];
    const updates: AssistantText[] = [];
    for (const [outputIndex, item] of (response.output ?? []).entries()) {
      if ((item.type && item.type !== "message") || (item.role && item.role !== "assistant")) continue;
      for (const [contentIndex, content] of (item.content ?? []).entries()) {
        const text = content.transcript ?? content.text;
        if (typeof text !== "string") continue;
        const update = this.complete({ response_id: id, item_id: item.id, output_index: outputIndex, content_index: contentIndex }, text);
        if (update) updates.push(update);
      }
    }
    // Preserve a streamed partial when cancellation/variants omit final output.
    for (const part of state.parts.values()) {
      if (!part.completed && part.text.trim()) {
        part.text = part.text.trim();
        part.completed = true;
        updates.push({ ...part });
      }
    }
    state.ended = true;
    return updates;
  }
}
