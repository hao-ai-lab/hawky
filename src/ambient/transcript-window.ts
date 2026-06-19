// =============================================================================
// TranscriptWindow — per-session rolling ring buffer (M8 §3.2, §9 H1).
// Stores the last K turns of {role, text, ts} for latent recognition.
// =============================================================================

export interface TranscriptTurn {
  role: "user" | "assistant";
  text: string;
  ts: string;
}

const DEFAULT_K = 12;

/**
 * Per-session transcript window: ring buffer of the last K turns.
 * append/get are synchronous; sessions that have never been appended to return [].
 */
export class TranscriptWindow {
  private readonly k: number;
  /** session key → circular buffer entries (oldest first) */
  private readonly windows = new Map<string, TranscriptTurn[]>();

  constructor(opts: { k?: number } = {}) {
    this.k = opts.k ?? DEFAULT_K;
  }

  /** Append a turn to the session's window. Trims to the last k entries. */
  append(sessionKey: string, turn: TranscriptTurn): void {
    let buf = this.windows.get(sessionKey);
    if (!buf) {
      buf = [];
      this.windows.set(sessionKey, buf);
    }
    buf.push(turn);
    if (buf.length > this.k) {
      buf.splice(0, buf.length - this.k);
    }
  }

  /** Return a snapshot of the window (oldest-first). Never mutates the buffer. */
  get(sessionKey: string): TranscriptTurn[] {
    return [...(this.windows.get(sessionKey) ?? [])];
  }

  /** Clear the window for a session (e.g. on session end). */
  clear(sessionKey: string): void {
    this.windows.delete(sessionKey);
  }
}
