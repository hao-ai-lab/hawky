import SwiftUI
import UIKit

struct PipecatRecordingView: View {
    @StateObject private var store = PipecatRecordingDemoStore()
    @FocusState private var focusedField: Field?
    @State private var copiedDiagnostics = false
    @State private var copiedHistoryPath = false
    @State private var apiKeyVisible = false
    @State private var copiedAPIKey = false
    @State private var folderShare: PipecatFolderShare?

    private enum Field {
        case apiKey
        case model
        case instructions
        case initialMessage
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                statusPanel
                controlsPanel
                activeRecordingPanel
                historyPanel
                eventPanel
            }
            .padding(16)
        }
        .background(DesignTokens.groupedBackground)
        .navigationTitle("Pipecat2")
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
                .accessibilityLabel("Copy Pipecat recording diagnostics")

                Button {
                    store.reloadSessions()
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .accessibilityLabel("Refresh recording history")
            }
        }
        .onDisappear {
            store.saveDrafts()
        }
        .sheet(item: $folderShare) { share in
            ActivityView(activityItems: [share.url])
        }
    }

    private var statusPanel: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                Image(systemName: AppTab.pipecatRecording.systemImage)
                    .font(.system(size: 28, weight: .semibold))
                    .foregroundStyle(.orange)
                    .frame(width: 44, height: 44)
                    .background(.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))

                VStack(alignment: .leading, spacing: 3) {
                    Text("WebRTC plus local archive")
                        .font(DesignTokens.Font.panelTitle)
                    Text("Starts a Pipecat OpenAI Realtime session and saves audio/video into a session folder.")
                        .font(DesignTokens.Font.panelBody)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            HStack {
                Label(store.stateLabel, systemImage: store.isRunning ? "record.circle.fill" : "circle")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(store.isRunning ? .red : .secondary)
                Spacer()
                Text(store.model.isEmpty ? "gpt-realtime-2" : store.model)
                    .font(DesignTokens.Font.meta)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(14)
        .paperSurface(in: RoundedRectangle(cornerRadius: DesignTokens.Radius.panel, style: .continuous))
        .accessibilityIdentifier("pipecatRecording.status")
    }

    private var controlsPanel: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Session")
                .font(DesignTokens.Font.panelTitle)
                .accessibilityIdentifier("pipecatRecording.session")

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
                .accessibilityIdentifier("pipecatRecording.apiKey")

                Button {
                    apiKeyVisible.toggle()
                } label: {
                    Image(systemName: apiKeyVisible ? "eye.slash" : "eye")
                        .frame(width: 24, height: 24)
                        .minimumHitTarget()
                }
                .buttonStyle(.plain)
                .accessibilityLabel(apiKeyVisible ? "Hide OpenAI API key" : "Show OpenAI API key")
                .accessibilityIdentifier("pipecatRecording.apiKey.reveal")

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

            TextField("Model", text: $store.model)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .focused($focusedField, equals: .model)
                .textFieldStyle(.roundedBorder)
                .accessibilityIdentifier("pipecatRecording.model")

            TextField("Instructions", text: $store.instructions, axis: .vertical)
                .lineLimit(2...4)
                .focused($focusedField, equals: .instructions)
                .textFieldStyle(.roundedBorder)
                .accessibilityIdentifier("pipecatRecording.instructions")

            TextField("Initial message", text: $store.initialMessage, axis: .vertical)
                .lineLimit(2...4)
                .focused($focusedField, equals: .initialMessage)
                .textFieldStyle(.roundedBorder)
                .accessibilityIdentifier("pipecatRecording.initialMessage")

            Toggle(isOn: $store.recordVideo) {
                Label("Record camera video", systemImage: store.recordVideo ? "video.fill" : "video")
            }
            .disabled(store.isRunning)
            .accessibilityIdentifier("pipecatRecording.recordVideo")

            Toggle(isOn: $store.sendVisualContext) {
                Label("Send camera frames to agent", systemImage: store.sendVisualContext ? "eye.fill" : "eye")
            }
            .disabled(store.isRunning)
            .accessibilityIdentifier("pipecatRecording.sendVisualContext")

            HStack(spacing: 12) {
                Label("Visual FPS", systemImage: "timer")
                    .font(DesignTokens.Font.panelBody)
                Slider(
                    value: $store.visualContextFPS,
                    in: 0.25...5,
                    step: 0.25
                )
                .disabled(store.isRunning || !store.sendVisualContext)
                Text(PipecatRecordingDemoStore.fpsLabel(store.visualContextFPS))
                    .font(.caption.monospacedDigit().weight(.semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 58, alignment: .trailing)
            }
            .accessibilityIdentifier("pipecatRecording.visualFPS")

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
                    Label(
                        store.isRunning ? "Stop and save" : "Start session",
                        systemImage: store.isRunning ? "stop.circle.fill" : "play.circle.fill"
                    )
                    .frame(maxWidth: .infinity)
                }
                .primaryPanelAction(
                    tint: store.isRunning ? DesignTokens.Status.error : DesignTokens.panelAccent,
                    foreground: store.isRunning ? .white : nil
                )
                .disabled(!store.isRunning && !store.canStart)
                .accessibilityIdentifier("pipecatRecording.start")

                Button {
                    Task { await store.setMicEnabled(!store.micEnabled) }
                } label: {
                    Image(systemName: store.micEnabled ? "mic.fill" : "mic.slash.fill")
                        .frame(width: 42, height: 20)
                }
                .secondaryPanelAction()
                .disabled(!store.isRunning)
                .accessibilityLabel(store.micEnabled ? "Mute microphone" : "Unmute microphone")
                .accessibilityIdentifier("pipecatRecording.mic")
            }
        }
        .padding(14)
        .paperSurface(in: RoundedRectangle(cornerRadius: DesignTokens.Radius.panel, style: .continuous))
    }

    private var activeRecordingPanel: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Recording Folder")
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
                .accessibilityLabel("Copy recording history folder path")
            }

            if let activeFolderURL = store.activeFolderURL {
                filePathRow(title: "Active", path: activeFolderURL.path)
            } else {
                filePathRow(title: "History", path: store.historyRootURL.path)
            }

            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 8) {
                PipecatMetricCell(title: "Audio", value: byteLabel(store.activeAudioBytes), icon: "waveform")
                PipecatMetricCell(title: "Video", value: byteLabel(store.activeVideoBytes), icon: "film")
                PipecatMetricCell(title: "Frames", value: "\(store.activeKeyframeCount)", icon: "photo")
                PipecatMetricCell(title: "Sent", value: "\(store.activeSentFrameCount)", icon: "eye")
            }
        }
        .padding(14)
        .paperSurface(in: RoundedRectangle(cornerRadius: DesignTokens.Radius.panel, style: .continuous))
        .accessibilityIdentifier("pipecatRecording.folder")
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
                Text("No saved recording folders yet.")
                    .font(DesignTokens.Font.panelBody)
                    .foregroundStyle(.secondary)
            } else {
                VStack(spacing: 10) {
                    ForEach(store.sessions) { session in
                        PipecatRecordingSessionRow(session: session)
                            .contextMenu {
                                Button {
                                    folderShare = PipecatFolderShare(url: session.folderURL)
                                } label: {
                                    Label("Export Folder", systemImage: "square.and.arrow.up")
                                }

                                Button {
                                    UIPasteboard.general.string = session.folderURL.path
                                } label: {
                                    Label("Copy Folder Path", systemImage: "doc.on.clipboard")
                                }
                            }
                    }
                }
            }
        }
        .padding(14)
        .paperSurface(in: RoundedRectangle(cornerRadius: DesignTokens.Radius.panel, style: .continuous))
        .accessibilityIdentifier("pipecatRecording.history")
    }

    private var eventPanel: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Events")
                .font(DesignTokens.Font.panelTitle)

            ForEach(store.events) { event in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(event.date, style: .time)
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                        .frame(width: 72, alignment: .leading)
                    Text(event.message)
                        .font(DesignTokens.Font.panelBody)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .padding(14)
        .paperSurface(in: RoundedRectangle(cornerRadius: DesignTokens.Radius.panel, style: .continuous))
        .accessibilityIdentifier("pipecatRecording.events")
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

    private func byteLabel(_ bytes: UInt64) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
    }
}

