/** Browser media transport. It does not interpret provider events or own tasks. */
export function createMediaConnection(media: MediaStream, play: (stream: MediaStream) => void, continuous = false) {
  const pc = new RTCPeerConnection();
  pc.ontrack = e => play(e.streams[0]);
  const track = media.getAudioTracks()[0];
  if (track) track.enabled = false; // Restore context before the microphone goes live.
  // GPT-Live advances continuously with media. A sender without a track stalls
  // context injection when starting with Mic off. Generate silence, never capture
  // the microphone just to keep time; the real mic can replace this track later.
  let clock: AudioContext | undefined;
  let silence: MediaStream | undefined;
  if (continuous && !track) {
    clock = new AudioContext();
    const destination = clock.createMediaStreamDestination();
    const source = clock.createConstantSource(); source.offset.value = 0;
    source.connect(destination); source.start(); silence = destination.stream;
    void clock.resume();
  }
  const input = track ?? silence?.getAudioTracks()[0];
  const sender = input ? pc.addTrack(input, silence ?? media) : pc.addTransceiver("audio", { direction: "sendrecv" }).sender;
  return { pc, sender, dc: pc.createDataChannel("oai-events"), dispose: () => {
    silence?.getTracks().forEach(t => t.stop());
    if (clock) void clock.close();
  } };
}
