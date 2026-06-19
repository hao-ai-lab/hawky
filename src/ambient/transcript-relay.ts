// =============================================================================
// Transcript relay — device → gateway uplink (OQ4).
// Frame schema + ack only; transport piggybacks the bridge WS in M2.
// =============================================================================

export const TRANSCRIPT_DELTA = "transcript.delta";

export interface TranscriptDeltaFrame {
  sessionKey: string;
  seq: number;
  text: string;
  final: boolean;
  ts: string;
}

/** Gateway acks last seq persisted */
export interface TranscriptAck {
  sessionKey: string;
  seq: number;
}
