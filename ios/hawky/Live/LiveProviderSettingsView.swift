import SwiftUI

private let liveInputTranscriptionModelOptions: [(id: String, label: String)] = [
    ("gpt-4o-mini-transcribe", "gpt-4o-mini-transcribe"),
    ("gpt-4o-mini-transcribe-2025-03-20", "gpt-4o-mini-transcribe-2025-03-20"),
    ("gpt-4o-mini-transcribe-2025-12-15", "gpt-4o-mini-transcribe-2025-12-15"),
    ("gpt-4o-transcribe", "gpt-4o-transcribe"),
    ("gpt-4o-transcribe-diarize", "gpt-4o-transcribe-diarize"),
    ("gpt-realtime-whisper", "gpt-realtime-whisper"),
    ("whisper-1", "whisper-1"),
]

private let liveCustomTranscriptionModelID = "__custom_transcription_model__"

private enum LiveMaxResponseOutputTokenMode: String, CaseIterable, Identifiable {
    case custom
    case unlimited

    var id: String { rawValue }

    var label: String {
        switch self {
        case .custom: return "Custom"
        case .unlimited: return "Unlimited"
        }
    }
}

struct LiveProviderSettingsView: View {
    @Environment(AppContainer.self) private var container
    @State private var store = LiveSessionStore()

    var body: some View {
        Form {
            LiveSettingsFormContent(
                store: store,
                showsModelConfiguration: true
            )
        }
        .tint(DesignTokens.accent)
        .onAppear {
            store.configureGatewayBridge(
                gatewayURL: container.gatewayURL,
                activeChatSessionKey: container.sessionStore.activeSessionKey
            )
            store.refreshDirectOpenAIAPIKeyStatus()
        }
        .onChange(of: container.sessionStore.activeSessionKey) { _, newValue in
            store.configureGatewayBridge(
                gatewayURL: container.gatewayURL,
                activeChatSessionKey: newValue
            )
        }
    }
}

struct LiveSettingsFormContent: View {
    let store: LiveSessionStore
    var showsConversation: Bool = true
    var showsRecording: Bool = true
    var showsModelConfiguration: Bool = false

    var body: some View {
        if store.phase.isActive {
            Section {
                Label(
                    "Live is running — changes apply to the next session.",
                    systemImage: "info.circle"
                )
                .font(.footnote)
                .foregroundStyle(.secondary)
                .accessibilityIdentifier("live.settingsActiveHint")
            }
        }
        LiveProviderProfileSection(store: store)
        if showsConversation {
            LiveConversationSettingsSection(store: store)
        }
        if showsRecording {
            LiveRecordingSettingsSection(store: store)
        }
        LiveOutputSettingsSection(store: store)
        if showsModelConfiguration {
            LiveModelConfigurationSection(store: store)
        }
        LiveTurnDetectionSettingsSection(store: store)
        LiveToolboxSettingsSection(store: store)
        LiveGatewayBridgeSettingsSection(store: store)
        LiveInputSettingsSection(store: store)
    }
}

struct LivePromptSettingsSection: View {
    let store: LiveSessionStore

    var body: some View {
        Section {
            Picker("Prompt", selection: selectedPromptBinding) {
                ForEach(store.promptProfiles) { profile in
                    Text(profile.title).tag(profile.id)
                }
            }
            .pickerStyle(.navigationLink)
            .accessibilityIdentifier("live.prompt")

            TextField("Prompt name", text: promptTitleBinding)
                .textInputAutocapitalization(.words)
                .autocorrectionDisabled(false)
                .accessibilityIdentifier("live.promptTitle")

            TextEditor(text: promptInstructionsBinding)
                .frame(minHeight: 160)
                .font(.body)
                .textInputAutocapitalization(.sentences)
                .autocorrectionDisabled(false)
                .accessibilityIdentifier("live.promptInstructions")

            HStack {
                Button {
                    store.addPrompt()
                } label: {
                    Label("Add", systemImage: "plus")
                }
                Spacer()
                Button(role: .destructive) {
                    store.deleteSelectedPrompt()
                } label: {
                    Label("Delete", systemImage: "trash")
                }
                .disabled(selectedPrompt?.isBuiltIn ?? true)
            }
        } header: {
            Text("Prompt")
        } footer: {
            Text(promptFooter)
        }
    }

    private var selectedPrompt: LivePromptProfile? {
        store.promptProfiles.first { $0.id == store.config.selectedPromptID }
    }

    private var promptFooter: String {
        if selectedPrompt?.isBuiltIn == true {
            return "Built-in prompts can be edited for this session. Use Add to save a reusable copy you can delete later."
        }
        return "Custom prompts are saved locally and sent as Realtime session instructions when a new session starts."
    }

    private var selectedPromptBinding: Binding<String> {
        Binding(
            get: { store.config.selectedPromptID },
            set: { store.selectPrompt($0) }
        )
    }

    private var promptTitleBinding: Binding<String> {
        Binding(
            get: { store.config.promptTitle },
            set: { store.updateSelectedPromptTitle($0) }
        )
    }

    private var promptInstructionsBinding: Binding<String> {
        Binding(
            get: { store.config.promptInstructions },
            set: { store.updateSelectedPromptInstructions($0) }
        )
    }
}

struct LiveRecordingSettingsSection: View {
    let store: LiveSessionStore
    @AppStorage(BackgroundCapturePolicy.storageKey) private var backgroundCapturePolicyRaw: String = BackgroundCapturePolicy.defaultPolicy.rawValue

    private var backgroundCapturePolicy: BackgroundCapturePolicy {
        BackgroundCapturePolicy(storedValue: backgroundCapturePolicyRaw)
    }

