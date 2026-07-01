import SwiftUI
import UIKit

// Validates a gateway URL string. Lives at file scope so unit tests can reach it.
// Accepts http:// or https:// with a non-empty host.
func validateGatewayURL(_ raw: String) -> Bool {
    let trimmed = raw.trimmingCharacters(in: .whitespaces)
    guard let url = URL(string: trimmed),
          let scheme = url.scheme?.lowercased(),
          scheme == "http" || scheme == "https",
          let host = url.host, !host.isEmpty else {
        return false
    }
    return true
}

// Decode the `exp` claim from a JWT without verifying its signature.
// Trust boundary is the device; the server is the only signer that matters.
func decodeJWTExpiry(_ token: String) -> Date? {
    let parts = token.split(separator: ".")
    guard parts.count >= 2 else { return nil }
    var b64 = String(parts[1])
        .replacingOccurrences(of: "-", with: "+")
        .replacingOccurrences(of: "_", with: "/")
    // Pad to multiple of 4.
    while b64.count % 4 != 0 { b64.append("=") }
    guard let data = Data(base64Encoded: b64),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let exp = obj["exp"] as? TimeInterval else {
        return nil
    }
    return Date(timeIntervalSince1970: exp)
}

// A single user-facing toggle wired to one or more Hawky trigger event names.
// `names` has >1 entry when two event names refer to the same user-visible
// concept (e.g. both `permission.request` and `agent.permission_request`).
private struct NtfyTriggerOption: Identifiable {
    let id: String          // stable key for SwiftUI
    let label: String       // primary label
    let caption: String?    // secondary description
    let names: [String]     // Hawky event names this toggle controls
    let defaultOn: Bool     // default when user has never configured triggers
}

// The curated set of triggers we expose in the UI. `agent.text` is deliberately
// NOT offered here — it fires per token and would flood push notifications.
private let kNtfyTriggerOptions: [NtfyTriggerOption] = [
    NtfyTriggerOption(
        id: "turn_complete",
        label: "Turn complete",
        caption: "When the agent finishes a full response",
        names: ["agent.done"],
        defaultOn: true
    ),
    NtfyTriggerOption(
        id: "permission_requests",
        label: "Permission requests",
        caption: "When the agent asks to run a tool",
        names: ["permission.request", "agent.permission_request"],
        defaultOn: true
    ),
    NtfyTriggerOption(
        id: "tool_use_start",
        label: "Every tool call (high volume)",
        caption: "Fires once per tool invocation",
        names: ["agent.tool_use_start"],
        defaultOn: false
    ),
    NtfyTriggerOption(
        id: "tool_result",
        label: "Every tool result (high volume)",
        caption: "Fires once per tool result",
        names: ["agent.tool_result"],
        defaultOn: false
    ),
]

private enum SettingsIconAsset {
    static func name(for title: String) -> String? {
        switch title {
        case "Setup": return "SettingsIconSetup"
        case "Connection": return "SettingsIconConnection"
        case "Agent": return "SettingsIconAgent"
        case "Live": return "SettingsIconLive"
        case "Prompt": return "SettingsIconPrompt"
        case "Appearance": return "SettingsIconAppearance"
        case "Notifications": return "SettingsIconNotifications"
        case "App Layout": return "SettingsIconLayout"
        case "About": return "SettingsIconAbout"
        case "Developer Lab": return "SettingsIconDeveloperLab"
        case "Gateway Probes": return "SettingsIconGatewayProbes"
        case "PipeCat": return "SettingsIconWebRTCLab"
        case "Pipecat2": return "SettingsIconRecordingLab"
        case "GPTRDemo": return "SettingsIconTranscriptLab"
        case "Live2": return "SettingsIconExperimentalLive"
        default: return nil
        }
    }
}

private struct SettingsLandingRow: View {
    let systemImage: String
    let color: Color
    let title: String
    var subtitle: String?

    var body: some View {
        HStack(spacing: 12) {
            GeneratedIconTile(
                systemImage: systemImage,
                color: color,
                assetName: SettingsIconAsset.name(for: title)
            )
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(DesignTokens.Font.rowTitle)
                    .foregroundStyle(.primary)
                if let subtitle {
                    Text(subtitle)
                        .font(DesignTokens.Font.rowDetail)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }
            Spacer()
        }
        .padding(.vertical, subtitle == nil ? 4 : 6)
    }
}

private struct SettingsDetailHeader: View {
    let systemImage: String
    let color: Color
    let title: String
    let message: String

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            GeneratedIconTile(
                systemImage: systemImage,
                color: color,
                assetName: SettingsIconAsset.name(for: title),
                size: 46
            )
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(DesignTokens.Font.panelTitle)
                Text(message)
                    .font(DesignTokens.Font.rowDetail)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 4)
    }
}

private struct SettingsAccountCard: View {
    let deviceName: String
    let isAuthenticated: Bool

    var body: some View {
        HStack(spacing: 12) {
            AppMark(size: 36)

            VStack(alignment: .leading, spacing: 3) {
                Text(deviceName.isEmpty ? UIDevice.current.name : deviceName)
                    .font(DesignTokens.Font.rowTitle)
                    .lineLimit(1)
                Text(isAuthenticated ? "Signed in to gateway" : "Not signed in")
                    .font(DesignTokens.Font.rowDetail)
                    .foregroundStyle(.secondary)
            }
            Spacer()
        }
        .padding(.vertical, 2)
    }
}

private struct DeveloperToolRow<Destination: View>: View {
    let systemImage: String
    let title: String
    let subtitle: String
    let destination: Destination

    init(
        systemImage: String,
        title: String,
        subtitle: String,
        @ViewBuilder destination: () -> Destination
    ) {
        self.systemImage = systemImage
        self.title = title
        self.subtitle = subtitle
        self.destination = destination()
    }

    var body: some View {
        NavigationLink {
            destination
        } label: {
            SettingsLandingRow(
                systemImage: systemImage,
                color: .secondary,
                title: title,
                subtitle: subtitle
            )
        }
    }
}

private struct DeveloperLabPage: View {
    var body: some View {
        Form {
            Section {
                SettingsDetailHeader(
                    systemImage: "hammer",
                    color: .secondary,
                    title: "Developer Lab",
                    message: "Internal diagnostics and realtime experiments live here so the main app stays focused on Live, Chat, and Settings."
                )
            }
            .settingsSectionSurface()

            Section("Gateway") {
                DeveloperToolRow(
                    systemImage: AppTab.test.systemImage,
                    title: "Gateway Probes",
                    subtitle: "Health checks, token flow, WebSocket handshake, and node command probes."
                ) {
                    TestView()
                        .navigationTitle("Probes")
                        .navigationBarTitleDisplayMode(.inline)
                }
            }
            .settingsSectionSurface()

            Section("Realtime Experiments") {
                DeveloperToolRow(
                    systemImage: AppTab.pipecat.systemImage,
                    title: "PipeCat",
                    subtitle: "Pipecat OpenAI WebRTC setup, transcript, and event diagnostics."
                ) {
                    PipecatView()
                }

                DeveloperToolRow(
                    systemImage: AppTab.pipecatRecording.systemImage,
                    title: "Pipecat2",
                    subtitle: "Realtime session recording, local archive, and folder inspection."
                ) {
                    PipecatRecordingView()
                }

                DeveloperToolRow(
                    systemImage: AppTab.gptrDemo.systemImage,
                    title: "GPTRDemo",
                    subtitle: "Realtime transcription archive, JSONL event logs, and audio commit controls."
                ) {
                    GPTRTranscriptDemoView()
                }

                DeveloperToolRow(
                    systemImage: AppTab.live2.systemImage,
                    title: "Live2",
                    subtitle: "Alternate Live prototype used to validate camera, mic, and recording flows."
                ) {
                    Live2View()
                }
            }
            .settingsSectionSurface()
        }
        .navigationTitle("Developer Lab")
        .navigationBarTitleDisplayMode(.inline)
        .settingsBottomTabClearance()
    }
}

