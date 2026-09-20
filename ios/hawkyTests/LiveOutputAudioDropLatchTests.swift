import XCTest
@testable import hawky

// =============================================================================
// #18 (delta-revive latch): when user speech barges in we stop the player, but
// late `.outputAudioDelta`s from the just-cancelled response keep arriving and
// would play() again — reviving audio the user meant to interrupt. The store
// latches on the barge-in playback stop and DROPS subsequent output-audio deltas
// until the next response boundary (`response.created`), then lets the new turn's
// audio through. This pins that state machine via the pure decision helpers
// (the routing seam lives on a @MainActor store, so the logic is factored into
// testable statics like the #673 interruption helpers).
// =============================================================================
@MainActor
final class LiveOutputAudioDropLatchTests: XCTestCase {
    // MARK: latch engage on barge-in

    func testLatchEngagesWhenBargeInStopsPlayback() {
        XCTAssertTrue(LiveSessionStore.outputAudioDropLatchOnSpeechStart(
            stopsPlayback: true, current: false))
    }

    func testLatchStaysOffWhenBargeInDoesNotStopPlayback() {
        // let-assistant-finish / full-duplex: playback isn't stopped, so there's
        // nothing to protect and we must not start dropping the model's audio.
        XCTAssertFalse(LiveSessionStore.outputAudioDropLatchOnSpeechStart(
            stopsPlayback: false, current: false))
    }

    func testLatchIsIdempotentOnRepeatedSpeechStarts() {
        // A second speech_started before the next response boundary keeps it set.
        XCTAssertTrue(LiveSessionStore.outputAudioDropLatchOnSpeechStart(
            stopsPlayback: true, current: true))
    }

    func testNonStoppingSpeechStartLeavesAnExistingLatchUntouched() {
        XCTAssertTrue(LiveSessionStore.outputAudioDropLatchOnSpeechStart(
            stopsPlayback: false, current: true))
    }

    // MARK: latch release on response boundary

    func testResponseCreatedReleasesLatch() {
        XCTAssertFalse(LiveSessionStore.outputAudioDropLatchOnResponseCreated())
    }

    // MARK: latch release on response TERMINAL boundary (review finding, line 3823)

    func testResponseTerminalReleasesLatch() {
        // A spurious speech_started (noise) can stop playback and latch WITHOUT a
        // following response.created. Releasing at the interrupted response's own
        // terminal event bounds the latch to one response lifetime so the tail of a
        // still-active response is not stranded/dropped indefinitely.
        XCTAssertFalse(LiveSessionStore.outputAudioDropLatchOnResponseTerminal())
    }

    func testTerminalRawTypeClassification() {
        XCTAssertTrue(LiveSessionStore.isResponseTerminalRawType("response.done"))
        XCTAssertTrue(LiveSessionStore.isResponseTerminalRawType("response.cancelled"))
        XCTAssertTrue(LiveSessionStore.isResponseTerminalRawType("response.failed"))
        // Not terminal: creation boundary and unrelated events must not trip it.
        XCTAssertFalse(LiveSessionStore.isResponseTerminalRawType("response.created"))
        XCTAssertFalse(LiveSessionStore.isResponseTerminalRawType("response.output_audio.delta"))
        XCTAssertFalse(LiveSessionStore.isResponseTerminalRawType("input_audio_buffer.speech_started"))
    }

    func testSpuriousSpeechStartThenTerminalReleasesLatch() {
        // End-to-end (pure): noise stops playback -> latch engages -> no new
        // response.created ever arrives -> the current response ends
        // (response.done) -> latch releases so a later response's audio plays.
        var latched = LiveSessionStore.outputAudioDropLatchOnSpeechStart(
            stopsPlayback: true, current: false)
        XCTAssertTrue(LiveSessionStore.shouldDropOutputAudioDelta(latched: latched))

        // Interrupted response terminates without a new response.created.
        XCTAssertTrue(LiveSessionStore.isResponseTerminalRawType("response.done"))
        latched = LiveSessionStore.outputAudioDropLatchOnResponseTerminal()
        XCTAssertFalse(LiveSessionStore.shouldDropOutputAudioDelta(latched: latched))
    }