private struct PipecatFolderShare: Identifiable {
    let id = UUID()
    let url: URL
}

private struct PipecatMetricCell: View {
    let title: String
    let value: String
    let icon: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Image(systemName: icon)
                .font(DesignTokens.Font.panelTitle)
                .foregroundStyle(.secondary)
            Text(value)
                .font(.subheadline.weight(.semibold))
                .lineLimit(1)
                .minimumScaleFactor(0.75)
            Text(title)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .paperSurface(in: RoundedRectangle(cornerRadius: DesignTokens.Radius.panel, style: .continuous), inset: true)
    }
}

private struct PipecatRecordingSessionRow: View {
    let session: PipecatRecordingSession

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(session.folderName)
                        .font(.subheadline.weight(.semibold))
                    Text(session.startedAt, format: .dateTime.month(.abbreviated).day().hour().minute().second())
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
            }

            HStack(spacing: 8) {
                Label(ByteCountFormatter.string(fromByteCount: Int64(session.audioBytes), countStyle: .file), systemImage: "waveform")
                Label(ByteCountFormatter.string(fromByteCount: Int64(session.videoBytes), countStyle: .file), systemImage: "film")
                Label("\(session.keyframeCount)", systemImage: "photo")
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .padding(10)
        .paperSurface(in: RoundedRectangle(cornerRadius: DesignTokens.Radius.panel, style: .continuous), inset: true)
    }
}