private extension View {
    func settingsFormChrome() -> some View {
        listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(DesignTokens.groupedBackground)
            .tint(DesignTokens.accent)
    }

    func settingsSectionSurface(inset: Bool = false) -> some View {
        listRowBackground(inset ? DesignTokens.Surface.paperInset : DesignTokens.Surface.paper)
            .listRowSeparatorTint(DesignTokens.Surface.paperStroke)
    }

    func settingsBottomTabClearance() -> some View {
        settingsFormChrome()
            .safeAreaInset(edge: .bottom, spacing: 0) {
                Color.clear
                    .frame(height: 104)
                    .allowsHitTesting(false)
            }
    }
}

private struct TabConfigurationSection: View {
    @Binding var tabConfigurationRaw: String
    let legacyTabOrderRaw: String

    private var tabConfiguration: AppTabConfiguration {
        AppTabConfiguration.load(
            encoded: tabConfigurationRaw,
            legacyRaw: legacyTabOrderRaw
        )
    }

    private var configurableVisibleTabs: [AppTab] {
        tabConfiguration.movableVisibleTabs.filter { !$0.requiresDeveloperMode }
    }

    private var configurableHiddenTabs: [AppTab] {
        tabConfiguration.hiddenTabs.filter { !$0.requiresDeveloperMode }
    }

    var body: some View {
        Section {
            ForEach(configurableVisibleTabs) { tab in
                visibleTabRow(tab)
            }

            HStack {
                Label(AppTab.settings.label, systemImage: AppTab.settings.systemImage)
                Spacer()
                Image(systemName: "lock")
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
            }
            .accessibilityIdentifier("settings.tabs.fixed.settings")

            ForEach(configurableHiddenTabs) { tab in
                hiddenTabRow(tab)
            }
        } header: {
            Text("Product Tabs")
        } footer: {
            Text("Keep the main tab bar focused on user-facing spaces. Experimental screens live in Developer Lab when Developer mode is on.")
        }
    }

    private func visibleTabRow(_ tab: AppTab) -> some View {
        HStack {
            Label(tab.label, systemImage: tab.systemImage)
            Spacer()
            Button {
                updateTabConfiguration { $0.hide(tab) }
            } label: {
                Image(systemName: "eye.slash").minimumHitTarget()
            }
            .buttonStyle(.borderless)
            .accessibilityLabel("Hide \(tab.label)")
            .accessibilityIdentifier("settings.tabs.hide.\(tab.rawValue)")
        }
    }

    private func hiddenTabRow(_ tab: AppTab) -> some View {
        HStack {
            Label(tab.label, systemImage: tab.systemImage)
                .foregroundStyle(.secondary)
            Spacer()
            Button {
                updateTabConfiguration { $0.show(tab) }
            } label: {
                Image(systemName: "eye").minimumHitTarget()
            }
            .buttonStyle(.borderless)
            .accessibilityLabel("Show \(tab.label)")
            .accessibilityIdentifier("settings.tabs.show.\(tab.rawValue)")
        }
    }

    private func updateTabConfiguration(_ update: (inout AppTabConfiguration) -> Void) {
        var configuration = tabConfiguration
        update(&configuration)
        let sanitized = configuration.sanitized()
        tabConfigurationRaw = sanitized.encodedStorageValue
        FrontendTabStore.shared.ensureSelectedTabVisible(in: sanitized)
    }
}

struct SettingsView: View {
    @Environment(AppContainer.self) private var container
    @ObservedObject private var frontendTabs = FrontendTabStore.shared

    @State private var gatewayURL: String = UserDefaults.standard.string(forKey: "gatewayURL") ?? GatewayDefaults.urlString
    @State private var deviceName: String = UserDefaults.standard.string(forKey: "deviceName") ?? UIDevice.current.name
    @AppStorage(AppTabConfiguration.storageKey) private var tabConfigurationRaw: String = ""
    @AppStorage(AppTabConfiguration.legacyTabOrderKey) private var legacyTabOrderRaw: String = ""
    @State private var presentOnboarding = false
    @AppStorage(IntroSettings.enabledKey) private var introEnabled: Bool = false
    @State private var saveFeedback: String?
    @State private var connTestState: ConnTestState = .idle
    @State private var connTestFeedback: String?
    @State private var cfAccessClientId: String = ""
    @State private var cfAccessClientSecret: String = ""
    @State private var cfAccessFeedback: String?
    @State private var busy: Bool = false
    // Node role — OFF by default so the MVP does not change behaviour for
    // existing users. When ON, AppContainer.startNode() opens a second WS.
    @State private var actAsNode: Bool = UserDefaults.standard.bool(forKey: "actAsNode")
    // ntfy config — lives on this view so the settings screen owns the RPC lifecycle.
    // Loaded lazily via .task; no background sync. See NtfyConfigStore.swift.
    @State private var ntfy = NtfyConfigStore()
    @State private var ntfyCopyFeedback: String?
    @State private var agentConfig = AgentConfigStore()
    // Shared from ContentView via .environment — must NOT be a @State that
    // builds its own LiveSessionStore(). SwiftUI re-evaluates a @State default
    // initializer on every struct construction, so a self-owned store re-ran
    // LiveSessionArchive.loadConversation on the main thread on every settings
    // re-render (0x8BADF00D watchdog) and desynced from the Live tab's active
    // session ("not in session" on return; leaked capture/audio sessions).
    @Environment(LiveSessionStore.self) private var liveStore

    // Topic editor draft — only committed to the store on submit / Save button.
    @State private var topicDraft: String = ""
    @State private var providerDraft: String = AgentProvider.anthropic.rawValue
    @State private var modelDraft: String = ""
    @State private var customAgentModelDraft: String = ""
    @State private var apiBaseURLDraft: String = "https://api.anthropic.com"
    @State private var navigationPath: [SettingsRoute] = []

    private var urlValid: Bool { validateGatewayURL(gatewayURL) }

    private var tabConfiguration: AppTabConfiguration {
        AppTabConfiguration.load(
            encoded: tabConfigurationRaw,
            legacyRaw: legacyTabOrderRaw
        )
    }

