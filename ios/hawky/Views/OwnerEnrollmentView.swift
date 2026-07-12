import SwiftUI

// =============================================================================
// OwnerEnrollmentView — B3 owner voiceprint enrollment UI (thin SwiftUI shell).
//
// Guided prompts + a record/stop control + a live "enough speech" indicator + an
// explicit biometric-consent toggle + a submit button. All logic lives in
// OwnerEnrollmentModel; this view only renders state and forwards user actions.
//
// FAIL-CLOSED: the Enroll button is disabled until the user grants biometric +
// capture consent AND enough voiced speech is recorded. Enrolling here sets up the
// owner template only — it does NOT enable live voiceprint scoring (that stays a
// separate, still-off switch), and reaching this screen never flips any flag.
// =============================================================================

struct OwnerEnrollmentView: View {
    let store: LiveSessionStore

    @StateObject private var model: OwnerEnrollmentModel
    @State private var recorder = OwnerEnrollmentRecorder()
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

            recordingSection
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
                Text("Recording again replaces your current voice template.")
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
            Text("Record a short sample of your own voice so Hawky can recognize when you are the one speaking. Your voice template is encrypted and stays on your machine.")
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
            Text("Speak naturally for a little over 30 seconds. You can read these lines or just talk about your day.")
        }
    }

    private var recordingSection: some View {
        Section {
            Button {
                Task { await toggleRecording() }
            } label: {
                HStack {
                    Image(systemName: recorder.isRecording ? "stop.circle.fill" : "mic.circle.fill")
                    Text(recorder.isRecording ? "Stop recording" : "Record a sample")
                    Spacer()
                    if recorder.isRecording {
                        ProgressView()
                    }
                }
                .frame(maxWidth: .infinity)
            }
            .primaryPanelActionCompat()
            .disabled(isSubmitting)
            .accessibilityIdentifier("voiceprint.enroll.record")

            speechIndicator

            if !model.sources.isEmpty {
                LabeledContent("Clips recorded", value: "\(model.sources.count)")
                    .font(DesignTokens.Font.rowDetail)

                Button(role: .destructive) {
                    Task { await startOver() }
                } label: {
                    Label("Start over", systemImage: "arrow.counterclockwise")
                        .frame(maxWidth: .infinity)
                }
                .disabled(isSubmitting)
                .accessibilityIdentifier("voiceprint.enroll.startOver")

                Text("Not happy with the recording? Start over to clear these clips and record again.")
                    .font(DesignTokens.Font.meta)
                    .foregroundStyle(.secondary)
            }
        } header: {
            Text("Recording")
        } footer: {
            Text(speechFooter)
        }
    }

    private var speechIndicator: some View {
        // While recording, add a live estimate of the in-progress clip's voiced speech
        // (elapsed * the same ~0.74 voiced fraction) on top of the committed total so
        // the counter climbs in real time. On stop the final value is committed to the
        // model (per the decoupled-display path) and this live term drops to 0.
        let liveVoicedMs = recorder.isRecording
            ? recorder.elapsedMs * OwnerEnrollmentRecorder.voicedFraction
            : 0
        let displayedMs = model.totalVoicedMs + liveVoicedMs
        let seconds = Int((displayedMs / 1000).rounded())
        let enough = displayedMs >= model.voicedFloorMs
        return HStack(spacing: 8) {
            Image(systemName: enough ? "checkmark.circle.fill" : "waveform")
                .foregroundStyle(enough ? DesignTokens.Status.success : .secondary)
            Text(enough ? "Enough speech captured (\(seconds)s)" : "Voiced speech: \(seconds)s")
                .font(DesignTokens.Font.rowDetail)
            Spacer()
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("voiceprint.enroll.speechIndicator")
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
                Task { await model.submit() }
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
            let remaining = Int((model.remainingVoicedMs / 1000).rounded())
            Text("Record a bit more — about \(remaining)s of extra speech is needed.")
                .font(DesignTokens.Font.meta)
                .foregroundStyle(DesignTokens.Status.warning)
                .accessibilityIdentifier("voiceprint.enroll.tooShort")
        case .enrolled(let result):
            Text("Enrolled from \(result.sourceCount ?? model.sources.count) clip(s). Your voice is set up.")
                .font(DesignTokens.Font.meta)
                .foregroundStyle(DesignTokens.Status.success)
                .accessibilityIdentifier("voiceprint.enroll.enrolled")
        case .failed(let message):
            Text(message)
                .font(DesignTokens.Font.meta)
                .foregroundStyle(DesignTokens.Status.error)
                .accessibilityIdentifier("voiceprint.enroll.failed")
        default:
            if model.hasPendingUploads {
                // Enroll is disabled while a clip is still uploading; tell the user why.
                Label("Finishing upload…", systemImage: "arrow.up.circle")
                    .font(DesignTokens.Font.meta)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("voiceprint.enroll.uploading")
            } else if noGateway {
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
        !model.sources.isEmpty
            && model.consent.satisfiesGate
            && model.hasEnoughSpeech
            && !isSubmitting
            && !recorder.isRecording
            && !model.hasPendingUploads
    }

    /// The single most-important next action, driven by state, so the user is always
    /// led to the next step instead of guessing. nil once enrolled.
    private var nextStepText: String? {
        if case .enrolled = model.state { return nil }
        if model.hasPendingUploads { return "Finishing upload — one moment…" }
        if !model.hasEnoughSpeech {
            return "Step 1 — tap Record a sample and speak for a little over 30 seconds."
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

    private var speechFooter: String {
        if model.hasEnoughSpeech {
            return "You have enough speech. Grant consent below, then enroll."
        }
        let remaining = Int((model.remainingVoicedMs / 1000).rounded())
        return "Keep recording — about \(remaining)s more of voiced speech is needed."
    }

    // MARK: - Recording action

    /// Discard all captured clips and re-record from scratch WITHOUT leaving the
    /// screen. Stops any in-progress recording first (its clip is dropped, not
    /// enrolled), then clears the model; the biometric consent toggle is kept. Any
    /// in-flight background upload is orphaned safely (its callback no-ops on the
    /// cleared source).
    private func startOver() async {
        if recorder.isRecording {
            _ = await recorder.stop()
        }
        model.reset()
    }

    private func toggleRecording() async {
        if recorder.isRecording {
            // Decouple display from upload: stop() returns immediately with a local
            // source (voiced count computed on-device), so the counter + consent gate
            // update at once. The upload+register then runs in the BACKGROUND and
            // upgrades the source to artifact-backed. Enroll is gated on the source's
            // pending upload state until that finishes (see canSubmit / submit()).
            guard let outcome = await recorder.stop() else {
                model.refreshGateState()
                return
            }
            guard let artifact = outcome.artifact else {
                // WAV could not be finalized — nothing to enroll from.
                model.refreshGateState()
                return
            }

            let localSource = outcome.localSource
            model.addRecordedSource(localSource, uploadState: .pending)

            // Background upgrade: local-path -> artifact-backed. On success upgrade the
            // same source; on failure keep the local-path fallback (marked failed so
            // Enroll is no longer blocked waiting on it).
            Task {
                if let upgraded = await recorder.upload(
                    artifact: artifact,
                    sourceID: localSource.id,
                    voicedMs: localSource.voicedMs,
                    store: store
                ) {
                    model.markSourceUploaded(id: localSource.id, upgraded: upgraded)
                } else {
                    model.markSourceUploadFailed(id: localSource.id)
                }
            }
        } else {
            model.beginRecording()
            let result = await recorder.start(store: store)
            switch result {
            case .started:
                break
            case .permissionDenied:
                model.recordingFailed(
                    "Microphone access is off. Enable it in Settings to record your voice."
                )
            case .failed:
                model.recordingFailed("Could not start recording. Please try again.")
            }
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
/// nil, so the model's submit path fails closed with a clear "could not reach"
/// message rather than crashing or silently succeeding.
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
