import Foundation

// ---------------------------------------------------------------------------
// Uploader — sends rolling finalized PCM segments from Recorder to Hawky via
// the existing GatewayTransport WebSocket RPC transport.
//
// Design:
//  - Wired as a *second* consumer alongside WavFileSink; on-device recording
//    continues unchanged.
//  - The on-device WAV remains the full recording. Backend upload is split into
//    short self-contained media IDs (`<capture>.segNNN.mic`) so ASR/voice-loop
//    can react while recording is still in progress.
//  - Each segment is one `media.chunk.upload` request with seq=0 and final=true.
//    That reuses the gateway's existing media.finalized → ASR → voice-loop path
//    without transcribing the full recording again at stop.
//  - Bounded in-memory queue. Oldest segments are dropped with a log warning
//    when the queue is full.
// ---------------------------------------------------------------------------

enum UploaderStatus: Equatable {
    case idle
    case localOnly
    case uploading(sent: Int, total: Int)
    case done
}

private struct PendingChunk {
    let mediaId: String
    let pcm: Data
    let capturedAtNs: UInt64
    let sampleRate: Double
}

@MainActor
final class Uploader: ObservableObject {

    static let maxQueueDepth = 20
    static let segmentDurationSeconds: Double = 3

    @Published private(set) var status: UploaderStatus = .idle
    @Published private(set) var lastError: String?

    private var transport: GatewayTransport?
    private var mediaId: String = ""
    private var nextSegmentIndex: Int = 0
    private var totalEnqueued: Int = 0
    private var totalDispatched: Int = 0

    private var queue: [PendingChunk] = []
    private var accumulator: Data = Data()
    private var accumulatorStartNs: UInt64 = 0
    private var accumulatorSampleRate: Double = 48_000
    private var drainTask: Task<Void, Never>?

    func start(transport: GatewayTransport?, mediaId: String = UUID().uuidString) {
        self.transport = transport
        self.mediaId = mediaId
        print("[Uploader] start mediaId='\(mediaId)' (len=\(mediaId.count))")
        self.nextSegmentIndex = 0
        self.totalEnqueued = 0
        self.totalDispatched = 0
        self.queue.removeAll()
        self.accumulator = Data()
        self.accumulatorStartNs = 0
        self.accumulatorSampleRate = 48_000
        self.lastError = nil

        status = (transport?.isConnected == true)
            ? .uploading(sent: 0, total: 0)
            : .localOnly

        drainTask?.cancel()
        drainTask = Task { [weak self] in
            await self?.drainLoop()
        }
    }

    func ingest(chunk: AudioChunk, capturedAtNs: UInt64) {
        guard !mediaId.isEmpty else { return }
        if accumulator.isEmpty {
            accumulatorStartNs = capturedAtNs
            accumulatorSampleRate = chunk.sampleRate
        }
        accumulator.append(chunk.pcm)
        if accumulator.count >= segmentTargetBytes(sampleRate: accumulatorSampleRate) {
            flushAccumulator(isFinal: false)
        }
    }

    func stop() async {
        guard !mediaId.isEmpty else { return }
        flushAccumulator(isFinal: true)
        drainTask?.cancel()
        drainTask = nil
        await drainOnce()
        if totalEnqueued > 0 && totalDispatched == totalEnqueued {
            status = .done
        } else {
            // Partial / never-dispatched — keep counts visible; don't claim done.
            updateStatus()
        }
    }

    private func flushAccumulator(isFinal: Bool) {
        let bytes = accumulator
        let startNs = accumulatorStartNs
        let rate = accumulatorSampleRate
        accumulator = Data()
        accumulatorStartNs = 0
        accumulatorSampleRate = 48_000
        guard !bytes.isEmpty || isFinal else { return }
        guard !bytes.isEmpty else { return }

        let chunk = PendingChunk(
            mediaId: segmentMediaId(index: nextSegmentIndex),
            pcm: bytes,
            capturedAtNs: startNs,
            sampleRate: rate
        )
        nextSegmentIndex += 1
        enqueue(chunk)
    }

    private func enqueue(_ chunk: PendingChunk) {
        if queue.count >= Self.maxQueueDepth {
            queue.removeFirst()
            print("[Uploader] queue full — dropped oldest chunk (backpressure)")
        }
        queue.append(chunk)
        totalEnqueued += 1
        updateStatus()
    }

    // Sticky: once we've entered .uploading, stay there until .done.
    // Only transition .localOnly → .uploading when connectivity returns or
    // a chunk dispatches successfully.
    private func updateStatus() {
        if case .uploading = status {
            status = .uploading(sent: totalDispatched, total: totalEnqueued)
            return
        }
        if status == .done { return }
        if transport?.isConnected == true || totalDispatched > 0 {
            status = .uploading(sent: totalDispatched, total: totalEnqueued)
        } else {
            status = .localOnly
        }
    }

    private func drainLoop() async {
        while !Task.isCancelled {
            await drainOnce()
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
    }

    private func drainOnce() async {
        guard transport?.isConnected == true, !queue.isEmpty else { return }

        let batch = queue
        queue.removeAll()

        for (idx, chunk) in batch.enumerated() {
            if Task.isCancelled {
                // Re-queue everything we haven't sent yet.
                queue = Array(batch[idx...]) + queue
                return
            }
            do {
                try await sendChunk(chunk)
                totalDispatched += 1
                updateStatus()
            } catch {
                // Re-queue the failing chunk AND all later entries in this batch,
                // preserving any chunks enqueued during iteration.
                let message = "\(error)"
                lastError = message
                print("[Uploader] send failed (segment='\(chunk.mediaId)' baseMediaId='\(mediaId)'): \(message) - will retry")
                queue = Array(batch[idx...]) + queue
                return
            }
        }
    }

    private func sendChunk(_ chunk: PendingChunk) async throws {
        guard let transport else { throw UploaderError.noTransport }
        let b64 = chunk.pcm.base64EncodedString()
        let params: [String: JSONValue] = [
            "media_id": .string(chunk.mediaId),
            "seq": .number(0),
            "bytes": .string(b64),
            "mime": .string("audio/pcm16;rate=\(Int(chunk.sampleRate))"),
            "captured_at_ns": .number(Double(chunk.capturedAtNs)),
            "final": .bool(true),
        ]
        let frame = RequestFrame(
            id: UUID().uuidString,
            method: "media.chunk.upload",
            params: params
        )
        let resp = try await transport.send(frame)
        if !resp.ok {
            let msg = resp.error?.message ?? "media.chunk.upload failed"
            throw UploaderError.rpcError(msg)
        }
        lastError = nil
    }

    private func segmentTargetBytes(sampleRate: Double) -> Int {
        max(Self.targetChunkBytesFloor, Int(sampleRate * Self.segmentDurationSeconds) * 2)
    }

    private func segmentMediaId(index: Int) -> String {
        let base = mediaId.hasSuffix(".mic") ? String(mediaId.dropLast(4)) : mediaId
        return "\(base).seg\(String(format: "%03d", index)).mic"
    }

    private static let targetChunkBytesFloor = 3_200
}

enum UploaderError: Error {
    case noTransport
    case rpcError(String)
}
