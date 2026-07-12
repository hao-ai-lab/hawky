import SwiftUI

// =============================================================================
// OwnerEnrollmentView — B3 owner voiceprint enrollment UI (thin SwiftUI shell).
//
// Enrollment runs a SILENT live listening session (LiveSessionStore.
// startEnrollmentListeningSession): Hawky listens through the SAME live WebRTC
// pipeline recognition scores — a standalone recorder is acoustically orthogonal
// to that domain (docs/voiceprint-architecture.md, "capture-domain mismatch") —
// and the gateway then builds the owner template from the recording's uploaded
// segments via enroll_owner_from_recording. All logic lives in
// OwnerEnrollmentModel; this view only renders state and forwards user actions.
//
// FAIL-CLOSED: the Enroll button is disabled until the user grants biometric +
// capture consent AND enough voiced speech was captured. Enrolling here sets up
// the owner template only — it does NOT enable live voiceprint scoring (that
// stays a separate, still-off switch), and reaching this screen never flips any
// flag.
// =============================================================================

struct OwnerEnrollmentView: View {
    let store: LiveSessionStore

    @Environment(AppContainer.self) private var container
    @StateObject private var model: OwnerEnrollmentModel
    @State private var noGateway = false

    init(store: LiveSessionStore) {
        self.store = store
        // Build the model from the store's enrollment gateway. When no gateway is
        // configured (offline), fall back to an inert gateway so the view still
        // renders and the submit path fails closed with a clear message.
        if let (gateway, sessionKey) = store.voiceprintEnrollmentGateway() {
            _model = StateObject(wrappedValue: OwnerEnrollmentModel(gateway: gateway, sessionKey: sessionKey))
        } else {
            _model = StateObject(wrappedValue: OwnerEnrollmentModel(
                gateway: InertVoiceprintEnrollmentGateway(),
                sessionKey: "realtime:main"
            ))
        }
    }

