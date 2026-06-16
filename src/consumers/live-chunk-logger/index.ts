// =============================================================================
// live-chunk-logger — Slice 1 stub consumer.
//
// Subscribes to `media.live.chunk` and logs {session_key, media_kind, seq,
// size_bytes} at INFO. Nothing else: real consumers (Slice 3 streaming
// providers, retention GC, etc.) are follow-ups.
// =============================================================================

import { createSubsystemLogger } from "../../logging/index.js";
import { getBus } from "../../bus/index.js";
import type { MediaLiveChunkEvent } from "../../bus/events.js";

const log = createSubsystemLogger("live-chunk-logger");

export function registerLiveChunkLogger(): () => void {
  const bus = getBus();
  const unsub = bus.subscribe<MediaLiveChunkEvent>(
    "media.live.chunk",
    (event) => {
      log.info("live chunk", {
        session_key: event.session_key,
        media_kind: event.media_kind,
        seq: event.seq,
        size_bytes: event.size_bytes,
      });
    },
  );
  log.info("live-chunk-logger registered");
  return unsub;
}
