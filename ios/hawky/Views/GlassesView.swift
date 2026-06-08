import SwiftUI

/// Ray-Ban Meta connection panel, reached as a sub-page of the Recording
/// ("Capture") tab. Pared down from the former standalone Glasses tab: it now
/// shows only what a user needs to decide "can I record with the glasses?" —
/// registration + connection status, a Register action, and a collapsible
/// diagnostics block. The old test-only affordances (1 kHz tone, mic level
/// meter, HFP route status, talk button, and the manual Start/Stop video
/// stream + capture-policy pickers) were removed; recording the glasses camera
/// happens through the normal Recording flow by selecting the Ray-Ban video
/// source.
struct GlassesView: View {
    let runtimeEnabled: Bool

    init(runtimeEnabled: Bool = true) {
        self.runtimeEnabled = runtimeEnabled
    }

    var body: some View {
        if runtimeEnabled {
            GlassesRuntimeView()
        } else {
            GlassesStaticView()
        }
    }
}

private struct GlassesRuntimeView: View {
    @StateObject private var video = GlassesVideoStream()
    @State private var showDiagnostics = false

    var body: some View {
        Form {
            statusSection
            registerSection
            diagnosticsSection
            if let msg = video.errorMessage {
                Section {
                    Text(msg)
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .textSelection(.enabled)
                        .accessibilityIdentifier("glasses.error")
                }
            }
        }
        .navigationTitle("Ray-Ban Meta")
        .navigationBarTitleDisplayMode(.inline)
    }

    // MARK: - Sections

    private var statusSection: some View {
        Section {
            HStack(spacing: 12) {
                Image(systemName: video.hasConnectedDevice ? "eyeglasses" : "eyeglasses.slash")
                    .font(.title2)
                    .foregroundStyle(connectionColor)
                    .frame(width: 28)
                VStack(alignment: .leading, spacing: 2) {
                    Text(connectionTitle)
                        .font(.headline)
                    Text("Device: \(video.deviceName)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
            }
            .accessibilityIdentifier("glasses.status")

            LabeledContent("Registration", value: video.registrationState)
                .font(.subheadline)
        } header: {
            Text("Connection")
        } footer: {
            Text("Connect and register the glasses in the Meta AI app. Once connected, choose Ray-Ban as the video source in Recording to capture from the glasses camera.")
        }
    }

    private var registerSection: some View {
        Section {
            Button {
                video.registerGlasses()
            } label: {
                Label("Register glasses", systemImage: "link")
            }
            .accessibilityIdentifier("glasses.register")
        } footer: {
            Text("Opens Meta AI registration. Only needed once per device, or if registration was lost.")
        }
    }

    private var diagnosticsSection: some View {
        Section {
            DisclosureGroup("Diagnostics", isExpanded: $showDiagnostics) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Device: \(video.deviceDiagnostics)")
                        .fixedSize(horizontal: false, vertical: true)
                    Text("Camera permission: \(video.cameraPermissionState)")
                    Text("Session: \(video.sessionDiagnostics)")
                        .fixedSize(horizontal: false, vertical: true)
                }
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
                .accessibilityIdentifier("glasses.diagnostics")
            }
        }
    }

    // MARK: - Derived

    private var connectionTitle: String {
        if video.hasConnectedDevice { return "Connected" }
        if video.deviceName == "No device" || video.deviceName == "No active device" {
            return "Not connected"
        }
        return "Registered, not connected"
    }

    private var connectionColor: Color {
        video.hasConnectedDevice ? .green : .secondary
    }
}

private struct GlassesStaticView: View {
    var body: some View {
        Form {
            Section {
                HStack(spacing: 12) {
                    Image(systemName: "eyeglasses.slash")
                        .font(.title2)
                        .foregroundStyle(.secondary)
                        .frame(width: 28)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Not connected")
                            .font(.headline)
                        Text("Device: No device")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                }
                .accessibilityIdentifier("glasses.status")

                LabeledContent("Registration", value: "Unavailable")
                    .font(.subheadline)
            } header: {
                Text("Connection")
            } footer: {
                Text("Meta glasses runtime is unavailable in this launch profile.")
            }

            Section {
                Button {} label: {
                    Label("Register glasses", systemImage: "link")
                }
                .disabled(true)
                .accessibilityIdentifier("glasses.register")
            }

            Section {
                Text("Runtime disabled")
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("glasses.diagnostics")
            } header: {
                Text("Diagnostics")
            }
        }
        .navigationTitle("Ray-Ban Meta")
        .navigationBarTitleDisplayMode(.inline)
    }
}

#Preview {
    NavigationStack {
        GlassesView()
    }
}
