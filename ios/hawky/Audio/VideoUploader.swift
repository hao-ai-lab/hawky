import Foundation

// ---------------------------------------------------------------------------
// VideoUploader — streams fMP4 fragments from VideoCapture to Hawky.
//
// Mirrors Uploader.swift in design:
//  - Bounded in-memory queue (maxQueueDepth ≈ 300 fragments).
//  - Oldest fragments dropped under backpressure with a log warning.
//  - seq is monotonic from 0 per media_id; server tolerates gaps.
//  - `final: true` is sent on stop().
//  - Sticky status: once .uploading, stays until .done.
// ---------------------------------------------------------------------------

private struct PendingFragment {
    let seq: Int
    let bytes: Data
    let capturedAtNs: UInt64
    let isFinal: Bool
}

@MainActor
final class VideoUploader: ObservableObject {

    static let maxQueueDepth = 300

    @Published private(set) var status: UploaderStatus = .idle
    @Published private(set) var lastError: String?

    private var transport: GatewayTransport?
    private var mediaId: String = ""
    private var nextSeq: Int = 0
    private var totalEnqueued: Int = 0
    private var totalDispatched: Int = 0

    private var queue: [PendingFragment] = []
    private var drainTask: Task<Void, Never>?

    // MARK: - Lifecycle

    func start(transport: GatewayTransport?, mediaId: String) {
        self.transport = transport
        self.mediaId = mediaId
        self.nextSeq = 0
        self.totalEnqueued = 0
        self.totalDispatched = 0
        self.queue.removeAll()
        self.lastError = nil

        status = (transport?.isConnected == true)
            ? .uploading(sent: 0, total: 0)
            : .localOnly

        drainTask?.cancel()
        drainTask = Task { [weak self] in
            await self?.drainLoop()
        }
    }

    func ingest(mp4Bytes: Data, capturedAtNs: UInt64) {
        guard !mediaId.isEmpty else { return }
        let fragment = PendingFragment(
            seq: nextSeq,
            bytes: mp4Bytes,
            capturedAtNs: capturedAtNs,
            isFinal: false
        )
        nextSeq += 1
        enqueue(fragment)
    }

    func stop() async {
        guard !mediaId.isEmpty else { return }
        // Enqueue a final zero-byte fragment to signal end-of-stream.
        let finalFragment = PendingFragment(
            seq: nextSeq,
            bytes: Data(),
            capturedAtNs: UInt64(DispatchTime.now().uptimeNanoseconds),
            isFinal: true
        )
        nextSeq += 1
        enqueue(finalFragment)

        drainTask?.cancel()
        drainTask = nil
        await drainOnce()

        if totalEnqueued > 0 && totalDispatched == totalEnqueued {
            status = .done
        } else {
            updateStatus()
        }
    }

    // MARK: - Queue management

    private func enqueue(_ fragment: PendingFragment) {
        if queue.count >= Self.maxQueueDepth {
            queue.removeFirst()
            print("[VideoUploader] queue full — dropped oldest fragment (backpressure)")
        }
        queue.append(fragment)
        totalEnqueued += 1
        updateStatus()
    }

    // Sticky: once .uploading, stay there until .done.
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

    // MARK: - Drain loop

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

        for (idx, fragment) in batch.enumerated() {
            if Task.isCancelled {
                queue = Array(batch[idx...]) + queue
                return
            }
            do {
                try await sendFragment(fragment)
                totalDispatched += 1
                updateStatus()
            } catch {
                let message = "\(error)"
                lastError = message
                print("[VideoUploader] send failed (seq=\(fragment.seq)): \(message) - will retry")
                queue = Array(batch[idx...]) + queue
                return
            }
        }
    }

    // MARK: - Send

    private func sendFragment(_ fragment: PendingFragment) async throws {
        guard let transport else { throw VideoUploaderError.noTransport }
        let b64 = fragment.bytes.base64EncodedString()
        var params: [String: JSONValue] = [
            "media_id": .string(mediaId),
            "seq": .number(Double(fragment.seq)),
            "bytes": .string(b64),
            "mime": .string("video/mp4"),
            "captured_at_ns": .number(Double(fragment.capturedAtNs)),
        ]
        if fragment.isFinal {
            params["final"] = .bool(true)
        }
        let frame = RequestFrame(
            id: UUID().uuidString,
            method: "media.chunk.upload",
            params: params
        )
        let resp = try await transport.send(frame)
        if !resp.ok {
            let msg = resp.error?.message ?? "media.chunk.upload failed"
            throw VideoUploaderError.rpcError(msg)
        }
        lastError = nil
    }
}

