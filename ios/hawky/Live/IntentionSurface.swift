import Foundation

// STATIC REVIEW ONLY — no Swift/Xcode in CI; verified by grep.

// MARK: - Types

/// What the caller must do after `floorAction` returns.
enum SurfaceFloorAction: Equatable {
    /// Floor free and speak=true: send response.create immediately.
    case speakNow
    /// speak=false (or downgradeToContext): item already added; no response.create.
    case contextOnly
    /// Floor busy, cancelAndReplace: cancel active response, truncate, then response.create.
    case cancelThenSpeak
    /// Floor busy, queue: item was added to the TTL queue; drain on next response.done.
    case enqueue
}

/// Busy policy forwarded from the gateway's DeliveryDecision.busy field (§6).
enum SurfaceBusyPolicy: Equatable {
    /// Add context silently; no response.create.
    case downgradeToContext
    /// Cancel active response, truncate audio, then response.create.
    case cancelAndReplace
    /// Enqueue; drain on next response.done (TTL guarded).
    case queue
}

/// Voice-status of a surface item — mirrors the gateway contract.
enum SurfaceVoiceStatus: Equatable {
    case spoken      // response.create was sent (or will be after truncation)
    case waiting     // enqueued; will speak on next gap
    case context     // item injected silently; no response.create
}

/// A queued surface item with TTL.
struct QueuedSurface: Equatable {
    let text: String
    let expiresAt: Date
}

// MARK: - Pure state machine

/// Pure floor-guard state machine (§5, M1 delivery spine).
///
/// Holds only value-typed state — no URLSession, no WebSocket, no UI deps.
/// Callers (OpenAIRealtimeLiveSessionProvider) drive it and execute the
/// returned actions themselves.
struct SurfaceStateMachine {

    // MARK: Floor state

    /// True between response.created and response.done/cancelled.
    private(set) var responseActive: Bool = false
    /// Item id of the current assistant output item (from response.output_item.added).
    private(set) var currentAssistantItemId: String?
    /// Best-effort played audio offset in ms for truncation.
    // TODO(device): tune audio_end_ms; requires real audio player position
    private(set) var playedMs: Int = 0
    /// Whether playback is currently active (set by caller from audio events).
    private(set) var playbackActive: Bool = false

    // MARK: Queue

    /// Bounded queue of surface items awaiting the next response gap (TTL guarded).
    private(set) var queuedSurface: [QueuedSurface] = []
    let queueMaxSize: Int
    let queueTTL: TimeInterval

    init(queueMaxSize: Int = 10, queueTTL: TimeInterval = 120) {
        self.queueMaxSize = queueMaxSize
        self.queueTTL = queueTTL
    }

    // MARK: Core decision

    /// Pure floor-guard decision. Returns what the caller must do.
    ///
    /// The caller is responsible for actually sending the WebSocket messages;
    /// this function only decides the action and, if `.enqueue`, appends to the
    /// internal queue via `mutating` state.
    mutating func floorAction(
        speak: Bool,
        floorFree: Bool,
        whenBusy: SurfaceBusyPolicy,
        text: String,
        now: Date = Date()
    ) -> SurfaceFloorAction {
        guard speak else { return .contextOnly }

        if floorFree {
            return .speakNow
        }

        // Floor is busy — apply strategy
        switch whenBusy {
        case .downgradeToContext:
            return .contextOnly

        case .cancelAndReplace:
            return .cancelThenSpeak

        case .queue:
            // Evict expired entries and respect max size
            queuedSurface = queuedSurface.filter { $0.expiresAt > now }
            if queuedSurface.count < queueMaxSize {
                queuedSurface.append(QueuedSurface(
                    text: text,
                    expiresAt: now.addingTimeInterval(queueTTL)
                ))
            }
            return .enqueue
        }
    }

    /// Inferred voice-status from a floor action.
    static func voiceStatus(for action: SurfaceFloorAction) -> SurfaceVoiceStatus {
        switch action {
        case .speakNow, .cancelThenSpeak:
            return .spoken
        case .enqueue:
            return .waiting
        case .contextOnly:
            return .context
        }
    }

    // MARK: Event callbacks

    /// Call when response.created arrives — marks floor busy.
    mutating func markResponseStarted() {
        responseActive = true
    }

    /// Call when response.output_item.added arrives — records item id for truncation.
    mutating func markOutputItemAdded(itemId: String) {
        currentAssistantItemId = itemId
    }

    /// Call when response.done arrives — clears floor, dequeues exactly one
    /// survivor for the caller to send as response.create.  Expired items ahead
    /// of the first survivor are dropped; the rest remain queued.
    /// Returns nil when the queue is empty or all items have expired.
    mutating func markResponseDone(now: Date = Date()) -> QueuedSurface? {
        responseActive = false
        currentAssistantItemId = nil
        return dequeueNextSurvivor(now: now)
    }

    // MARK: Queue helpers

    /// Removes and returns the first non-expired item, dropping any expired
    /// items that precede it.  Items after the first survivor stay in the queue.
    mutating func dequeueNextSurvivor(now: Date = Date()) -> QueuedSurface? {
        // Drop leading expired entries
        while let first = queuedSurface.first, first.expiresAt <= now {
            queuedSurface.removeFirst()
        }
        guard !queuedSurface.isEmpty else { return nil }
        return queuedSurface.removeFirst()
    }

    /// Non-expired items in arrival order, and clears the queue.
    /// Used by tests; callers should prefer dequeueNextSurvivor for one-at-a-time drain.
    mutating func surviving(now: Date = Date()) -> [QueuedSurface] {
        let valid = queuedSurface.filter { $0.expiresAt > now }
        queuedSurface = []
        return valid
    }

    // MARK: Playback tracking

    mutating func updatePlayback(active: Bool, playedMs: Int) {
        self.playbackActive = active
        self.playedMs = playedMs
    }
}
