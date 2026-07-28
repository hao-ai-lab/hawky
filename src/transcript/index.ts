// =============================================================================
// @hawky/transcript — canonical transcript reducer (public surface)
//
// Pure, deployment-neutral fold from agent StreamEvents (and persisted
// history) to an ordered transcript. Consumed via the "@hawky/transcript"
// path alias by web/ and web-ios/, and directly by the TUI — and designed to
// also run inside the gateway later. See reducer.ts for the canonical
// behavior choices and types.ts for the state model.
// =============================================================================

export {
  initialState,
  reduce,
  fromHistory,
  selectFlat,
  appendUserMessage,
  formatInputPreview,
  isUserAbortError,
} from "./reducer.js";

export type {
  StreamEvent,
  TranscriptState,
  TranscriptCursor,
  TranscriptItem,
  TranscriptMessageItem,
  TranscriptToolItem,
  TranscriptOutputLine,
  TranscriptRole,
  TranscriptToolStatus,
  HistoryMessage,
  HistoryBlock,
} from "./types.js";