    // Node registration status → (label, dot color). Reads NodeRunner.status if
    // the runner exists; shows "Disconnected" while startNode() is still
    // acquiring a token or if the toggle just flipped on.
    private var nodeStatusLabel: (String, Color) {
        guard let runner = container.nodeRunner else { return ("Disconnected", DesignTokens.Status.neutral) }
        switch runner.status {
        case .registering: return ("Registering…", DesignTokens.Status.warning)
        case .connected: return ("Connected", DesignTokens.Status.success)
        case .disconnected: return ("Disconnected", DesignTokens.Status.neutral)
        case .stopped: return ("Stopped", DesignTokens.Status.neutral)
        }
    }

    private var tokenStatus: (text: String, ok: Bool) {
        guard let token = try? KeychainStore.load(for: container.gatewayURL), !token.isEmpty else {
            return ("Not authenticated", false)
        }
        if let exp = decodeJWTExpiry(token) {
            let fmt = DateFormatter()
            fmt.dateStyle = .medium
            fmt.timeStyle = .short
            return ("Authenticated, expires \(fmt.string(from: exp))", true)
        }
        return ("Authenticated (opaque token)", true)
    }

    // True if Hawky is unreachable — surfaces a badge next to the section
    // title so the user knows the rows reflect last-known state.
    private var gatewayUnreachable: Bool {
        if case .error = ntfy.loadState { return true }
        return container.transport == nil
    }

    var body: some View {
        NavigationStack(path: $navigationPath) {
            settingsRoot
                .navigationTitle("Settings")
                .navigationBarTitleDisplayMode(.inline)
                .navigationDestination(for: SettingsRoute.self) { route in
                    settingsDestination(for: route)
                }
        }
        .onAppear {
            applyPendingSettingsRouteIfNeeded()
        }
        .onChange(of: frontendTabs.settingsRouteRequestID) { _, _ in
            applyPendingSettingsRouteIfNeeded()
        }
        .fullScreenCover(isPresented: $presentOnboarding) {
            OnboardingView(liveStore: liveStore)
                .environment(container)
        }
    }

    private var settingsRoot: some View {
        Form {
            Section {
                NavigationLink(value: SettingsRoute.connection) {
                    SettingsAccountCard(
                        deviceName: deviceName,
                        isAuthenticated: tokenStatus.ok
                    )
                }
                .accessibilityIdentifier("settings.account.row")

                Button {
                    presentOnboarding = true
                } label: {
                    SettingsLandingRow(
                        systemImage: "wand.and.sparkles",
                        color: setupStatusColor,
                        title: "Setup",
                        subtitle: "Check connection, Live, and camera setup."
                    )
                }
                .subtlePressAction()
                .accessibilityIdentifier("settings.setup.run")
            }
            .settingsSectionSurface()

            Section {
                NavigationLink(value: SettingsRoute.connection) {
                    SettingsLandingRow(
                        systemImage: "network",
                        color: .blue,
                        title: "Connection",
                        subtitle: tokenStatus.ok ? "Gateway is connected" : "Sign in and name this device"
                    )
                }
                .accessibilityIdentifier("settings.connection.row")

                NavigationLink(value: SettingsRoute.agent) {
                    SettingsLandingRow(
                        systemImage: "brain.head.profile",
                        color: .purple,
                        title: "Agent",
                        subtitle: "Choose the assistant model"
                    )
                }
                .accessibilityIdentifier("settings.agent.row")

                NavigationLink(value: SettingsRoute.live) {
                    SettingsLandingRow(
                        systemImage: "waveform",
                        color: DesignTokens.accent,
                        title: "Live",
                        subtitle: "Tune voice, camera, and recording"
                    )
                }
                .accessibilityIdentifier("settings.live.row")

                NavigationLink(value: SettingsRoute.prompt) {
                    SettingsLandingRow(
                        systemImage: "text.quote",
                        color: .green,
                        title: "Prompt",
                        subtitle: "Shape the realtime personality"
                    )
                }
                .accessibilityIdentifier("settings.prompt.row")
            }
            .settingsSectionSurface()

            Section {
                NavigationLink(value: SettingsRoute.appearance) {
                    SettingsLandingRow(
                        systemImage: "paintpalette.fill",
                        color: .pink,
                        title: "Appearance",
                        subtitle: "Adjust launch and visual polish"
                    )
                }
                .accessibilityIdentifier("settings.appearance.row")

                NavigationLink(value: SettingsRoute.notifications) {
                    SettingsLandingRow(
                        systemImage: "bell.badge.fill",
                        color: .orange,
                        title: "Notifications",
                        subtitle: "Choose alerts and sessions"
                    )
                }
                .accessibilityIdentifier("settings.notifications.row")

                NavigationLink(value: SettingsRoute.layout) {
                    SettingsLandingRow(
                        systemImage: "rectangle.grid.2x2",
                        color: .indigo,
                        title: "App Layout",
                        subtitle: "Choose the tabs you use"
                    )
                }
                .accessibilityIdentifier("settings.layout.row")

                NavigationLink(value: SettingsRoute.about) {
                    SettingsLandingRow(
                        systemImage: "info.circle.fill",
                        color: .gray,
                        title: "About",
                        subtitle: "Version and active gateway"
                    )
                }
                .accessibilityIdentifier("settings.about.row")
            }
            .settingsSectionSurface()

            Section {
                Toggle("Developer mode", isOn: Binding(
                    get: { tabConfiguration.developerModeEnabled },
                    set: { newValue in
                        updateTabConfiguration { $0.setDeveloperModeEnabled(newValue) }
                    }
                ))
                .accessibilityIdentifier("settings.developerMode")
                if tabConfiguration.developerModeEnabled {
                    NavigationLink {
                        DeveloperLabPage()
                    } label: {
                        SettingsLandingRow(
                            systemImage: "hammer",
                            color: .secondary,
                            title: "Developer Lab",
                            subtitle: "Diagnostics and realtime experiments"
                        )
                    }
                    .accessibilityIdentifier("settings.developerLab.row")
                }
            } footer: {
                Text(tabConfiguration.developerModeEnabled
                     ? "Developer tools stay grouped here so the main app keeps a product-focused layout."
                     : "Shows internal diagnostics and advanced Live controls.")
            }
            .settingsSectionSurface()
        }
        .settingsBottomTabClearance()
        .tint(DesignTokens.accent)
        .task {
            loadCloudflareAccess()
            configureLiveSettingsStore()
            // Load ntfy config once the connection is live. A missing transport
            // is expected on first launch while auth is still in flight — the
            // load state stays `.idle` and the view shows defaults.
            if let transport = container.transport {
                await agentConfig.load(transport: transport)
                providerDraft = agentConfig.provider
                modelDraft = agentConfig.model
                customAgentModelDraft = isKnownAgentModel(agentConfig.model) ? "" : agentConfig.model
                apiBaseURLDraft = agentConfig.apiBaseURL
                await ntfy.load(transport: transport)
                topicDraft = ntfy.topic
            }
            // Refresh the session list so the allowlist UI has fresh candidates.
            // Failure is non-fatal — the UI falls back to SessionStore contents.
            try? await container.refreshSessionList()
        }
        .onChange(of: ntfy.topic) { _, newValue in
            // Keep the draft in sync when the store updates (e.g. random topic).
            if topicDraft != newValue { topicDraft = newValue }
        }
        .onChange(of: agentConfig.provider) { _, newValue in
            if providerDraft != newValue { providerDraft = newValue }
        }
        .onChange(of: agentConfig.model) { _, newValue in
            if modelDraft != newValue { modelDraft = newValue }
            customAgentModelDraft = isKnownAgentModel(newValue) ? "" : newValue
        }
        .onChange(of: agentConfig.apiBaseURL) { _, newValue in
            if apiBaseURLDraft != newValue { apiBaseURLDraft = newValue }
        }
        .onChange(of: container.sessionStore.activeSessionKey) { _, _ in
            configureLiveSettingsStore()
        }
    }