    var body: some View {
        Section {
            Picker("Save Live media", selection: mediaPersistenceBinding) {
                ForEach(LiveMediaPersistenceMode.allCases) { mode in
                    Text(mode.label).tag(mode)
                }
            }
            .accessibilityIdentifier("live.settings.mediaPersistence")

            Picker("Background capture", selection: $backgroundCapturePolicyRaw) {
                ForEach(BackgroundCapturePolicy.allCases) { policy in
                    Label(policy.label, systemImage: policy == .off ? "hand.raised" : "mic.fill")
                        .tag(policy.rawValue)
                }
            }
            .accessibilityIdentifier("live.settings.backgroundCapture")

            Text(store.config.mediaPersistenceMode.description)
                .font(.caption)
                .foregroundStyle(.secondary)
            Text("Background capture: \(backgroundCapturePolicy.label). \(backgroundCapturePolicy.recordingDescription)")
                .font(.caption)
                .foregroundStyle(.secondary)
        } header: {
            Text("Recording")
        } footer: {
            Text("Applies automatically when a new Live session starts. Change it before starting Live.")
        }
    }

    private var mediaPersistenceBinding: Binding<LiveMediaPersistenceMode> {
        Binding(
            get: { store.config.mediaPersistenceMode },
            set: { store.updateMediaPersistenceMode($0) }
        )
    }
}

struct LiveConversationSettingsSection: View {
    let store: LiveSessionStore
    @AppStorage(AppTabConfiguration.storageKey) private var tabConfigurationRaw: String = ""
    @AppStorage(AppTabConfiguration.legacyTabOrderKey) private var legacyTabOrderRaw: String = ""

    private var developerModeEnabled: Bool {
        AppTabConfiguration.load(
            encoded: tabConfigurationRaw,
            legacyRaw: legacyTabOrderRaw
        ).developerModeEnabled
    }

    var body: some View {
        Section {
            if developerModeEnabled {
                Toggle("Show system messages", isOn: Binding(
                    get: { store.config.showSystemMessages },
                    set: { store.updateShowSystemMessages($0) }
                ))
                .accessibilityIdentifier("live.settings.showSystemMessages")
            } else {
                LabeledContent("Show system messages", value: "Off")
                    .accessibilityIdentifier("live.settings.showSystemMessages.fixed")
            }

            Picker("Diagnostics", selection: Binding(
                get: { store.config.diagnosticsLevel },
                set: { store.updateDiagnosticsLevel($0) }
            )) {
                ForEach(LiveDiagnosticsLevel.allCases) { level in
                    Text(level.label).tag(level)
                }
            }
            .accessibilityIdentifier("live.settings.diagnosticsLevel")

            Toggle("Keep running offscreen", isOn: Binding(
                get: { store.config.keepRunningOffscreen },
                set: { store.updateKeepRunningOffscreen($0) }
            ))
            .accessibilityIdentifier("live.settings.keepRunningOffscreen")

            Picker("Lock Screen", selection: Binding(
                get: { store.config.lockScreenMode },
                set: { store.updateLockScreenMode($0) }
            )) {
                ForEach(LiveLockScreenMode.allCases) { mode in
                    Text(mode.label).tag(mode)
                }
            }
            .accessibilityIdentifier("live.settings.lockScreenMode")

            Text(store.config.lockScreenMode.description)
                .font(.caption)
                .foregroundStyle(.secondary)

            Toggle("Show camera frames in transcript", isOn: Binding(
                get: { store.config.showVisualFramesInTranscript },
                set: { store.updateShowVisualFramesInTranscript($0) }
            ))
            .accessibilityIdentifier("live.settings.showVisualFramesInTranscript")
        } header: {
            Text("Conversation")
        } footer: {
            Text("System messages show connection, tool, and diagnostic events only in Developer Mode. Keep running offscreen preserves Live audio when switching tabs or locking the phone; iOS may still interrupt audio in some conditions. Show camera frames is a debug aid: the live video now appears in a floating preview, so the raw keyframes sent to the model are hidden from the transcript unless this is on.")
        }
        .onAppear(perform: enforceNonDeveloperSystemMessagesDefault)
        .onChange(of: tabConfigurationRaw) { _, _ in
            enforceNonDeveloperSystemMessagesDefault()
        }
    }

    private func enforceNonDeveloperSystemMessagesDefault() {
        guard !developerModeEnabled, store.config.showSystemMessages else { return }
        store.updateShowSystemMessages(false)
    }
}

struct LiveOutputSettingsSection: View {
    let store: LiveSessionStore

    var body: some View {
        Section {
            if usesOpenAIWebRTC {
                LabeledContent("Agent response", value: LiveResponseModality.audio.label)
                    .accessibilityIdentifier("live.responseModality.fixed")
            } else {
                Picker("Agent response", selection: responseModalityBinding) {
                    ForEach(LiveResponseModality.allCases) { modality in
                        Text(modality.label).tag(modality)
                    }
                }
                .pickerStyle(.navigationLink)
                .accessibilityIdentifier("live.responseModality")
            }

            if usesOpenAIWebRTC || store.config.responseModality == .audio {
                Picker("Voice", selection: realtimeVoiceBinding) {
                    ForEach(LiveRealtimeVoice.allCases) { voice in
                        Text(voice.label).tag(voice)
                    }
                }
                .pickerStyle(.navigationLink)
                .accessibilityIdentifier("live.realtimeVoice")

                Picker("Output", selection: audioOutputDestinationBinding) {
                    ForEach(LiveAudioOutputDestination.allCases) { destination in
                        Text(destination.label).tag(destination)
                    }
                }
                .pickerStyle(.navigationLink)
                .accessibilityIdentifier("live.audioOutputDestination")

                Picker("Noise reduction", selection: noiseReductionBinding) {
                    ForEach(LiveNoiseReduction.allCases) { reduction in
                        Text(reduction.label).tag(reduction)
                    }
                }
                .pickerStyle(.navigationLink)
                .accessibilityIdentifier("live.noiseReduction")
            }

            Toggle("User transcript", isOn: inputTranscriptionEnabledBinding)
                .accessibilityIdentifier("live.inputTranscriptionEnabled")

            if store.config.inputTranscriptionEnabled {
                Picker("Transcription model", selection: inputTranscriptionModelSelectionBinding) {
                    ForEach(liveInputTranscriptionModelOptions, id: \.id) { option in
                        Text(option.label).tag(option.id)
                    }
                    Text("Custom name").tag(liveCustomTranscriptionModelID)
                }
                .pickerStyle(.navigationLink)
                .accessibilityIdentifier("live.inputTranscriptionModelPicker")

                if isCustomInputTranscriptionModel {
                    TextField("Custom transcription model", text: inputTranscriptionModelBinding)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        .keyboardType(.asciiCapable)
                        .font(DesignTokens.Font.mono)
                        .accessibilityIdentifier("live.inputTranscriptionModel")
                }
            }

            Toggle("Assistant transcript", isOn: outputTranscriptionEnabledBinding)
                .accessibilityIdentifier("live.outputTranscriptionEnabled")

            Toggle("Show system messages", isOn: Binding(
                get: { store.config.showSystemMessages },
                set: { store.updateShowSystemMessages($0) }
            ))
            .accessibilityIdentifier("live.settings.showSystemMessages.provider")
        } header: {
            Text("Response")
        } footer: {
            Text("Voice responses use Realtime WebRTC audio output. User transcription is off by default for lower latency; assistant transcript can remain on independently. Show system messages surfaces connection/tool/diagnostic events in the transcript (useful for debugging).")
        }
    }

