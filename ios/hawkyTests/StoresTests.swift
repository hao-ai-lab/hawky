import Testing
import Foundation
@testable import hawky

@Suite @MainActor
struct ChatStoreTests {
    @Test func appendsUserAndAssistant() {
        let store = ChatStore()
        let uid = store.appendUser("hello")
        let aid = store.beginAssistantTurn()
        #expect(store.messages.count == 2)
        #expect(store.messages[0].id == uid)
        #expect(store.messages[0].role == .user)
        #expect(store.messages[0].text == "hello")
        #expect(store.messages[0].isStreaming == false)
        #expect(store.messages[1].id == aid)
        #expect(store.messages[1].role == .assistant)
        #expect(store.messages[1].isStreaming == true)
        #expect(store.messages[1].text == "")
    }

    @Test func streamsDeltasAndFinalizes() {
        let store = ChatStore()
        let aid = store.beginAssistantTurn()
        store.appendDelta("Hel", to: aid)
        store.appendDelta("lo ", to: aid)
        store.appendDelta("world", to: aid)
        #expect(store.messages[0].text == "Hello world")
        #expect(store.messages[0].isStreaming == true)
        store.finalizeAssistant(id: aid)
        #expect(store.messages[0].isStreaming == false)
    }

    @Test func appendDeltaUnknownIdIsNoOp() {
        let store = ChatStore()
        let aid = store.beginAssistantTurn()
        store.appendDelta("keep", to: aid)
        store.appendDelta("dropped", to: UUID())
        store.finalizeAssistant(id: UUID()) // also no-op
        #expect(store.messages.count == 1)
        #expect(store.messages[0].text == "keep")
        #expect(store.messages[0].isStreaming == true)
    }

    @Test func appendErrorPrefixesAsSystem() {
        let store = ChatStore()
        store.appendError("boom")
        #expect(store.messages.count == 1)
        #expect(store.messages[0].role == .system)
        #expect(store.messages[0].text == "Error: boom")
    }

    @Test func resetClearsMessages() {
        let store = ChatStore()
        store.appendUser("a")
        let aid = store.beginAssistantTurn()
        store.appendDelta("b", to: aid)
        store.reset()
        #expect(store.messages.isEmpty)
    }

    @Test func replaceAllReplacesExistingMessages() {
        let store = ChatStore()
        store.appendUser("old")
        let replacement = [
            ChatStore.Message(id: UUID(), role: .user, text: "new", isStreaming: false, timestamp: Date())
        ]
        store.replaceAll(replacement)
        #expect(store.messages.count == 1)
        #expect(store.messages[0].text == "new")
    }

    // Covers session.history decoding:
    //   - user with string content (fallback)
    //   - assistant with content-block array; concatenates text blocks, skips tool_use/tool_result
    //   - message whose blocks are all non-text → dropped
    //   - display_text overrides text when present
    @Test func decodesSessionHistoryPayload() {
        let payload: JSONValue = .object([
            "sessionKey": .string("ios:main"),
            "total": .number(3),
            "messages": .array([
                .object([
                    "role": .string("user"),
                    "timestamp": .string("2025-04-18T10:00:00.000Z"),
                    "content": .array([
                        .object(["type": .string("text"), "text": .string("hello"), "display_text": .string("/hi")])
                    ])
                ]),
                .object([
                    "role": .string("assistant"),
                    "content": .array([
                        .object(["type": .string("text"), "text": .string("Hi, ")]),
                        .object(["type": .string("tool_use"), "id": .string("t1"), "name": .string("bash"), "input": .object([:])]),
                        .object(["type": .string("text"), "text": .string("how are you?")])
                    ])
                ]),
                .object([
                    "role": .string("assistant"),
                    "content": .array([
                        .object(["type": .string("tool_result"), "tool_use_id": .string("t1"), "content": .string("ok")])
                    ])
                ])
            ])
        ])
        let decoded = ChatStore.decodeHistoryPayload(payload)
        #expect(decoded.count == 2)
        #expect(decoded[0].role == .user)
        #expect(decoded[0].text == "/hi") // display_text wins
        #expect(decoded[1].role == .assistant)
        #expect(decoded[1].text == "Hi, how are you?")
    }

    @Test func decodeHistoryReturnsEmptyForMalformed() {
        #expect(ChatStore.decodeHistoryPayload(.null).isEmpty)
        #expect(ChatStore.decodeHistoryPayload(.array([])).isEmpty)
        #expect(ChatStore.decodeHistoryPayload(.object(["total": .number(0)])).isEmpty)
    }
}

