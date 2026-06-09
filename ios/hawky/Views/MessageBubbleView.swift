import MarkdownUI
import SwiftUI

// Per-role message bubble. User = full-width warm pill. Assistant = leading
// markdown text with streaming cursor. System = full-width muted note.
struct MessageBubbleView: View {
    let message: ChatStore.Message

    var body: some View {
        switch message.role {
        case .user:
            VStack(alignment: .leading, spacing: 4) {
                MarkdownMessageText(message.text, font: .body)
                    .foregroundStyle(Color(.label))
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("You said \(message.text)")
                MessageTimestampText(date: message.timestamp)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .paperSurface(
                in: RoundedRectangle(cornerRadius: DesignTokens.Radius.bubble, style: .continuous)
            )
            .accessibilityIdentifier("messageBubble.user.\(message.id.uuidString)")
            .padding(.horizontal, DesignTokens.Spacing.page)
        case .assistant:
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    assistantText
                    MessageTimestampText(date: message.timestamp)
                }
                .accessibilityIdentifier("messageBubble.assistant.\(message.id.uuidString)")
                Spacer(minLength: 0)
            }
            .padding(.horizontal, DesignTokens.Spacing.page)
        case .system:
            MarkdownMessageText(message.text, font: .caption)
                .foregroundStyle(Color(.secondaryLabel))
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("System: \(message.text)")
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .paperSurface(
                    in: RoundedRectangle(cornerRadius: DesignTokens.Radius.pill, style: .continuous),
                    inset: true
                )
                .accessibilityIdentifier("messageBubble.system.\(message.id.uuidString)")
                .padding(.horizontal, DesignTokens.Spacing.page)
        }
    }

    private var assistantText: some View {
        // Append inline cursor while streaming.
        let display = message.isStreaming ? message.text + "▋" : message.text
        // Secretary signature: assistant text in serif (chat.jsx:215).
        return MarkdownMessageText(display, font: DesignTokens.Font.assistant)
            .foregroundStyle(Color(.label))
            // Collapse the rendered Markdown to one element and label it, so
            // VoiceOver announces the role and clean text — never the "▋"
            // streaming cursor that the rendered string carries. (#576)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(message.isStreaming
                ? "Assistant, responding. \(message.text)"
                : "Assistant said \(message.text)")
    }
}

private struct MarkdownMessageText: View {
    let text: String
    let font: Font

    init(_ text: String, font: Font) {
        self.text = text
        self.font = font
    }

    var body: some View {
        Markdown(text)
            .font(font)
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
    }
}