    // MARK: delta routing

    func testDropsDeltaWhileLatched() {
        XCTAssertTrue(LiveSessionStore.shouldDropOutputAudioDelta(latched: true))
    }

    func testPlaysDeltaWhenNotLatched() {
        XCTAssertFalse(LiveSessionStore.shouldDropOutputAudioDelta(latched: false))
    }

    // MARK: documented residual edge — post-terminal stray delta (review finding, line 6039)
    //
    // Revival safety depends on the WS wire order delivering a response's deltas
    // BEFORE its terminal event; the client does not enforce it. This pins the
    // ACCEPTED, bounded consequence so it stays a conscious contract: once terminal
    // releases the latch, a stray late delta for the SAME (now-terminated) response
    // is NOT protected — it plays. If a future change adds per-response floor
    // tracking to close this edge, this test must be updated deliberately.
    func testStrayDeltaAfterTerminalReleaseIsNotDroppedByLatch() {
        // Barge-in latches; the interrupted response's deltas are dropped in order.
        var latched = LiveSessionStore.outputAudioDropLatchOnSpeechStart(
            stopsPlayback: true, current: false)
        XCTAssertTrue(LiveSessionStore.shouldDropOutputAudioDelta(latched: latched))

        // Terminal arrives (in order) and releases the latch.
        latched = LiveSessionStore.outputAudioDropLatchOnResponseTerminal()

        // A stray delta that (hypothetically) arrives AFTER terminal is no longer
        // gated by the latch — documented single-delta revival window, not a bug.
        XCTAssertFalse(
            LiveSessionStore.shouldDropOutputAudioDelta(latched: latched),
            "post-terminal deltas are not latch-protected; revival safety is a wire-ordering assumption")
    }

    // MARK: integration — real .raw routing releases the latch (review finding, line 5985)
    //
    // The pure-helper tests above mirror the wiring but do NOT prove that a received
    // response.created / terminal raw event actually clears the latch through
    // handle(.raw) -> updateConversationState. These drive the REAL store routing via
    // the DEBUG seam so a future refactor that drops/reorders that call fails here.

    func testReceivedResponseCreatedReleasesLatchThroughRealRouting() {
        let store = LiveSessionStore(config: LiveSessionConfig())
        store.debugSetOutputAudioDropLatched(true)
        XCTAssertTrue(store.debugOutputAudioDropLatched)

        store.debugRouteReceivedRawEvent(type: "response.created")

        XCTAssertFalse(
            store.debugOutputAudioDropLatched,
            "response.created must clear the drop latch via updateConversationState")
    }

    func testReceivedResponseTerminalReleasesLatchThroughRealRouting() {
        // Covers the spurious-noise case: latch is set, only a terminal event
        // (never a new response.created) arrives, and it must still release.
        for terminal in ["response.done", "response.cancelled", "response.failed"] {
            let store = LiveSessionStore(config: LiveSessionConfig())
            store.debugSetOutputAudioDropLatched(true)

            store.debugRouteReceivedRawEvent(type: terminal)

            XCTAssertFalse(
                store.debugOutputAudioDropLatched,
                "\(terminal) must clear the drop latch via updateConversationState")
        }
    }

