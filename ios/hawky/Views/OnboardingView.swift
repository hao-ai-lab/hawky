import SwiftUI
import UIKit

enum OnboardingState {
    static let completedKey = "onboarding.completed"
    static let skippedKey = "onboarding.skipped"
    static let presentKey = "onboarding.present"

    static func shouldAutoPresent(defaults: UserDefaults = .standard) -> Bool {
        if defaults.bool(forKey: completedKey) || defaults.bool(forKey: skippedKey) {
            return false
        }
        return defaults.string(forKey: "gatewayURL") == nil
    }

    static func markCompleted(defaults: UserDefaults = .standard) {
        defaults.set(true, forKey: completedKey)
        defaults.set(false, forKey: skippedKey)
        defaults.set(false, forKey: presentKey)
    }

    static func markSkipped(defaults: UserDefaults = .standard) {
        defaults.set(false, forKey: completedKey)
        defaults.set(true, forKey: skippedKey)
        defaults.set(false, forKey: presentKey)
    }
}

private enum SetupProbeState: Equatable {
    case idle
    case running
    case success(String)
    case warning(String)
    case failure(String)

    var label: String {
        switch self {
        case .idle: return "Not checked"
        case .running: return "Checking..."
        case .success(let message), .warning(let message), .failure(let message):
            return message
        }
    }

    var systemImage: String {
        switch self {
        case .idle: return "circle"
        case .running: return "clock"
        case .success: return "checkmark.circle.fill"
        case .warning: return "exclamationmark.triangle.fill"
        case .failure: return "xmark.circle.fill"
        }
    }

    var color: Color {
        switch self {
        case .idle: return .secondary
        case .running: return .orange
        case .success: return .green
        case .warning: return .orange
        case .failure: return .red
        }
    }
}

/// The ordered steps of the first-run wizard. Every step has a sensible
/// default, so a user can tap through (or "Skip for now") and still land in a
/// working-or-recoverable state; anything skipped can be set later in Settings.
private enum OnboardingStep: Int, CaseIterable, Identifiable, Equatable {
    case welcome
    case gateway
    case provider
    case glasses
    case done

    var id: Int { rawValue }

    var title: String {
        switch self {
        case .welcome: return "Welcome"
        case .gateway: return "Connect"
        case .provider: return "Live Provider"
        case .glasses: return "Ray-Ban Meta"
        case .done: return "All Set"
        }
    }
}

/// How the user picks the gateway: the bundled default, or a hand-entered URL.
private enum ConnectionMode: String, CaseIterable, Identifiable {
    case `default`
    case customized

    var id: String { rawValue }

    var label: String {
        switch self {
        case .default: return "Default"
        case .customized: return "Customized"
        }
    }
}

struct OnboardingView: View {
    @Environment(AppContainer.self) private var container
    @Environment(\.dismiss) private var dismiss

    /// Live store so the provider step writes the same config Settings uses.
    let liveStore: LiveSessionStore
    let onComplete: (() -> Void)?
    let glassesStepMode: LaunchConfiguration.GlassesStepMode
    let showsWelcomeStep: Bool

    @State private var step: OnboardingStep

    // Gateway / connection
    @State private var gatewayURL: String = UserDefaults.standard.string(forKey: "gatewayURL") ?? GatewayDefaults.urlString
    @State private var connectionMode: ConnectionMode = .default
    // Device name still flows through onboarding's save path, but its editor now
    // lives in Settings; default to the iPhone's own name.
    @State private var deviceName: String = UserDefaults.standard.string(forKey: "deviceName") ?? UIDevice.current.name
    @State private var cfAccessClientId: String = ""
    @State private var cfAccessClientSecret: String = ""
    @State private var useCloudflareAccess = false
    @State private var revealAccessSecret = false
    @State private var healthState: SetupProbeState = .idle
    @State private var authState: SetupProbeState = .idle
    @State private var didLoadAccess = false

