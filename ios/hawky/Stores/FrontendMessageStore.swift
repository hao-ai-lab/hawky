import Foundation
import Combine

@MainActor
final class FrontendMessageStore: ObservableObject {
    static let shared = FrontendMessageStore()

    struct Item: Identifiable, Equatable {
        let id: UUID
        let kind: String
        let title: String
        let body: String
        let actionId: String?
        let receivedAt: Date

        var isBackendMessage: Bool {
            kind != "transcript"
        }
    }

    @Published private(set) var items: [Item] = []

    private let maxItems = 120

    private init() {}

    var latestTranscript: Item? {
        items.last { $0.kind == "transcript" }
    }

    var transcriptItems: [Item] {
        items.filter { $0.kind == "transcript" }
    }

    var liveTranscriptBody: String {
        transcriptItems
            .map(\.body)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .joined(separator: "\n\n")
    }

    var latestMessage: Item? {
        items.last { $0.isBackendMessage }
    }

    @discardableResult
    func append(kind: String, title: String, body: String, actionId: String? = nil) -> Item {
        let normalizedKind = kind.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? "message"
            : kind.trimmingCharacters(in: .whitespacesAndNewlines)
        let item = Item(
            id: UUID(),
            kind: normalizedKind,
            title: title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "Hawky" : title,
            body: body,
            actionId: actionId,
            receivedAt: Date()
        )
        items.append(item)
        if items.count > maxItems {
            items.removeFirst(items.count - maxItems)
        }
        return item
    }

    func clear() {
        items.removeAll()
    }
}
