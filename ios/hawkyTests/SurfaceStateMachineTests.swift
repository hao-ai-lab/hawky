import Testing
import Foundation
@testable import hawky

// MARK: - SurfaceStateMachine tests
// Ported from B4 (origin/rt-delivery-state-machine).
// Pure state-machine tests — no live session, no WebSocket needed.

@Suite struct SurfaceStateMachineTests {

    // MARK: floorAction — floor free

    @Test func speakNowWhenFloorFreeAndSpeakTrue() {
        var sm = SurfaceStateMachine()
        let action = sm.floorAction(speak: true, floorFree: true, whenBusy: .queue, text: "hello")
        #expect(action == .speakNow)
    }

    @Test func contextOnlyWhenFloorFreeAndSpeakFalse() {
        var sm = SurfaceStateMachine()
        let action = sm.floorAction(speak: false, floorFree: true, whenBusy: .queue, text: "hello")
        #expect(action == .contextOnly)
    }

    // MARK: floorAction — floor busy, downgradeToContext

    @Test func contextOnlyWhenBusyAndDowngrade() {
        var sm = SurfaceStateMachine()
        sm.markResponseStarted()
        let action = sm.floorAction(speak: true, floorFree: false, whenBusy: .downgradeToContext, text: "hello")
        #expect(action == .contextOnly)
    }

    // MARK: floorAction — floor busy, cancelAndReplace

    @Test func cancelThenSpeakWhenBusyAndCancelAndReplace() {
        var sm = SurfaceStateMachine()
        sm.markResponseStarted()
        let action = sm.floorAction(speak: true, floorFree: false, whenBusy: .cancelAndReplace, text: "hello")
        #expect(action == .cancelThenSpeak)
    }

    // MARK: floorAction — floor busy, queue

    @Test func enqueueWhenBusyAndQueue() {
        var sm = SurfaceStateMachine()
        sm.markResponseStarted()
        let action = sm.floorAction(speak: true, floorFree: false, whenBusy: .queue, text: "hello")
        #expect(action == .enqueue)
        #expect(sm.queuedSurface.count == 1)
        #expect(sm.queuedSurface[0].text == "hello")
    }

    @Test func enqueueDoesNotExceedMaxSize() {
        var sm = SurfaceStateMachine(queueMaxSize: 2)
        sm.markResponseStarted()
        _ = sm.floorAction(speak: true, floorFree: false, whenBusy: .queue, text: "a")
        _ = sm.floorAction(speak: true, floorFree: false, whenBusy: .queue, text: "b")
        _ = sm.floorAction(speak: true, floorFree: false, whenBusy: .queue, text: "c") // should be dropped
        #expect(sm.queuedSurface.count == 2)
        #expect(sm.queuedSurface[0].text == "a")
        #expect(sm.queuedSurface[1].text == "b")
    }

    // MARK: TTL expiry

    @Test func expiredItemsEvictedOnEnqueue() {
        var sm = SurfaceStateMachine(queueMaxSize: 10, queueTTL: 60)
        sm.markResponseStarted()

        // Manually inject an expired item
        // (floorAction uses Date() internally; we simulate expiry by using surviving)
        _ = sm.floorAction(speak: true, floorFree: false, whenBusy: .queue, text: "fresh",
                           now: Date())
        // Expire it by advancing "now" past TTL
        let futureNow = Date(timeIntervalSinceNow: 300)
        let survived = sm.surviving(now: futureNow)
        #expect(survived.isEmpty)
        #expect(sm.queuedSurface.isEmpty)
    }

    @Test func nonExpiredItemsSurvive() {
        var sm = SurfaceStateMachine(queueMaxSize: 10, queueTTL: 600)
        sm.markResponseStarted()
        _ = sm.floorAction(speak: true, floorFree: false, whenBusy: .queue, text: "keep me")
        let survived = sm.surviving(now: Date())
        #expect(survived.count == 1)
        #expect(survived[0].text == "keep me")
    }

    // MARK: markResponseDone / drain

    @Test func markResponseDoneResetsFloorAndReturnsOneItem() {
        var sm = SurfaceStateMachine()
        sm.markResponseStarted()
        sm.markOutputItemAdded(itemId: "item_123")
        _ = sm.floorAction(speak: true, floorFree: false, whenBusy: .queue, text: "queued")
        #expect(sm.responseActive == true)
        #expect(sm.currentAssistantItemId == "item_123")

        let next = sm.markResponseDone()
        #expect(sm.responseActive == false)
        #expect(sm.currentAssistantItemId == nil)
        #expect(next?.text == "queued")
        #expect(sm.queuedSurface.isEmpty)
    }

    @Test func markResponseDoneWithEmptyQueueReturnsNil() {
        var sm = SurfaceStateMachine()
        sm.markResponseStarted()
        let next = sm.markResponseDone()
        #expect(next == nil)
        #expect(sm.responseActive == false)
    }

