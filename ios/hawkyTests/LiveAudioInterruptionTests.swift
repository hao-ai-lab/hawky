import XCTest
import AVFoundation
@testable import hawky

// =============================================================================
// #673 (mid-session): when a call / another app grabs the mic, iOS deactivates
// our audio session and Live can no longer hear the user. Live must auto-pause
// (and notify) rather than sit "connected" with a dead mic — but ONLY on the
// interruption's .began edge while actively connected. It must NOT act on .ended
// (no auto-resume) or when already paused/idle. This pins that decision matrix.
// =============================================================================
@MainActor
final class LiveAudioInterruptionTests: XCTestCase {
    func testAutoPausesOnBeganWhileConnectedAndCapturing() {
        XCTAssertTrue(LiveSessionStore.shouldAutoPause(forInterruptionType: .began, phase: .connected, isCapturingMic: true))
    }

    func testDoesNotAutoPauseOnEnded() {
        XCTAssertFalse(LiveSessionStore.shouldAutoPause(forInterruptionType: .ended, phase: .connected, isCapturingMic: true))
    }

    func testDoesNotAutoPauseWhenNotConnected() {
        XCTAssertFalse(LiveSessionStore.shouldAutoPause(forInterruptionType: .began, phase: .paused, isCapturingMic: true))
        XCTAssertFalse(LiveSessionStore.shouldAutoPause(forInterruptionType: .began, phase: .idle, isCapturingMic: true))
        XCTAssertFalse(LiveSessionStore.shouldAutoPause(forInterruptionType: .began, phase: .connecting, isCapturingMic: true))
    }

    func testDoesNotAutoPauseWhenTypeMissing() {
        XCTAssertFalse(LiveSessionStore.shouldAutoPause(forInterruptionType: nil, phase: .connected, isCapturingMic: true))
    }

    func testDoesNotAutoPauseTextOnlySessionNotCapturingMic() {
        // Mic off (text/listen-only): nothing to lose, so don't force-pause with
        // a misleading "microphone is in use" notice.
        XCTAssertFalse(LiveSessionStore.shouldAutoPause(forInterruptionType: .began, phase: .connected, isCapturingMic: false))
    }

    // MARK: no-audio watchdog (connected but mic captured nothing)

    func testWarnsWhenNoMicChunksAfterConnect() {
        XCTAssertTrue(LiveSessionStore.shouldWarnNoMicInput(
            capturedChunks: 0, baseline: 0, phase: .connected, isStreamingAudio: true))
    }

    func testDoesNotWarnWhenMicChunksArrived() {
        XCTAssertFalse(LiveSessionStore.shouldWarnNoMicInput(
            capturedChunks: 12, baseline: 0, phase: .connected, isStreamingAudio: true))
    }

    func testDoesNotWarnWhenNotStreamingOrNotConnected() {
        XCTAssertFalse(LiveSessionStore.shouldWarnNoMicInput(
            capturedChunks: 0, baseline: 0, phase: .connected, isStreamingAudio: false))
        XCTAssertFalse(LiveSessionStore.shouldWarnNoMicInput(
            capturedChunks: 0, baseline: 0, phase: .paused, isStreamingAudio: true))
    }

    // MARK: auto-recovery window (interruption / background → restart on return)

    func testRecoversWhenArmedWithinWindow() {
        let now = Date()
        XCTAssertTrue(LiveSessionStore.shouldRecoverInterruptedSession(
            deadline: now.addingTimeInterval(60), now: now))
    }

    func testDoesNotRecoverWhenWindowExpired() {
        let now = Date()
        XCTAssertFalse(LiveSessionStore.shouldRecoverInterruptedSession(
            deadline: now.addingTimeInterval(-1), now: now))
    }

    func testDoesNotRecoverWhenNotArmed() {
        XCTAssertFalse(LiveSessionStore.shouldRecoverInterruptedSession(
            deadline: nil, now: Date()))
    }
}
