import SwiftUI
import UIKit

struct GPTRTranscriptDemoView: View {
    @StateObject private var store = GPTRTranscriptDemoStore()
    @FocusState private var focusedField: Field?
    @State private var apiKeyVisible = false
    @State private var copiedAPIKey = false
    @State private var copiedDiagnostics = false
    @State private var copiedHistoryPath = false
    @State private var folderShare: GPTRFolderShare?

    private enum Field {
        case apiKey
        case model
        case language
    }

    private let delayOptions = ["default", "minimal", "low", "medium", "high", "xhigh"]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                statusPanel
                controlsPanel
                transcriptPanel
                archivePanel
                eventsPanel
                historyPanel
            }
            .padding(16)
        }
        .background(DesignTokens.groupedBackground)
        .navigationTitle("GPTRDemo")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button {
                    UIPasteboard.general.string = store.diagnosticsText()
                    copiedDiagnostics = true
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.4) {
                        copiedDiagnostics = false
                    }
                } label: {
                    Image(systemName: copiedDiagnostics ? "checkmark" : "doc.on.doc")
                }
                .accessibilityLabel("Copy GPTRDemo diagnostics")

                Button {
                    store.reloadSessions()
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .accessibilityLabel("Refresh GPTRDemo history")
            }
        }
        .sheet(item: $folderShare) { share in
            ActivityView(activityItems: [share.url])
        }
        .onDisappear {
            store.saveDrafts()
        }
    }

    private var statusPanel: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                Image(systemName: AppTab.gptrDemo.systemImage)
                    .font(.system(size: 28, weight: .semibold))
                    .foregroundStyle(.indigo)
                    .frame(width: 44, height: 44)
                    .background(.indigo.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))

                VStack(alignment: .leading, spacing: 3) {
                    Text("Realtime transcription archive")
                        .font(DesignTokens.Font.panelTitle)
                    Text("Streams mic PCM over WebSocket and saves clean JSONL transcript/event logs.")
                        .font(DesignTokens.Font.panelBody)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            HStack {
                Label(store.stateLabel, systemImage: store.isRunning ? "waveform.circle.fill" : "circle")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(store.isRunning ? .green : .secondary)
                Spacer()
                Text(byteLabel(store.audioBytes))
                    .font(DesignTokens.Font.meta)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(14)
        .paperSurface(in: RoundedRectangle(cornerRadius: DesignTokens.Radius.panel, style: .continuous))
        .accessibilityIdentifier("gptr.status")
    }

    private var controlsPanel: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Session")
                .font(DesignTokens.Font.panelTitle)
                .accessibilityIdentifier("gptr.session")

            keyField

            TextField("Model", text: $store.model)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .focused($focusedField, equals: .model)
                .textFieldStyle(.roundedBorder)
                .accessibilityIdentifier("gptr.model")

            HStack {
                TextField("Language", text: $store.language)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .focused($focusedField, equals: .language)
                    .textFieldStyle(.roundedBorder)
                    .accessibilityIdentifier("gptr.language")

                Picker("Delay", selection: $store.delay) {
                    ForEach(delayOptions, id: \.self) { value in
                        Text(value).tag(value)
                    }
                }
                .pickerStyle(.menu)
                .frame(maxWidth: 148)
                .accessibilityIdentifier("gptr.delay")
            }

            Toggle(isOn: $store.transcriptionEnabled) {
                Label("Send to OpenAI transcription", systemImage: store.transcriptionEnabled ? "text.quote" : "text.quote")
            }
            .disabled(store.isRunning)
            .accessibilityIdentifier("gptr.transcriptionEnabled")

            Toggle(isOn: $store.recordAudio) {
                Label("Archive audio.wav", systemImage: store.recordAudio ? "waveform" : "waveform.slash")
            }
            .disabled(store.isRunning)
            .accessibilityIdentifier("gptr.recordAudio")

            Toggle(isOn: $store.autoCommitEnabled) {
                Label("Auto commit", systemImage: store.autoCommitEnabled ? "timer" : "timer")
            }
            .disabled(store.isRunning)
            .accessibilityIdentifier("gptr.autoCommit")

            HStack {
                Text("Commit")
                    .font(DesignTokens.Font.panelBody)
                Slider(value: $store.autoCommitSeconds, in: 1...12, step: 1)
                    .disabled(store.isRunning || !store.autoCommitEnabled)
                Text("\(Int(store.autoCommitSeconds))s")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .frame(width: 36, alignment: .trailing)
            }
            .accessibilityIdentifier("gptr.autoCommitSeconds")

            Toggle(isOn: $store.includeBase64InOutboundLog) {
                Label("Log outbound base64 audio", systemImage: store.includeBase64InOutboundLog ? "doc.badge.gearshape" : "doc")
            }
            .disabled(store.isRunning)
            .accessibilityIdentifier("gptr.includeBase64")

            HStack(spacing: 10) {
                Button {
                    focusedField = nil
                    Task {
                        if store.isRunning {
                            await store.stop()
                        } else {
                            await store.start()
                        }
                    }
                } label: {
                    Label(store.isRunning ? "Stop" : "Start", systemImage: store.isRunning ? "stop.circle.fill" : "play.circle.fill")
                        .frame(maxWidth: .infinity)
                }
                .primaryPanelAction(
                    tint: store.isRunning ? DesignTokens.Status.error : DesignTokens.panelAccent,
                    foreground: store.isRunning ? .white : nil
                )
                .disabled(!store.isRunning && !store.canStart)
                .accessibilityIdentifier("gptr.start")

                Button {
                    Task { await store.commitAudio() }
                } label: {
                    Image(systemName: "arrow.up.doc")
                        .frame(width: 42, height: 20)
                }
                .secondaryPanelAction()
                .disabled(!store.isRunning || store.pendingAudioBytes == 0)
                .accessibilityLabel("Commit pending audio")
                .accessibilityIdentifier("gptr.commit")
            }
        }
        .padding(14)
        .paperSurface(in: RoundedRectangle(cornerRadius: DesignTokens.Radius.panel, style: .continuous))
    }

    private var keyField: some View {
        HStack(spacing: 8) {
            Group {
                if apiKeyVisible {
                    TextField("OpenAI API key", text: $store.apiKey)
                } else {
                    SecureField("OpenAI API key", text: $store.apiKey)
                }
            }
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .textContentType(.password)
            .focused($focusedField, equals: .apiKey)
            .accessibilityIdentifier("gptr.apiKey")

            Button {
                apiKeyVisible.toggle()
            } label: {
                Image(systemName: apiKeyVisible ? "eye.slash" : "eye")
                    .frame(width: 24, height: 24)
                    .minimumHitTarget()
            }
            .buttonStyle(.plain)
            .accessibilityLabel(apiKeyVisible ? "Hide OpenAI API key" : "Show OpenAI API key")
            .accessibilityIdentifier("gptr.apiKey.reveal")

            Button {
                UIPasteboard.general.string = store.apiKey
                copiedAPIKey = true
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.4) {
                    copiedAPIKey = false
                }
            } label: {
                Image(systemName: copiedAPIKey ? "checkmark" : "doc.on.doc")
                    .frame(width: 24, height: 24)
                    .minimumHitTarget()
            }
            .buttonStyle(.plain)
            .disabled(store.apiKey.isEmpty)
            .accessibilityLabel("Copy OpenAI API key")
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 7)
        .background(
            RoundedRectangle(cornerRadius: 8)
                .stroke(Color(.separator), lineWidth: 0.5)
                .background(Color(.systemBackground), in: RoundedRectangle(cornerRadius: 8))
        )
    }

    private var transcriptPanel: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Transcript")
                    .font(DesignTokens.Font.panelTitle)
                Spacer()
                Text(store.pendingAudioBytes == 0 ? "Committed" : "\(byteLabel(store.pendingAudioBytes)) pending")
                    .font(DesignTokens.Font.metaStrong)
                    .foregroundStyle(.secondary)
            }

            VStack(alignment: .leading, spacing: 8) {
                transcriptBlock(title: "Live", text: store.liveTranscript)
                Divider()
                transcriptBlock(title: "Final", text: store.finalTranscript)
            }
            .padding(12)
            .paperSurface(in: RoundedRectangle(cornerRadius: DesignTokens.Radius.panel, style: .continuous), inset: true)
        }
        .padding(14)
        .paperSurface(in: RoundedRectangle(cornerRadius: DesignTokens.Radius.panel, style: .continuous))
        .accessibilityIdentifier("gptr.transcriptPanel")
    }

    private var archivePanel: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Archive")
                    .font(DesignTokens.Font.panelTitle)
                Spacer()
                Button {
                    UIPasteboard.general.string = store.historyRootURL.path
                    copiedHistoryPath = true
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.4) {
                        copiedHistoryPath = false
                    }
                } label: {
                    Image(systemName: copiedHistoryPath ? "checkmark" : "doc.on.clipboard")
                }
                .accessibilityLabel("Copy GPTRDemo history folder path")
            }
            filePathRow(title: store.activeFolderURL == nil ? "History" : "Active", path: (store.activeFolderURL ?? store.historyRootURL).path)
        }
        .padding(14)
        .paperSurface(in: RoundedRectangle(cornerRadius: DesignTokens.Radius.panel, style: .continuous))
        .accessibilityIdentifier("gptr.archive")
    }

    private var eventsPanel: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Events")
                .font(DesignTokens.Font.panelTitle)
                .accessibilityIdentifier("gptr.events")

            HStack {
                Toggle("Inbound", isOn: $store.showInboundEvents)
                    .accessibilityIdentifier("gptr.events.inbound")
                Toggle("Outbound", isOn: $store.showOutboundEvents)
                    .accessibilityIdentifier("gptr.events.outbound")
                Toggle("Text", isOn: $store.showTranscriptEvents)
                    .accessibilityIdentifier("gptr.events.text")
            }
            .font(.caption)

            let filtered = store.events.filter { event in
                (event.direction == "in" && store.showInboundEvents)
                    || (event.direction == "out" && store.showOutboundEvents)
                    || (event.direction == "transcript" && store.showTranscriptEvents)
                    || event.direction == "local"
            }

            if filtered.isEmpty {
                Text("No events yet.")
                    .font(DesignTokens.Font.panelBody)
                    .foregroundStyle(.secondary)
            } else {
                VStack(spacing: 8) {
                    ForEach(filtered.prefix(80)) { event in
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text(event.timestamp, style: .time)
                                .font(.caption.monospacedDigit())
                                .foregroundStyle(.secondary)
                                .frame(width: 72, alignment: .leading)
                            Text(event.direction)
                                .font(.caption.monospaced())
                                .foregroundStyle(.secondary)
                                .frame(width: 58, alignment: .leading)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(event.type)
                                    .font(DesignTokens.Font.metaStrong)
                                if !event.summary.isEmpty {
                                    Text(event.summary)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                        .lineLimit(3)
                                }
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                }
            }
        }
        .padding(14)
        .paperSurface(in: RoundedRectangle(cornerRadius: DesignTokens.Radius.panel, style: .continuous))
    }

    private var historyPanel: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("History")
                    .font(DesignTokens.Font.panelTitle)
                Spacer()
                Text("\(store.sessions.count)")
                    .font(DesignTokens.Font.metaStrong)
                    .foregroundStyle(.secondary)
            }

            if store.sessions.isEmpty {
                Text("No saved transcript folders yet.")
                    .font(DesignTokens.Font.panelBody)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("gptr.history.empty")
            } else {
                VStack(spacing: 10) {
                    ForEach(store.sessions) { session in
                        GPTRTranscriptSessionRow(session: session) {
                            folderShare = GPTRFolderShare(url: session.folderURL)
                        }
                    }
                }
            }
        }
        .padding(14)
        .paperSurface(in: RoundedRectangle(cornerRadius: DesignTokens.Radius.panel, style: .continuous))
        .accessibilityIdentifier("gptr.history")
    }

    private func transcriptBlock(title: String, text: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(DesignTokens.Font.metaStrong)
                .foregroundStyle(.secondary)
            Text(text.isEmpty ? "Waiting..." : text)
                .font(.body)
                .foregroundStyle(text.isEmpty ? .secondary : .primary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        }
    }

    private func filePathRow(title: String, path: String) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title)
                .font(DesignTokens.Font.metaStrong)
                .foregroundStyle(.secondary)
            Text(path)
                .font(.caption.monospaced())
                .textSelection(.enabled)
                .lineLimit(4)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .paperSurface(in: RoundedRectangle(cornerRadius: DesignTokens.Radius.panel, style: .continuous), inset: true)
    }

    private func byteLabel(_ bytes: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
    }
}

