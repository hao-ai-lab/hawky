import XCTest
import SwiftUI
import SnapshotTesting
@testable import hawky

// Snapshot tests for the chat rendering surfaces. Goal: pin the current visual
// contract so accidental DesignTokens / MessageBubbleView regressions surface
// as a failing test instead of a silent UI drift.
//
// We host the views in a fixed-size container and compare images. Comparisons
// use a small perceptual tolerance (precision 0.99 / perceptualPrecision 0.98)
// so anti-aliasing and font-hinting differences across machines/CI do not flake
// the suite, while a real DesignTokens / MessageBubbleView change still moves
// enough pixels to fail. Recorded baselines stay portable across the iPhone 17
// Pro simulator; if a genuine rendering change lands, re-record by deleting the
// __Snapshots__ entry and re-running once.
//
// Tests operate on MessageBubbleView directly (rather than a full ChatView)
// because ChatView reads from @Environment(AppContainer) which would require
// standing up the full networking stack just to render a bubble.
@MainActor
final class ChatViewSnapshotTests: XCTestCase {

    private let deviceSize = CGSize(width: 390, height: 120)

    private func host<V: View>(_ view: V, height: CGFloat = 120) -> some View {
        view
            .frame(width: deviceSize.width, height: height, alignment: .topLeading)
            .background(Color(.systemBackground))
            .environment(\.colorScheme, .dark)
    }

    // 1. Empty-state: the ChatView copy rendered in isolation.
    func testEmptyState() {
        let view = VStack(spacing: 6) {
            Spacer(minLength: 20)
            Text("Start a conversation")
                .font(DesignTokens.Font.assistant)
                .foregroundStyle(Color(.secondaryLabel))
            Text("ios:main")
                .font(DesignTokens.Font.mono)
                .foregroundStyle(DesignTokens.tertiaryText)
            Spacer()
        }
        .frame(maxWidth: .infinity)
        assertSnapshot(of: host(view, height: 180), as: .image(precision: 0.99, perceptualPrecision: 0.98))
    }

    // 2. Single user bubble — trailing, tinted, asymmetric corner.
    func testUserBubble() {
        let msg = ChatStore.Message(
            id: UUID(uuidString: "00000000-0000-0000-0000-000000000001")!,
            role: .user,
            text: "Hello from the test harness",
            isStreaming: false,
            timestamp: Date(timeIntervalSince1970: 0)
        )
        assertSnapshot(of: host(MessageBubbleView(message: msg)), as: .image(precision: 0.99, perceptualPrecision: 0.98))
    }

    // 3. Streaming assistant — inline cursor on serif body.
    func testAssistantStreaming() {
        let msg = ChatStore.Message(
            id: UUID(uuidString: "00000000-0000-0000-0000-000000000002")!,
            role: .assistant,
            text: "The assistant is still typing",
            isStreaming: true,
            timestamp: Date(timeIntervalSince1970: 0)
        )
        assertSnapshot(of: host(MessageBubbleView(message: msg)), as: .image(precision: 0.99, perceptualPrecision: 0.98))
    }

    // 4. Finalized assistant — no cursor, full turn rendered.
    func testAssistantFinalized() {
        let msg = ChatStore.Message(
            id: UUID(uuidString: "00000000-0000-0000-0000-000000000003")!,
            role: .assistant,
            text: "The assistant finished its turn.",
            isStreaming: false,
            timestamp: Date(timeIntervalSince1970: 0)
        )
        assertSnapshot(of: host(MessageBubbleView(message: msg)), as: .image(precision: 0.99, perceptualPrecision: 0.98))
    }

    // 5. Error / system row — centered caption appearance.
    func testErrorSystemRow() {
        let msg = ChatStore.Message(
            id: UUID(uuidString: "00000000-0000-0000-0000-000000000004")!,
            role: .system,
            text: "Error: [E_NET] websocket closed",
            isStreaming: false,
            timestamp: Date(timeIntervalSince1970: 0)
        )
        assertSnapshot(of: host(MessageBubbleView(message: msg), height: 80), as: .image(precision: 0.99, perceptualPrecision: 0.98))
    }
}
