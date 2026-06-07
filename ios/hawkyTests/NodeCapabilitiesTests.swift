import Testing
import Foundation
#if canImport(UserNotifications)
import UserNotifications
#endif
@testable import hawky

// NodeCapabilitiesTests — invokes each capability in isolation and asserts
// the returned JSON shape/ranges are sensible on a simulator.
@Suite(.serialized) @MainActor struct NodeCapabilitiesTests {
    private struct FakeClipboard: ClipboardReading {
        let hasStrings: Bool
        let strings: [String]?
        let string: String?
    }

    #if canImport(UserNotifications)
    private final class FakeNotificationScheduler: NotificationScheduling {
        let status: UNAuthorizationStatus
        let requestResult: Bool
        var addedTitle: String?
        var addedBody: String?

        init(status: UNAuthorizationStatus, requestResult: Bool = false) {
            self.status = status
            self.requestResult = requestResult
        }

        func notificationAuthorizationStatus() async -> UNAuthorizationStatus {
            status
        }

        func requestNotificationAuthorization(options: UNAuthorizationOptions) async throws -> Bool {
            requestResult
        }

        func addNotification(title: String, body: String) async throws {
            addedTitle = title
            addedBody = body
        }
    }
    #endif

    @Test func batteryShape() async throws {
        let result = try await BatteryCommand().invoke(args: .null)
        guard case let .object(obj) = result else { Issue.record("not object"); return }
        guard case let .some(.string(state)) = obj["state"] else { Issue.record("state missing"); return }
        #expect(["unknown", "unplugged", "charging", "full"].contains(state))
        if case let .some(.number(lvl)) = obj["level"] {
            #expect(lvl == -1 || (lvl >= 0 && lvl <= 1))
        } else { Issue.record("level missing") }
        #expect(obj["lowPowerMode"].flatMap { if case .bool = $0 { return true } else { return nil } } == true)
    }

    @Test func storageShape() async throws {
        let result = try await StorageCommand().invoke(args: .null)
        guard case let .object(obj) = result,
              case let .some(.number(total)) = obj["totalBytes"],
              case let .some(.number(free)) = obj["freeBytes"],
              case let .some(.number(used)) = obj["usedBytes"] else {
            Issue.record("missing fields"); return
        }
        #expect(total > 0)
        #expect(free >= 0)
        #expect(free <= total)
        #expect(used >= 0 && used <= total)
    }

    @Test func networkShape() async throws {
        let t0 = Date()
        let result = try await NetworkCommand().invoke(args: .null)
        #expect(Date().timeIntervalSince(t0) < 2.5)
        guard case let .object(obj) = result,
              case let .some(.string(conn)) = obj["connectionType"] else {
            Issue.record("missing connectionType"); return
        }
        #expect(["wifi", "cellular", "wired", "none"].contains(conn))
        if case .bool = obj["isExpensive"] ?? .null {} else { Issue.record("isExpensive not bool") }
        if case .bool = obj["isConstrained"] ?? .null {} else { Issue.record("isConstrained not bool") }
    }

    @Test func clipboardShape() async throws {
        let result = ClipboardCommand.collect(pasteboard: FakeClipboard(
            hasStrings: false,
            strings: nil,
            string: nil
        ))
        guard case let .object(obj) = result else { Issue.record("not object"); return }
        guard case let .some(.number(count)) = obj["stringsCount"] else { Issue.record("stringsCount missing"); return }
        #expect(count == 0)
        #expect(obj["hasStrings"] == .bool(false))
        #expect(obj["authorized"] == .bool(false))

        let populated = ClipboardCommand.collect(pasteboard: FakeClipboard(
            hasStrings: true,
            strings: ["hello"],
            string: "hello"
        ))
        guard case let .object(populatedObj) = populated else { Issue.record("populated not object"); return }
        #expect(populatedObj["text"] == .string("hello"))
        #expect(populatedObj["hasStrings"] == .bool(true))
        #expect(populatedObj["stringsCount"] == .number(1))
        #expect(populatedObj["authorized"] == .bool(true))
    }

    @Test func notificationShape() async throws {
        #if canImport(UserNotifications)
        let deniedCenter = FakeNotificationScheduler(status: .denied)
        let result = await NotificationShowCommand.schedule(
            title: "t",
            body: "b",
            center: deniedCenter
        )
        guard case let .object(obj) = result else { Issue.record("not object"); return }
        #expect(obj["shown"] == .bool(false))
        #expect(obj["reason"] == .string("unauthorized"))
        #expect(deniedCenter.addedTitle == nil)

        let authorizedCenter = FakeNotificationScheduler(status: .authorized)
        let shown = await NotificationShowCommand.schedule(
            title: "t",
            body: "b",
            center: authorizedCenter
        )
        guard case let .object(shownObj) = shown else { Issue.record("shown not object"); return }
        #expect(shownObj["shown"] == .bool(true))
        #expect(shownObj["reason"] == .null)
        #expect(authorizedCenter.addedTitle == "t")
        #expect(authorizedCenter.addedBody == "b")
        #else
        let result = try await NotificationShowCommand().invoke(args: .null)
        guard case let .object(obj) = result else { Issue.record("not object"); return }
        #expect(obj["shown"] == .bool(false))
        #expect(obj["reason"] == .string("unsupported"))
        #endif
    }

