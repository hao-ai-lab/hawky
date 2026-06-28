import Testing
import PipecatClientIOS
@testable import hawky

@MainActor
@Suite struct LiveRealtimeResponseFloorTests {
    @Test func userStopDuringActiveRealtimeResponseQueuesManualCreate() async {
        let provider = PipecatOpenAIRealtimeLiveSessionProvider()
        provider.debugSetManualResponseMode(true)

        provider.onServerMessage(data: .object(["type": .string("response.created")]))
        await Task.yield()

        #expect(provider.debugRealtimeResponseActive)
        #expect(provider.debugResponseFloorBusy)

        provider.onUserStoppedSpeaking()
        await Task.yield()

        #expect(provider.debugRealtimeResponseActive)
        #expect(provider.debugPendingManualResponseCreate)

        await provider.close()
    }

    @Test func responseDoneDoesNotClearPlaybackFloor() async {
        let provider = PipecatOpenAIRealtimeLiveSessionProvider()
        provider.debugSetManualResponseMode(true)

        provider.onServerMessage(data: .object(["type": .string("response.created")]))
        await Task.yield()
        provider.onServerMessage(data: .object(["type": .string("response.done")]))
        await Task.yield()

        #expect(provider.debugRealtimeResponseActive == false)
        #expect(provider.debugResponseFloorBusy)

        await provider.close()
    }

    @Test func responseDoneDoesNotDrainPendingUserTurnWhilePlaybackBusy() async {
        let provider = PipecatOpenAIRealtimeLiveSessionProvider()
        provider.debugSetManualResponseMode(true)

        provider.onServerMessage(data: .object(["type": .string("response.created")]))
        await Task.yield()
        provider.onUserStoppedSpeaking()
        await Task.yield()
        provider.onServerMessage(data: .object(["type": .string("response.done")]))
        await Task.yield()

        #expect(provider.debugRealtimeResponseActive == false)
        #expect(provider.debugResponseFloorBusy)
        #expect(provider.debugPendingManualResponseCreate)

        await provider.close()
    }

    @Test func queuedUserTurnFallbackClearsMissingPlaybackStop() async {
        let provider = PipecatOpenAIRealtimeLiveSessionProvider()
        provider.debugSetManualResponseMode(true)
        provider.debugSetQueuedTurnPlaybackDrainFallbackNs(1_000_000)

        provider.onServerMessage(data: .object(["type": .string("response.created")]))
        await Task.yield()
        provider.onUserStoppedSpeaking()
        await Task.yield()
        provider.onServerMessage(data: .object(["type": .string("response.done")]))
        await Task.yield()

        #expect(provider.debugRealtimeResponseActive == false)
        #expect(provider.debugResponseFloorBusy)
        #expect(provider.debugPendingManualResponseCreate)

        for _ in 0..<50 {
            if !provider.debugResponseFloorBusy { break }
            try? await Task.sleep(nanoseconds: 1_000_000)
        }

        #expect(provider.debugResponseFloorBusy == false)
        #expect(provider.debugPendingManualResponseCreate)

        await provider.close()
    }

    @Test func queuedUserTurnAfterServerDoneUsesPlaybackFallback() async {
        let provider = PipecatOpenAIRealtimeLiveSessionProvider()
        provider.debugSetManualResponseMode(true)
        provider.debugSetQueuedTurnPlaybackDrainFallbackNs(1_000_000)

        provider.onServerMessage(data: .object(["type": .string("response.created")]))
        await Task.yield()
        provider.onServerMessage(data: .object(["type": .string("response.done")]))
        await Task.yield()

        #expect(provider.debugRealtimeResponseActive == false)
        #expect(provider.debugResponseFloorBusy)
        #expect(provider.debugPendingManualResponseCreate == false)

        provider.onUserStoppedSpeaking()
        await Task.yield()

        #expect(provider.debugPendingManualResponseCreate)

        for _ in 0..<50 {
            if !provider.debugResponseFloorBusy { break }
            try? await Task.sleep(nanoseconds: 1_000_000)
        }

        #expect(provider.debugResponseFloorBusy == false)
        #expect(provider.debugPendingManualResponseCreate)

        await provider.close()
    }