    private var usesOpenAIWebRTC: Bool {
        store.config.provider == .openAIRealtime
    }

    private var responseModalityBinding: Binding<LiveResponseModality> {
        Binding(
            get: { store.config.responseModality },
            set: { store.updateResponseModality($0) }
        )
    }

    private var realtimeVoiceBinding: Binding<LiveRealtimeVoice> {
        Binding(
            get: { store.config.realtimeVoice },
            set: { store.updateRealtimeVoice($0) }
        )
    }

    private var audioOutputDestinationBinding: Binding<LiveAudioOutputDestination> {
        Binding(
            get: { store.config.audioOutputDestination },
            set: { store.updateAudioOutputDestination($0) }
        )
    }

    private var noiseReductionBinding: Binding<LiveNoiseReduction> {
        Binding(
            get: { store.config.noiseReduction },
            set: { store.updateNoiseReduction($0) }
        )
    }

    private var inputTranscriptionEnabledBinding: Binding<Bool> {
        Binding(
            get: { store.config.inputTranscriptionEnabled },
            set: { store.updateInputTranscriptionEnabled($0) }
        )
    }

    private var inputTranscriptionModelBinding: Binding<String> {
        Binding(
            get: { store.config.inputTranscriptionModel },
            set: { store.updateInputTranscriptionModel($0) }
        )
    }

    private var inputTranscriptionModelSelectionBinding: Binding<String> {
        Binding(
            get: {
                liveInputTranscriptionModelOptions.contains { $0.id == store.config.inputTranscriptionModel }
                    ? store.config.inputTranscriptionModel
                    : liveCustomTranscriptionModelID
            },
            set: { newValue in
                if newValue == liveCustomTranscriptionModelID {
                    store.updateInputTranscriptionModel("")
                } else {
                    store.updateInputTranscriptionModel(newValue)
                }
            }
        )
    }

    private var isCustomInputTranscriptionModel: Bool {
        !liveInputTranscriptionModelOptions.contains { $0.id == store.config.inputTranscriptionModel }
    }

    private var outputTranscriptionEnabledBinding: Binding<Bool> {
        Binding(
            get: { store.config.outputTranscriptionEnabled },
            set: { store.updateOutputTranscriptionEnabled($0) }
        )
    }
}

struct LiveModelConfigurationSection: View {
    let store: LiveSessionStore