struct Live2View: View {
    @StateObject private var store = Live2SessionStore()
    @FocusState private var focusedField: Field?
    @State private var textDraft = ""
    @State private var copiedDiagnostics = false

    private enum Field {
        case model
        case instructions
        case initialMessage
        case text
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                statusPanel
                previewPanel
                controlsPanel
                textPanel
                settingsNavigationPanel
                recordingNavigationPanel
                eventPanel
            }
            .padding(16)
        }
        .background(DesignTokens.groupedBackground)
        .navigationTitle("Live2")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    UIPasteboard.general.string = store.diagnosticsText()
                    copiedDiagnostics = true
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.4) {
                        copiedDiagnostics = false
                    }
                } label: {
                    Image(systemName: copiedDiagnostics ? "checkmark" : "doc.on.doc")
                }
                .accessibilityLabel("Copy Live2 diagnostics")
            }
        }
        .onDisappear {
            store.saveDrafts()
        }
    }

    private var statusPanel: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                Image(systemName: AppTab.live2.systemImage)
                    .font(.system(size: 28, weight: .semibold))
                    .foregroundStyle(.teal)
                    .frame(width: 44, height: 44)
                    .background(.teal.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))

                VStack(alignment: .leading, spacing: 3) {
                    Text("OpenAI WebRTC")
                        .font(DesignTokens.Font.panelTitle)
                    Text(store.hasSavedOpenAIKey ? "Direct key saved" : "Save a Direct OpenAI key in Settings > Live")
                        .font(DesignTokens.Font.panelBody)
                        .foregroundStyle(store.hasSavedOpenAIKey ? Color.secondary : Color.orange)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            HStack {
                Label(store.stateLabel, systemImage: store.isRunning ? "waveform.circle.fill" : "circle")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(store.isRunning ? .green : .secondary)
                Spacer()
                Text(store.model.isEmpty ? "gpt-realtime-2" : store.model)
                    .font(DesignTokens.Font.meta)
                    .foregroundStyle(.secondary)
            }

            if let lastError = store.lastError {
                Text(lastError)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(14)
        .paperSurface(in: RoundedRectangle(cornerRadius: DesignTokens.Radius.panel, style: .continuous))
        .accessibilityIdentifier("live2.status")
    }

    private var previewPanel: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Camera")
                    .font(DesignTokens.Font.panelTitle)
                    .accessibilityIdentifier("live2.cameraPanel")
                Spacer()
                cameraCounterBadge
                Label(store.cameraEnabled ? "On" : "Off", systemImage: store.cameraEnabled ? "camera.fill" : "camera")
                    .font(DesignTokens.Font.metaStrong)
                    .foregroundStyle(store.cameraEnabled ? .green : .secondary)
                Button {
                    store.setCameraPosition(store.cameraPosition.toggled)
                } label: {
                    Image(systemName: "camera.rotate")
                }
                .secondaryPanelAction()
                .disabled(store.isConnecting)
                .accessibilityLabel("Flip Live2 camera")
            }

            ZStack {
                if let capture = store.capture {
                    VideoPreviewView(capture: capture)
                } else {
                    Color.black
                    Image(systemName: "camera")
                        .font(.system(size: 32, weight: .semibold))
                        .foregroundStyle(.white.opacity(0.55))
                }
            }
            .aspectRatio(4 / 3, contentMode: .fit)
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .accessibilityLabel("Live2 camera preview")
            .accessibilityIdentifier("live2.preview")
        }
        .padding(14)
        .paperSurface(in: RoundedRectangle(cornerRadius: DesignTokens.Radius.panel, style: .continuous))
    }

    private var cameraCounterBadge: some View {
        VStack(alignment: .trailing, spacing: 1) {
            Text("Captured \(store.framesCaptured)")
            Text("Sent \(store.framesSent)")
        }
        .font(.caption2.monospacedDigit().weight(.semibold))
        .foregroundStyle(.secondary)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Captured \(store.framesCaptured), sent \(store.framesSent)")
        .accessibilityIdentifier("live2.cameraCounters")
    }

    private var controlsPanel: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Session")
                .font(DesignTokens.Font.panelTitle)
                .accessibilityIdentifier("live2.session")

            HStack(spacing: 10) {
                Button {
                    focusedField = nil
                    Task {
                        if store.isRunning || store.isConnecting {
                            await store.stop()
                        } else {
                            await store.start()
                        }
                    }
                } label: {
                    Label(
                        store.isRunning || store.isConnecting ? "Stop" : "Start",
                        systemImage: store.isRunning || store.isConnecting ? "stop.circle.fill" : "play.circle.fill"
                    )
                    .frame(maxWidth: .infinity)
                }
                .primaryPanelAction(
                    tint: store.isRunning || store.isConnecting ? DesignTokens.Status.error : DesignTokens.panelAccent,
                    foreground: store.isRunning || store.isConnecting ? .white : nil
                )
                .disabled(!store.hasSavedOpenAIKey && !store.isRunning && !store.isConnecting)
                .accessibilityIdentifier("live2.start")

                Button {
                    Task { await store.setMicEnabled(!store.micEnabled) }
                } label: {
                    Image(systemName: store.micEnabled ? "mic.fill" : "mic.slash.fill")
                        .frame(width: 42, height: 20)
                }
                .secondaryPanelAction()
                .disabled(!store.isRunning)
                .accessibilityLabel(store.micEnabled ? "Mute microphone" : "Unmute microphone")
                .accessibilityIdentifier("live2.mic")
            }
        }
        .padding(14)
        .paperSurface(in: RoundedRectangle(cornerRadius: DesignTokens.Radius.panel, style: .continuous))
    }

    private var settingsNavigationPanel: some View {
        NavigationLink {
            Live2SettingsView(store: store)
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "slider.horizontal.3")
                    .font(DesignTokens.Font.panelTitle)
                    .foregroundStyle(.teal)
                    .frame(width: 34, height: 34)
                    .background(.teal.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))

                VStack(alignment: .leading, spacing: 4) {
                    Text("Settings")
                        .font(DesignTokens.Font.panelTitle)
                        .foregroundStyle(.primary)
                    Text("\(store.model.isEmpty ? "gpt-realtime-2" : store.model) · \(Live2SessionStore.fpsLabel(store.visualContextFPS))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }

                Spacer()

                Image(systemName: "chevron.right")
                    .font(DesignTokens.Font.metaStrong)
                    .foregroundStyle(.tertiary)
            }
            .padding(14)
            .paperSurface(in: RoundedRectangle(cornerRadius: DesignTokens.Radius.panel, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("live2.settingsLink")
    }

    private var recordingNavigationPanel: some View {
        NavigationLink {
            Live2RecordingHistoryView(store: store)
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "folder")
                    .font(DesignTokens.Font.panelTitle)
                    .foregroundStyle(.teal)
                    .frame(width: 34, height: 34)
                    .background(.teal.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))

                VStack(alignment: .leading, spacing: 4) {
                    Text("Recording Folder")
                        .font(DesignTokens.Font.panelTitle)
                        .foregroundStyle(.primary)
                    Text(recordingSummary)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }

                Spacer()

                Image(systemName: "chevron.right")
                    .font(DesignTokens.Font.metaStrong)
                    .foregroundStyle(.tertiary)
            }
            .padding(14)
            .paperSurface(in: RoundedRectangle(cornerRadius: DesignTokens.Radius.panel, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("live2.recordingsLink")
    }

    private var recordingSummary: String {
        if let activeFolderURL = store.activeFolderURL {
            return "Active: \(activeFolderURL.lastPathComponent)"
        }
        return "\(store.sessions.count) saved sessions"
    }

    private var textPanel: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Text Turn")
                .font(DesignTokens.Font.panelTitle)
                .accessibilityIdentifier("live2.textTurn")

            TextField("Send a text turn", text: $textDraft, axis: .vertical)
                .lineLimit(2...5)
                .focused($focusedField, equals: .text)
                .textFieldStyle(.roundedBorder)
                .accessibilityIdentifier("live2.textDraft")

            HStack(spacing: 10) {
                Button {
                    let text = textDraft
                    textDraft = ""
                    Task { await store.sendText(text, createResponse: true) }
                } label: {
                    Label("Send as User", systemImage: "paperplane.fill")
                        .frame(maxWidth: .infinity)
                }
                .primaryPanelAction()
                .disabled(textDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !store.isRunning)
                .accessibilityIdentifier("live2.sendUser")

                Button {
                    let text = textDraft
                    textDraft = ""
                    Task { await store.sendText(text, createResponse: false) }
                } label: {
                    Label("Context", systemImage: "text.badge.plus")
                        .frame(maxWidth: .infinity)
                }
                .secondaryPanelAction()
                .disabled(textDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !store.isRunning)
                .accessibilityIdentifier("live2.sendContext")
            }
        }
        .padding(14)
        .paperSurface(in: RoundedRectangle(cornerRadius: DesignTokens.Radius.panel, style: .continuous))
    }

    private var eventPanel: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Events")
                    .font(DesignTokens.Font.panelTitle)
                Spacer()
                Button {
                    store.clearEvents()
                } label: {
                    Image(systemName: "trash")
                }
                .accessibilityLabel("Clear Live2 events")
                .accessibilityIdentifier("live2.events.clear")

                Menu {
                    ForEach(PipecatDemoEventKind.allCases) { kind in
                        Button {
                            store.toggleEventKind(kind)
                        } label: {
                            Label(kind.label, systemImage: store.visibleEventKinds.contains(kind) ? "checkmark" : "")
                        }
                    }
                } label: {
                    Image(systemName: "line.3.horizontal.decrease.circle")
                }
                .accessibilityLabel("Filter Live2 events")
                .accessibilityIdentifier("live2.events.filter")
            }

            ForEach(visibleEvents) { event in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(Self.eventTimeFormatter.string(from: event.date))
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                        .frame(width: 72, alignment: .leading)
                    Text(event.message)
                        .font(DesignTokens.Font.panelBody)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .padding(14)
        .paperSurface(in: RoundedRectangle(cornerRadius: DesignTokens.Radius.panel, style: .continuous))
        .accessibilityIdentifier("live2.events")
    }

    private var visibleEvents: [PipecatDemoEvent] {
        store.events
            .filter { store.visibleEventKinds.contains($0.kind) }
            .prefix(30)
            .map { $0 }
    }

    private static let eventTimeFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm:ss"
        return formatter
    }()
}

