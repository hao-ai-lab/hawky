export const VENUS_MARKERS = ["<|speak|>", "<|listen|>", "<|turn_eos|>", "<|chunk_eos|>", "<|chunk_bos|>", "<|turn_bos|>", "<|tts_bos|>", "<|tts_eos|>", "<|chunk_tts_bos|>", "<|chunk_tts_eos|>", "<|tts_pad|>", "<unit>", "</unit>", "<image>", "</image>", "<delegate>", "</delegate>", "<backend>", "</backend>"];
export function venusPrefill(text: string) {
  let safe = text, old: string;
  do { old = safe; for (const token of VENUS_MARKERS) safe = safe.replaceAll(token, ""); } while (safe !== old);
  return `<backend>${safe.trim()}</backend>`;
}
/** One private request per model turn. Partial tags never reach captions/audio. */
export class VenusText {
  private pending = "";
  private privateText: string | undefined;
  private seen = false;
  private invalid = false;
  private muted = false;
  private speaking = false;
  feed(delta: string) {
    this.pending += delta;
    let visible = "", request: string | undefined;
    while (this.pending && !this.invalid) {
      const tag = VENUS_MARKERS.find(t => this.pending.startsWith(t));
      if (tag) {
        this.pending = this.pending.slice(tag.length);
        // Native duplex output can contain non-speech text before the speech
        // marker. Only the spoken span belongs in the assistant transcript.
        if (["<|speak|>", "<|tts_bos|>", "<|chunk_tts_bos|>"].includes(tag)) this.speaking = true;
        if (["<|listen|>", "<|tts_eos|>", "<|chunk_tts_eos|>", "<|turn_eos|>", "</unit>"].includes(tag)) this.speaking = false;
        if (tag === "<delegate>") {
          this.muted = true;
          if (this.seen || this.privateText !== undefined) { this.invalid = true; break; }
          this.privateText = ""; this.seen = true;
        } else if ((tag === "</delegate>" || tag === "<|turn_eos|>") && this.privateText !== undefined) {
          if (!this.privateText.trim()) { this.invalid = true; break; }
          request = this.privateText.trim(); this.privateText = undefined;
        }
        continue;
      }
      if (VENUS_MARKERS.some(t => t.startsWith(this.pending))) break;
      const char = this.pending[0]; this.pending = this.pending.slice(1);
      if (this.privateText !== undefined) {
        this.privateText += char;
        if (this.privateText.length > 4000) this.invalid = true;
      } else if (this.speaking) visible += char;
    }
    return { visible, request: this.invalid ? undefined : request, mute: this.muted || this.pending.length > 0 || this.invalid, invalid: this.invalid };
  }
  finish() { return { malformed: this.invalid || this.privateText !== undefined || !!this.pending }; }
}