    var body: some View {
        Section {
            VStack(alignment: .leading, spacing: 8) {
                Text("Max tokens")
                    .font(.body)
                Picker("Max tokens", selection: maxResponseOutputTokenModeBinding) {
                    ForEach(LiveMaxResponseOutputTokenMode.allCases) { mode in
                        Text(mode.label).tag(mode)
                    }
                }
                .pickerStyle(.segmented)
                .accessibilityIdentifier("live.maxResponseOutputTokens.mode")

                if store.config.maxResponseOutputTokens == nil {
                    Text("Uses the model maximum.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }

            if store.config.maxResponseOutputTokens != nil {
                Stepper(
                    value: maxResponseOutputTokensBinding,
                    in: 1...4_096,
                    step: 256
                ) {
                    LabeledContent("Token limit", value: "\(store.config.maxResponseOutputTokens ?? 4_096)")
                }
                .accessibilityIdentifier("live.maxResponseOutputTokens.value")
            }

            Picker("Tool choice", selection: toolChoiceBinding) {
                ForEach(LiveToolChoice.allCases) { choice in
                    Text(choice.label).tag(choice)
                }
            }
            .pickerStyle(.navigationLink)
            .disabled(store.phase.isActive || !store.config.toolsEnabled)
            .accessibilityIdentifier("live.toolChoice")

            Toggle("Parallel tool calls", isOn: parallelToolCallsEnabledBinding)
                .disabled(store.phase.isActive || !store.config.toolsEnabled)
                .accessibilityIdentifier("live.parallelToolCalls")

            Picker("Reasoning effort", selection: reasoningEffortBinding) {
                ForEach(LiveReasoningEffort.allCases) { effort in
                    Text(effort.label).tag(effort)
                }
            }
            .pickerStyle(.navigationLink)
            .accessibilityIdentifier("live.reasoningEffort")
        } header: {
            Text("Model configuration")
        } footer: {
            Text("Max tokens maps to OpenAI Realtime max_response_output_tokens. Tool settings apply when Local tools are enabled.")
        }
    }

    private var maxResponseOutputTokenModeBinding: Binding<LiveMaxResponseOutputTokenMode> {
        Binding(
            get: { store.config.maxResponseOutputTokens == nil ? .unlimited : .custom },
            set: { mode in
                switch mode {
                case .custom:
                    store.updateMaxResponseOutputTokens(store.config.maxResponseOutputTokens ?? 4_096)
                case .unlimited:
                    store.updateMaxResponseOutputTokens(nil)
                }
            }
        )
    }

    private var maxResponseOutputTokensBinding: Binding<Int> {
        Binding(
            get: { store.config.maxResponseOutputTokens ?? 4_096 },
            set: { store.updateMaxResponseOutputTokens($0) }
        )
    }

    private var toolChoiceBinding: Binding<LiveToolChoice> {
        Binding(
            get: { store.config.toolChoice },
            set: { store.updateToolChoice($0) }
        )
    }

    private var parallelToolCallsEnabledBinding: Binding<Bool> {
        Binding(
            get: { store.config.parallelToolCallsEnabled },
            set: { store.updateParallelToolCallsEnabled($0) }
        )
    }

    private var reasoningEffortBinding: Binding<LiveReasoningEffort> {
        Binding(
            get: { store.config.reasoningEffort },
            set: { store.updateReasoningEffort($0) }
        )
    }
}

struct LiveToolboxSettingsSection: View {
    let store: LiveSessionStore
    @AppStorage(AppTabConfiguration.storageKey) private var tabConfigurationRaw: String = ""
    @AppStorage(AppTabConfiguration.legacyTabOrderKey) private var legacyTabOrderRaw: String = ""

    private var developerModeEnabled: Bool {
        AppTabConfiguration.load(
            encoded: tabConfigurationRaw,
            legacyRaw: legacyTabOrderRaw
        ).developerModeEnabled
    }

    var body: some View {
        Section {
            if developerModeEnabled {
                Toggle("Local tools", isOn: toolsEnabledBinding)
                    .accessibilityIdentifier("live.settings.toolsEnabled")
            } else {
                LabeledContent("Local tools", value: "On")
                    .accessibilityIdentifier("live.settings.toolsEnabled.fixed")
            }

            NavigationLink {
                LiveToolboxView(store: store)
            } label: {
                LabeledContent("Toolbox", value: toolboxSummary)
            }
            .accessibilityIdentifier("live.toolbox")
        } header: {
            Text("Tools")
        } footer: {
            Text("Local tools must be ON for the realtime model to call tools (incl. session_send_message for Slack). OpenAI-format tool schemas with Hawky metadata; frontend tools run on this iPhone, backend bridge tools call the bound Hawky session.")
        }
        .onAppear(perform: enforceNonDeveloperToolsDefault)
        .onChange(of: tabConfigurationRaw) { _, _ in
            enforceNonDeveloperToolsDefault()
        }
    }

    private var toolsEnabledBinding: Binding<Bool> {
        Binding(
            get: { store.config.toolsEnabled },
            set: { store.updateToolsEnabled($0) }
        )
    }

    private func enforceNonDeveloperToolsDefault() {
        guard !developerModeEnabled, !store.phase.isActive, !store.config.toolsEnabled else { return }
        store.updateToolsEnabled(true)
    }

    private var toolboxSummary: String {
        let manifest = store.toolboxManifest
        let tools = manifest.filter { $0.kind == .tool }
        let available = tools.filter(\.available).count
        let skills = manifest.filter { $0.kind == .skill }.count
        return "\(available)/\(tools.count) tools, \(skills) skills"
    }
}

// Extensible filter for the Toolbox list. To add a new filter later (by kind,
// availability, category, …) add a stored property here and a clause in
// `matches(_:)` — the view body stays the same. (#583)
struct LiveToolboxFilter {
    var searchText: String = ""

    var isActive: Bool {
        !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    func apply(to tools: [LiveToolManifestItem]) -> [LiveToolManifestItem] {
        tools.filter(matches)
    }

    func matches(_ tool: LiveToolManifestItem) -> Bool {
        // AND across active criteria; add new filter clauses here as they land.
        matchesSearch(tool)
    }

    private func matchesSearch(_ tool: LiveToolManifestItem) -> Bool {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !query.isEmpty else { return true }
        // Every whitespace-separated term must appear somewhere (tokenized AND),
        // so "memory user" matches a tool mentioning both.
        return query.split(separator: " ").allSatisfy { tool.searchHaystack.contains($0) }
    }
}

extension LiveToolManifestItem {
    /// Lowercased text the Toolbox search scans. Add a field here to make it
    /// searchable everywhere at once. (#583)
    var searchHaystack: String {
        ([name, description] + metadata.whenToUse + metadata.whenNotToUse)
            .joined(separator: " ")
            .lowercased()
    }
}

struct LiveToolboxView: View {
    let store: LiveSessionStore
    @State private var filter = LiveToolboxFilter()

    private var visibleTools: [LiveToolManifestItem] {
        filter.apply(to: store.toolboxManifest)
    }

    var body: some View {
        List {
            Section {
                ForEach(visibleTools) { tool in
                    NavigationLink {
                        LiveToolDetailView(store: store, tool: tool)
                    } label: {
                        LiveToolRow(tool: tool)
                    }
                    .accessibilityIdentifier("live.toolbox.tool.\(tool.name)")
                }
            } footer: {
                Text("This is the local frontend manifest. Future backend-provided tools can use the same OpenAI function schema plus Hawky metadata.")
            }
        }
        .navigationTitle("Toolbox")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $filter.searchText, prompt: "Search tools & skills")
        .overlay {
            if visibleTools.isEmpty {
                ContentUnavailableView.search(text: filter.searchText)
            }
        }
    }
}

private struct LiveToolRow: View {
    let tool: LiveToolManifestItem

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .foregroundStyle(color)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 4) {
                Text(tool.name)
                    .font(.body)
                    .fontDesign(.monospaced)
                Text(tool.description)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer()
            Text(statusText)
                .font(.caption)
                .foregroundStyle(tool.available ? .green : .secondary)
        }
        .padding(.vertical, 2)
    }

    private var statusText: String {
        switch tool.kind {
        case .tool: return tool.available ? "On" : "Off"
        case .skill: return "Skill"
        }
    }

    private var icon: String {
        if tool.kind == .skill { return "sparkles" }
        switch tool.metadata.category {
        case .localContext: return "clock"
        case .deviceDiagnostics: return "iphone"
        case .sessionBridge: return "link"
        case .memory: return "brain.head.profile"
        case .media: return "photo.on.rectangle"
        case .shortcut: return "bolt"
        }
    }

    private var color: Color {
        if !tool.available { return .secondary }
        switch tool.metadata.risk {
        case .low: return .green
        case .medium: return DesignTokens.accent
        case .high: return .orange
        }
    }
}

private struct LiveToolDetailView: View {
    let store: LiveSessionStore
    let tool: LiveToolManifestItem

    private enum SchemaDisplayMode: String, CaseIterable, Identifiable {
        case pretty
        case raw

