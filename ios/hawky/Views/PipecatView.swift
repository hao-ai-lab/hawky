import SwiftUI
import UIKit

struct PipecatView: View {
    @StateObject private var store = PipecatDemoStore()
    @FocusState private var focusedField: Field?
    @State private var didHandleLaunchArguments = false
    @State private var copiedDiagnostics = false
    @State private var apiKeyVisible = false
    @State private var copiedAPIKey = false

    private enum Field {
        case apiKey
        case model
        case instructions
        case initialMessage
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                statusPanel
                connectionPanel
                webrtcPanel
                transcriptPanel
                eventPanel
            }
            .padding(16)
        }
        .background(DesignTokens.groupedBackground)
        .navigationTitle("PipeCat")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button {
                    UIPasteboard.general.string = store.diagnosticsText()
                    copiedDiagnostics = true
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                        copiedDiagnostics = false
                    }
                } label: {
                    Image(systemName: copiedDiagnostics ? "checkmark" : "doc.on.doc")
                }
                .accessibilityLabel("Copy PipeCat diagnostics")

                Button {
                    store.clearEvents()
                } label: {
                    Image(systemName: "trash")
                }
                .accessibilityLabel("Clear PipeCat events")
            }
        }
        .onDisappear {
            store.saveDrafts()
        }
        .task {
            guard !didHandleLaunchArguments else { return }
            didHandleLaunchArguments = true
            guard ProcessInfo.processInfo.arguments.contains("--pipecat-autoconnect") else { return }
            await store.connectFromLaunchArgument()
        }
    }

    private var statusPanel: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 12) {
                Image(systemName: AppTab.pipecat.systemImage)
                    .font(.system(size: 28, weight: .semibold))
                    .foregroundStyle(.cyan)
                    .frame(width: 44, height: 44)
                    .background(.cyan.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
                VStack(alignment: .leading, spacing: 3) {
                    Text("Pipecat OpenAI WebRTC")
                        .font(DesignTokens.Font.panelTitle)
                    Text("Direct iOS demo for realtime speech, barge-in, and echo comparison.")
                        .font(DesignTokens.Font.panelBody)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            HStack {
                Label(store.stateLabel, systemImage: statusIcon)
                    .font(.subheadline.weight(.semibold))
                Spacer()
                Label(store.model.isEmpty ? "gpt-realtime-2" : store.model, systemImage: "waveform")
                    .font(DesignTokens.Font.meta)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(14)
        .paperSurface(in: RoundedRectangle(cornerRadius: DesignTokens.Radius.panel, style: .continuous))
        .accessibilityIdentifier("pipecat.status")
    }

    private var connectionPanel: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Session")
                .font(DesignTokens.Font.panelTitle)
                .accessibilityIdentifier("pipecat.session")

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
                .accessibilityIdentifier("pipecat.apiKey")

                Button {
                    apiKeyVisible.toggle()
                } label: {
                    Image(systemName: apiKeyVisible ? "eye.slash" : "eye")
                        .frame(width: 24, height: 24)
                        .minimumHitTarget()
                }
                .buttonStyle(.plain)
                .accessibilityLabel(apiKeyVisible ? "Hide OpenAI API key" : "Show OpenAI API key")
                .accessibilityIdentifier("pipecat.apiKey.reveal")

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
                .accessibilityIdentifier("pipecat.model")

            TextField("Instructions", text: $store.instructions, axis: .vertical)
                .lineLimit(2...4)
                .focused($focusedField, equals: .instructions)
                .textFieldStyle(.roundedBorder)
                .accessibilityIdentifier("pipecat.instructions")

            TextField("Initial message", text: $store.initialMessage, axis: .vertical)
                .lineLimit(2...4)
                .focused($focusedField, equals: .initialMessage)
                .textFieldStyle(.roundedBorder)
                .accessibilityIdentifier("pipecat.initialMessage")

            Toggle(isOn: Binding(
                get: { store.transcriptEnabled },
                set: { store.setTranscriptEnabled($0) }
            )) {
                Label("Transcript", systemImage: store.transcriptEnabled ? "text.bubble.fill" : "text.bubble")
            }
            .accessibilityIdentifier("pipecat.transcriptEnabled")

            Toggle(isOn: Binding(
                get: { store.startupGuardEnabled },
                set: { store.setStartupGuardEnabled($0) }
            )) {
                Label("Startup guard", systemImage: store.startupGuardEnabled ? "mic.badge.xmark" : "mic")
            }
            .disabled(store.isConnected)
            .accessibilityIdentifier("pipecat.startupGuard")

            HStack(spacing: 10) {
                Button {
                    focusedField = nil
                    Task {
                        if store.isConnected {
                            await store.disconnect()
                        } else {
                            await store.connect()
                        }
                    }
                } label: {
                    Label(
                        store.isConnected ? "Disconnect" : "Connect",
                        systemImage: store.isConnected ? "stop.circle.fill" : "play.circle.fill"
                    )
                    .frame(maxWidth: .infinity)
                }
                .primaryPanelAction()
                .disabled(!store.isConnected && !store.canConnect)
                .accessibilityIdentifier("pipecat.connect")

                Button {
                    Task { await store.setMicEnabled(!store.micEnabled) }
                } label: {
                    Image(systemName: store.micEnabled ? "mic.fill" : "mic.slash.fill")
                        .frame(width: 42, height: 20)
                }
                .secondaryPanelAction()
                .disabled(!store.isConnected)
                .accessibilityLabel(store.micEnabled ? "Mute PipeCat microphone" : "Unmute PipeCat microphone")
                .accessibilityIdentifier("pipecat.mic")
            }

            Text("This direct-key path is for local testing. A production app should mint ephemeral sessions server-side or connect through a Pipecat/Daily transport.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(14)
        .paperSurface(in: RoundedRectangle(cornerRadius: DesignTokens.Radius.panel, style: .continuous))
    }

    private var webrtcPanel: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Why WebRTC")
                .font(DesignTokens.Font.panelTitle)

            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
                PipecatCapabilityCell(icon: "ear.and.waveform", title: "AEC", detail: "Far-end audio is part of the media graph.")
                PipecatCapabilityCell(icon: "bolt.horizontal", title: "Low latency", detail: "Pacing, jitter, and congestion are built in.")
                PipecatCapabilityCell(icon: "waveform.badge.mic", title: "Barge-in", detail: "Mic and model audio stay full duplex.")
                PipecatCapabilityCell(icon: "video", title: "Media-ready", detail: "The stack can grow into camera/video paths.")
            }
        }
        .padding(14)
        .paperSurface(in: RoundedRectangle(cornerRadius: DesignTokens.Radius.panel, style: .continuous))
        .accessibilityIdentifier("pipecat.webrtc")
    }

    private var transcriptPanel: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Transcript")
                    .font(DesignTokens.Font.panelTitle)
                Spacer()
                Text(store.transcriptEnabled ? "On" : "Off")
                    .font(DesignTokens.Font.metaStrong)
                    .foregroundStyle(store.transcriptEnabled ? .primary : .secondary)
            }

            VStack(alignment: .leading, spacing: 8) {
                transcriptRow(title: "You", text: store.userTranscript)
                Divider()
                transcriptRow(title: "Bot", text: store.botTranscript)
            }
            .padding(12)
            .paperSurface(in: RoundedRectangle(cornerRadius: DesignTokens.Radius.panel, style: .continuous), inset: true)
        }
        .padding(14)
        .paperSurface(in: RoundedRectangle(cornerRadius: DesignTokens.Radius.panel, style: .continuous))
        .accessibilityIdentifier("pipecat.transcriptPanel")
    }

    private var eventPanel: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Events")
                .font(DesignTokens.Font.panelTitle)

            if store.events.isEmpty {
                Text("No events yet.")
                    .font(DesignTokens.Font.panelBody)
                    .foregroundStyle(.secondary)
            } else {
                VStack(spacing: 8) {
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
            }
        }
        .padding(14)
        .paperSurface(in: RoundedRectangle(cornerRadius: DesignTokens.Radius.panel, style: .continuous))
        .accessibilityIdentifier("pipecat.events")
    }

    private var statusIcon: String {
        switch store.stateLabel.lowercased() {
        case let value where value.contains("ready") || value.contains("connected"):
            return "checkmark.circle.fill"
        case let value where value.contains("error"):
            return "exclamationmark.triangle.fill"
        case let value where value.contains("connecting") || value.contains("auth"):
            return "arrow.triangle.2.circlepath"
        default:
            return "circle"
        }
    }

    private func transcriptRow(title: String, text: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(DesignTokens.Font.metaStrong)
                .foregroundStyle(.secondary)
            Text(text.isEmpty ? "Waiting for speech..." : text)
                .font(.body)
                .foregroundStyle(text.isEmpty ? .secondary : .primary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

private struct PipecatCapabilityCell: View {
    let icon: String
    let title: String
    let detail: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Image(systemName: icon)
                .font(.title3)
                .foregroundStyle(.cyan)
            Text(title)
                .font(.subheadline.weight(.semibold))
            Text(detail)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, minHeight: 118, alignment: .topLeading)
        .padding(10)
        .paperSurface(in: RoundedRectangle(cornerRadius: DesignTokens.Radius.panel, style: .continuous), inset: true)
    }
}

#Preview {
    NavigationStack {
        PipecatView()
    }
}