    // MARK: terminal-set / real-routing lockstep (review finding, line 6045)
    //
    // The unconditional latch release in the `response.done/cancelled/failed` case
    // relies on that switch label being EXACTLY the set `isResponseTerminalRawType`
    // reports. If a future edit adds a raw type to the switch label but forgets the
    // classifier (or vice versa) the two lists silently diverge. This pins the
    // parity: for a representative type universe, "classified terminal" iff "the
    // real router releases the latch". A divergence flips exactly one side and fails.
    func testTerminalClassifierAndRealRoutingStayInLockstep() {
        let candidateRawTypes = [
            "response.done", "response.cancelled", "response.failed",
            "response.created", "response.output_audio.delta",
            "input_audio_buffer.speech_started", "response.output_text.delta",
        ]
        for type in candidateRawTypes {
            let classifiedTerminal = LiveSessionStore.isResponseTerminalRawType(type)

            let store = LiveSessionStore(config: LiveSessionConfig())
            store.debugSetOutputAudioDropLatched(true)
            store.debugRouteReceivedRawEvent(type: type)
            // response.created also releases, so it is excluded from the terminal
            // side of the parity by using a fresh store that stays latched unless
            // THIS type is the terminal release path.
            let releasedByRouting = !store.debugOutputAudioDropLatched

            if type == "response.created" {
                // Creation boundary releases too but is NOT terminal — assert it is
                // not misclassified as terminal, and skip the parity equality.
                XCTAssertFalse(
                    classifiedTerminal,
                    "response.created is a creation boundary, not a terminal type")
                continue
            }
            XCTAssertEqual(
                classifiedTerminal, releasedByRouting,
                "terminal classifier and real-routing latch release diverged for \(type)")
        }
    }

    func testBargeInSpeechStartEngagesLatchThroughRealRouting() {
        // Default barge-in policy (.interruptAssistant) stops playback, so a
        // received speech_started must engage the latch through handleRealtimeRawEvent.
        let store = LiveSessionStore(config: LiveSessionConfig())
        XCTAssertFalse(store.debugOutputAudioDropLatched)

        store.debugRouteReceivedRawEvent(type: "input_audio_buffer.speech_started")

        XCTAssertTrue(
            store.debugOutputAudioDropLatched,
            "a barge-in speech_started must engage the drop latch via handleRealtimeRawEvent")
    }

    // MARK: latch never carries across a WS reconnect (review finding, line 3817)
    //
    // The store instance is long-lived across an in-session WS reconnect (unlike a
    // stop/restart, which tears down and clears the latch). If the socket blipped
    // while the latch was engaged, the stranded latch would otherwise persist into
    // the reconnected leg and drop the tail of a still-active response. The
    // `.reconnect` handler must fail-closed by clearing it. This drives the REAL
    // top-level `handle(_:)` routing so a future edit dropping the clear fails here.

    func testReconnectClearsDropLatchThroughRealRouting() {
        let store = LiveSessionStore(config: LiveSessionConfig())
        store.debugSetOutputAudioDropLatched(true)
        XCTAssertTrue(store.debugOutputAudioDropLatched)

        store.debugRouteSessionEvent(.reconnect(count: 1))

        XCTAssertFalse(
            store.debugOutputAudioDropLatched,
            "a WS reconnect must clear the barge-in drop latch so it never carries into the reconnected session")
    }

    // MARK: end-to-end sequence (barge-in -> drop -> new turn plays)

    func testBargeInThenNewResponsePlaysAgain() {
        // Start clean: deltas play.
        var latched = false
        XCTAssertFalse(LiveSessionStore.shouldDropOutputAudioDelta(latched: latched))

        // User barges in, playback stops -> latch engages, stray deltas dropped.
        latched = LiveSessionStore.outputAudioDropLatchOnSpeechStart(
            stopsPlayback: true, current: latched)
        XCTAssertTrue(LiveSessionStore.shouldDropOutputAudioDelta(latched: latched))

        // Late deltas from the cancelled response are still dropped.
        XCTAssertTrue(LiveSessionStore.shouldDropOutputAudioDelta(latched: latched))

        // New response boundary -> latch releases, new turn audio plays.
        latched = LiveSessionStore.outputAudioDropLatchOnResponseCreated()
        XCTAssertFalse(LiveSessionStore.shouldDropOutputAudioDelta(latched: latched))
    }
}