private struct Live2SettingsView: View {
    @ObservedObject var store: Live2SessionStore
    @FocusState private var focusedField: Field?

    private enum Field {
        case customModel
        case instructions
        case initialMessage
    }

    var body: some View {
        List {
            Section("Model") {
                Picker("Model", selection: Binding(
                    get: { store.modelPreset },
                    set: { store.setModelPreset($0) }
                )) {
                    ForEach(LiveOpenAIModelPreset.selectableCases) { preset in
                        Text(preset.label).tag(preset)
                    }
                }
                .pickerStyle(.navigationLink)
                .disabled(store.isRunning || store.isConnecting)
                .accessibilityIdentifier("live2.settings.modelPreset")

                if store.modelPreset == .custom {
                    TextField("Custom model ID", text: $store.model)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .focused($focusedField, equals: .customModel)
                        .disabled(store.isRunning || store.isConnecting)
                        .accessibilityIdentifier("live2.settings.customModel")
                }
            }

            Section("Prompt") {
                TextField("Instructions", text: $store.instructions, axis: .vertical)
                    .lineLimit(3...8)
                    .focused($focusedField, equals: .instructions)
                    .disabled(store.isRunning || store.isConnecting)
                    .accessibilityIdentifier("live2.settings.instructions")

                TextField("Initial message", text: $store.initialMessage, axis: .vertical)
                    .lineLimit(2...5)
                    .focused($focusedField, equals: .initialMessage)
                    .disabled(store.isRunning || store.isConnecting)
                    .accessibilityIdentifier("live2.settings.initialMessage")
            }

            Section("Visual") {
                Toggle(isOn: Binding(
                    get: { store.visualContextEnabled },
                    set: { enabled in
                        Task { await store.setCameraEnabled(enabled) }
                    }
                )) {
                    Label("Send camera frames", systemImage: store.visualContextEnabled ? "eye.fill" : "eye")
                }
                .disabled(store.isRunning || store.isConnecting)
                .accessibilityIdentifier("live2.settings.visualContext")

                Toggle(isOn: Binding(
                    get: { store.recordVideo },
                    set: { store.setRecordVideo($0) }
                )) {
                    Label("Record camera video", systemImage: store.recordVideo ? "video.fill" : "video")
                }
                .disabled(store.isRunning || store.isConnecting)
                .accessibilityIdentifier("live2.settings.recordVideo")

                Picker("Camera", selection: Binding(
                    get: { store.cameraPosition },
                    set: { store.setCameraPosition($0) }
                )) {
                    ForEach(LiveCameraPosition.allCases) { position in
                        Text(position.label).tag(position)
                    }
                }
                .pickerStyle(.segmented)
                .accessibilityIdentifier("live2.settings.camera")

                HStack(spacing: 12) {
                    Label("Visual FPS", systemImage: "timer")
                    Slider(
                        value: $store.visualContextFPS,
                        in: 0.25...5,
                        step: 0.25
                    )
                    .disabled(store.isRunning || !store.visualContextEnabled)
                    Text(Live2SessionStore.fpsLabel(store.visualContextFPS))
                        .font(.caption.monospacedDigit().weight(.semibold))
                        .foregroundStyle(.secondary)
                        .frame(width: 58, alignment: .trailing)
                }
                .accessibilityIdentifier("live2.settings.visualFPS")
            }
        }
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.inline)
        .onDisappear {
            store.saveDrafts()
        }
    }
}