private struct GPTRFolderShare: Identifiable {
    let id = UUID()
    let url: URL
}

private struct GPTRTranscriptSessionRow: View {
    let session: GPTRTranscriptSession
    let onExportFolder: () -> Void
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(session.folderName)
                        .font(.subheadline.weight(.semibold))
                    Text(session.startedAt, style: .date)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button {
                    onExportFolder()
                } label: {
                    Image(systemName: "square.and.arrow.up")
                }
                .accessibilityLabel("Export GPTRDemo folder")

                Button {
                    UIPasteboard.general.string = session.folderURL.path
                    copied = true
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.4) {
                        copied = false
                    }
                } label: {
                    Image(systemName: copied ? "checkmark" : "doc.on.clipboard")
                }
                .accessibilityLabel("Copy GPTRDemo folder path")
            }

            HStack(spacing: 8) {
                Label(ByteCountFormatter.string(fromByteCount: Int64(session.audioBytes), countStyle: .file), systemImage: "waveform")
                Label("JSONL", systemImage: "curlybraces")
            }
            .font(.caption)
            .foregroundStyle(.secondary)

            Text(session.folderURL.path)
                .font(.caption2.monospaced())
                .foregroundStyle(.secondary)
                .lineLimit(3)
                .textSelection(.enabled)
        }
        .padding(10)
        .paperSurface(in: RoundedRectangle(cornerRadius: DesignTokens.Radius.panel, style: .continuous), inset: true)
    }
}

#Preview {
    NavigationStack {
        GPTRTranscriptDemoView()
    }
}
