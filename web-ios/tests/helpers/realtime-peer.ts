/** A controllable transport, not a simulated model. Only acknowledges supplied protocol events. */
export class TestChannel extends EventTarget {
  readyState = "connecting";
  sent: any[] = [];
  send(value: string) {
    const event = JSON.parse(value);
    this.sent.push(event);
    if (!TestPeer.autoAcknowledge) return;
    void Promise.resolve().then(() => {
      if (this.readyState !== "open") return;
      if (event.type === "session.update") this.receive({ type: "session.updated", session: event.session });
      if (event.type === "conversation.item.create") this.receive({ type: "conversation.item.added", item: event.item });
    });
  }
  receive(event: object) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) })); }
  close() { this.readyState = "closed"; this.dispatchEvent(new Event("close")); }
  open() { this.readyState = "open"; this.dispatchEvent(new Event("open")); }
}

export class TestPeer extends EventTarget {
  static all: TestPeer[] = [];
  static autoAcknowledge = true;
  connectionState = "new";
  channel = new TestChannel();
  senders: Array<{ track: MediaStreamTrack | null; replaceTrack: (track: MediaStreamTrack | null) => Promise<void> }> = [];
  transceivers: Array<{ kind: string; direction?: string }> = [];
  ontrack = null;
  constructor() { super(); TestPeer.all.push(this); }
  createDataChannel() { return this.channel; }
  async createOffer() { return { sdp: "offer" }; }
  async setLocalDescription() {}
  async setRemoteDescription() {}
  addTrack(track: MediaStreamTrack | null) {
    const sender = { track, replaceTrack: async (next: MediaStreamTrack | null) => { sender.track = next; } };
    this.senders.push(sender); return sender;
  }
  addTransceiver(kind: string, options?: { direction: string }) {
    this.transceivers.push({ kind, direction: options?.direction });
    return { sender: this.addTrack(null) };
  }
  close() { this.connectionState = "closed"; }
}