    var body: some View {
        Form {
            Section {
                header
                if let enrolled = model.existingEnrollment, enrolled.enrolled {
                    existingEnrollmentBanner(enrolled)
                }
                nextStepBanner
            }
            .settingsSectionSurfaceCompat()

            guidedPromptsSection
                .settingsSectionSurfaceCompat()

            listeningSection
                .settingsSectionSurfaceCompat()

            consentSection
                .settingsSectionSurfaceCompat()

            submitSection
                .settingsSectionSurfaceCompat()
        }
        .navigationTitle("Voice enrollment")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            noGateway = store.voiceprintEnrollmentGateway() == nil
        }
        .onDisappear {
            // Leaving the screen must not leave a silent live session (and its
            // mic + upload) running in the background. The captured recording
            // stays enrollable if the user comes back.
            if model.isListening {
                Task { await model.stopListening(store: store) }
            }
        }
        .task {
            // Query existing enrollment once on appear so the UI can show an
            // "already enrolled" summary instead of always the first-time flow.
            await model.loadEnrollmentStatus()
        }
    }

    /// Summary shown when an owner template already exists: re-recording is a
    /// REPLACEMENT, so this frames the flow as "already set up — re-record to
    /// update" rather than a blank first-time enrollment.
    private func existingEnrollmentBanner(_ status: LiveVoiceprintOwnerTemplateStatus) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "checkmark.seal.fill")
                .foregroundStyle(.green)
            VStack(alignment: .leading, spacing: 2) {
                Text("Your voice is already enrolled")
                    .font(DesignTokens.Font.rowTitle)
                Text(Self.enrolledSummary(status))
                    .font(DesignTokens.Font.rowDetail)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Text("Enrolling again replaces your current voice template.")
                    .font(DesignTokens.Font.rowDetail)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 4)
    }

    /// One-line "enrolled <date> · <seconds>s · <quality>" summary from the
    /// gateway's scalar status. Missing fields are simply omitted.
    static func enrolledSummary(_ status: LiveVoiceprintOwnerTemplateStatus) -> String {
        var parts: [String] = []
        if let iso = status.enrolledAt, let date = ISO8601DateFormatter().date(from: iso) {
            let formatter = DateFormatter()
            formatter.dateStyle = .medium
            formatter.timeStyle = .none
            parts.append("Enrolled \(formatter.string(from: date))")
        }
        if let speechMs = status.speechMs, speechMs > 0 {
            parts.append("\(Int((speechMs / 1000).rounded()))s of speech")
        }
        if let quality = status.quality, !quality.isEmpty {
            parts.append("\(quality) quality")
        }
        return parts.isEmpty ? "Set up and encrypted on your machine." : parts.joined(separator: " · ")
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Set up your owner voice")
                .font(DesignTokens.Font.panelTitle)
            Text("Hawky listens silently through a short live session while you talk, so it can recognize when you are the one speaking. Your voice template is encrypted and stays on your machine.")
                .font(DesignTokens.Font.rowDetail)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 4)
    }

    private var guidedPromptsSection: some View {
        Section {
            ForEach(Self.guidedPrompts, id: \.self) { prompt in
                Label {
                    Text(prompt)
                        .font(DesignTokens.Font.rowDetail)
                } icon: {
                    Image(systemName: "quote.opening").foregroundStyle(.secondary)
                }
            }
        } header: {
            Text("Say a few sentences")
        } footer: {
            Text("Talk naturally the whole time — read these lines, or just talk about your day.")
        }
    }

    /// Contextual label for the primary listening action: a first take starts
    /// fresh, a later take CONTINUES (keeps what was recorded and adds to it),
    /// and an active session stops.
    private var listenButtonTitle: String {
        if model.isListening { return "Stop listening" }
        return model.capturedRecordingBaseIds.isEmpty ? "Start listening" : "Continue recording"
    }

    private var listeningSection: some View {
        Section {
            Button {
                Task { await toggleListening() }
            } label: {
                HStack {
                    Image(systemName: model.isListening ? "stop.circle.fill" : "ear")
                    Text(listenButtonTitle)
                    Spacer()
                    if model.isListening {
                        ProgressView()
                    }
                }
                .frame(maxWidth: .infinity)
            }
            .primaryPanelActionCompat()
            .disabled(isSubmitting || (!model.isListening && model.atTakeLimit))
            .accessibilityIdentifier("voiceprint.enroll.listen")

            if !model.isListening, !model.capturedRecordingBaseIds.isEmpty {
                Text("Keeps what you've recorded and adds to it.")
                    .font(DesignTokens.Font.meta)
                    .foregroundStyle(.secondary)
            }

            speechIndicator

            if !model.capturedRecordingBaseIds.isEmpty, !model.isListening {
                Button(role: .destructive) {
                    model.reset()
                } label: {
                    Label("Start over", systemImage: "arrow.counterclockwise")
                        .frame(maxWidth: .infinity)
                }
                .disabled(isSubmitting)
                .accessibilityIdentifier("voiceprint.enroll.startOver")

                Text("Not happy with the takes? Start over to discard everything and listen again.")
                    .font(DesignTokens.Font.meta)
                    .foregroundStyle(.secondary)
            }
        } header: {
            Text("Listening")
        } footer: {
            Text(listeningFooter)
        }
    }

    /// The ONE progress row every state renders — "Xs / 30s of speech" against
    /// the server's voiced floor, from the model's single accumulated
    /// `speechProgressMs` (server-counted anchor + client estimates + the live
    /// take). Orange with an exact "keep talking" hint once the server has
    /// rejected a count; the green "enough" state hedges because only the
    /// server's count is final.
    private var speechIndicator: some View {
        let seconds = Int((model.speechProgressMs / 1000).rounded())
        let floorSeconds = Int(OwnerEnrollmentModel.serverVoicedFloorMs / 1000)
        let enough = model.hasEnoughListeningSpeech
        let serverAnchored = model.serverCountedSpeechMs != nil
        return HStack(spacing: 8) {
            Image(systemName: enough ? "checkmark.circle.fill" : "waveform")
                .foregroundStyle(enough
                    ? DesignTokens.Status.success
                    : serverAnchored ? DesignTokens.Status.warning : .secondary)
            Text(speechIndicatorText(seconds: seconds, floorSeconds: floorSeconds,
                                     enough: enough, serverAnchored: serverAnchored))
                .font(DesignTokens.Font.rowDetail)
                .foregroundStyle(!enough && serverAnchored ? DesignTokens.Status.warning : .primary)
            Spacer()
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("voiceprint.enroll.speechIndicator")
    }

    private func speechIndicatorText(
        seconds: Int, floorSeconds: Int, enough: Bool, serverAnchored: Bool
    ) -> String {
        if enough {
            return "About \(seconds)s captured — 30s is the minimum; closer to a minute makes recognition noticeably stronger."
        }
        if serverAnchored {
            return "\(seconds)s / \(floorSeconds)s — keep talking about \(model.keepTalkingSeconds) more seconds"
        }
        return "\(seconds)s / \(floorSeconds)s of speech"
    }

    private var consentSection: some View {
        Section {
            Toggle(isOn: $model.consent.biometricAllowed) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("I consent to biometric voice enrollment")
                    Text("Required. Hawky builds an encrypted voice template from this recording.")
                        .font(DesignTokens.Font.meta)
                        .foregroundStyle(.secondary)
                }
            }
            .onChange(of: model.consent.biometricAllowed) { _, _ in
                // Grant capture consent alongside biometric consent — enrollment
                // cannot happen without capturing the sample. Both are required by
                // the fail-closed gate; keeping them coupled avoids a half-granted
                // state that could never submit.
                model.consent.captureAllowed = model.consent.biometricAllowed
                model.refreshGateState()
            }
            .accessibilityIdentifier("voiceprint.enroll.consent")
        } header: {
            Text("Consent")
        } footer: {
            Text("Nothing is enrolled until you turn this on. You can delete your voice template at any time.")
        }
    }

    private var submitSection: some View {
        Section {
            Button {
                Task { await model.submitFromRecording() }
            } label: {
                HStack {
                    Text("Enroll my voice")
                    Spacer()
                    if isSubmitting { ProgressView() }
                }
                .frame(maxWidth: .infinity)
            }
            .primaryPanelActionCompat()
            .disabled(!canSubmit)
            .accessibilityIdentifier("voiceprint.enroll.submit")

            statusMessage
        } footer: {
            Text("Enrolling sets up your voice template only. It does not turn on live voice recognition — that stays a separate switch in Live settings.")
        }
    }

    @ViewBuilder private var statusMessage: some View {
        switch model.state {
        case .needsConsent:
            Text("Turn on biometric consent above to enroll.")
                .font(DesignTokens.Font.meta)
                .foregroundStyle(.secondary)
        case .tooShort:
            // Prefer the server's exact shortfall (from a not_enough_speech
            // rejection) over the client wall-clock estimate — the model exposes
            // both through keepTalkingSeconds.
            Text("Keep talking about \(model.keepTalkingSeconds) more seconds — start another listening session and talk a bit longer.")
                .font(DesignTokens.Font.meta)
                .foregroundStyle(DesignTokens.Status.warning)
                .accessibilityIdentifier("voiceprint.enroll.tooShort")
        case .enrolled(let result):
            Text("Enrolled from \(Int(((result.speechMs ?? 0) / 1000).rounded()))s of your speech. Your voice is set up.")
                .font(DesignTokens.Font.meta)
                .foregroundStyle(DesignTokens.Status.success)
                .accessibilityIdentifier("voiceprint.enroll.enrolled")
        case .failed(let message):
            Text(message)
                .font(DesignTokens.Font.meta)
                .foregroundStyle(DesignTokens.Status.error)
                .accessibilityIdentifier("voiceprint.enroll.failed")
        default:
            if noGateway {
                Text("Hawky gateway is not reachable — connect first to enroll.")
                    .font(DesignTokens.Font.meta)
                    .foregroundStyle(.secondary)
            }
        }
    }

    // MARK: - Derived UI state

    private var isSubmitting: Bool {
        if case .submitting = model.state { return true }
        return false
    }

    private var canSubmit: Bool {
        model.canSubmitFromRecording && !isSubmitting
    }

    /// The single most-important next action, driven by state, so the user is always
    /// led to the next step instead of guessing. nil once enrolled.
    private var nextStepText: String? {
        if case .enrolled = model.state { return nil }
        if model.isListening {
            return "Keep talking — Hawky is listening silently."
        }
        if model.capturedRecordingBaseIds.isEmpty {
            return "Step 1 — tap Start listening and talk for about a minute."
        }
        if !model.hasEnoughListeningSpeech {
            return "Keep going — tap Continue recording and talk about \(model.keepTalkingSeconds) more seconds."
        }
        if !model.consent.satisfiesGate {
            return "Step 2 — turn on biometric consent below."
        }
        return "You're ready — tap Enroll my voice at the bottom."
    }

    @ViewBuilder private var nextStepBanner: some View {
        if let text = nextStepText {
            Label {
                Text(text).font(DesignTokens.Font.rowDetail)
            } icon: {
                Image(systemName: "arrow.turn.down.right")
            }
            .foregroundStyle(DesignTokens.accent)
            .padding(.top, 2)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityIdentifier("voiceprint.enroll.nextStep")
        }
    }

    private var listeningFooter: String {
        if !model.isListening, model.atTakeLimit {
            return "Take limit reached — enroll what you've recorded, or start over."
        }
        if model.isListening {
            return "Hawky is listening silently — it won't speak or respond. Keep talking until the counter fills."
        }
        if !model.capturedRecordingBaseIds.isEmpty, model.hasEnoughListeningSpeech {
            return model.consent.satisfiesGate
                ? "You have enough speech. Tap Enroll my voice below."
                : "You have enough speech. Grant consent below, then enroll."
        }
        return "Hawky will listen silently while you talk — aim for about a minute of speech. Do this alone in a quiet place — it should only hear your voice."
    }

    // MARK: - Listening action

    private func toggleListening() async {
        if model.isListening {
            await model.stopListening(store: store)
        } else {
            // The recording's segments upload live over the app's gateway
            // transport (the same one LiveView hands to start()). Revive it
            // first if it went stale, so the session doesn't record into a
            // dead socket and end in no_usable_segments.
            try? await container.ensureConnected()
            await model.startListening(
                store: store,
                recordingTransport: container.transport
            )
        }
    }

    static let guidedPrompts: [String] = [
        "Hi, this is my voice for Hawky.",
        "I'm setting up voice recognition so Hawky knows when I'm talking.",
        "The quick brown fox jumps over the lazy dog.",
        "I usually start my mornings with a strong cup of coffee.",
    ]
}

