import MarkdownUI
import SwiftUI

/// Live session summary (#537 V1). Pick a scope (last session / past day) and
/// the gateway agent produces a readable recap from the transcript(s).
struct LiveSummarySheet: View {
    let store: LiveSessionStore
    let container: AppContainer
    @Environment(\.dismiss) private var dismiss

    @State private var scope: LiveSummaryScope = .currentSession
    @State private var phase: Phase = .idle

    private enum Phase: Equatable {
        case idle
        case loading
        case result(String)
        case failed(String)

        var isResultOrFailed: Bool {
            switch self {
            case .result, .failed: return true
            default: return false
            }
        }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    ForEach(LiveSummaryScope.allCases) { option in
                        Button {
                            guard phase != .loading else { return }
                            if scope != option {
                                scope = option
                                // Switching range clears a stale summary so it's
                                // obvious the result matches the selection.
                                if case .result = phase { phase = .idle }
                                if case .failed = phase { phase = .idle }
                            }
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(option.label)
                                        .foregroundStyle(.primary)
                                    Text(option.subtitle)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                if scope == option {
                                    Image(systemName: "checkmark")
                                        .foregroundStyle(DesignTokens.accent)
                                }
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .disabled(phase == .loading)
                        .accessibilityIdentifier("live.summary.scope.\(option.rawValue)")
                    }
                } header: {
                    Text("Range")
                }

                switch phase {
                case .idle:
                    EmptyView()
                case .loading:
                    Section {
                        HStack(spacing: 12) {
                            ProgressView()
                            Text("Summarizing…")
                                .foregroundStyle(.secondary)
                        }
                    }
                case .result(let text):
                    Section("Summary") {
                        Markdown(text)
                            .textSelection(.enabled)
                            .accessibilityIdentifier("live.summary.result")
                    }
                case .failed(let message):
                    Section {
                        Label(message, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle("Summary")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Close") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button(phase.isResultOrFailed ? "Regenerate" : "Summarize") {
                        generate()
                    }
                    .disabled(phase == .loading)
                    .accessibilityIdentifier("live.summary.generate")
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func generate() {
        phase = .loading
        let summarizer = LiveSessionSummarizer(container: container, store: store)
        let scope = scope
        Task {
            do {
                let summary = try await summarizer.summarize(scope: scope)
                phase = .result(summary)
            } catch {
                phase = .failed(error.localizedDescription)
            }
        }
    }
}