enum VideoUploaderError: Error {
    case noTransport
    case rpcError(String)
}

private struct PendingKeyframe {
    let seq: Int
    let bytes: Data
    let capturedAtNs: UInt64
}

@MainActor
final class KeyframeUploader: ObservableObject {

    static let maxQueueDepth = 12

    @Published private(set) var status: UploaderStatus = .idle
    @Published private(set) var queueDepth: Int = 0
    @Published private(set) var droppedCount: Int = 0
    @Published private(set) var lastError: String?

    private var transport: GatewayTransport?
    private var captureId: String = ""
    private var nextSeq: Int = 0
    private var totalEnqueued: Int = 0
    private var totalDispatched: Int = 0
    private var queue: [PendingKeyframe] = []
    private var drainTask: Task<Void, Never>?

    func start(transport: GatewayTransport?, captureId: String) {
        self.transport = transport
        self.captureId = captureId
        self.nextSeq = 0
        self.totalEnqueued = 0
        self.totalDispatched = 0
        self.queue.removeAll()
        self.queueDepth = 0
        self.droppedCount = 0
        self.lastError = nil

        status = (transport?.isConnected == true)
            ? .uploading(sent: 0, total: 0)
            : .localOnly

        drainTask?.cancel()
        drainTask = Task { [weak self] in
            await self?.drainLoop()
        }
    }

    func ingest(jpegBytes: Data, capturedAtNs: UInt64) {
        guard !captureId.isEmpty else { return }
        let frame = PendingKeyframe(seq: nextSeq, bytes: jpegBytes, capturedAtNs: capturedAtNs)
        nextSeq += 1
        enqueue(frame)
    }

    func stop() async {
        guard !captureId.isEmpty else { return }
        drainTask?.cancel()
        drainTask = nil
        await drainOnce()
        status = totalEnqueued > 0 && totalDispatched == totalEnqueued ? .done : status
        captureId = ""
    }

    private func enqueue(_ frame: PendingKeyframe) {
        if queue.count >= Self.maxQueueDepth {
            queue.removeFirst()
            droppedCount += 1
            print("[KeyframeUploader] queue full — dropped oldest frame (backpressure)")
        }
        queue.append(frame)
        queueDepth = queue.count
        totalEnqueued += 1
        updateStatus()
    }

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
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
    }

    private func drainOnce() async {
        guard transport?.isConnected == true, !queue.isEmpty else { return }
        let batch = queue
        queue.removeAll()
        queueDepth = queue.count

        for (idx, frame) in batch.enumerated() {
            if Task.isCancelled {
                queue = Array(batch[idx...]) + queue
                queueDepth = queue.count
                return
            }
            do {
                try await send(frame)
                totalDispatched += 1
                lastError = nil
                updateStatus()
            } catch {
                let message = "\(error)"
                lastError = message
                print("[KeyframeUploader] send failed (seq=\(frame.seq)): \(message) - will retry")
                queue = Array(batch[idx...]) + queue
                queueDepth = queue.count
                return
            }
        }
    }

    private func send(_ frame: PendingKeyframe) async throws {
        guard let transport else { throw VideoUploaderError.noTransport }
        let params: [String: JSONValue] = [
            "session_key": .string(captureId),
            "media_kind": .string("frame"),
            "bytes": .string(frame.bytes.base64EncodedString()),
            "mime": .string("image/jpeg"),
            "ts_captured_ns": .number(Double(frame.capturedAtNs)),
        ]
        let request = RequestFrame(
            id: UUID().uuidString,
            method: "media.chunk.upload",
            params: params
        )
        let response = try await transport.send(request)
        if !response.ok {
            let msg = response.error?.message ?? "media.chunk.upload frame failed"
            throw VideoUploaderError.rpcError(msg)
        }
    }
}
