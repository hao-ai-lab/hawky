// =============================================================================
// ASRBackend — the swap-point abstraction.
//
// Two capability modes unified: batch (transcribeFile) and streaming
// (openStream). Slice 0 ships only batch (WhisperAPIBackend). See §5.
// =============================================================================

export interface TranscriptSegment {
  t0_ms: number;
  t1_ms: number;
  text: string;
  words?: Array<{ t0_ms: number; t1_ms: number; text: string; conf?: number }>;
  confidence?: number;
  speaker?: string;
}

export interface Transcript {
  media_id: string;
  lang: string;
  backend: string;
  model: string;
  segments: TranscriptSegment[];
}

export interface ASRBackendCapabilities {
  batch: boolean;
  streaming: boolean;
  partials: boolean;
  diarization: boolean;
  langs: string[]; // iso codes, ["*"] for auto
}

export interface ASRSession {
  feed(pcm: Buffer, captured_at_ns: bigint): void;
  onPartial(cb: (p: { t0_ms: number; t1_ms: number; text: string }) => void): void;
  onFinal(cb: (seg: TranscriptSegment) => void): void;
  close(): Promise<Transcript>;
}

export interface ASRBackend {
  name: string;
  capabilities: ASRBackendCapabilities;
  transcribeFile?(
    wavPath: string,
    opts: { media_id: string; lang?: string },
  ): Promise<Transcript>;
  openStream?(opts: { media_id: string; lang?: string }): ASRSession;
}
