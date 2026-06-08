import SwiftUI

// Text composer pinned above the keyboard. Auto-growing text field + circular send button.
struct ComposerView: View {
    @Binding var text: String
    let isEnabled: Bool
    let onSend: () -> Void
    var focusBinding: FocusState<Bool>.Binding? = nil

    // Bumped on each send so `.sensoryFeedback` fires a light confirmatory tap. (#577)
    @State private var sendHaptic = 0

    private var canSend: Bool {
        isEnabled && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func send() {
        sendHaptic &+= 1
        onSend()
    }

    var body: some View {
        // Secretary composer: glass pill, leading +, trailing accent send / mic.
        HStack(alignment: .bottom, spacing: 8) {
            textField
                .lineLimit(1...6)
                .textFieldStyle(.plain)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .softGlass(in: RoundedRectangle(cornerRadius: DesignTokens.Radius.bubble, style: .continuous))
                .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.bubble, style: .continuous))
                .submitLabel(.send)
                .onSubmit {
                    if canSend { send() }
                }
                .accessibilityIdentifier("composer.textfield")

            Button {
                send()
            } label: {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.system(size: 32))
                    .foregroundStyle(canSend ? DesignTokens.accent : Color(.tertiaryLabel))
                    .minimumHitTarget()
            }
            .disabled(!canSend)
            .accessibilityLabel("Send message")
            .accessibilityIdentifier("composer.sendButton")
        }
        .padding(.horizontal, DesignTokens.Spacing.page)
        .padding(.vertical, 8)
        .background(Color(.systemBackground))
        .sensoryFeedback(.impact(weight: .light), trigger: sendHaptic)
    }

    @ViewBuilder
    private var textField: some View {
        if let focusBinding {
            TextField("Message Hawky...", text: $text, axis: .vertical)
                .focused(focusBinding)
        } else {
            TextField("Message Hawky...", text: $text, axis: .vertical)
        }
    }
}