private struct Live2RecordingHistoryView: View {
    @ObservedObject var store: Live2SessionStore
    @State private var copiedHistoryPath = false
    @State private var folderShare: PipecatFolderShare?

    var body: some View {
        List {
            Section("Current") {
                activeRecordingPanel
                    .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                    .listRowBackground(Color.clear)
            }

            Section("History") {
                if store.sessions.isEmpty {
                    Text("No saved Live2 recording folders yet.")
                        .font(DesignTokens.Font.panelBody)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("live2.recordings.empty")
                } else {
                    ForEach(store.sessions) { session in
                        NavigationLink {
                            Live2RecordingSessionDetailView(session: session)
                        } label: {
                            PipecatRecordingSessionRow(session: session)
                        }
                        .contextMenu {
                            sessionActions(for: session)
                        }
                        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                            Button {
                                folderShare = PipecatFolderShare(url: session.folderURL)
                            } label: {
                                Label("Export", systemImage: "square.and.arrow.up")
                            }
                            .tint(.blue)

                            Button {
                                UIPasteboard.general.string = session.folderURL.path
                            } label: {
                                Label("Copy", systemImage: "doc.on.clipboard")
                            }
                            .tint(.gray)
                        }
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .background(DesignTokens.groupedBackground)
        .navigationTitle("Recordings")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button {
                    UIPasteboard.general.string = store.historyRootURL.path
                    copiedHistoryPath = true
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.4) {
                        copiedHistoryPath = false
                    }
                } label: {
                    Image(systemName: copiedHistoryPath ? "checkmark" : "doc.on.clipboard")
                }
                .accessibilityLabel("Copy Live2 recording history folder path")

                Button {
                    store.reloadSessions()
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .accessibilityLabel("Refresh Live2 recording history")
            }
        }
        .sheet(item: $folderShare) { share in
            ActivityView(activityItems: [share.url])
        }
    }

    private var activeRecordingPanel: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let activeFolderURL = store.activeFolderURL {
                filePathRow(title: "Active", path: activeFolderURL.path)
            } else {
                filePathRow(title: "History", path: store.historyRootURL.path)
            }

            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 8) {
                PipecatMetricCell(title: "Audio", value: byteLabel(store.activeAudioBytes), icon: "waveform")
                PipecatMetricCell(title: "Video", value: byteLabel(store.activeVideoBytes), icon: "film")
                PipecatMetricCell(title: "Keyframes", value: "\(store.activeKeyframeCount)", icon: "photo")
                PipecatMetricCell(title: "Sent", value: "\(store.framesSent)", icon: "eye")
            }
        }
        .padding(14)
        .paperSurface(in: RoundedRectangle(cornerRadius: DesignTokens.Radius.panel, style: .continuous))
        .accessibilityIdentifier("live2.recordings.current")
    }

    @ViewBuilder
    private func sessionActions(for session: PipecatRecordingSession) -> some View {
        Button {
            folderShare = PipecatFolderShare(url: session.folderURL)
        } label: {
            Label("Export Folder", systemImage: "square.and.arrow.up")
        }

        Button {
            UIPasteboard.general.string = session.folderURL.path
        } label: {
            Label("Copy Folder Path", systemImage: "doc.on.clipboard")
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

    private func byteLabel(_ bytes: UInt64) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
    }
}