/// Inert gateway used only when no Hawky gateway is configured. Every call returns
/// nil (the from-recording method inherits the protocol's nil default), so the
/// model's submit paths fail closed with a clear "could not reach" message rather
/// than crashing or silently succeeding.
private struct InertVoiceprintEnrollmentGateway: VoiceprintEnrollmentGateway {
    func registerVoiceprintAudioArtifact(
        sessionKey: String, audioArtifactID: String, mediaID: String,
        sampleRate: Double?, route: String?, timeoutSeconds: TimeInterval
    ) async -> LiveVoiceprintAudioArtifactRegistration? { nil }

    func enrollVoiceprintOwner(
        sessionKey: String, params: [String: JSONValue], timeoutSeconds: TimeInterval
    ) async -> LiveVoiceprintEnrollmentResult? { nil }

    func addVoiceprintEnrollmentClip(
        sessionKey: String, params: [String: JSONValue], timeoutSeconds: TimeInterval
    ) async -> LiveVoiceprintEnrollmentResult? { nil }
}

// Design-token style helpers. These wrap the shared modifiers when present, and
// otherwise fall back to a neutral rendering so the view compiles standalone.
private extension View {
    @ViewBuilder
    func settingsSectionSurfaceCompat() -> some View {
        self.listRowBackground(DesignTokens.Surface.paper)
            .listRowSeparatorTint(DesignTokens.Surface.paperStroke)
    }

    @ViewBuilder
    func primaryPanelActionCompat() -> some View {
        self.buttonStyle(.borderedProminent)
            .tint(DesignTokens.accent)
    }
}
