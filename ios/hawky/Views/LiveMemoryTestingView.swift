import SwiftUI

// =============================================================================
// LiveMemoryTestingView — developer testing tab for the memory system (#653).
//
// Shows the user's four-tier memory (soul / identity / global / daily) read live
// from the gateway, and provides buttons to manually trigger distillation:
//   - Distill current session → today's daily log (memory.distill scope=daily)
//   - Consolidate into global  → MEMORY.md          (memory.distill scope=global)
//   - Mock variants            → same, but skip the LLM (offline/CI)
//
// All work goes through LiveSessionStore → LiveGatewayBridge → gateway RPCs.
// This is a debugging surface, not a user-facing feature.
// =============================================================================

struct LiveMemoryTestingView: View {
    let store: LiveSessionStore

    @State private var snapshot: LiveMemorySnapshot?
    @State private var isLoading = true
    @State private var isWorking = false
    @State private var lastResult: LiveMemoryDistillResult?
    @State private var lastError: String?

    var body: some View {
        List {
            actionsSection
            if let lastResult { resultSection(lastResult) }
            if let lastError { errorSection(lastError) }

            if isLoading && snapshot == nil {
                HStack { Spacer(); ProgressView(); Spacer() }
                    .listRowBackground(Color.clear)
            } else if let snapshot {
                tierSection("Soul", systemImage: "sparkles", file: "SOUL.md", text: snapshot.soul)
                tierSection("Identity", systemImage: "person.text.rectangle", file: "IDENTITY.md", text: snapshot.identity)
                tierSection("Global Memory", systemImage: "brain", file: "MEMORY.md", text: snapshot.global)
                dailySection(snapshot.daily)
            } else {
                ContentUnavailableView(
                    "No memory available",
                    systemImage: "externaldrive.badge.questionmark",
                    description: Text("Couldn't reach the gateway. Configure the Live gateway URL and try again.")
                )
            }
        }
        .navigationTitle("Memory")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task { await load() }
    }

    // MARK: - Sections

    private var actionsSection: some View {
        Section("Distill") {
            distillButton("Distill current session", systemImage: "arrow.down.doc", scope: "daily", mock: false)
            distillButton("Consolidate into global", systemImage: "arrow.triangle.merge", scope: "global", mock: false)
            distillButton("Mock distill (daily)", systemImage: "wand.and.stars", scope: "daily", mock: true)
            distillButton("Mock consolidate (global)", systemImage: "wand.and.stars", scope: "global", mock: true)
        }
        .disabled(isWorking)
    }

    private func distillButton(_ title: String, systemImage: String, scope: String, mock: Bool) -> some View {
        Button {
            Task { await runDistill(scope: scope, mock: mock) }
        } label: {
            HStack {
                Label(title, systemImage: systemImage)
                Spacer()
                if isWorking { ProgressView() }
            }
        }
        .accessibilityIdentifier("live.memory.distill.\(scope).\(mock ? "mock" : "real")")
    }

    private func resultSection(_ result: LiveMemoryDistillResult) -> some View {
        Section("Last run") {
            LabeledContent("Result", value: result.ok ? "OK" : "No change")
            LabeledContent("Scope", value: result.scope)
            LabeledContent("File", value: result.file)
            if result.mocked { LabeledContent("Mode", value: "mock") }
            if let note = result.note {
                Text(note).font(.footnote).foregroundStyle(.secondary)
            }
            if !result.preview.isEmpty {
                Text(result.preview)
                    .font(.system(.footnote, design: .monospaced))
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func errorSection(_ message: String) -> some View {
        Section {
            Label(message, systemImage: "exclamationmark.triangle")
                .foregroundStyle(.orange)
        }
    }

    private func tierSection(_ title: String, systemImage: String, file: String, text: String) -> some View {
        Section {
            if text.isEmpty {
                Text("(empty)").foregroundStyle(.secondary).font(.footnote)
            } else {
                Text(text)
                    .font(.system(.footnote, design: .monospaced))
                    .textSelection(.enabled)
            }
        } header: {
            Label("\(title) — \(file)", systemImage: systemImage)
        }
    }

    private func dailySection(_ entries: [LiveMemoryDailyEntry]) -> some View {
        Section {
            if entries.isEmpty {
                Text("No daily logs yet.").foregroundStyle(.secondary).font(.footnote)
            } else {
                ForEach(entries) { entry in
                    DisclosureGroup(entry.date) {
                        Text(entry.content.isEmpty ? "(empty)" : entry.content)
                            .font(.system(.footnote, design: .monospaced))
                            .textSelection(.enabled)
                    }
                }
            }
        } header: {
            Label("Daily Memory — memory/YYYY-MM-DD.md", systemImage: "calendar")
        }
    }

    // MARK: - Actions

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        snapshot = await store.fetchMemorySnapshot()
        if snapshot == nil { lastError = "Couldn't load memory snapshot from the gateway." }
    }

    private func runDistill(scope: String, mock: Bool) async {
        isWorking = true
        lastError = nil
        defer { isWorking = false }
        guard let result = await store.distillMemory(scope: scope, mock: mock) else {
            lastError = "Distill request failed (no gateway or transport error)."
            return
        }
        lastResult = result
        // Refresh the displayed tiers so the new daily log / global memory shows.
        await load()
    }
}