private struct Live2RecordingSessionDetailView: View {
    let session: PipecatRecordingSession
    @State private var messages: [ArchivedSessionLine] = []
    @State private var openAIEvents: [ArchivedSessionLine] = []
    @State private var manifestItems: [ArchivedManifestItem] = []
    @State private var folderShare: PipecatFolderShare?
    @State private var copied = false

    var body: some View {
        List {
            Section("Summary") {
                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 8) {
                    PipecatMetricCell(title: "Audio", value: byteLabel(session.audioBytes), icon: "waveform")
                    PipecatMetricCell(title: "Video", value: byteLabel(session.videoBytes), icon: "film")
                    PipecatMetricCell(title: "Keyframes", value: "\(session.keyframeCount)", icon: "photo")
                    PipecatMetricCell(title: "Started", value: Self.shortTimeFormatter.string(from: session.startedAt), icon: "clock")
                }
                .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                .listRowBackground(Color.clear)
            }

            if !manifestItems.isEmpty {
                Section("Manifest") {
                    ForEach(manifestItems) { item in
                        HStack(alignment: .firstTextBaseline) {
                            Text(item.title)
                                .foregroundStyle(.secondary)
                            Spacer()
                            Text(item.value)
                                .multilineTextAlignment(.trailing)
                        }
                        .font(DesignTokens.Font.panelBody)
                    }
                }
            }

            Section("Transcript Events") {
                if messages.isEmpty {
                    Text("No transcript events saved.")
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(messages) { line in
                        archivedLineRow(line)
                    }
                }
            }

            Section("OpenAI Events") {
                if openAIEvents.isEmpty {
                    Text("No raw OpenAI events saved.")
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(openAIEvents.prefix(40)) { line in
                        archivedLineRow(line)
                    }
                }
            }
        }
        .navigationTitle(session.folderName)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button {
                    folderShare = PipecatFolderShare(url: session.folderURL)
                } label: {
                    Image(systemName: "square.and.arrow.up")
                }
                .accessibilityLabel("Export session folder")

