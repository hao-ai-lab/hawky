export const VENUS_MARKERS = ["<|speak|>", "<|listen|>", "<|turn_eos|>", "<|chunk_eos|>", "<unit>", "</unit>", "<image>", "</image>", "<delegate>", "</delegate>", "<backend>", "</backend>"];
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
  feed(delta: string) {
    this.pending += delta;
    let visible = "", request: string | undefined;
    while (this.pending && !this.invalid) {
      const tag = VENUS_MARKERS.find(t => this.pending.startsWith(t));
      if (tag) {
        this.pending = this.pending.slice(tag.length);
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
      } else visible += char;
    }
    return { visible, request: this.invalid ? undefined : request, mute: this.muted || this.pending.length > 0 || this.invalid, invalid: this.invalid };
  }
  finish() { return { malformed: this.invalid || this.privateText !== undefined || !!this.pending }; }
}