@Suite @MainActor
struct ConnectionStoreTests {
    @Test func transitionsBetweenStatuses() {
        let store = ConnectionStore()
        #expect(store.status == .idle)
        #expect(store.lastError == nil)

        store.markConnecting()
        #expect(store.status == .connecting)

        store.markConnected(connId: "c-123")
        #expect(store.status == .connected(connId: "c-123"))
        #expect(store.lastError == nil)

        store.markError("socket closed")
        #expect(store.status == .error("socket closed"))
        #expect(store.lastError == "socket closed")
    }

    @Test func abandonedIsTerminalButRecoverable() {
        let store = ConnectionStore()
        store.markConnecting()
        store.markAbandoned()
        #expect(store.status == .abandoned)
        // Caller treats abandoned as terminal, but the store permits recovery
        // (e.g. manual "reconnect" action from the UI) by flipping back to idle.
        store.markIdle()
        #expect(store.status == .idle)
        #expect(store.lastError == nil)
    }

    @Test func markIdleClearsError() {
        let store = ConnectionStore()
        store.markError("nope")
        #expect(store.lastError == "nope")
        store.markIdle()
        #expect(store.status == .idle)
        #expect(store.lastError == nil)
    }
}

@Suite @MainActor
struct SessionStoreTests {
    @Test func defaultSession() {
        let store = SessionStore()
        #expect(store.activeSessionKey == "ios:main")
        #expect(store.sessions.count == 1)
        #expect(store.sessions[0].key == "ios:main")
        #expect(store.sessions[0].displayName == "main")
    }

    @Test func setActiveAddsWhenUnknown() {
        let store = SessionStore()
        store.setActive("ios:work")
        #expect(store.activeSessionKey == "ios:work")
        #expect(store.sessions.contains(where: { $0.key == "ios:work" }))
        #expect(store.sessions.count == 2)
    }

    @Test func setActiveExistingDoesNotDuplicate() {
        let store = SessionStore()
        store.setActive("ios:main")
        #expect(store.sessions.count == 1)
    }

    @Test func upsertAddsNew() {
        let store = SessionStore()
        store.upsert(.init(key: "ios:work", displayName: "Work", unreadCount: 3))
        #expect(store.sessions.count == 2)
        let work = store.sessions.first(where: { $0.key == "ios:work" })
        #expect(work?.displayName == "Work")
        #expect(work?.unreadCount == 3)
    }

    @Test func upsertUpdatesInPlace() {
        let store = SessionStore()
        store.upsert(.init(key: "ios:main", displayName: "Main (renamed)", unreadCount: 5))
        #expect(store.sessions.count == 1)
        #expect(store.sessions[0].displayName == "Main (renamed)")
        #expect(store.sessions[0].unreadCount == 5)
    }

    @Test func replaceAllReplaces() {
        let store = SessionStore()
        store.replaceAll([
            .init(key: "ios:a", displayName: "a", unreadCount: 0),
            .init(key: "ios:b", displayName: "b", unreadCount: 0),
        ])
        #expect(store.sessions.count == 2)
        #expect(store.sessions[0].key == "ios:a")
        #expect(store.sessions[1].key == "ios:b")
    }

    @Test func defaultDisplayNameExtractsTrailingSegment() {
        #expect(SessionStore.defaultDisplayName(for: "ios:main") == "main")
        #expect(SessionStore.defaultDisplayName(for: "foo:bar:baz") == "baz")
        #expect(SessionStore.defaultDisplayName(for: "nocolon") == "nocolon")
    }

    @Test func activeSummaryReturnsActive() {
        let store = SessionStore()
        store.upsert(.init(key: "ios:work", displayName: "Work", unreadCount: 0))
        store.setActive("ios:work")
        #expect(store.activeSummary?.displayName == "Work")
    }
}

// #694 de-productization: the tool-call source was renamed .hawky -> .gateway.
// Because LiveToolCallInfo is Codable and rides in persisted LiveLocalSession,
// the decoder must keep accepting the legacy "hawky" rawValue.
@Suite @MainActor
struct LiveToolCallSourceTests {
    private func decodeSource(_ raw: String) throws -> LiveToolCallInfo.Source {
        try JSONDecoder().decode(LiveToolCallInfo.Source.self, from: Data("\"\(raw)\"".utf8))
    }

    @Test func decodesLegacyHawkyAsGateway() throws {
        #expect(try decodeSource("hawky") == .gateway)
        #expect(try decodeSource("gateway") == .gateway)
        #expect(try decodeSource("realtime") == .realtime)
    }

    @Test func encodesGatewayWithNewName() throws {
        let data = try JSONEncoder().encode(LiveToolCallInfo.Source.gateway)
        #expect(String(data: data, encoding: .utf8) == "\"gateway\"")
    }

    @Test func rejectsUnknownSource() {
        #expect(throws: DecodingError.self) {
            _ = try decodeSource("nonsense")
        }
    }
}