                Button {
                    UIPasteboard.general.string = session.folderURL.path
                    copied = true
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.4) {
                        copied = false
                    }
                } label: {
                    Image(systemName: copied ? "checkmark" : "doc.on.clipboard")
                }
                .accessibilityLabel("Copy session folder path")
            }
        }
        .sheet(item: $folderShare) { share in
            ActivityView(activityItems: [share.url])
        }
        .task {
            messages = Self.loadArchivedMessages(from: session.messagesURL)
            openAIEvents = Self.loadOpenAIEvents(from: session.openAIEventsURL)
            manifestItems = Self.loadManifestItems(from: session.manifestURL)
        }
    }

    private func archivedLineRow(_ line: ArchivedSessionLine) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                Text(line.title)
                    .font(.subheadline.weight(.semibold))
                Spacer()
                Text(line.timestamp)
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            if !line.detail.isEmpty {
                Text(line.detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func byteLabel(_ bytes: UInt64) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
    }

    private static func loadArchivedMessages(from url: URL) -> [ArchivedSessionLine] {
        loadJSONLines(from: url).compactMap { object in
            let timestamp = displayTimestamp(object["timestamp"])
            let role = object["role"] as? String ?? "event"
            let event = object["event"] as? String ?? "message"
            let content = object["content"] as? String
            let detail = content ?? metadataSummary(object, skipping: ["timestamp", "role", "event"])
            return ArchivedSessionLine(timestamp: timestamp, title: "\(role): \(event)", detail: detail)
        }
    }

    private static func loadOpenAIEvents(from url: URL) -> [ArchivedSessionLine] {
        loadJSONLines(from: url).compactMap { object in
            let timestamp = displayTimestamp(object["timestamp"])
            if let event = object["event"] as? [String: Any] {
                let type = event["type"] as? String ?? "openai.event"
                let detail = metadataSummary(event, skipping: ["type"])
                return ArchivedSessionLine(timestamp: timestamp, title: type, detail: detail)
            }
            let detail = metadataSummary(object, skipping: ["timestamp"])
            return ArchivedSessionLine(timestamp: timestamp, title: "openai.event", detail: detail)
        }
    }

    private static func loadManifestItems(from url: URL) -> [ArchivedManifestItem] {
        guard let data = try? Data(contentsOf: url),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return []
        }
        let keys = [
            "finalized_at",
            "record_video",
            "visual_context_enabled",
            "visual_context_fps",
            "visual_context_sent_frames",
            "assistant_audio_captured"
        ]
        return keys.compactMap { key in
            guard let value = object[key], !(value is NSNull) else { return nil }
            return ArchivedManifestItem(title: key.replacingOccurrences(of: "_", with: " "), value: displayValue(value))
        }
    }

    private static func loadJSONLines(from url: URL) -> [[String: Any]] {
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return [] }
        return text
            .split(separator: "\n")
            .compactMap { line -> [String: Any]? in
                guard let data = line.data(using: .utf8) else { return nil }
                return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            }
    }

    private static func metadataSummary(_ object: [String: Any], skipping keys: Set<String>) -> String {
        object
            .filter { !keys.contains($0.key) && !($0.value is NSNull) }
            .sorted { $0.key < $1.key }
            .prefix(4)
            .map { "\($0.key): \(displayValue($0.value))" }
            .joined(separator: ", ")
    }

    private static func displayTimestamp(_ value: Any?) -> String {
        guard let raw = value as? String else { return "" }
        if let date = isoFormatter.date(from: raw) {
            return shortTimeFormatter.string(from: date)
        }
        return raw
    }

    private static func displayValue(_ value: Any) -> String {
        switch value {
        case let string as String:
            return string
        case let number as NSNumber:
            return number.stringValue
        case let array as [Any]:
            return "\(array.count) items"
        case let object as [String: Any]:
            return object["type"] as? String ?? "\(object.count) fields"
        default:
            return String(describing: value)
        }
    }

    private static let isoFormatter = ISO8601DateFormatter()

    private static let shortTimeFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm:ss"
        return formatter
    }()
}

private struct ArchivedSessionLine: Identifiable {
    let id = UUID()
    let timestamp: String
    let title: String
    let detail: String
}

private struct ArchivedManifestItem: Identifiable {
    let id = UUID()
    let title: String
    let value: String
}
