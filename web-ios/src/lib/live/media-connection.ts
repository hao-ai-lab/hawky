/** Browser media transport. It does not interpret provider events or own tasks. */
export function createMediaConnection(media: MediaStream, play: (stream: MediaStream) => void) {
  const pc = new RTCPeerConnection();
  pc.ontrack = e => play(e.streams[0]);
  const track = media.getAudioTracks()[0];
  if (track) track.enabled = false; // Restore context before the microphone goes live.
  const sender = track ? pc.addTrack(track, media) : pc.addTransceiver("audio", { direction: "sendrecv" }).sender;
  return { pc, sender, dc: pc.createDataChannel("oai-events") };
}
