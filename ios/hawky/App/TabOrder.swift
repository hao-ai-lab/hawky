import Combine
import Foundation

enum AppTab: String, CaseIterable, Codable, Hashable, Identifiable {
    case chat
    case test
    case live
    case pipecat
    case pipecatRecording
    case gptrDemo
    // Deprecated storage alias. The standalone Recording tab was removed;
    // recording now happens inside Live and its history lives in Live's ⋯
    // menu. Kept so saved configurations referencing "recording" still decode
    // and migrate cleanly into Live.
    case recording
    case live2
    // Deprecated storage alias. The standalone Glasses tab was merged into the
    // Recording ("Capture") tab as a sub-page; kept so saved configurations
    // referencing "glasses" still decode and migrate cleanly.
    case glasses
    case settings

    static var allCases: [AppTab] {
        [.chat, .test, .live, .live2, .pipecat, .pipecatRecording, .gptrDemo, .settings]
    }

    var id: String { rawValue }

    var label: String {
        switch self {
        case .chat: return "Chat"
        case .test: return "Probes"
        case .recording: return "Recording"
        case .live: return "Live"
        case .pipecat: return "PipeCat"
        case .pipecatRecording: return "Pipecat2"
        case .gptrDemo: return "GPTRDemo"
        case .live2: return "Live2"
        case .glasses: return "Glasses"
        case .settings: return "Settings"
        }
    }

    var systemImage: String {
        switch self {
        case .chat: return "message"
        case .test: return "testtube.2"
        case .recording: return "record.circle"
        case .live: return "camera.badge.ellipsis"
        case .pipecat: return "pipe.and.drop"
        case .pipecatRecording: return "recordingtape"
        case .gptrDemo: return "text.bubble"
        case .live2: return "sparkles.tv"
        case .glasses: return "eyeglasses"
        case .settings: return "gearshape"
        }
    }

    var requiresDeveloperMode: Bool {
        switch self {
        case .test, .live2, .pipecat, .pipecatRecording, .gptrDemo:
            return true
        case .chat, .live, .recording, .glasses, .settings:
            return false
        }
    }

    static func frontendValue(_ raw: String) -> AppTab? {
        switch raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "chat", "messages", "message":
            return .chat
        case "test", "testing", "tweak", "probe", "probes":
            return .test
        case "live", "realtime", "real-time", "camera-live", "vision-live",
             "recording", "record", "recorder", "glasses", "glass":
            // Recording (and the older Glasses tab) were folded into Live.
            return .live
        case "live2", "live-2":
            return .live2
        case "pipecat", "pipe-cat", "pipe_cat", "webrtc", "rtc":
            return .pipecat
        case "pipecat-record", "pipecat-recording", "pipecat_recording", "rtc-recording", "webrtc-recording":
            return .pipecatRecording
        case "gptrdemo", "gptr", "gpt-realtime-transcript", "realtime-transcription", "transcription":
            return .gptrDemo
        case "settings", "setting":
            return .settings
        default:
            return nil
        }
    }
}

struct AppTabConfiguration: Codable, Equatable {
    static let storageKey = "tabConfiguration"
    static let legacyTabOrderKey = "tabOrder"
    static let maxRenderedTabs = 6

    static let defaultValue = AppTabConfiguration(
        visibleTabs: [.live, .settings],
        hiddenTabs: [.pipecat, .pipecatRecording, .gptrDemo, .chat, .test],
        developerModeEnabled: false
    )

    var visibleTabs: [AppTab]
    var hiddenTabs: [AppTab]
    var developerModeEnabled: Bool

    var encodedStorageValue: String {
        guard let data = try? JSONEncoder().encode(sanitized()),
              let raw = String(data: data, encoding: .utf8) else {
            return ""
        }
        return raw
    }

    var movableVisibleTabs: [AppTab] {
        visibleTabs.filter { $0 != .settings }
    }

    var visibleTabsForRendering: [AppTab] {
        sanitized().visibleTabs
    }

    var defaultSelectedTab: AppTab {
        visibleTabsForRendering.first ?? .settings
    }