    private func applyPendingSettingsRouteIfNeeded() {
        guard let route = frontendTabs.consumePendingSettingsRoute() else { return }
        navigationPath = route.navigationPath
    }

    @ViewBuilder
    private func settingsDestination(for route: SettingsRoute) -> some View {
        switch route {
        case .connection:
            connectionPage
        case .agent:
            agentPage
        case .live:
            liveSettingsPage
        case .prompt:
            promptSettingsPage
        case .appearance:
            appearancePage
        case .notifications:
            notificationsPage
        case .notificationSessions:
            NotifySessionsView(ntfy: ntfy)
        case .layout:
            appLayoutPage
        case .about:
            aboutPage
        }
    }

    private var connectionPage: some View {
        Form {
            Section {
                SettingsDetailHeader(
                    systemImage: "network",
                    color: .blue,
                    title: "Connection",
                    message: "The gateway is the backend this iPhone talks to. The device name is how this phone appears to sessions, nodes, and setup flows."
                )
            }
            .settingsSectionSurface()

            Section("Gateway") {
                TextField("Gateway URL", text: $gatewayURL)
                    .keyboardType(.URL)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .textContentType(.URL)
                    .submitLabel(.done)
                    .font(DesignTokens.Font.mono)
                    .accessibilityIdentifier("settings.gatewayURL")
                if !urlValid && !gatewayURL.isEmpty {
                    Text("Must be http:// or https:// with a host")
                        .errorCaption()
                }
                LabeledContent("Name") {
                    TextField("Device name", text: $deviceName)
                        .multilineTextAlignment(.trailing)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        .keyboardType(.asciiCapable)
                        .textContentType(.none)
                        .submitLabel(.done)
                        .accessibilityIdentifier("settings.deviceName")
                }

                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Button {
                            save()
                        } label: {
                            Label(busy ? "Saving" : "Save", systemImage: busy ? "clock" : "square.and.arrow.down")
                                .frame(maxWidth: .infinity)
                        }
                        .primaryPanelAction()
                        .disabled(!urlValid || busy)
                        .accessibilityIdentifier("settings.save")

                        Button {
                            Task { await testConnection() }
                        } label: {
                            Label(connTestState.buttonTitle, systemImage: connTestState.systemImage)
                                .frame(maxWidth: .infinity)
                        }
                        .secondaryPanelAction(tint: connTestState.color)
                        .disabled(!urlValid || connTestState == .running)
                        .accessibilityLabel(connTestState.accessibilityLabel)
                        .accessibilityIdentifier("settings.testConnection")
                    }

                    if let msg = connTestFeedback {
                        Text(msg)
                            .errorCaption()
                            .lineLimit(2)
                            .transition(.opacity.combined(with: .move(edge: .top)))
                            .accessibilityIdentifier("settings.testConnection.feedback")
                    }
                }
                .animation(.easeInOut(duration: 0.24), value: connTestFeedback)
                if let msg = saveFeedback {
                    Text(msg)
                        .helperCaption()
                }
            }
            .settingsSectionSurface()

            Section {
                let status = tokenStatus
                HStack {
                    Circle()
                        .fill(status.ok ? DesignTokens.Status.success : DesignTokens.Status.neutral)
                        .frame(width: 8, height: 8)
                        .accessibilityHidden(true)
                    Text(status.text)
                        .font(DesignTokens.Font.mono)
                        .accessibilityIdentifier("settings.tokenStatus")
                }
                // State is in the text; hide the color-only dot and read as one. (#576)
                .accessibilityElement(children: .combine)
                VStack(spacing: 10) {
                    Button {
                        busy = true
                        Task {
                            await container.reauthenticate()
                            busy = false
                        }
                    } label: {
                        Label(tokenStatus.ok ? "Re-authenticate" : "Authenticate", systemImage: "person.badge.key")
                            .frame(maxWidth: .infinity)
                    }
                    .secondaryPanelAction()
                    .disabled(busy)
                    .accessibilityIdentifier("settings.reauth")

                    Button(role: .destructive) {
                        Task { await container.clearToken() }
                    } label: {
                        Label("Clear token", systemImage: "trash")
                            .frame(maxWidth: .infinity)
                    }
                    .destructivePanelAction()
                    .accessibilityIdentifier("settings.clearToken")
                }
            } header: {
                Text("Gateway Token")
            } footer: {
                Text("A token is this iPhone's saved sign-in pass for the active gateway. Re-authenticate when it expires or after changing Access credentials.")
            }
            .settingsSectionSurface()