    // MARK: dequeueNextSurvivor — 3 queued items drain one-per-response-gap

    @Test func threeQueuedItemsDrainOnePerResponseGap() {
        var sm = SurfaceStateMachine()
        sm.markResponseStarted()
        _ = sm.floorAction(speak: true, floorFree: false, whenBusy: .queue, text: "first")
        _ = sm.floorAction(speak: true, floorFree: false, whenBusy: .queue, text: "second")
        _ = sm.floorAction(speak: true, floorFree: false, whenBusy: .queue, text: "third")
        #expect(sm.queuedSurface.count == 3)

        // Drain 1: response.done → dequeue "first", two remain
        let drain1 = sm.markResponseDone()
        #expect(drain1?.text == "first")
        #expect(sm.queuedSurface.count == 2)

        // Drain 2: new response cycle → dequeue "second", one remains
        sm.markResponseStarted()
        let drain2 = sm.markResponseDone()
        #expect(drain2?.text == "second")
        #expect(sm.queuedSurface.count == 1)

        // Drain 3: new response cycle → dequeue "third", queue empty
        sm.markResponseStarted()
        let drain3 = sm.markResponseDone()
        #expect(drain3?.text == "third")
        #expect(sm.queuedSurface.isEmpty)
    }

    @Test func expiredItemsSkippedDuringDequeue() {
        var sm = SurfaceStateMachine(queueMaxSize: 10, queueTTL: 60)
        let baseNow = Date()
        sm.markResponseStarted()
        // Enqueue two items; both fresh at enqueue time
        _ = sm.floorAction(speak: true, floorFree: false, whenBusy: .queue, text: "will-expire", now: baseNow)
        _ = sm.floorAction(speak: true, floorFree: false, whenBusy: .queue, text: "fresh", now: baseNow)
        #expect(sm.queuedSurface.count == 2)

        // Drain well past TTL: "will-expire" is dropped, "fresh" is dequeued
        let futureNow = baseNow.addingTimeInterval(300)
        let next = sm.dequeueNextSurvivor(now: futureNow)
        #expect(next == nil) // both expired (TTL=60, advanced 300s)
        #expect(sm.queuedSurface.isEmpty)
    }

    @Test func expiredLeadingItemsDroppedFreshSurvivorDequeued() {
        var sm = SurfaceStateMachine(queueMaxSize: 10, queueTTL: 240)
        let baseNow = Date()
        // Inject items at different times so we can expire only the first
        _ = sm.floorAction(speak: true, floorFree: false, whenBusy: .queue, text: "expired-soon", now: baseNow)
        // Enqueue second item 200s later (expiresAt = baseNow + 200 + 240 = +440)
        let laterNow = baseNow.addingTimeInterval(200)
        _ = sm.floorAction(speak: true, floorFree: false, whenBusy: .queue, text: "still-valid", now: laterNow)
        #expect(sm.queuedSurface.count == 2)

        // Drain at baseNow + 300: first item expired (expiresAt = baseNow+240), second valid
        let drainNow = baseNow.addingTimeInterval(300)
        let next = sm.dequeueNextSurvivor(now: drainNow)
        #expect(next?.text == "still-valid")
        #expect(sm.queuedSurface.isEmpty)
    }

    // MARK: voiceStatus mapping

    @Test func voiceStatusSpeakNow() {
        #expect(SurfaceStateMachine.voiceStatus(for: .speakNow) == .spoken)
    }

    @Test func voiceStatusCancelThenSpeak() {
        #expect(SurfaceStateMachine.voiceStatus(for: .cancelThenSpeak) == .spoken)
    }

    @Test func voiceStatusEnqueue() {
        #expect(SurfaceStateMachine.voiceStatus(for: .enqueue) == .waiting)
    }

    @Test func voiceStatusContextOnly() {
        #expect(SurfaceStateMachine.voiceStatus(for: .contextOnly) == .context)
    }

    // MARK: playback tracking

    @Test func updatePlayback() {
        var sm = SurfaceStateMachine()
        #expect(sm.playbackActive == false)
        #expect(sm.playedMs == 0)
        sm.updatePlayback(active: true, playedMs: 1500)
        #expect(sm.playbackActive == true)
        #expect(sm.playedMs == 1500)
    }

    // MARK: re-emit guard (speak=false is idempotent)

    @Test func contextOnlyNeverEnqueues() {
        var sm = SurfaceStateMachine()
        sm.markResponseStarted()
        _ = sm.floorAction(speak: false, floorFree: false, whenBusy: .queue, text: "silent")
        #expect(sm.queuedSurface.isEmpty)
    }

    // MARK: markResponseStarted / output item id

    @Test func markOutputItemAddedStoredId() {
        var sm = SurfaceStateMachine()
        sm.markResponseStarted()
        #expect(sm.currentAssistantItemId == nil)
        sm.markOutputItemAdded(itemId: "abc")
        #expect(sm.currentAssistantItemId == "abc")
    }
}