    static func load(
        encoded rawConfiguration: String? = UserDefaults.standard.string(forKey: storageKey),
        legacyRaw: String? = UserDefaults.standard.string(forKey: legacyTabOrderKey)
    ) -> AppTabConfiguration {
        if let rawConfiguration, !rawConfiguration.isEmpty,
           let data = rawConfiguration.data(using: .utf8),
           let decoded = try? JSONDecoder().decode(AppTabConfiguration.self, from: data) {
            return decoded.sanitized()
        }

        if let legacyRaw, !legacyRaw.isEmpty,
           let legacyOrder = AppTabOrder(rawValue: legacyRaw) {
            return migrating(legacyOrder: legacyOrder)
        }

        return defaultValue.sanitized()
    }

    static func migrating(legacyOrder: AppTabOrder) -> AppTabConfiguration {
        AppTabConfiguration(
            visibleTabs: legacyOrder.primaryTabs + [.settings],
            hiddenTabs: [],
            developerModeEnabled: legacyOrder.primaryTabs.contains(.test)
        )
        .sanitized()
    }

    func isVisible(_ tab: AppTab) -> Bool {
        visibleTabsForRendering.contains(tab)
    }

    func sanitized() -> AppTabConfiguration {
        var visible = Self.uniqueTabs(visibleTabs.map(Self.normalizedTab))
        var hidden = Self.uniqueTabs(hiddenTabs.map(Self.normalizedTab))

        visible.removeAll { $0 == .settings }
        hidden.removeAll { $0 == .settings }

        // The standalone Glasses tab was merged into Recording. Drop any saved
        // reference to it so it never renders as its own tab again.
        visible.removeAll { $0 == .glasses }
        hidden.removeAll { $0 == .glasses }

        if !developerModeEnabled {
            let developerTabs = AppTab.allCases.filter(\.requiresDeveloperMode)
            visible.removeAll { $0.requiresDeveloperMode }
            for tab in developerTabs where !hidden.contains(tab) {
                hidden.append(tab)
            }
        }

        if !visible.contains(.live) && !hidden.contains(.live) {
            hidden.append(.live)
        }

        if !visible.contains(.live2) && !hidden.contains(.live2) {
            hidden.append(.live2)
        }

        if !visible.contains(.pipecatRecording) && !hidden.contains(.pipecatRecording) {
            hidden.append(.pipecatRecording)
        }

        if !visible.contains(.gptrDemo) && !hidden.contains(.gptrDemo) {
            hidden.append(.gptrDemo)
        }

        hidden.removeAll { visible.contains($0) }

        for tab in AppTab.allCases where tab != .settings {
            guard developerModeEnabled || !tab.requiresDeveloperMode else { continue }
            if !visible.contains(tab) && !hidden.contains(tab) {
                visible.append(tab)
            }
        }

        if visible.count >= Self.maxRenderedTabs {
            let visibleLimit = Self.maxRenderedTabs - 1
            let overflow = Array(visible.dropFirst(visibleLimit))
            visible = Array(visible.prefix(visibleLimit))
            for tab in overflow where !hidden.contains(tab) {
                hidden.append(tab)
            }
        }

        visible.append(.settings)

        return AppTabConfiguration(
            visibleTabs: visible,
            hiddenTabs: hidden,
            developerModeEnabled: developerModeEnabled
        )
    }

    mutating func setDeveloperModeEnabled(_ enabled: Bool) {
        developerModeEnabled = enabled
        if enabled {
            show(.test)
        } else {
            for tab in AppTab.allCases where tab.requiresDeveloperMode {
                hide(tab)
            }
        }
    }

    mutating func hide(_ tab: AppTab) {
        guard tab != .settings else { return }
        visibleTabs.removeAll { $0 == tab }
        if !hiddenTabs.contains(tab) {
            hiddenTabs.append(tab)
        }
        self = sanitized()
    }