        var id: String { rawValue }

        var label: String {
            switch self {
            case .pretty: return "Pretty"
            case .raw: return "Raw"
            }
        }
    }

    @State private var argumentsJSON = "{}"
    @State private var resultText = ""
    @State private var isRunning = false
    @State private var schemaDisplayMode: SchemaDisplayMode = .pretty

    var body: some View {
        Form {
            Section("Tool") {
                LabeledContent("Name", value: tool.name)
                    .fontDesign(.monospaced)
                LabeledContent("Kind", value: tool.kind.rawValue)
                LabeledContent("Source", value: tool.source.rawValue)
                LabeledContent("Executor", value: tool.executor.runtime.rawValue)
                LabeledContent("Binding", value: tool.executor.binding)
                    .fontDesign(.monospaced)
                LabeledContent("Hot-loadable", value: tool.executor.hotLoadable ? "Yes" : "No")
                LabeledContent("Category", value: tool.metadata.category.rawValue)
                LabeledContent("Latency", value: tool.metadata.latency.rawValue)
                LabeledContent("Durability", value: tool.metadata.durability.rawValue)
                LabeledContent("Risk", value: tool.metadata.risk.rawValue)
                LabeledContent("Available", value: tool.available ? "Yes" : "No")
            }

            if !tool.metadata.whenToUse.isEmpty {
                Section("When to use") {
                    ForEach(tool.metadata.whenToUse, id: \.self) { item in
                        Text(item)
                    }
                }
            }

            if !tool.metadata.whenNotToUse.isEmpty {
                Section("Avoid when") {
                    ForEach(tool.metadata.whenNotToUse, id: \.self) { item in
                        Text(item)
                    }
                }
            }

            if let instructions = tool.instructions, !instructions.isEmpty {
                Section("Instructions") {
                    Text(instructions)
                        .textSelection(.enabled)
                }
            }

            Section(tool.kind == .tool ? "OpenAI schema" : "Skill manifest") {
                Picker("Format", selection: $schemaDisplayMode) {
                    ForEach(SchemaDisplayMode.allCases) { mode in
                        Text(mode.label).tag(mode)
                    }
                }
                .pickerStyle(.segmented)
                .accessibilityIdentifier("live.toolbox.schemaFormat")

                Text(schemaText)
                    .font(DesignTokens.Font.mono)
                    .textSelection(.enabled)
            }

            if tool.kind == .tool {
                Section {
                TextEditor(text: $argumentsJSON)
                    .font(DesignTokens.Font.mono)
                    .frame(minHeight: 100)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .accessibilityIdentifier("live.toolbox.arguments")

                Button {
                    Task { await runTool() }
                } label: {
                    Label(isRunning ? "Running" : "Run tool", systemImage: isRunning ? "clock" : "play.fill")
                }
                .disabled(isRunning || !tool.available)
                .accessibilityIdentifier("live.toolbox.run")

                if !resultText.isEmpty {
                    Text(resultText)
                        .font(DesignTokens.Font.mono)
                        .textSelection(.enabled)
                        .accessibilityIdentifier("live.toolbox.result")
                }
            } header: {
                Text("Test")
            } footer: {
                Text("Testing executes the iPhone-side tool with your JSON arguments. Bridge tools may call the configured Hawky gateway.")
            }
            }
        }
        .navigationTitle(tool.name)
        .navigationBarTitleDisplayMode(.inline)
    }

    @MainActor
    private func runTool() async {
        isRunning = true
        resultText = await store.testTool(name: tool.name, argumentsJSON: argumentsJSON)
        isRunning = false
    }

    private var schemaText: String {
        switch schemaDisplayMode {
        case .pretty: return tool.definitionJSON
        case .raw: return tool.rawDefinitionJSON
        }
    }
}

struct LiveGatewayBridgeSettingsSection: View {
    let store: LiveSessionStore

    var body: some View {
        Section {
            Toggle("Hawky background agent", isOn: enabledBinding)
                .accessibilityIdentifier("live.gatewayBridgeEnabled")

            if store.config.gatewayBridgeEnabled {
                Toggle("Require gateway connection", isOn: requiredBinding)
                    .accessibilityIdentifier("live.gatewayBridgeRequired")

                Text(store.config.gatewayBridgeRequired
                    ? "Live won't start if your Hawky machine is unreachable — you'll get a clear error instead of a session without your memory + tools."
                    : "If your Hawky machine is unreachable, Live still connects to OpenAI and shows an offline banner. Your machine's memory + tools stay off until it's back.")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                Picker("Channel", selection: modeBinding) {
                    ForEach(LiveGatewayBridgeSessionMode.allCases) { mode in
                        Text(mode.label).tag(mode)
                    }
                }
                .pickerStyle(.navigationLink)
                .accessibilityIdentifier("live.gatewayBridgeSessionMode")

                TextField("Hawky session", text: sessionKeyBinding)
                    .font(DesignTokens.Font.mono)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .disabled(store.phase.isActive || store.config.gatewayBridgeSessionMode == .temporary)
                    .accessibilityIdentifier("live.gatewayBridgeSessionKey")

                Text(store.config.gatewayBridgeSessionMode.description)
                    .font(.caption)
                    .foregroundStyle(.secondary)

                Picker("Feed", selection: feedModeBinding) {
                    ForEach(LiveGatewayBridgeFeedMode.allCases) { mode in
                        Text(mode.label).tag(mode)
                    }
                }
                .pickerStyle(.navigationLink)
                .accessibilityIdentifier("live.gatewayBridgeFeedMode")

                Text(store.config.gatewayBridgeFeedMode.description)
                    .font(.caption)
                    .foregroundStyle(.secondary)

                Picker("Opening", selection: openingBehaviorBinding) {
                    ForEach(LiveOpeningBehavior.allCases) { behavior in
                        Text(behavior.label).tag(behavior)
                    }
                }
                .pickerStyle(.navigationLink)
                .accessibilityIdentifier("live.openingBehavior")

                Text(store.config.openingBehavior.description)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        } header: {
            Text("Hawky Bridge")
        } footer: {
            Text("When enabled, Realtime gets tools for asking the background Hawky agent for longer-running help while the phone remains the live frontend.")
        }
    }

    private var enabledBinding: Binding<Bool> {
        Binding(
            get: { store.config.gatewayBridgeEnabled },
            set: { store.updateGatewayBridgeEnabled($0) }
        )
    }

    private var requiredBinding: Binding<Bool> {
        Binding(
            get: { store.config.gatewayBridgeRequired },
            set: { store.updateGatewayBridgeRequired($0) }
        )
    }

    private var modeBinding: Binding<LiveGatewayBridgeSessionMode> {
        Binding(
            get: { store.config.gatewayBridgeSessionMode },
            set: { store.updateGatewayBridgeSessionMode($0) }
        )
    }

    private var sessionKeyBinding: Binding<String> {
        Binding(
            get: { store.config.gatewayBridgeSessionKey },
            set: { store.updateGatewayBridgeSessionKey($0) }
        )
    }

    private var feedModeBinding: Binding<LiveGatewayBridgeFeedMode> {
        Binding(
            get: { store.config.gatewayBridgeFeedMode },
            set: { store.updateGatewayBridgeFeedMode($0) }
        )
    }

    private var openingBehaviorBinding: Binding<LiveOpeningBehavior> {
        Binding(
            get: { store.config.openingBehavior },
            set: { store.updateOpeningBehavior($0) }
        )
    }
}

struct LiveInputSettingsSection: View {
    let store: LiveSessionStore