    @Test func frontendMessageCommandAppendsToStore() async throws {
        FrontendMessageStore.shared.clear()
        let result = try await FrontendMessageCommand().invoke(args: .object([
            "kind": .string("transcript"),
            "title": .string("Transcript"),
            "body": .string("hello from backend"),
            "action_id": .string("a-1"),
        ]))
        guard case let .object(obj) = result else { Issue.record("not object"); return }
        #expect(obj["delivered"] == .bool(true))
        let items = FrontendMessageStore.shared.items
        let transcript = FrontendMessageStore.shared.latestTranscript
        let backendMessage = FrontendMessageStore.shared.latestMessage
        #expect(items.count == 1)
        #expect(transcript?.body == "hello from backend")
        #expect(transcript?.actionId == "a-1")
        #expect(transcript?.isBackendMessage == false)
        #expect(backendMessage == nil)
        FrontendMessageStore.shared.clear()
    }

    @Test func frontendMessageCommandExtendsLiveTranscript() async throws {
        FrontendMessageStore.shared.clear()
        _ = try await FrontendMessageCommand().invoke(args: .object([
            "kind": .string("transcript"),
            "title": .string("Transcript"),
            "body": .string("first chunk"),
        ]))
        _ = try await FrontendMessageCommand().invoke(args: .object([
            "kind": .string("transcript"),
            "title": .string("Transcript"),
            "body": .string("second chunk"),
        ]))

        #expect(FrontendMessageStore.shared.transcriptItems.count == 2)
        #expect(FrontendMessageStore.shared.latestTranscript?.body == "second chunk")
        #expect(FrontendMessageStore.shared.liveTranscriptBody == "first chunk\n\nsecond chunk")
        FrontendMessageStore.shared.clear()
    }

    @Test func frontendMessageCommandTracksLatestBackendMessage() async throws {
        FrontendMessageStore.shared.clear()
        _ = try await FrontendMessageCommand().invoke(args: .object([
            "kind": .string("message"),
            "title": .string("Backend"),
            "body": .string("speak this"),
        ]))
        let message = FrontendMessageStore.shared.latestMessage
        #expect(message?.body == "speak this")
        #expect(message?.isBackendMessage == true)
        FrontendMessageStore.shared.clear()
    }

    @Test func frontendOpenTabCommandSelectsTab() async throws {
        UserDefaults.standard.removeObject(forKey: AppTabConfiguration.storageKey)
        UserDefaults.standard.removeObject(forKey: AppTabConfiguration.legacyTabOrderKey)
        FrontendTabStore.shared.open(.chat, source: "test-reset")
        var config = AppTabConfiguration.defaultValue
        config.setDeveloperModeEnabled(true)
        UserDefaults.standard.set(config.encodedStorageValue, forKey: AppTabConfiguration.storageKey)

        // The standalone "recording" tab was removed; requesting it now resolves
        // to the unified Live tab (recording lives inside Live).
        let result = try await FrontendOpenTabCommand().invoke(args: .object([
            "tab": .string("recording"),
            "source": .string("test"),
        ]))
        guard case let .object(obj) = result else { Issue.record("not object"); return }
        #expect(obj["opened"] == .bool(true))
        #expect(obj["tab"] == .string("live"))
        #expect(FrontendTabStore.shared.selectedTab == .live)
        #expect(FrontendTabStore.shared.lastSource == "test")
        FrontendTabStore.shared.open(.chat, source: "test-reset")
        UserDefaults.standard.removeObject(forKey: AppTabConfiguration.storageKey)
    }

    @Test func frontendOpenTabCommandReportsHiddenTab() async throws {
        UserDefaults.standard.removeObject(forKey: AppTabConfiguration.legacyTabOrderKey)
        UserDefaults.standard.set(
            AppTabConfiguration.defaultValue.encodedStorageValue,
            forKey: AppTabConfiguration.storageKey
        )
        FrontendTabStore.shared.open(.chat, source: "test-reset")

        let result = try await FrontendOpenTabCommand().invoke(args: .object([
            "tab": .string("probes"),
            "source": .string("test"),
        ]))
        guard case let .object(obj) = result else { Issue.record("not object"); return }
        #expect(obj["opened"] == .bool(false))
        #expect(obj["tab"] == .string("test"))
        #expect(obj["reason"] == .string("tab_hidden"))
        #expect(FrontendTabStore.shared.selectedTab != .test)
        #expect(FrontendTabStore.shared.lastSource != "test")

        UserDefaults.standard.removeObject(forKey: AppTabConfiguration.storageKey)
        FrontendTabStore.shared.open(.chat, source: "test-reset")
    }
}
