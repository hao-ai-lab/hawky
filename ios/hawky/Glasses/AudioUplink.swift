import Foundation
import SwiftUI

/// Hold-to-talk coordinator for the Glasses tab.
///
/// Drives `MicAudioSource` (Phase A) and ships ~100ms PCM16 mono 16kHz chunks
/// to Hawky via the existing `chat.audio.chunk` RPC on the app-wide chat
/// WebSocket. Does NOT open a new connection — reuses `container.transport`.
///
/// Buffer sizing: 16000 samples/sec * 2 bytes/sample * 0.1s = 3200 bytes.
/// We accumulate raw PCM16 from MicAudioSource's AsyncStream (which yields
/// ~50ms buffers) until we hit the 3200-byte threshold, then emit a chunk.
/// On stop, any residual bytes ship with `final: true` — even if <3200.
///
/// Protocol contract (pinned by M3.2):
///   method: "chat.audio.chunk"
///   params: { sessionKey, seq, pcm16 (base64), sampleRate, final }
@MainActor
final class AudioUplink: ObservableObject {
    enum State: Equatable {
        case idle
        case talking
        case error(String)
    }

    @Published private(set) var state: State = .idle
    @Published private(set) var bytesSent: Int = 0

    /// Resolved lazily at press-time — container.transport may be nil until the
    /// first `container.start()` completes, and may change after reauthenticate.
    private var transportProvider: @MainActor () -> GatewayTransport?
    private var sessionKeyProvider: @MainActor () -> String

    /// Swap in live providers once the SwiftUI environment is available.
    /// Idempotent — safe to call on every `.task` / `.onAppear`.
    func rebind(
        transport: @MainActor @escaping () -> GatewayTransport?,
        sessionKey: @MainActor @escaping () -> String
    ) {
        self.transportProvider = transport
        self.sessionKeyProvider = sessionKey
    }

    private var mic: MicAudioSource?
    private var pumpTask: Task<Void, Never>?
    private var buffer = Data()
    private var seq: Int = 0

    /// Target bytes per chunk (~100ms @ 16kHz mono PCM16).
    private static let chunkTargetBytes = 3200

    init(
        transport transportProvider: @MainActor @escaping () -> GatewayTransport?,
        sessionKey sessionKeyProvider: @MainActor @escaping () -> String
    ) {
        self.transportProvider = transportProvider
        self.sessionKeyProvider = sessionKeyProvider
    }

    /// Begin a turn — allocate a fresh mic, reset counters, start pumping.
    /// Safe to call while already talking (no-op). Runs on main actor.
    func start() {
        if case .talking = state { return }
        guard transportProvider() != nil else {
            state = .error("Not connected")
            return
        }
        buffer.removeAll(keepingCapacity: true)
        bytesSent = 0
        seq = 0
        state = .talking

        let mic = MicAudioSource(sampleRate: 16_000)
        self.mic = mic

        pumpTask = Task { [weak self] in
            guard let self else { return }
            do {
                try await mic.start()
            } catch {
                await MainActor.run {
                    self.state = .error("Mic failed: \(error.localizedDescription)")
                }
                await mic.stop()
                return
            }
            for await chunk in mic.samples {
                if Task.isCancelled { break }
                await self.ingest(chunk.pcm)
            }
        }
    }

    /// End a turn — flush whatever's in the buffer with `final: true`, tear
    /// down the mic, return to idle. Safe to call from any state.
    func stop() {
        guard case .talking = state else {
            // Still make sure we don't leak a running mic.
            pumpTask?.cancel()
            pumpTask = nil
            let m = mic
            mic = nil
            Task { await m?.stop() }
            return
        }
        let tailBuffer = buffer
        buffer.removeAll(keepingCapacity: true)
        let seqToUse = seq
        seq += 1
        let m = mic
        mic = nil
        pumpTask?.cancel()
        pumpTask = nil
        state = .idle

        Task { [weak self] in
            await m?.stop()
            // Always send a final frame, even if tailBuffer is empty, so the
            // server knows the turn is over.
            await self?.sendChunk(pcm: tailBuffer, seq: seqToUse, final: true)
        }
    }

    // MARK: - Private

    /// Accumulate PCM into buffer; when we cross the 3200-byte threshold, emit.
    /// Multiple chunks may fire from a single mic buffer if it overshoots.
    private func ingest(_ pcm: Data) async {
        buffer.append(pcm)
        while buffer.count >= Self.chunkTargetBytes {
            let slice = buffer.prefix(Self.chunkTargetBytes)
            buffer.removeFirst(Self.chunkTargetBytes)
            let s = seq
            seq += 1
            await sendChunk(pcm: Data(slice), seq: s, final: false)
        }
    }

    private func sendChunk(pcm: Data, seq: Int, final: Bool) async {
        guard let transport = transportProvider() else {
            if final { return } // best-effort flush; already tearing down
            state = .error("Not connected")
            return
        }
        let b64 = pcm.base64EncodedString()
        let params: [String: JSONValue] = [
            "sessionKey": .string(sessionKeyProvider()),
            "seq": .number(Double(seq)),
            "pcm16": .string(b64),
            "sampleRate": .number(16_000),
            "final": .bool(final)
        ]
        let frame = RequestFrame(id: UUID().uuidString, method: "chat.audio.chunk", params: params)
        do {
            let resp = try await transport.send(frame)
            if !resp.ok {
                let msg = resp.error?.message ?? "chat.audio.chunk failed"
                // On server-side rejection (e.g. METHOD_NOT_FOUND when the
                // Hawky branch isn't deployed) stop the turn and surface it.
                state = .error(msg)
                return
            }
            bytesSent += pcm.count
        } catch {
            state = .error("Send failed: \(error.localizedDescription)")
        }
    }
}
