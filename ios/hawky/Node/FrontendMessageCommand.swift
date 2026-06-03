import Foundation

// FrontendMessageCommand — lets Hawky send a small user-visible message to
// the iOS frontend. Phase 1 displays it in the Recording tab; later the same
// command can carry action IDs/results for a fuller device execution loop.
struct FrontendMessageCommand: NodeCommand {
    static let name = "frontend.message"

    func invoke(args: JSONValue) async throws -> JSONValue {
        guard case let .object(obj) = args else {
            throw NodeCommandError.invalidArgs("expected object")
        }

        let kind = obj.stringValue("kind") ?? "message"
        let title = obj.stringValue("title") ?? "Hawky"
        let body = obj.stringValue("body") ?? obj.stringValue("text") ?? ""
        let actionId = obj.stringValue("action_id") ?? obj.stringValue("actionId")

        guard !body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw NodeCommandError.invalidArgs("body is required")
        }

        let item = await FrontendMessageStore.shared.append(
            kind: kind,
            title: title,
            body: body,
            actionId: actionId
        )

        return .object([
            "delivered": .bool(true),
            "kind": .string(item.kind),
            "messageId": .string(item.id.uuidString),
            "action_id": item.actionId.map { .string($0) } ?? .null,
        ])
    }
}

// FrontendOpenTabCommand — lets the gateway switch the visible iOS tab without
// reaching into SwiftUI view state directly.
struct FrontendOpenTabCommand: NodeCommand {
    static let name = "frontend.open_tab"

    func invoke(args: JSONValue) async throws -> JSONValue {
        guard case let .object(obj) = args else {
            throw NodeCommandError.invalidArgs("expected object")
        }
        guard let rawTab = obj.stringValue("tab") ?? obj.stringValue("name") ?? obj.stringValue("target") else {
            throw NodeCommandError.invalidArgs("tab is required")
        }
        guard let tab = AppTab.frontendValue(rawTab) else {
            let supported = AppTab.allCases.map(\.rawValue).joined(separator: ", ")
            throw NodeCommandError.invalidArgs("unsupported tab '\(rawTab)'; expected one of: \(supported)")
        }

        let configuration = AppTabConfiguration.load()
        guard configuration.isVisible(tab) else {
            return .object([
                "opened": .bool(false),
                "tab": .string(tab.rawValue),
                "reason": .string("tab_hidden"),
            ])
        }

        let source = obj.stringValue("source") ?? "node"
        await FrontendTabStore.shared.open(tab, source: source)

        return .object([
            "opened": .bool(true),
            "tab": .string(tab.rawValue),
        ])
    }
}

private extension Dictionary where Key == String, Value == JSONValue {
    func stringValue(_ key: String) -> String? {
        guard case let .some(.string(value)) = self[key] else { return nil }
        return value
    }
}
