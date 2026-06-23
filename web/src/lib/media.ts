// =============================================================================
// Media capture helper (web demo, #681).
//
// Browsers only expose `navigator.mediaDevices` (and thus getUserMedia) in a
// SECURE CONTEXT — https://, or http://localhost / 127.0.0.1. On a plain-HTTP
// non-localhost origin (e.g. a LAN/Tailscale IP) `navigator.mediaDevices` is
// `undefined`, so a direct `.getUserMedia(...)` throws the opaque
// "Cannot read properties of undefined (reading 'getUserMedia')".
//
// This helper turns that into a clear, actionable error and centralizes the
// guard for both the Live and Transcription demos.
// =============================================================================

/** True when getUserMedia is usable (secure context + API present). */
export function canUseMedia(): boolean {
  return (
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === "function"
  );
}

/** Human-readable reason the camera/mic can't be used, or null when it can. */
export function mediaUnavailableReason(): string | null {
  if (canUseMedia()) return null;
  const isSecure = typeof window !== "undefined" && window.isSecureContext;
  if (!isSecure) {
    const origin = typeof window !== "undefined" ? window.location.origin : "this URL";
    return (
      `Camera/microphone need a secure context. ${origin} is plain HTTP, so the ` +
      `browser hides them. Open the demo over https:// or via http://localhost ` +
      `to enable Live and Transcription.`
    );
  }
  return "This browser does not expose camera/microphone access (getUserMedia is unavailable).";
}

/**
 * getUserMedia with a clear precondition check. Throws an Error carrying
 * mediaUnavailableReason() instead of an opaque undefined-property TypeError.
 */
export async function getUserMediaSafe(constraints: MediaStreamConstraints): Promise<MediaStream> {
  const reason = mediaUnavailableReason();
  if (reason) throw new Error(reason);
  return navigator.mediaDevices.getUserMedia(constraints);
}