    private var trimmedGatewayURL: String {
        gatewayURL.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var trimmedDeviceName: String {
        deviceName.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var urlValid: Bool {
        validateGatewayURL(trimmedGatewayURL)
    }

    private var gatewayURLValue: URL? {
        URL(string: trimmedGatewayURL)
    }

    init(
        liveStore: LiveSessionStore,
        onComplete: (() -> Void)? = nil,
        glassesStep: LaunchConfiguration.GlassesStepMode = .registration,
        startsAtConnection: Bool = false
    ) {
        self.liveStore = liveStore
        self.onComplete = onComplete
        self.glassesStepMode = glassesStep
        self.showsWelcomeStep = !startsAtConnection
        _step = State(initialValue: startsAtConnection ? .gateway : .welcome)
    }

    private var setupSteps: [OnboardingStep] {
        showsWelcomeStep ? OnboardingStep.allCases : OnboardingStep.allCases.filter { $0 != .welcome }
    }

    private var hasAccessDraft: Bool {
        useCloudflareAccess &&
        (!cfAccessClientId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
         !cfAccessClientSecret.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                progressHeader
                TabView(selection: $step) {
                    if showsWelcomeStep {
                        welcomeStep.tag(OnboardingStep.welcome)
                    }
                    gatewayStep.tag(OnboardingStep.gateway)
                    providerStep.tag(OnboardingStep.provider)
                    glassesStep.tag(OnboardingStep.glasses)
                    doneStep.tag(OnboardingStep.done)
                }
                .tabViewStyle(.page(indexDisplayMode: .never))
                // The primary action is pinned via safeAreaInset (deterministic
                // layout — no first-frame size jump like .overlay produced) and
                // kept visually bare with a clear background. safeAreaInset also
                // reserves the space, so content never hides under the button.
                .safeAreaInset(edge: .bottom) {
                    navigationBar
                        .background(Color.clear)
                }
            }
            .onChange(of: step) { _, _ in
                // Dismiss the keyboard whenever the user moves between steps.
                dismissKeyboard()
            }
            .accessibilityIdentifier("screen.onboarding")
            .navigationTitle(step.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    if previousStep != nil {
                        Button {
                            goBack()
                        } label: {
                            Label("Back", systemImage: "chevron.left")
                        }
                        .accessibilityIdentifier("onboarding.back")
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    // Skip appears on the setup steps (gateway, provider) and the
                    // optional Ray-Ban step. Welcome and the final step don't
                    // need it.
                    if step == .gateway || step == .provider || step == .glasses {
                        Button("Skip") { advance() }
                            .accessibilityIdentifier("onboarding.skipStep")
                    }
                }
            }
        }
        .tint(DesignTokens.accent)
        .interactiveDismissDisabled()
        .task {
            if !didLoadAccess {
                didLoadAccess = true
                // Default vs Customized is inferred from the saved URL.
                connectionMode = (trimmedGatewayURL == GatewayDefaults.urlString) ? .default : .customized
                loadCloudflareAccess()
                // If nothing was saved yet, seed Default mode with local secrets.
                prefillDefaultCloudflareAccessIfNeeded()
            }
        }
        .onChange(of: gatewayURL) { _, _ in
            loadCloudflareAccess()
            healthState = .idle
            authState = .idle
        }
    }

    // MARK: - Chrome

    private var progressHeader: some View {
        HStack(spacing: 8) {
            ForEach(setupSteps) { item in
                Capsule()
                    .fill(item.rawValue <= step.rawValue ? DesignTokens.accent : Color.secondary.opacity(0.25))
                    .frame(height: 4)
                    .animation(.easeInOut, value: step)
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 12)
        .padding(.bottom, 4)
        .accessibilityElement()
        .accessibilityLabel("Step \(currentStepIndex + 1) of \(setupSteps.count)")
    }

    @ViewBuilder
    private var navigationBar: some View {
        // A single, centered floating primary action. Back lives top-left and
        // Skip top-right in the nav bar. No opaque bar/divider — the button
        // floats over the content.
        Button {
            primaryAction()
        } label: {
            Text(primaryActionTitle)
                .frame(maxWidth: .infinity)
        }
        .primaryPanelAction()
        .controlSize(.large)
        .disabled(step == .gateway && !urlValid)
        .accessibilityIdentifier(primaryActionIdentifier)
        .padding(.horizontal, 20)
        .padding(.bottom, 12)
        .padding(.top, 8)
    }

    private func dismissKeyboard() {
        UIApplication.shared.sendAction(
            #selector(UIResponder.resignFirstResponder),
            to: nil, from: nil, for: nil
        )
    }

    private var primaryActionTitle: String {
        switch step {
        case .welcome: return "Get Started"
        case .gateway, .provider, .glasses: return "Continue"
        case .done: return "Finish setup"
        }
    }

    private var primaryActionIdentifier: String {
        switch step {
        case .welcome: return "onboarding.getStarted"
        case .gateway, .provider, .glasses: return "onboarding.continue"
        case .done: return "onboarding.openApp"
        }
    }

    private func primaryAction() {
        switch step {
        case .welcome, .gateway, .provider, .glasses:
            advance()
        case .done:
            finish()
        }
    }

    // MARK: - Steps

    private var welcomeStep: some View {
        stepScroll {
            VStack(alignment: .leading, spacing: 18) {
                Image(systemName: "sparkles")
                    .font(.system(size: 52))
                    .foregroundStyle(DesignTokens.accent)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.top, 8)

                Text("Welcome to Hawky")
                    .font(.largeTitle.bold())
                    .accessibilityIdentifier("onboarding.welcome.title")

                Text("Let's get this iPhone talking to your Hawky gateway and ready for live, voice, and camera sessions. It takes about a minute.")
                    .font(.body)
                    .foregroundStyle(.secondary)

                VStack(alignment: .leading, spacing: 14) {
                    bullet("network", "Connect to your gateway", "Point the app at your Hawky broker URL.")
                    bullet("waveform", "Pick a Live provider", "OpenAI Realtime works out of the box via the gateway.")
                    bullet("eyeglasses", "Optional: Ray-Ban Meta", "Use your glasses' camera as a live visual source.")
                }
                .padding(.top, 4)

                Text("You can skip any step and finish setup later in Settings.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .padding(.top, 4)
            }
        }
    }

    private var gatewayStep: some View {
        Form {
            Section {
                Text("Connect this iPhone to your Hawky gateway. Use the default, or open the details to point at your own.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }

            Section {
                NavigationLink {
                    connectionDetailView
                } label: {
                    HStack(spacing: 8) {
                        Label("Hawky Connection", systemImage: "network")
                        Spacer()
                        Text(connectionMode.label)
                            .foregroundStyle(.secondary)
                        statusDot(for: authState)
                    }
                }
                .accessibilityIdentifier("onboarding.connection.link")
            } footer: {
                Text(connectionSummary)
            }
        }
    }

    /// The detail page reached from "Hawky Connection": pick Default or
    /// Customized, optionally enter a custom URL + Cloudflare Access token, and
    /// run the readiness check.
    private var connectionDetailView: some View {
        Form {
            Section {
                Picker("Connection", selection: $connectionMode) {
                    ForEach(ConnectionMode.allCases) { mode in
                        Text(mode.label).tag(mode)
                    }
                }
                .pickerStyle(.segmented)
                .accessibilityIdentifier("onboarding.connection.mode")
            } footer: {
                Text(connectionMode == .default
                     ? "Uses \(GatewayDefaults.urlString)."
                     : "Enter the URL of your own Hawky gateway.")
            }

            if connectionMode == .customized {
                Section {
                    TextField("Gateway URL", text: $gatewayURL)
                        .keyboardType(.URL)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        .textContentType(.URL)
                        .font(DesignTokens.Font.mono)
                        .accessibilityIdentifier("onboarding.gatewayURL")

                    if !urlValid && !trimmedGatewayURL.isEmpty {
                        Text("Use an http:// or https:// URL with a host.")
                            .font(.caption)
                            .foregroundStyle(.red)
                    }
                } header: {
                    Text("Gateway URL")
                }
            }

            Section {
                Toggle("Cloudflare Access", isOn: $useCloudflareAccess)
                    .accessibilityIdentifier("onboarding.cloudflare.enabled")

                if useCloudflareAccess {
                    TextField("CF-Access-Client-Id", text: $cfAccessClientId)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        .keyboardType(.asciiCapable)
                        .textContentType(.username)
                        .font(DesignTokens.Font.mono)
                        .accessibilityIdentifier("onboarding.cloudflare.clientId")

                    if revealAccessSecret {
                        TextField("CF-Access-Client-Secret", text: $cfAccessClientSecret)
                            .accessSecretFieldStyle()
                            .accessibilityIdentifier("onboarding.cloudflare.clientSecret.revealed")
                    } else {
                        SecureField("CF-Access-Client-Secret", text: $cfAccessClientSecret)
                            .accessSecretFieldStyle()
                            .accessibilityIdentifier("onboarding.cloudflare.clientSecret")
                    }

                    Toggle("Show secret", isOn: $revealAccessSecret)
                        .accessibilityIdentifier("onboarding.cloudflare.showSecret")
                }
            } footer: {
                Text("Turn on only when your gateway is behind Cloudflare Access. Different from OpenAI API keys.")
            }

            Section {
                probeRow(title: "Gateway reachable", state: healthState)
                probeRow(title: "Device auth", state: authState)

                Button {
                    Task { await verifyAll() }
                } label: {
                    Label("Run readiness check", systemImage: "checklist")
                }
                .disabled(!urlValid || healthState == .running || authState == .running)
                .accessibilityIdentifier("onboarding.verify")
            } header: {
                Text("Verify")
            } footer: {
                Text("A successful auth check stores the app token for this gateway. If it fails, check VPN, Cloudflare Access, and the gateway process.")
            }
        }
        .navigationTitle("Hawky Connection")
        .navigationBarTitleDisplayMode(.inline)
        .onChange(of: connectionMode) { _, mode in
            // Default mode always points at the bundled gateway.
            if mode == .default {
                gatewayURL = GatewayDefaults.urlString
                prefillDefaultCloudflareAccessIfNeeded()
            }
        }
        .onChange(of: useCloudflareAccess) { _, on in
            // Turning the toggle on in Default mode pre-fills the known service
            // token (from the local, gitignored DefaultSecrets.plist) when the
            // fields are still empty.
            if on { prefillDefaultCloudflareAccessIfNeeded() }
        }
    }

    /// In Default mode, seed empty Cloudflare Access fields from the bundled
    /// local secrets (if present). Never overwrites values the user typed and
    /// never applies in Customized mode.
    private func prefillDefaultCloudflareAccessIfNeeded() {
        guard connectionMode == .default else { return }
        guard cfAccessClientId.isEmpty, cfAccessClientSecret.isEmpty else { return }
        guard let creds = DefaultSecrets.cloudflareAccess else { return }
        cfAccessClientId = creds.id
        cfAccessClientSecret = creds.secret
        useCloudflareAccess = true
    }

    private var connectionSummary: String {
        let host = URL(string: trimmedGatewayURL)?.host ?? trimmedGatewayURL
        let prefix = "\(connectionMode.label): \(host)"
        if case .success = authState { return "\(prefix) — connected." }
        return "\(prefix). Tap to change or verify."
    }

    @ViewBuilder
    private func statusDot(for state: SetupProbeState) -> some View {
        if case .success = state {
            Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                .accessibilityLabel("Succeeded")
        } else if case .failure = state {
            Image(systemName: "exclamationmark.circle.fill").foregroundStyle(.orange)
                .accessibilityLabel("Failed")
        }
    }

    private var providerStep: some View {
        Form {
            Section {
                Text("OpenAI Realtime via your gateway is the recommended default.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }

            // Reuses the exact same provider UI as Settings → Live, so
            // onboarding and Settings stay one source of truth.
            LiveProviderProfileSection(store: liveStore)
        }
        .onAppear {
            // Nudge first-run users onto the recommended provider. Only when the
            // store is still at its untouched .mock default, so we never clobber
            // a choice the user already made in Settings.
            if liveStore.config.provider == .mock {
                liveStore.updateProvider(.openAIRealtime)
            }
        }
    }

    @ViewBuilder
    private var glassesStep: some View {
        if glassesStepMode == .staticPreview {
            OnboardingGlassesPreviewStep()
        } else {
            OnboardingGlassesRegistrationStep()
        }
    }

    private var doneStep: some View {
        stepScroll {
            VStack(alignment: .leading, spacing: 18) {
                Image(systemName: "checkmark.seal.fill")
                    .font(.system(size: 56))
                    .foregroundStyle(.green)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.top, 8)

                Text("Setup complete")
                    .font(.largeTitle.bold())

                VStack(alignment: .leading, spacing: 12) {
                    summaryRow("Gateway", value: trimmedGatewayURL.isEmpty ? "Not set" : trimmedGatewayURL, ok: urlValid)
                    summaryRow("Device auth", value: authState.label, ok: { if case .success = authState { return true } else { return false } }())
                    summaryRow("Live provider", value: liveStore.config.provider.label, ok: liveStore.config.provider != .mock)
                }

                Text("Anything you skipped can be configured later in **Settings** — including re-running this setup.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .padding(.top, 4)
            }
        }
    }

    // MARK: - Step helpers

    private func stepScroll<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        ScrollView {
            content()
                .padding(.horizontal, 24)
                .padding(.vertical, 16)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func bullet(_ icon: String, _ title: String, _ subtitle: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon)
                .font(.title3)
                .foregroundStyle(DesignTokens.accent)
                .frame(width: 28)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.headline)
                Text(subtitle).font(.subheadline).foregroundStyle(.secondary)
            }
        }
    }

    private func summaryRow(_ title: String, value: String, ok: Bool) -> some View {
        HStack(spacing: 10) {
            Image(systemName: ok ? "checkmark.circle.fill" : "exclamationmark.circle")
                .foregroundStyle(ok ? .green : .orange)
                .accessibilityLabel(ok ? "OK" : "Attention")
            VStack(alignment: .leading, spacing: 1) {
                Text(title).font(.subheadline.weight(.medium))
                Text(value).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
        }
        // Status is icon-colour only; label it and read the row as one. (#576)
        .accessibilityElement(children: .combine)
    }

    private func probeLabel(title: String, state: SetupProbeState) -> some View {
        HStack {
            Label(title, systemImage: state.systemImage)
                .foregroundStyle(state.color)
            Spacer()
            Text(state.label)
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.trailing)
        }
    }

    private func probeRow(title: String, state: SetupProbeState) -> some View {
        HStack {
            Image(systemName: state.systemImage)
                .foregroundStyle(state.color)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                Text(state.label)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    // MARK: - Navigation

    private func advance() {
        // Persist whatever the current step owns before moving on.
        if step == .gateway, urlValid {
            persistGateway()
        }
        goNext()
    }

    private var currentStepIndex: Int {
        setupSteps.firstIndex(of: step) ?? 0
    }

    private var previousStep: OnboardingStep? {
        let index = currentStepIndex
        guard index > 0 else { return nil }
        return setupSteps[index - 1]
    }

    private func goNext() {
        let index = currentStepIndex
        guard setupSteps.indices.contains(index + 1) else { return }
        let next = setupSteps[index + 1]
        withAnimation { step = next }
    }

    private func goBack() {
        guard let previousStep else { return }
        withAnimation { step = previousStep }
    }

    // MARK: - Persistence / verification

    private func persistGateway() {
        guard let baseURL = gatewayURLValue else { return }
        UserDefaults.standard.set(trimmedGatewayURL, forKey: "gatewayURL")
        UserDefaults.standard.set(trimmedDeviceName, forKey: "deviceName")
        Task { await saveAccessDraft(for: baseURL) }
    }

    private func verifyAll() async {
        await testGateway()
        guard case .success = healthState else { return }
        await testAuth()
    }

    private func testGateway() async {
        guard let baseURL = gatewayURLValue else {
            healthState = .failure("Invalid URL")
            return
        }
        await saveAccessDraft(for: baseURL)
        healthState = .running
        do {
            let statusCode = try await fetchHealthStatus(baseURL: baseURL)
            switch statusCode {
            case 200...299:
                healthState = .success("Gateway found")
            case 401, 403:
                healthState = .warning("Access rejected (\(statusCode)) — check Cloudflare Access")
            default:
                healthState = .failure("HTTP \(statusCode)")
            }
        } catch {
            healthState = .failure("Could not reach gateway — check the URL / VPN")
        }
    }

    private func testAuth() async {
        guard let baseURL = gatewayURLValue else {
            authState = .failure("Invalid URL")
            return
        }
        await saveAccessDraft(for: baseURL)
        authState = .running
        // Whether a complete CF Access credential is actually persisted for this
        // gateway right now — lets us tell "no creds saved" apart from "the
        // service token was rejected" in the failure copy.
        let hasSavedAccess = ((try? CloudflareAccessStore.load(for: baseURL))??.isComplete) ?? false
        do {
            _ = try await DeviceAuthClient(baseURL: baseURL).acquireAndStore()
            authState = .success("Token saved")
        } catch DeviceAuthError.unauthorized {
            authState = .failure(hasSavedAccess
                ? "Unauthorized — Cloudflare Access service token rejected"
                : "Unauthorized — add your Cloudflare Access service token above")
        } catch DeviceAuthError.httpStatus(let statusCode) {
            authState = .failure("HTTP \(statusCode) from gateway")
        } catch DeviceAuthError.malformedResponse {
            authState = .failure("Unexpected reply from gateway")
        } catch DeviceAuthError.unexpectedBody {
            // A 2xx whose body wasn't JSON — almost always a Cloudflare Access
            // login page because the service token wasn't accepted.
            authState = .failure(hasSavedAccess
                ? "Cloudflare Access login page returned — check the service token"
                : "Blocked by Cloudflare Access — add your service token above")
        } catch DeviceAuthError.notOk(let message) {
            authState = .failure(message ?? "Gateway returned not ok")
        } catch {
            authState = .failure("Auth failed — could not reach gateway")
        }
    }

    private func fetchHealthStatus(baseURL: URL) async throws -> Int {
        let url = baseURL.appendingPathComponent("health")
        var request = URLRequest(url: url)
        request.timeoutInterval = 6
        CloudflareAccessStore.applyHeaders(to: &request, gatewayURL: baseURL)
        let (_, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        return http.statusCode
    }

    private func loadCloudflareAccess() {
        guard let baseURL = gatewayURLValue else { return }
        guard let credentials = try? CloudflareAccessStore.load(for: baseURL),
              credentials.clientId.isEmpty == false || credentials.clientSecret.isEmpty == false else {
            cfAccessClientId = ""
            cfAccessClientSecret = ""
            useCloudflareAccess = false
            return
        }
        cfAccessClientId = credentials.clientId
        cfAccessClientSecret = credentials.clientSecret
        // Surface saved credentials by switching the toggle on.
        useCloudflareAccess = true
    }

    @MainActor
    private func saveAccessDraft(for baseURL: URL) async {
        let credentials = CloudflareAccessCredentials(
            clientId: cfAccessClientId,
            clientSecret: cfAccessClientSecret
        )
        if hasAccessDraft {
            try? CloudflareAccessStore.save(credentials, for: baseURL)
        } else {
            try? CloudflareAccessStore.delete(for: baseURL)
        }
    }

    // MARK: - Finish

    private func finish() {
        if urlValid { persistGateway() }
        OnboardingState.markCompleted()
        if let onComplete {
            onComplete()
        } else {
            dismiss()
        }
    }
}

private struct OnboardingGlassesRegistrationStep: View {
    // Ray-Ban registration uses the same stream object as the Live Ray-Ban panel,
    // but only when this optional step is actually shown.
    @StateObject private var glasses = GlassesVideoStream()

    private var glassesStatusText: String {
        if glasses.hasConnectedDevice { return "Connected" }
        if glasses.deviceName == "No device" || glasses.deviceName == "No active device" {
            return "Not connected"
        }
        return glasses.registrationState
    }

    var body: some View {
        OnboardingGlassesStepContent {
            VStack(alignment: .leading, spacing: 6) {
                Button {
                    glasses.registerGlasses()
                } label: {
                    Label("Register glasses", systemImage: "link")
                        .frame(maxWidth: .infinity)
                }
                .secondaryPanelAction()

                LabeledContent("Status", value: glassesStatusText)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if let msg = glasses.errorMessage {
                    Text(msg)
                        .font(.caption)
                        .foregroundStyle(.orange)
                        .textSelection(.enabled)
                }
            }
            .padding(.top, 4)
        }
    }
}

private struct OnboardingGlassesPreviewStep: View {
    var body: some View {
        OnboardingGlassesStepContent {
            VStack(alignment: .leading, spacing: 6) {
                LabeledContent("Status", value: "Not connected")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding(.top, 4)
        }
    }
}

private struct OnboardingGlassesStepContent<RegistrationContent: View>: View {
    private let registrationContent: RegistrationContent

    init(@ViewBuilder registrationContent: () -> RegistrationContent) {
        self.registrationContent = registrationContent()
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Image(systemName: "eyeglasses")
                    .font(.system(size: 48))
                    .foregroundStyle(DesignTokens.accent)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.top, 8)

                Text("Ray-Ban Meta")
                    .font(.title2.bold())

                Text("To use your Ray-Ban Meta glasses' camera as a live visual source, set up the Meta AI app, then register the glasses with Hawky.")
                    .font(.body)
                    .foregroundStyle(.secondary)

                Text("Enable Developer Mode in the Meta AI app:")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .padding(.top, 2)

                VStack(alignment: .leading, spacing: 14) {
                    HStack(alignment: .top, spacing: 12) {
                        Text("1")
                            .font(.subheadline.bold())
                            .foregroundStyle(.white)
                            .frame(width: 24, height: 24)
                            .background(Circle().fill(DesignTokens.accent))
                        VStack(alignment: .leading, spacing: 8) {
                            Text(.init("Open the **Meta AI** app on your iPhone."))
                                .font(.subheadline)
                            Button {
                                openMetaAIApp()
                            } label: {
                                HStack(spacing: 8) {
                                    MetaAIAppIcon()
                                    Text("Get / Open Meta AI app")
                                }
                            }
                            .secondaryPanelAction()
                        }
                    }
                    numberedStep(2, "Go to **Settings** (gear icon, bottom left).")
                    numberedStep(3, "Tap **App Info**.")
                    numberedStep(4, "Tap the **App version** number **5 times** — this unlocks Developer Mode.")
                    numberedStep(5, "Go back to Settings — turn on the new **Developer Mode** toggle.")
                }

                registrationContent

                Text("No glasses? Just continue — the iPhone camera works as a visual source too.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 24)
            .padding(.vertical, 16)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func numberedStep(_ n: Int, _ markdown: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Text("\(n)")
                .font(.subheadline.bold())
                .foregroundStyle(.white)
                .frame(width: 24, height: 24)
                .background(Circle().fill(DesignTokens.accent))
            Text(.init(markdown))
                .font(.subheadline)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func openMetaAIApp() {
        // Meta AI app App Store id. Opening the App Store page works whether or
        // not the app is installed (iOS shows "Open" if it is).
        let appStore = URL(string: "https://apps.apple.com/app/meta-ai/id6480947613")!
        UIApplication.shared.open(appStore)
    }
}

private struct MetaAIAppIcon: View {
    var body: some View {
        if UIImage(named: "MetaAIIcon") != nil {
            Image("MetaAIIcon")
                .resizable()
                .frame(width: 22, height: 22)
                .clipShape(RoundedRectangle(cornerRadius: 5, style: .continuous))
        } else {
            Image(systemName: "infinity.circle.fill")
                .font(.system(size: 20))
                .foregroundStyle(Color(red: 0.0, green: 0.5, blue: 1.0))
        }
    }
}

private extension View {
    func accessSecretFieldStyle() -> some View {
        self
            .autocorrectionDisabled()
            .textInputAutocapitalization(.never)
            .keyboardType(.asciiCapable)
            .textContentType(.password)
            .font(DesignTokens.Font.mono)
    }
}
