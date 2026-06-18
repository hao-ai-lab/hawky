import AppIntents
import Foundation

enum LiveControlAction: String, AppEnum {
    case openLive
    case toggleMute
    case pauseLive
    case resumeLive
    case stopLive

    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Live Control")

    static var caseDisplayRepresentations: [LiveControlAction: DisplayRepresentation] = [
        .openLive: "Open Live",
        .toggleMute: "Mute or Unmute",
        .pauseLive: "Pause Live",
        .resumeLive: "Resume Live",
        .stopLive: "Stop Live",
    ]

    var commandAction: LiveControlCommandAction {
        switch self {
        case .openLive: return .openLive
        case .toggleMute: return .toggleMute
        case .pauseLive: return .pauseLive
        case .resumeLive: return .resumeLive
        case .stopLive: return .stopLive
        }
    }
}

struct LiveControlIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "Control Hawky Live"
    static var description = IntentDescription("Open or control the active Hawky Live session.")
    static var openAppWhenRun: Bool { false }

    @Parameter(title: "Action")
    var action: LiveControlAction

    init() {
        self.action = .openLive
    }

    init(action: LiveControlAction) {
        self.action = action
    }

    func perform() async throws -> some IntentResult {
        LiveControlCommandStore.enqueue(action.commandAction)
        return .result()
    }
}

struct OpenLiveIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "Open Hawky Live"
    static var description = IntentDescription("Open the Hawky Live tab.")
    static var openAppWhenRun: Bool { true }

    func perform() async throws -> some IntentResult {
        return .result()
    }
}