    mutating func show(_ tab: AppTab) {
        guard tab != .settings else { return }
        guard developerModeEnabled || !tab.requiresDeveloperMode else {
            self = sanitized()
            return
        }
        hiddenTabs.removeAll { $0 == tab }
        if !visibleTabs.contains(tab) {
            if let settingsIndex = visibleTabs.firstIndex(of: .settings) {
                visibleTabs.insert(tab, at: settingsIndex)
            } else {
                visibleTabs.append(tab)
            }
        }
        self = sanitized()
    }

    mutating func moveVisibleTabs(from source: IndexSet, to destination: Int) {
        var movable = sanitized().movableVisibleTabs
        let moving = source.sorted().compactMap { index in
            movable.indices.contains(index) ? movable[index] : nil
        }
        for index in source.sorted(by: >) where movable.indices.contains(index) {
            movable.remove(at: index)
        }
        let removedBeforeDestination = source.filter { $0 < destination }.count
        let adjustedDestination = max(0, min(destination - removedBeforeDestination, movable.count))
        movable.insert(contentsOf: moving, at: adjustedDestination)
        visibleTabs = movable + [.settings]
        self = sanitized()
    }

    private static func uniqueTabs(_ tabs: [AppTab]) -> [AppTab] {
        var seen = Set<AppTab>()
        return tabs.filter { seen.insert($0).inserted }
    }

    private static func normalizedTab(_ tab: AppTab) -> AppTab {
        // The removed standalone Recording tab collapses into Live.
        switch tab {
        case .recording: return .live
        default: return tab
        }
    }
}

enum AppTabOrder: String, CaseIterable, Identifiable {
    case chatFirst
    case recordingFirst
    case testFirst

    var id: String { rawValue }

    var label: String {
        switch self {
        case .chatFirst: return "Chat first"
        case .recordingFirst: return "Recording first"
        case .testFirst: return "Test first"
        }
    }

    var primaryTabs: [AppTab] {
        switch self {
        case .chatFirst: return [.chat, .live, .test, .recording]
        case .recordingFirst: return [.recording, .chat, .live, .test]
        case .testFirst: return [.test, .chat, .live, .recording]
        }
    }
}

@MainActor
final class FrontendTabStore: ObservableObject {
    static let shared = FrontendTabStore()

    @Published var selectedTab: AppTab = .live
    @Published private(set) var lastOpenedAt: Date?
    @Published private(set) var lastSource: String?
    @Published private(set) var settingsRouteRequestID = UUID()
    @Published private(set) var liveRouteRequestID = UUID()
    @Published private(set) var chatRouteRequestID = UUID()
    private var pendingSettingsRoute: SettingsRoute?
    private var pendingLiveRoute: LiveRoute?
    private var pendingChatSessionKey: String?

    private init() {}

    func open(_ tab: AppTab, source: String? = nil) {
        selectedTab = tab
        lastOpenedAt = Date()
        lastSource = source
    }

    func openSettings(_ route: SettingsRoute?, source: String? = nil) {
        pendingSettingsRoute = route
        settingsRouteRequestID = UUID()
        open(.settings, source: source)
    }

    func openLive(_ route: LiveRoute = .root, source: String? = nil) {
        pendingLiveRoute = route
        liveRouteRequestID = UUID()
        open(.live, source: source)
    }

    func openChat(sessionKey: String?, source: String? = nil) {
        pendingChatSessionKey = sessionKey
        chatRouteRequestID = UUID()
        open(.chat, source: source)
    }

    func consumePendingSettingsRoute() -> SettingsRoute? {
        defer { pendingSettingsRoute = nil }
        return pendingSettingsRoute
    }

    func consumePendingLiveRoute() -> LiveRoute? {
        defer { pendingLiveRoute = nil }
        return pendingLiveRoute
    }

    func consumePendingChatSessionKey() -> String? {
        defer { pendingChatSessionKey = nil }
        return pendingChatSessionKey
    }

    func ensureSelectedTabVisible(in configuration: AppTabConfiguration) {
        guard !configuration.isVisible(selectedTab) else { return }
        selectedTab = configuration.defaultSelectedTab
    }
}