    @Test func noActiveResponseErrorDoesNotStickServerFloor() async {
        let provider = PipecatOpenAIRealtimeLiveSessionProvider()
        provider.debugSetManualResponseMode(true)

        provider.onServerMessage(data: .object([
            "type": .string("error"),
            "error": .object([
                "message": .string("No active response to cancel."),
                "code": .string("response_cancel_not_active"),
            ]),
        ]))
        await Task.yield()

        #expect(provider.debugRealtimeResponseActive == false)
        #expect(provider.debugResponseFloorBusy == false)
        #expect(provider.debugPendingManualResponseCreate == false)

        await provider.close()
    }

    @Test func unrelatedAlreadyActiveErrorDoesNotQueueManualCreate() async {
        let provider = PipecatOpenAIRealtimeLiveSessionProvider()
        provider.debugSetManualResponseMode(true)

        provider.onServerMessage(data: .object([
            "type": .string("error"),
            "error": .object([
                "message": .string("Conversation already has an active response in progress. Wait until the response is finished before creating a new one."),
                "code": .string("conversation_already_has_active_response"),
            ]),
        ]))
        await Task.yield()

        #expect(provider.debugRealtimeResponseActive)
        #expect(provider.debugPendingManualResponseCreate == false)

        await provider.close()
    }

    @Test func inFlightManualCreateAlreadyActiveErrorQueuesUserTurn() async {
        let provider = PipecatOpenAIRealtimeLiveSessionProvider()
        provider.debugSetManualResponseMode(true)
        provider.debugSetManualResponseCreateInFlight(true)

        provider.onServerMessage(data: .object([
            "type": .string("error"),
            "error": .object([
                "message": .string("Conversation already has an active response in progress. Wait until the response is finished before creating a new one."),
                "code": .string("conversation_already_has_active_response"),
            ]),
        ]))
        await Task.yield()

        #expect(provider.debugRealtimeResponseActive)
        #expect(provider.debugPendingManualResponseCreate)

        await provider.close()
    }

    @Test func delegateAlreadyActiveErrorQueuesInFlightManualCreate() async {
        let provider = PipecatOpenAIRealtimeLiveSessionProvider()
        provider.debugSetManualResponseMode(true)
        provider.debugSetManualResponseCreateInFlight(true)

        provider.onError(message: #"{"error":{"message":"Conversation already has an active response in progress: resp_123. Wait until the response is finished before creating a new one.","code":"conversation_already_has_active_response"}}"#)
        await Task.yield()

        #expect(provider.debugRealtimeResponseActive)
        #expect(provider.debugPendingManualResponseCreate)

        await provider.close()
    }

    @Test func delegateAlreadyActiveErrorWithoutInFlightCreateDoesNotQueueManualCreate() async {
        let provider = PipecatOpenAIRealtimeLiveSessionProvider()
        provider.debugSetManualResponseMode(true)

        provider.onError(message: #"{"error":{"message":"Conversation already has an active response in progress: resp_123. Wait until the response is finished before creating a new one.","code":"conversation_already_has_active_response"}}"#)
        await Task.yield()

        #expect(provider.debugRealtimeResponseActive)
        #expect(provider.debugPendingManualResponseCreate == false)

        await provider.close()
    }

    @Test func delegateNoActiveResponseErrorDoesNotStickServerFloor() async {
        let provider = PipecatOpenAIRealtimeLiveSessionProvider()
        provider.debugSetManualResponseMode(true)
        provider.debugSetManualResponseCreateInFlight(true)

        provider.onError(message: #"{"error":{"message":"No active response to cancel.","code":"response_cancel_not_active"}}"#)
        await Task.yield()

        #expect(provider.debugRealtimeResponseActive == false)
        #expect(provider.debugResponseFloorBusy == false)
        #expect(provider.debugPendingManualResponseCreate == false)

        await provider.close()
    }
}