    var body: some View {
        Section("Inputs") {
            Picker("Audio", selection: audioSourceBinding) {
                ForEach(LiveAudioSource.allCases) { source in
                    Text(source.label).tag(source)
                }
            }
            .pickerStyle(.navigationLink)
            .accessibilityIdentifier("live.audioSource")

            Text("Use the mic button in the composer to choose whether audio is sent for this Live session.")
                .font(.caption)
                .foregroundStyle(.secondary)

            Picker("Visual", selection: visualSourceBinding) {
                ForEach(LiveVisualSource.allCases) { source in
                    Text(source.label).tag(source)
                }
            }
            .pickerStyle(.navigationLink)
            .accessibilityIdentifier("live.visualSource")

            Picker("Visual cadence", selection: visualCadenceBinding) {
                ForEach(LiveVisualCadence.allCases) { cadence in
                    Text(cadence.label).tag(cadence)
                }
            }
            .disabled(store.config.visualSource == .off)
            .pickerStyle(.navigationLink)
            .accessibilityIdentifier("live.visualCadence")

            if store.config.visualSource != .rayBanMeta {
                Picker("Camera", selection: cameraPositionBinding) {
                    ForEach(LiveCameraPosition.allCases) { position in
                        Text(position.label).tag(position)
                    }
                }
                .pickerStyle(.navigationLink)
                .accessibilityIdentifier("live.cameraPosition")
            }

            if store.config.visualCadence == .custom {
                Stepper(value: customFPSBinding, in: 0.1...5, step: 0.1) {
                    Text("Custom cadence \(String(format: "%.1f", store.config.customVisualFPS)) fps")
                }
                .accessibilityIdentifier("live.customVisualFPS")
            }

            VStack(alignment: .leading, spacing: 4) {
                Toggle("Skip near-identical frames", isOn: visualDedupEnabledBinding)
                    .accessibilityIdentifier("live.visualDedup")
                Text("A static scene sends one frame instead of a flood of duplicates, so the model stops repeating itself. Off sends every frame at the chosen cadence.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .disabled(store.config.visualSource == .off)

            VStack(alignment: .leading, spacing: 4) {
                Toggle("Respond only when I talk", isOn: speakOnlyWhenSpokenToBinding)
                    .accessibilityIdentifier("live.speakOnlyWhenSpokenTo")
                Text("The model stays quiet and replies only after you speak — it won't chime in on its own or narrate the camera. Useful with the camera on.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            VStack(alignment: .leading, spacing: 4) {
                Toggle("Safety Check", isOn: safetyCheckEnabledBinding)
                    .accessibilityIdentifier("live.safetyCheckEnabled")
                Text("With the camera on, the model watches silently and warns you only if it sees a hazard (fire, an unattended stove, a knife danger, etc.). Needs the camera on.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var speakOnlyWhenSpokenToBinding: Binding<Bool> {
        Binding(
            get: { store.config.speakOnlyWhenSpokenTo },
            set: { store.updateSpeakOnlyWhenSpokenTo($0) }
        )
    }

    private var safetyCheckEnabledBinding: Binding<Bool> {
        Binding(
            get: { store.config.safetyCheckEnabled },
            set: { store.updateSafetyCheckEnabled($0) }
        )
    }

    private var audioSourceBinding: Binding<LiveAudioSource> {
        Binding(
            get: { store.config.audioSource },
            set: { store.updateAudioSource($0) }
        )
    }

    private var visualSourceBinding: Binding<LiveVisualSource> {
        Binding(
            get: { store.config.visualSource },
            set: { store.updateVisualSource($0) }
        )
    }

    private var visualCadenceBinding: Binding<LiveVisualCadence> {
        Binding(
            get: { store.config.visualCadence },
            set: { store.updateVisualCadence($0) }
        )
    }

    private var customFPSBinding: Binding<Double> {
        Binding(
            get: { store.config.customVisualFPS },
            set: { store.updateCustomVisualFPS($0) }
        )
    }

    private var visualDedupEnabledBinding: Binding<Bool> {
        Binding(
            get: { store.config.visualDedupEnabled },
            set: { store.updateVisualDedupEnabled($0) }
        )
    }

    private var cameraPositionBinding: Binding<LiveCameraPosition> {
        Binding(
            get: { store.config.cameraPosition },
            set: { position in
                Task { await store.updateCameraPosition(position) }
            }
        )
    }
}

struct LiveTurnDetectionSettingsSection: View {
    let store: LiveSessionStore

    var body: some View {
        Section {
            Picker("Mode", selection: turnDetectionModeBinding) {
                ForEach(LiveTurnDetectionMode.allCases) { mode in
                    Text(mode.label).tag(mode)
                }
            }
            .pickerStyle(.navigationLink)
            .accessibilityIdentifier("live.turnDetectionMode")

            if store.config.turnDetectionMode == .serverVAD {
                SliderRow(
                    title: "Threshold",
                    value: vadThresholdBinding,
                    range: 0...1,
                    step: 0.05,
                    formattedValue: String(format: "%.2f", store.config.vadThreshold)
                )
                SliderRow(
                    title: "Prefix padding",
                    value: vadPrefixPaddingBinding,
                    range: 0...2_000,
                    step: 50,
                    formattedValue: "\(Int(store.config.vadPrefixPaddingMs.rounded())) ms"
                )
                SliderRow(
                    title: "Silence",
                    value: vadSilenceBinding,
                    range: 100...2_000,
                    step: 50,
                    formattedValue: "\(Int(store.config.vadSilenceDurationMs.rounded())) ms"
                )
                Toggle("Idle prompt", isOn: vadIdleTimeoutEnabledBinding)
                if store.config.vadIdleTimeoutEnabled {
                    Stepper(value: vadIdleTimeoutBinding, in: 5_000...30_000, step: 1_000) {
                        Text("Idle timeout \(Int(store.config.vadIdleTimeoutMs / 1_000))s")
                    }
                }
            } else if store.config.turnDetectionMode == .semanticVAD {
                Picker("Eagerness", selection: semanticVADEagernessBinding) {
                    ForEach(LiveSemanticVADEagerness.allCases) { eagerness in
                        Text(eagerness.label).tag(eagerness)
                    }
                }
                .pickerStyle(.navigationLink)
                .accessibilityIdentifier("live.semanticVADEagerness")
            }

            if store.config.turnDetectionMode != .manual {
                Toggle("Auto-create response", isOn: vadCreateResponseBinding)

                Picker("Barge-in", selection: bargeInPolicyBinding) {
                    ForEach(LiveBargeInPolicy.allCases) { policy in
                        Text(policy.label).tag(policy)
                    }
                }
                .accessibilityIdentifier("live.bargeInPolicy")

                Text(store.config.bargeInPolicy.description)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        } header: {
            Text("Turn Detection")
        } footer: {
            Text(turnDetectionFooter)
        }
    }

    private var turnDetectionFooter: String {
        switch store.config.turnDetectionMode {
        case .manual:
            return "Manual turns set OpenAI turn_detection to null; the app decides when to send a response."
        case .serverVAD:
            return "Server VAD uses audio volume and silence. Lower silence responds faster; higher threshold is better for noisy rooms."
        case .semanticVAD:
            return "Semantic VAD waits until the model thinks the utterance is complete. Low eagerness waits longer; high responds sooner."
        }
    }

    private var turnDetectionModeBinding: Binding<LiveTurnDetectionMode> {
        Binding(
            get: { store.config.turnDetectionMode },
            set: { store.updateTurnDetectionMode($0) }
        )
    }

    private var vadThresholdBinding: Binding<Double> {
        Binding(
            get: { store.config.vadThreshold },
            set: { store.updateVADThreshold($0) }
        )
    }

    private var vadPrefixPaddingBinding: Binding<Double> {
        Binding(
            get: { store.config.vadPrefixPaddingMs },
            set: { store.updateVADPrefixPaddingMs($0) }
        )
    }

    private var vadSilenceBinding: Binding<Double> {
        Binding(
            get: { store.config.vadSilenceDurationMs },
            set: { store.updateVADSilenceDurationMs($0) }
        )
    }

    private var vadCreateResponseBinding: Binding<Bool> {
        Binding(
            get: { store.config.vadCreateResponse },
            set: { store.updateVADCreateResponse($0) }
        )
    }

    private var bargeInPolicyBinding: Binding<LiveBargeInPolicy> {
        Binding(
            get: { store.config.bargeInPolicy },
            set: { store.updateBargeInPolicy($0) }
        )
    }

    private var vadIdleTimeoutEnabledBinding: Binding<Bool> {
        Binding(
            get: { store.config.vadIdleTimeoutEnabled },
            set: { store.updateVADIdleTimeoutEnabled($0) }
        )
    }

    private var vadIdleTimeoutBinding: Binding<Double> {
        Binding(
            get: { store.config.vadIdleTimeoutMs },
            set: { store.updateVADIdleTimeoutMs($0) }
        )
    }

    private var semanticVADEagernessBinding: Binding<LiveSemanticVADEagerness> {
        Binding(
            get: { store.config.semanticVADEagerness },
            set: { store.updateSemanticVADEagerness($0) }
        )
    }
}

private struct SliderRow: View {
    let title: String
    @Binding var value: Double
    let range: ClosedRange<Double>
    let step: Double
    let formattedValue: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(title)
                Spacer()
                Text(formattedValue)
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            Slider(value: $value, in: range, step: step)
        }
    }
}

struct LiveProviderProfileSection: View {
    let store: LiveSessionStore
    @State private var directAPIKeyDraft = ""
    @State private var revealAPIKey = false
    @State private var didSeedAPIKey = false
    @State private var apiKeyTestState: KeyTestState = .idle

    /// Result of pinging OpenAI to verify the direct API key.
    enum KeyTestState: Equatable {
        case idle, running, success(String), failure(String)

        var label: String {
            switch self {
            case .idle: return "Not tested"
            case .running: return "Testing…"
            case .success(let m), .failure(let m): return m
            }
        }
        var systemImage: String {
            switch self {
            case .idle: return "questionmark.circle"
            case .running: return "clock"
            case .success: return "checkmark.circle.fill"
            case .failure: return "xmark.circle.fill"
            }
        }
        var color: Color {
            switch self {
            case .idle: return .secondary
            case .running: return .orange
            case .success: return .green
            case .failure: return .red
            }
        }
    }

    init(store: LiveSessionStore) {
        self.store = store
    }

    private var settingsDisabled: Bool {
        store.phase.isActive
    }

    var body: some View {
        Section {
            Picker("Provider", selection: providerBinding) {
                ForEach(LiveProviderKind.allCases) { provider in
                    Text(provider.label).tag(provider)
                }
            }
            .pickerStyle(.navigationLink)
            .disabled(settingsDisabled)
            .accessibilityIdentifier("live.provider")

            if store.config.provider == .openAIRealtime {
                LabeledContent("Credentials", value: LiveOpenAICredentialMode.directAPIKey.label)
                    .accessibilityIdentifier("live.openAICredentialMode")

                Picker("Model", selection: modelPresetBinding) {
                    ForEach(LiveOpenAIModelPreset.selectableCases) { preset in
                        Text(preset.label).tag(preset)
                    }
                }
                .pickerStyle(.navigationLink)
                .disabled(settingsDisabled)
                .accessibilityIdentifier("live.openAIModelPreset")

                if store.config.openAIModelPreset == .custom {
                    TextField("Custom model ID", text: modelBinding)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        .keyboardType(.asciiCapable)
                        .font(DesignTokens.Font.mono)
                        .disabled(settingsDisabled)
                        .accessibilityIdentifier("live.model")
                }
            } else {
                // Non-OpenAI providers have no presets; keep a free-form model.
                TextField("Model", text: modelBinding)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .keyboardType(.asciiCapable)
                    .font(DesignTokens.Font.mono)
                    .accessibilityIdentifier("live.model")
            }

            if store.config.provider == .openAIRealtime {
                // Single hide/visible field that saves to the Keychain as you
                // type (clearing it removes the stored key). No separate
                // Save/Clear buttons.
                HStack {
                    Group {
                        if revealAPIKey {
                            TextField("OpenAI API key", text: $directAPIKeyDraft)
                        } else {
                            SecureField("OpenAI API key", text: $directAPIKeyDraft)
                        }
                    }
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.asciiCapable)
                    .font(DesignTokens.Font.mono)
                    .disabled(settingsDisabled)
                    .accessibilityIdentifier("live.directOpenAIAPIKey")
                    .onChange(of: directAPIKeyDraft) { _, newValue in
                        store.saveDirectOpenAIAPIKey(newValue)
                    }

                    Button {
                        revealAPIKey.toggle()
                    } label: {
                        Image(systemName: revealAPIKey ? "eye.slash" : "eye").minimumHitTarget()
                    }
                    .buttonStyle(.borderless)
                    .accessibilityIdentifier("live.directOpenAIAPIKey.reveal")
                }

                Button {
                    Task { await testOpenAIKey() }
                } label: {
                    HStack {
                        Label("Test key", systemImage: apiKeyTestState.systemImage)
                        Spacer()
                        Text(apiKeyTestState.label)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .secondaryPanelAction(tint: apiKeyTestState.color)
                .disabled(settingsDisabled || apiKeyTestState == .running ||
                          directAPIKeyDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityIdentifier("live.directOpenAIAPIKey.test")
            }

            if store.config.provider == .custom {
                LabeledContent("Endpoint") {
                    TextField("Custom endpoint URL", text: customEndpointBinding)
                        .multilineTextAlignment(.trailing)
                        .keyboardType(.URL)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        .textContentType(.URL)
                        .font(DesignTokens.Font.mono)
                        .accessibilityIdentifier("live.customEndpointURL")
                }

                TextField("Event dialect", text: customDialectBinding)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .keyboardType(.asciiCapable)
                    .font(DesignTokens.Font.mono)
                    .accessibilityIdentifier("live.customDialect")
            }

            if store.config.provider == .openAIRealtime {
                Text(openAIHelpText)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("live.provider.openaiHelp")
            } else if !store.config.provider.canStartLocally {
                Text("Adapter disabled until a provider broker is implemented.")
                    .font(.caption)
                    .foregroundStyle(.orange)
                    .accessibilityIdentifier("live.provider.disabled")
            }
        } header: {
            Text("Live Provider")
        } footer: {
            Text("Saved on this iPhone for Live.")
        }
        .onAppear {
            // Seed the field with the stored key once so the user sees that one
            // is saved (and can reveal/edit it). Avoids re-clobbering on every
            // redraw.
            guard !didSeedAPIKey else { return }
            didSeedAPIKey = true
            if let saved = (try? KeychainStore.loadOpenAIAPIKey()) ?? nil {
                directAPIKeyDraft = saved
            }
        }
    }

    /// Verify the direct OpenAI API key by listing models. A 200 means the key
    /// is accepted; 401 means it's invalid.
    @MainActor
    private func testOpenAIKey() async {
        let key = directAPIKeyDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty else { return }
        apiKeyTestState = .running
        var request = URLRequest(url: URL(string: "https://api.openai.com/v1/models")!)
        request.httpMethod = "GET"
        request.timeoutInterval = 10
        request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                apiKeyTestState = .failure("Unexpected response")
                return
            }
            switch http.statusCode {
            case 200...299: apiKeyTestState = .success("Key works")
            case 401: apiKeyTestState = .failure("Invalid key (401)")
            case 429: apiKeyTestState = .failure("Rate limited (429) — key is valid")
            default: apiKeyTestState = .failure("HTTP \(http.statusCode)")
            }
        } catch {
            apiKeyTestState = .failure("Could not reach OpenAI")
        }
    }

    private var providerBinding: Binding<LiveProviderKind> {
        Binding(
            get: { store.config.provider },
            set: { store.updateProvider($0) }
        )
    }

    private var modelBinding: Binding<String> {
        Binding(
            get: { store.config.model },
            set: { store.updateModel($0) }
        )
    }

    private var modelPresetBinding: Binding<LiveOpenAIModelPreset> {
        Binding(
            get: { store.config.openAIModelPreset },
            set: { store.updateOpenAIModelPreset($0) }
        )
    }

    private var openAIHelpText: String {
        "Uses the saved OpenAI key to run a direct Realtime WebRTC voice session. User transcription defaults off for latency and can be enabled when needed."
    }

    private var customEndpointBinding: Binding<String> {
        Binding(
            get: { store.config.customEndpointURL },
            set: { store.updateCustomEndpointURL($0) }
        )
    }

    private var customDialectBinding: Binding<String> {
        Binding(
            get: { store.config.customDialect },
            set: { store.updateCustomDialect($0) }
        )
    }
}

#Preview {
    NavigationStack {
        LiveProviderSettingsView()
            .navigationTitle("Live Providers")
    }
}