            Section {
                NavigationLink {
                    cloudflareAccessPage
                } label: {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Service token")
                            .font(DesignTokens.Font.rowTitle)
                        Text(cfAccessFeedback ?? cloudflareAccessSummary)
                            .font(DesignTokens.Font.meta)
                            .foregroundStyle(.secondary)
                    }
                }
            } header: {
                Text("Cloudflare Access")
            } footer: {
                Text("Use only when this gateway is protected by Cloudflare Access.")
            }
            .settingsSectionSurface()

            nodeRoleSection
                .settingsSectionSurface()
        }
        .navigationTitle("Connection")
        .navigationBarTitleDisplayMode(.inline)
        .settingsBottomTabClearance()
        .onAppear {
            // Reflect the persisted values and drop any unsaved edit, so leaving
            // the page without Save truthfully reverts the field instead of
            // lingering as if it had been saved (the @State draft otherwise
            // survives on SettingsView and looks committed).
            gatewayURL = UserDefaults.standard.string(forKey: "gatewayURL") ?? GatewayDefaults.urlString
            deviceName = UserDefaults.standard.string(forKey: "deviceName") ?? UIDevice.current.name
            setConnectionTestState(.idle, animated: false)
            saveFeedback = nil
            loadCloudflareAccess()
        }
        .onChange(of: gatewayURL) { _, _ in
            loadCloudflareAccess()
            setConnectionTestState(.idle)
        }
    }

    private var agentPage: some View {
        Form {
            Section {
                SettingsDetailHeader(
                    systemImage: "brain.head.profile",
                    color: .purple,
                    title: "Agent",
                    message: "These choices control the backend agent used for normal text sessions. Changes apply to the next agent turn."
                )
            }
            .settingsSectionSurface()

            agentSettingsSection
                .settingsSectionSurface()
        }
        .navigationTitle("Agent")
        .navigationBarTitleDisplayMode(.inline)
        .settingsBottomTabClearance()
    }

    private var liveSettingsPage: some View {
        Form {
            Section {
                SettingsDetailHeader(
                    systemImage: "waveform",
                    color: .teal,
                    title: "Live",
                    message: "Live settings are local to this iPhone and control realtime voice, input, tools, and recording behavior."
                )
            }
            .settingsSectionSurface()

            LiveSettingsFormContent(store: liveStore)
        }
        .navigationTitle("Live")
        .navigationBarTitleDisplayMode(.inline)
        .settingsBottomTabClearance()
    }

    private var promptSettingsPage: some View {
        Form {
            Section {
                SettingsDetailHeader(
                    systemImage: "text.quote",
                    color: .mint,
                    title: "Prompt",
                    message: "Choose and edit the Live persona instructions sent when a new realtime session starts."
                )
            }
            .settingsSectionSurface()

            LivePromptSettingsSection(store: liveStore)
        }
        .navigationTitle("Prompt")
        .navigationBarTitleDisplayMode(.inline)
        .settingsBottomTabClearance()
    }

    private var appearancePage: some View {
        Form {
            Section {
                SettingsDetailHeader(
                    systemImage: "paintpalette.fill",
                    color: .pink,
                    title: "Appearance",
                    message: "Choose visual behavior for this iPhone. Launch intro changes apply the next time the app starts."
                )
            }
            .settingsSectionSurface()

            Section {
                Toggle("Launch intro", isOn: $introEnabled)
                    .accessibilityIdentifier("settings.appearance.introEnabled")
            } header: {
                Text("Launch")
            } footer: {
                Text("Plays the animated launch reveal on cold start, following the system light/dark appearance. Off by default while in development.")
            }
            .settingsSectionSurface()
        }
        .navigationTitle("Appearance")
        .navigationBarTitleDisplayMode(.inline)
        .settingsBottomTabClearance()
    }

    private func configureLiveSettingsStore() {
        liveStore.configureGatewayBridge(
            gatewayURL: container.gatewayURL,
            activeChatSessionKey: container.sessionStore.activeSessionKey
        )
        liveStore.refreshDirectOpenAIAPIKeyStatus()
    }

    private var notificationsPage: some View {
        Form {
            Section {
                SettingsDetailHeader(
                    systemImage: "bell.badge.fill",
                    color: .red,
                    title: "Notifications",
                    message: "ntfy sends push notifications for selected gateway events. Use triggers to decide which events are important enough to wake the phone."
                )
            }
            .settingsSectionSurface()

            ntfySettingsSection
                .settingsSectionSurface()
            ntfyTriggersSection
                .settingsSectionSurface()
            ntfyTestPushSection
                .settingsSectionSurface()

            Section("Sessions") {
                NavigationLink(value: SettingsRoute.notificationSessions) {
                    HStack {
                        Text("Sessions to notify")
                        Spacer()
                        Text(sessionsSummary)
                            .helperCaption()
                    }
                }
                .accessibilityIdentifier("settings.ntfy.sessions.row")
            }
            .settingsSectionSurface()
        }
        .navigationTitle("Notifications")
        .navigationBarTitleDisplayMode(.inline)
        .settingsBottomTabClearance()
    }

    private var appLayoutPage: some View {
        Form {
            Section {
                SettingsDetailHeader(
                    systemImage: "rectangle.grid.2x2",
                    color: .indigo,
                    title: "App Layout",
                    message: "Choose the user-facing spaces that appear in the bottom bar. Settings stays fixed, and experimental tools stay grouped in Developer Lab."
                )
            }
            .settingsSectionSurface()

            TabConfigurationSection(
                tabConfigurationRaw: $tabConfigurationRaw,
                legacyTabOrderRaw: legacyTabOrderRaw
            )
            .settingsSectionSurface()
        }
        .navigationTitle("App Layout")
        .navigationBarTitleDisplayMode(.inline)
        .settingsBottomTabClearance()
    }

    private var aboutPage: some View {
        Form {
            Section {
                SettingsDetailHeader(
                    systemImage: "info.circle.fill",
                    color: .gray,
                    title: "About",
                    message: "Build information and the live gateway currently used by the app."
                )
            }
            .settingsSectionSurface()

            Section {
                LabeledContent("Version", value: appVersion)
                LabeledContent("Gateway (live)", value: container.gatewayURL.absoluteString)
                    .font(DesignTokens.Font.mono)
            }
            .settingsSectionSurface()
        }
        .navigationTitle("About")
        .navigationBarTitleDisplayMode(.inline)
        .settingsBottomTabClearance()
    }

    private var nodeRoleSection: some View {
        Section("Node Role") {
            Toggle("Act as node", isOn: $actAsNode)
                .accessibilityIdentifier("settings.actAsNode")
                .onChange(of: actAsNode) { _, newValue in
                    UserDefaults.standard.set(newValue, forKey: "actAsNode")
                    Task {
                        if newValue {
                            await container.startNode()
                        } else {
                            await container.stopNode()
                        }
                    }
                }
            if actAsNode {
                let (text, color) = nodeStatusLabel
                HStack {
                    Circle().fill(color).frame(width: 8, height: 8)
                        .accessibilityHidden(true)
                    Text("Status")
                    Spacer()
                    Text(text)
                        .font(DesignTokens.Font.mono)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("settings.nodeStatus")
                }
                // State is in the text; hide the color-only dot and read as one. (#576)
                .accessibilityElement(children: .combine)
                HStack {
                    Text("Node ID")
                    Spacer()
                    Text(container.nodeRunner?.nodeId ?? "—")
                        .font(DesignTokens.Font.mono)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .accessibilityIdentifier("settings.nodeId")
                }
            }
            Text(actAsNode
                 ? "This device exposes node commands to the gateway, including frontend.message and frontend.open_tab."
                 : "Off — this device acts as a client only.")
                .helperCaption()
        }
    }

    private var agentSettingsSection: some View {
        Section {
            Picker("Provider", selection: $providerDraft) {
                ForEach(AgentProvider.allCases) { provider in
                    Text(provider.label).tag(provider.rawValue)
                }
            }
            .accessibilityIdentifier("settings.agent.provider")

            Picker("Model", selection: agentModelSelectionBinding) {
                ForEach(agentModelOptionsForDraft) { option in
                    Text(option.label).tag(option.id)
                }
            }
            .accessibilityIdentifier("settings.agent.modelPicker")

            if isCustomAgentModelSelected {
                TextField("Custom model ID", text: customAgentModelBinding)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .keyboardType(.asciiCapable)
                    .font(DesignTokens.Font.mono)
                    .accessibilityIdentifier("settings.agent.model")
            }

            LabeledContent("Base URL") {
                TextField("API base URL", text: $apiBaseURLDraft)
                    .multilineTextAlignment(.trailing)
                    .keyboardType(.URL)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .textContentType(.URL)
                    .font(DesignTokens.Font.mono)
                    .accessibilityIdentifier("settings.agent.apiBaseURL")
            }

            if providerDraft == AgentProvider.vertex.rawValue {
                LabeledContent("Vertex project", value: agentConfig.vertexProjectID.isEmpty ? "Not set" : agentConfig.vertexProjectID)
                    .font(DesignTokens.Font.mono)
                LabeledContent("Vertex region", value: agentConfig.vertexRegion)
                    .font(DesignTokens.Font.mono)
            } else if providerDraft == AgentProvider.openaiCompatible.rawValue {
                Text("Use https://api.hawky.live/v1 for the current LiteLLM Omni endpoint.")
                    .helperCaption()
            }

            Button {
                saveAgentConfig()
            } label: {
                HStack {
                    Text("Save provider/model/base URL")
                    Spacer()
                    if case .saving = agentConfig.saveState {
                        ProgressView()
                    }
                }
                .frame(maxWidth: .infinity)
            }
            .primaryPanelAction()
            .disabled(container.transport == nil || providerDraft.trimmingCharacters(in: .whitespaces).isEmpty || modelDraft.trimmingCharacters(in: .whitespaces).isEmpty)
            .accessibilityIdentifier("settings.agent.save")

            switch agentConfig.saveState {
            case .saved(let note):
                Text(note ?? "Saved")
                    .font(DesignTokens.Font.meta)
                    .foregroundStyle(note == nil ? Color.secondary : DesignTokens.Status.warning)
            case .error(let msg):
                Text(msg)
                    .errorCaption()
            default:
                EmptyView()
            }

            if case .error(let msg) = agentConfig.loadState {
                Text(msg)
                    .errorCaption()
            }
        } header: {
            HStack {
                Text("Provider")
                if gatewayUnreachable {
                    Spacer()
                    Text("gateway unreachable")
                        .warningBadge()
                        .accessibilityIdentifier("settings.agent.unreachableBadge")
                }
            }
        } footer: {
            Text("Provider, model, and OpenAI base URL are swapped on the gateway and apply to the next agent turn. Older gateways may reject provider changes.")
        }
    }

    private var ntfySettingsSection: some View {
        Section {
            if let url = ntfy.subscriptionURL {
                Button {
                    UIPasteboard.general.string = url.absoluteString
                    ntfyCopyFeedback = "Copied"
                    Task {
                        try? await Task.sleep(nanoseconds: 1_500_000_000)
                        await MainActor.run { ntfyCopyFeedback = nil }
                    }
                } label: {
                    HStack {
                        Text("Subscription URL")
                            .foregroundStyle(.primary)
                        Spacer()
                        Text(ntfyCopyFeedback ?? url.absoluteString)
                            .font(DesignTokens.Font.mono)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                }
                .accessibilityIdentifier("settings.ntfy.subscriptionURL")
            } else {
                HStack {
                    Text("Subscription URL")
                    Spacer()
                    Text("Set a topic to receive notifications.")
                        .helperCaption()
                        .multilineTextAlignment(.trailing)
                }
            }

            Toggle("Enabled", isOn: Binding(
                get: { ntfy.enabled },
                set: { newValue in
                    guard let transport = container.transport else { return }
                    Task { await ntfy.setEnabled(newValue, transport: transport) }
                }
            ))
            .accessibilityIdentifier("settings.ntfy.enabled")
            .disabled(container.transport == nil || ntfy.topic.isEmpty)

            TextField("Topic", text: $topicDraft)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                .font(DesignTokens.Font.mono)
                .accessibilityIdentifier("settings.ntfy.topic")
                .onSubmit { commitTopicDraft() }

            Button {
                guard let transport = container.transport else { return }
                Task {
                    let next = await ntfy.generateRandomTopic(transport: transport)
                    topicDraft = next
                }
            } label: {
                HStack {
                    Image(systemName: "dice")
                    Text("Generate random")
                }
                .frame(maxWidth: .infinity)
            }
            .secondaryPanelAction()
            .disabled(container.transport == nil)
            .accessibilityIdentifier("settings.ntfy.generate")

            if let topicURL = ntfyTopicAppURL {
                Button {
                    UIApplication.shared.open(topicURL)
                } label: {
                    HStack {
                        Text("Open ntfy iOS app")
                        Spacer()
                        Image(systemName: "arrow.up.right.square")
                            .foregroundStyle(.secondary)
                    }
                }
                .accessibilityIdentifier("settings.ntfy.openApp")
            }

            if case .error(let msg) = ntfy.loadState {
                Text(msg)
                    .errorCaption()
            }
        } header: {
            HStack {
                Text("ntfy")
                if gatewayUnreachable {
                    Spacer()
                    Text("gateway unreachable")
                        .warningBadge()
                        .accessibilityIdentifier("settings.ntfy.unreachableBadge")
                }
            }
        }
    }

    private var ntfyTriggersSection: some View {
        Section {
            ForEach(kNtfyTriggerOptions) { opt in
                Toggle(isOn: Binding(
                    get: { isTriggerOn(opt) },
                    set: { newValue in
                        guard let transport = container.transport else { return }
                        Task {
                            await ntfy.toggleTrigger(
                                names: opt.names,
                                on: newValue,
                                transport: transport
                            )
                        }
                    }
                )) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(opt.label)
                        if let cap = opt.caption {
                            Text(cap)
                                .helperCaption()
                        }
                    }
                }
                .accessibilityIdentifier("settings.ntfy.trigger.\(opt.id)")
                .disabled(container.transport == nil)
            }
        } header: {
            Text("Triggers")
        } footer: {
            Text("Triggers choose which gateway events create push notifications. Leave high-volume triggers off unless you want a notification for every tool event.")
        }
    }

    private var ntfyTestPushSection: some View {
        Section {
            Button {
                Task { await ntfy.sendTestPush() }
            } label: {
                HStack {
                    Image(systemName: "paperplane")
                    Text("Send test push")
                    Spacer()
                    if let msg = ntfy.testPushFeedback {
                        Text(msg)
                            .font(DesignTokens.Font.meta)
                            .foregroundStyle(msg == "Sent" ? DesignTokens.Status.success : Color.secondary)
                    }
                }
                .frame(maxWidth: .infinity)
            }
            .secondaryPanelAction()
            .disabled(ntfy.topic.trimmingCharacters(in: .whitespaces).isEmpty)
            .accessibilityIdentifier("settings.ntfy.testPush")
        } footer: {
            Text("Posts directly to \(ntfy.baseUrl)/\(ntfy.topic.isEmpty ? "<topic>" : ntfy.topic) — bypasses the gateway so you can verify the iOS app wiring.")
                .font(DesignTokens.Font.meta)
        }
    }

    private var setupStatusSection: some View {
        Section {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: setupStatusIcon)
                    .foregroundStyle(setupStatusColor)
                    .imageScale(.large)
                    .frame(width: 24)
                VStack(alignment: .leading, spacing: 6) {
                    Text(setupStatusTitle)
                        .font(DesignTokens.Font.rowTitle)
                    Text(setupStatusDetail)
                        .font(DesignTokens.Font.meta)
                        .foregroundStyle(.secondary)
                }
            }
            .accessibilityIdentifier("settings.setup.status")

            Button {
                presentOnboarding = true
            } label: {
                Label("Run setup", systemImage: "wand.and.sparkles")
                    .frame(maxWidth: .infinity)
            }
            .primaryPanelAction()
            .accessibilityIdentifier("settings.setup.run")
        } header: {
            Text("Setup")
        } footer: {
            Text("Use setup when a new install cannot tell whether the gateway, Access token, device name, or Live provider is configured.")
        }
    }

    private var setupStatusTitle: String {
        if container.transport != nil && tokenStatus.ok { return "Ready" }
        if !tokenStatus.ok { return "Needs authentication" }
        return "Gateway not connected"
    }

    private var setupStatusDetail: String {
        var parts: [String] = []
        parts.append("Gateway: \(container.gatewayURL.absoluteString)")
        parts.append("Device: \(deviceName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "mobile" : deviceName)")
        parts.append("Access: \(cloudflareAccessSummary)")
        parts.append("Live: \(liveProfileSummary)")
        return parts.joined(separator: "\n")
    }

    private var setupStatusIcon: String {
        if container.transport != nil && tokenStatus.ok { return "checkmark.circle.fill" }
        if !tokenStatus.ok { return "key.fill" }
        return "wifi.exclamationmark"
    }

    private var setupStatusColor: Color {
        if container.transport != nil && tokenStatus.ok { return DesignTokens.Status.success }
        if !tokenStatus.ok { return DesignTokens.Status.warning }
        return DesignTokens.Status.error
    }

    // True if any of the option's event names is currently in ntfy.triggers,
    // OR — when the user has never configured triggers (empty array) — fall
    // back to the option's default so the UI reflects Hawky's defaults.
    private func isTriggerOn(_ opt: NtfyTriggerOption) -> Bool {
        if ntfy.triggers.isEmpty { return opt.defaultOn }
        return opt.names.contains { ntfy.triggers.contains($0) }
    }

    private func commitTopicDraft() {
        let trimmed = topicDraft.trimmingCharacters(in: .whitespaces)
        guard trimmed != ntfy.topic, let transport = container.transport else { return }
        Task { await ntfy.setTopic(trimmed, transport: transport) }
    }

    private var agentModelOptionsForDraft: [AgentModelOption] {
        var options = kAgentModelOptions.filter { option in
            if option.provider == nil {
                return providerDraft == AgentProvider.anthropic.rawValue || providerDraft == AgentProvider.vertex.rawValue
            }
            return option.provider == providerDraft
        }
        let trimmed = modelDraft.trimmingCharacters(in: .whitespaces)
        if !trimmed.isEmpty && !options.contains(where: { $0.id == trimmed }) {
            options.insert(AgentModelOption(id: trimmed, label: trimmed, provider: providerDraft), at: 0)
        }
        options.append(AgentModelOption(id: agentCustomModelID, label: "Custom name", provider: providerDraft))
        return options
    }

    private var agentCustomModelID: String { "__custom_model__" }

    private var isCustomAgentModelSelected: Bool {
        !isKnownAgentModel(modelDraft)
    }

    private var agentModelSelectionBinding: Binding<String> {
        Binding(
            get: { isKnownAgentModel(modelDraft) ? modelDraft : agentCustomModelID },
            set: { newValue in
                if newValue == agentCustomModelID {
                    modelDraft = customAgentModelDraft.trimmingCharacters(in: .whitespacesAndNewlines)
                } else {
                    modelDraft = newValue
                }
            }
        )
    }

    private var customAgentModelBinding: Binding<String> {
        Binding(
            get: { customAgentModelDraft },
            set: { newValue in
                customAgentModelDraft = newValue
                modelDraft = newValue
            }
        )
    }

    private func isKnownAgentModel(_ model: String) -> Bool {
        kAgentModelOptions.contains {
            guard $0.id == model else { return false }
            if $0.provider == nil {
                return providerDraft == AgentProvider.anthropic.rawValue || providerDraft == AgentProvider.vertex.rawValue
            }
            return $0.provider == providerDraft
        }
    }

    private func updateTabConfiguration(_ update: (inout AppTabConfiguration) -> Void) {
        var configuration = tabConfiguration
        update(&configuration)
        let sanitized = configuration.sanitized()
        tabConfigurationRaw = sanitized.encodedStorageValue
        FrontendTabStore.shared.ensureSelectedTabVisible(in: sanitized)
    }

    private var liveProfileSummary: String {
        let config = LiveProfileDefaults.load()
        return config.provider.label
    }

    private var cloudflareAccessPage: some View {
        Form {
            Section {
                TextField("Client ID", text: $cfAccessClientId)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .keyboardType(.asciiCapable)
                    .textContentType(.username)
                    .font(DesignTokens.Font.mono)
                    .accessibilityIdentifier("settings.cloudflare.clientId")

                SecureField("Client secret", text: $cfAccessClientSecret)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .keyboardType(.asciiCapable)
                    .textContentType(.password)
                    .font(DesignTokens.Font.mono)
                    .accessibilityIdentifier("settings.cloudflare.clientSecret")

                Button {
                    saveCloudflareAccess()
                } label: {
                    Label("Save Access token", systemImage: "square.and.arrow.down")
                        .frame(maxWidth: .infinity)
                }
                .primaryPanelAction()
                .disabled(!urlValid)
                .accessibilityIdentifier("settings.cloudflare.save")

                Button(role: .destructive) {
                    clearCloudflareAccess()
                } label: {
                    Label("Clear", systemImage: "trash")
                        .frame(maxWidth: .infinity)
                }
                .destructivePanelAction()
                .disabled(!urlValid)
                .accessibilityIdentifier("settings.cloudflare.clear")
            } header: {
                Text("Service token")
            } footer: {
                Text("Adds CF-Access-Client-Id and CF-Access-Client-Secret to token and WebSocket requests.")
            }
            .settingsSectionSurface()
        }
        .settingsFormChrome()
        .navigationTitle("Cloudflare Access")
        .navigationBarTitleDisplayMode(.inline)
    }

    private var cloudflareAccessSummary: String {
        cfAccessClientId.isEmpty && cfAccessClientSecret.isEmpty ? "No service token saved" : "Service token configured"
    }

    private func saveAgentConfig() {
        guard let transport = container.transport else { return }
        Task {
            await agentConfig.save(provider: providerDraft, model: modelDraft, apiBaseURL: apiBaseURLDraft, transport: transport)
            providerDraft = agentConfig.provider
            modelDraft = agentConfig.model
            customAgentModelDraft = isKnownAgentModel(agentConfig.model) ? "" : agentConfig.model
            apiBaseURLDraft = agentConfig.apiBaseURL
        }
    }

    // Trailing summary shown on the "Sessions to notify" navigation row.
    // Mirrors the store semantics: empty allowlist = "All sessions", else the
    // count. Rendered in the caption slot so the row stays one line tall.
    private var sessionsSummary: String {
        if ntfy.sessions.isEmpty { return "All sessions" }
        let n = ntfy.sessions.count
        return n == 1 ? "1 allowed" : "\(n) allowed"
    }

    private var connectionSummary: String {
        let name = deviceName.trimmingCharacters(in: .whitespacesAndNewlines)
        return name.isEmpty ? "Unnamed" : name
    }

    private var agentSummary: String {
        AgentProvider(rawValue: providerDraft)?.label ?? providerDraft
    }

    private var notificationSummary: String {
        guard !ntfy.topic.trimmingCharacters(in: .whitespaces).isEmpty else { return "Off" }
        return ntfy.enabled ? "On" : "Configured"
    }

    private var tabLayoutSummary: String {
        let configuration = AppTabConfiguration.load(
            encoded: tabConfigurationRaw,
            legacyRaw: legacyTabOrderRaw
        )
        return "\(configuration.visibleTabs.count) tabs"
    }

    // Deep link for the ntfy iOS app. ntfy registers `https://ntfy.sh/<topic>`
    // as a universal link; if the app is not installed the system falls back
    // to Safari, which is the desired behaviour.
    private var ntfyTopicAppURL: URL? {
        let trimmed = ntfy.topic.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return nil }
        return URL(string: "https://ntfy.sh/\(trimmed)")
    }

    private func save() {
        let trimmed = gatewayURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard urlValid, let url = URL(string: trimmed) else { return }
        busy = true
        saveFeedback = "Saving…"
        Task {
            do {
                try await container.applyGatewaySettings(gatewayURL: url, deviceName: deviceName)
                gatewayURL = container.gatewayURL.absoluteString
                configureLiveSettingsStore()
                if let transport = container.transport {
                    await agentConfig.load(transport: transport)
                    providerDraft = agentConfig.provider
                    modelDraft = agentConfig.model
                    customAgentModelDraft = isKnownAgentModel(agentConfig.model) ? "" : agentConfig.model
                    apiBaseURLDraft = agentConfig.apiBaseURL
                    await ntfy.load(transport: transport)
                    topicDraft = ntfy.topic
                }
                saveFeedback = "Saved and connected."
                setConnectionTestState(.success("Reachable"))
            } catch {
                saveFeedback = "Saved, but reconnect failed: \(error.localizedDescription)"
                setConnectionTestState(.failure("Reconnect failed"))
            }
            busy = false
        }
    }

    private func setConnectionTestState(_ state: ConnTestState, animated: Bool = true) {
        let update = {
            connTestState = state
            switch state {
            case .idle, .success:
                connTestFeedback = nil
            case .failure(let message):
                connTestFeedback = message
            case .running:
                break
            }
        }
        if animated {
            withAnimation(.easeInOut(duration: 0.24)) {
                update()
            }
        } else {
            update()
        }
    }

    /// Result of probing the entered gateway URL's /health endpoint.
    enum ConnTestState: Equatable {
        case idle, running, success(String), failure(String)

        var label: String {
            switch self {
            case .idle: return "Not tested"
            case .running: return "Testing…"
            case .success(let m), .failure(let m): return m
            }
        }
        var buttonTitle: String {
            switch self {
            case .idle: return "Test connection"
            case .running: return "Testing..."
            case .success: return "Reachable"
            case .failure: return "Try again"
            }
        }
        var accessibilityLabel: String {
            switch self {
            case .idle, .running:
                return buttonTitle
            case .success(let m), .failure(let m):
                return "\(buttonTitle), \(m)"
            }
        }
        var systemImage: String {
            switch self {
            case .idle: return "antenna.radiowaves.left.and.right"
            case .running: return "clock"
            case .success: return "checkmark.circle.fill"
            case .failure: return "xmark.circle.fill"
            }
        }
        var color: Color {
            switch self {
            case .idle: return DesignTokens.panelAccentInk
            case .running: return DesignTokens.Status.warning
            case .success: return DesignTokens.Status.success
            case .failure: return DesignTokens.Status.error
            }
        }
    }

    /// Probe the URL currently in the field (not the saved one) by GETting
    /// <url>/health. Sends Cloudflare Access service-token headers when they are
    /// configured for this gateway so a CF-Access-gated gateway doesn't 403.
    private func testConnection() async {
        let trimmed = gatewayURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard urlValid, let base = URL(string: trimmed) else {
            setConnectionTestState(.failure("Invalid URL"))
            return
        }
        setConnectionTestState(.running)
        var request = URLRequest(url: base.appendingPathComponent("health"))
        request.httpMethod = "GET"
        request.timeoutInterval = 8
        if let creds = try? CloudflareAccessStore.load(for: base), creds.isComplete {
            request.setValue(creds.clientId, forHTTPHeaderField: "CF-Access-Client-Id")
            request.setValue(creds.clientSecret, forHTTPHeaderField: "CF-Access-Client-Secret")
        }
        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                setConnectionTestState(.failure("Unexpected response"))
                return
            }
            switch http.statusCode {
            case 200...299: setConnectionTestState(.success("Reachable"))
            case 401, 403: setConnectionTestState(.failure("Auth required (\(http.statusCode)) — check Cloudflare Access"))
            default: setConnectionTestState(.failure("HTTP \(http.statusCode)"))
            }
        } catch {
            setConnectionTestState(.failure("Could not reach gateway"))
        }
    }

    private func gatewayURLForDraft() -> URL? {
        URL(string: gatewayURL.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    private func loadCloudflareAccess() {
        guard let url = gatewayURLForDraft() else { return }
        guard let credentials = try? CloudflareAccessStore.load(for: url) else {
            cfAccessClientId = ""
            cfAccessClientSecret = ""
            return
        }
        cfAccessClientId = credentials.clientId
        cfAccessClientSecret = credentials.clientSecret
        cfAccessFeedback = credentials.isComplete ? "Access token saved for this gateway." : "Access token is incomplete."
    }

    private func saveCloudflareAccess() {
        guard let url = gatewayURLForDraft() else {
            cfAccessFeedback = "Enter a valid gateway URL first."
            return
        }
        let credentials = CloudflareAccessCredentials(
            clientId: cfAccessClientId,
            clientSecret: cfAccessClientSecret
        )
        do {
            try CloudflareAccessStore.save(credentials, for: url)
            try? KeychainStore.delete(for: url)
            cfAccessFeedback = credentials.isComplete
                ? "Saved. Tap Re-authenticate to use it."
                : "Saved, but Client ID or secret is empty."
        } catch {
            cfAccessFeedback = "Could not save Access token: \(error)"
        }
    }

    private func clearCloudflareAccess() {
        guard let url = gatewayURLForDraft() else {
            cfAccessFeedback = "Enter a valid gateway URL first."
            return
        }
        do {
            try CloudflareAccessStore.delete(for: url)
            try? KeychainStore.delete(for: url)
            cfAccessClientId = ""
            cfAccessClientSecret = ""
            cfAccessFeedback = "Cleared. Tap Re-authenticate after saving new credentials."
        } catch {
            cfAccessFeedback = "Could not clear Access token: \(error)"
        }
    }

    private var appVersion: String {
        let v = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?"
        let b = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "?"
        return "\(v) (\(b))"
    }
}
