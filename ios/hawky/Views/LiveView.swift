import SwiftUI
import UIKit

private enum LiveSheet: Identifiable {
    case actions
    case more
    case settings
    case status
    case glasses
    case recordings
    case mockLocation
    case sessions
    case summary
    case detail(LiveConversationEntry)
    case export(LiveExportFile)

    var id: String {
        switch self {
        case .actions: return "actions"
        case .more: return "more"
        case .settings: return "settings"
        case .status: return "status"
        case .glasses: return "glasses"
        case .recordings: return "recordings"
        case .mockLocation: return "mockLocation"
        case .sessions: return "sessions"
        case .summary: return "summary"
        case .detail(let entry): return entry.id.uuidString
        case .export(let file): return file.id.uuidString
        }
    }
}

/// Centered soft-glass dialog that renders a `LiveUserAlert` (the store-owned,
/// general user-error channel), styled to the app's panel language (warm amber
/// accent, rounded glass surface, capsule panel actions) rather than a stock
/// system `.alert`. `paperSurface` stays opaque so the dark scrim doesn't mute
/// it.
private struct LiveActionAlertCard: View {
    let alert: LiveUserAlert
    let onOpenSettings: () -> Void
    let onDismiss: () -> Void

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 32, weight: .semibold))
                .foregroundStyle(DesignTokens.Status.warning)
                .accessibilityHidden(true)

            VStack(spacing: 6) {
                Text(alert.title)
                    .font(DesignTokens.Font.liveHeroTitle)
                    .foregroundStyle(.primary)
                    .multilineTextAlignment(.center)
                Text(alert.message)
                    .font(DesignTokens.Font.panelBody)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }

            VStack(spacing: 10) {
                if alert.opensSettings {
                    Button("Open Live Settings", action: onOpenSettings)
                        .primaryPanelAction()
                        .frame(maxWidth: .infinity)
                        .accessibilityIdentifier("live.actionAlert.openSettings")
                    Button("Not now", action: onDismiss)
                        .secondaryPanelAction()
                        .frame(maxWidth: .infinity)
                        .accessibilityIdentifier("live.actionAlert.dismiss")
                } else {
                    Button("OK", action: onDismiss)
                        .primaryPanelAction()
                        .frame(maxWidth: .infinity)
                        .accessibilityIdentifier("live.actionAlert.dismiss")
                }
            }
        }
        .padding(24)
        .frame(maxWidth: 320)
        // paperSurface (not softGlass): a dialog floats over a dark scrim, and
        // softGlass samples that scrim through its blur, muddying the card to
        // gray. The opaque paper surface stays as bright as the tab bar.
        .paperSurface(in: RoundedRectangle(cornerRadius: DesignTokens.Radius.glass, style: .continuous))
        .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.glass, style: .continuous))
        .padding(.horizontal, 40)
        // Absorb taps on the card so only the scrim behind dismisses.
        .contentShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.glass, style: .continuous))
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isModal)
        .accessibilityIdentifier("live.actionAlert")
    }
}

private struct LiveExportFile: Identifiable {
    let id = UUID()
    let shareURL: URL
    let previewURL: URL
    let title: String

    init(shareURL: URL, previewURL: URL? = nil, title: String) {
        self.shareURL = shareURL
        self.previewURL = previewURL ?? shareURL
        self.title = title
    }
}

/// The assistant/user message text. While an entry streams, it reads the live
/// in-flight text from `LiveStreamingText` keyed by entry id; otherwise it shows
/// the committed text. As its own view observing only `streaming.text`, a
/// per-token delta re-renders just this bubble — not the whole transcript. (#623)
private struct LiveStreamingBubbleText: View {
    let entryID: UUID
    let committed: String
    let isError: Bool
    let streaming: LiveStreamingText

    var body: some View {
        Text(streaming.text[entryID] ?? committed)
            .font(DesignTokens.Font.assistant)
            .foregroundStyle(isError ? .red : .primary)
            .textSelection(.enabled)
    }
}

/// Per-entry transcript visibility. Pure function so it's unit-testable (the
/// Safety Check #648 "warning hidden when system log is off" bug lived here).
enum LiveConversationVisibility {
    static func isVisible(
        entry: LiveConversationEntry,
        devMode: Bool,
        showSystem: Bool,
        showFrames: Bool,
        imageOnly: Bool
    ) -> Bool {
        // Camera keyframes are a model-input detail; kept out unless the debug toggle
        // is on (#415).
        if imageOnly, !showFrames { return false }
        // Safety Check (#648): hazard warnings are ALWAYS shown (red banner),
        // regardless of the Show-system-messages toggle / developer mode — they're the
        // whole point of Safety Check, not system chatter.
        if entry.eventType == "safety.warning" { return true }
        // Tool bubbles always shown; only system chatter respects the toggle.
        return entry.role != .system || (devMode && showSystem)
    }
}

enum LiveConversationRow: Identifiable, Equatable {
    case entry(LiveConversationEntry)
    case systemGroup(id: String, entries: [LiveConversationEntry])

    var id: String {
        switch self {
        case .entry(let entry):
            return entry.id.uuidString
        case .systemGroup(let id, _):
            return id
        }
    }

    /// Group consecutive system entries into a collapsible group, EXCEPT entries that
    /// must always stand alone: the boot-context line and Safety Check (#648) hazard
    /// warnings (which render as their own red bubble — never hidden in a group).
    /// Extracted as a pure function so the grouping is unit-testable.
    static func group(_ entries: [LiveConversationEntry]) -> [LiveConversationRow] {
        var rows: [LiveConversationRow] = []
        var systemRun: [LiveConversationEntry] = []

        func flushSystemRun() {
            guard let first = systemRun.first, let last = systemRun.last else { return }
            let id = "system-\(first.id.uuidString)-\(last.id.uuidString)-\(systemRun.count)"
            rows.append(.systemGroup(id: id, entries: systemRun))
            systemRun.removeAll()
        }

        for entry in entries {
            let standalone = entry.eventType == "hawky.boot_context.loaded"
                || entry.eventType == "safety.warning"
            if standalone {
                flushSystemRun()
                rows.append(.entry(entry))
            } else if entry.role == .system {
                systemRun.append(entry)
            } else {
                flushSystemRun()
                rows.append(.entry(entry))
            }
        }
        flushSystemRun()
        return rows
    }
}


struct LiveView: View {
    @Environment(AppContainer.self) private var container
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ObservedObject private var frontendTabs = FrontendTabStore.shared
    let store: LiveSessionStore
    let title: String
    let cameraInputMode: Bool
    let cameraAutostartEnabled: Bool
    let metaRuntimeEnabled: Bool
    @State private var testText = ""
    @State private var presentedSheet: LiveSheet?
    @State private var shouldAutoScroll = true
    /// SF Symbol for the agent's mini-avatar in the identity pill; user-chosen
    /// via the top-left agent sheet's icon picker.
    @AppStorage("agentCardSymbol") private var agentCardSymbol = "brain.head.profile"
    @AppStorage(AppTabConfiguration.storageKey) private var tabConfigurationRaw: String = ""
    @AppStorage(AppTabConfiguration.legacyTabOrderKey) private var legacyTabOrderRaw: String = ""
    @State private var expandedSystemGroups: Set<String> = []
    @State private var isTextComposerVisible = false
    /// Tracks the composer text field's focus so we can scroll the transcript to
    /// the bottom when the keyboard appears (the SwiftUI equivalent of
    /// `textViewDidBeginEditing → scrollToBottom`). (#417)
    @FocusState private var isComposerFocused: Bool
    /// True while the live-video PiP is expanded to fullscreen; the nav bar and
    /// toolbar hide so the video owns the whole screen. (#415)
    @State private var isVideoFullscreen = false
    /// FaceTime-style chrome visibility: tapping a non-interactive area of the
    /// stage toggles the floating controls, and they auto-hide after ~5s while
    /// a session is connected. Idle/failed states keep the chrome pinned so the
    /// start button never disappears.
    @State private var isChromeVisible = true
    @State private var chromeAutoHideTask: Task<Void, Never>?
    init(
        store: LiveSessionStore,
        defaultBrokerURL: URL? = nil,
        title: String = "Live",
        cameraInputMode: Bool = false,
        cameraAutostartEnabled: Bool = true,
        metaRuntimeEnabled: Bool = true
    ) {
        self.store = store
        self.title = title
        self.cameraInputMode = cameraInputMode
        self.cameraAutostartEnabled = cameraAutostartEnabled
        self.metaRuntimeEnabled = metaRuntimeEnabled
    }

    var body: some View {
        // FaceTime-style stage: the transcript fills the screen edge to edge and
        // all chrome (identity pill, function button, control stack) floats over
        // it. The old controls carousel pane is gone — diagnostics now live in
        // the More sheet.
        liveSessionPane
        // FaceTime-style floating camera preview over the transcript while a
        // Live visual stream is active. Replaces the old image-bubble feed. (#415)
        .overlay {
            LivePiPView(store: store, isFullscreen: $isVideoFullscreen)
        }
        // Haptics on the primary call actions (#577): a firm tap when the call
        // connects/ends, and a light selection tick when the user toggles mic or
        // camera. Intermediate phases (connecting/stopping) stay silent.
        .sensoryFeedback(trigger: store.phase) { _, newPhase in
            switch newPhase {
            case .connected: return .impact(weight: .medium)   // started / resumed
            case .idle: return .impact(weight: .light)          // ended
            case .paused: return .selection
            case .failed: return .error
            case .connecting, .stopping: return nil
            }
        }
        .sensoryFeedback(.selection, trigger: store.isStreamingAudio)
        .sensoryFeedback(.selection, trigger: store.isStreamingVisual)
        .tint(DesignTokens.accent)
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        // Compact (iPhone) hides the nav bar entirely — the floating agent pill
        // replaces the title and opens the actions sheet. iPad keeps its bar.
        .toolbar(
            isVideoFullscreen || horizontalSizeClass == .compact ? .hidden : .visible,
            for: .navigationBar
        )
        .toolbar(isVideoFullscreen ? .hidden : .visible, for: .tabBar)
        .statusBarHidden(isVideoFullscreen)
        .onAppear {
            if cameraInputMode && cameraAutostartEnabled {
                store.configureIPhoneCameraDefaults()
            }
            store.configureGatewayBridge(
                gatewayURL: container.gatewayURL,
                activeChatSessionKey: container.sessionStore.activeSessionKey
            )
            // Let the summarize_session tool run the same path as the Summary
            // button (LiveSessionSummarizer needs the gateway container).
            store.summarizeProvider = { [store, container] scope in
                let s = LiveSummaryScope(rawValue: scope) ?? .currentSession
                return try await LiveSessionSummarizer(container: container, store: store).summarize(scope: s)
            }
            applyPendingLiveRouteIfNeeded()
        }
        .onChange(of: container.sessionStore.activeSessionKey) { _, newValue in
            store.configureGatewayBridge(
                gatewayURL: container.gatewayURL,
                activeChatSessionKey: newValue
            )
        }
        .onChange(of: frontendTabs.liveRouteRequestID) { _, _ in
            applyPendingLiveRouteIfNeeded()
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                liveActionsMenu
            }
        }
        .sheet(item: $presentedSheet) { sheet in
            NavigationStack {
                switch sheet {
                case .actions:
                    LiveActionsListView(
                        store: store,
                        agentSymbol: $agentCardSymbol
                    ) { file in
                        presentedSheet = .export(file)
                    }
                        .navigationTitle("Live")
                        .navigationBarTitleDisplayMode(.inline)
                case .more:
                    LiveMoreSheet(
                        store: store,
                        onOpenSettings: {
                            // Swap More → Live Settings (dismiss then present so
                            // the sheet transition is clean).
                            presentedSheet = nil
                            DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
                                presentedSheet = .settings
                            }
                        },
                        onMockLocation: {
                            // Swap More → Mock Location (developer tool, #481).
                            presentedSheet = nil
                            DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
                                presentedSheet = .mockLocation
                            }
                        }
                    )
                    .navigationTitle("More")
                    .navigationBarTitleDisplayMode(.inline)
                    .presentationDetents([.medium])
                case .mockLocation:
                    LiveMockLocationSheet(store: store)
                        .navigationTitle("Mock Location")
                        .navigationBarTitleDisplayMode(.inline)
                case .settings:
                    LiveSessionSettingsSheet(store: store, defaultBrokerURL: container.gatewayURL)
                        .navigationTitle("Live Settings")
                        .navigationBarTitleDisplayMode(.inline)
                case .status:
                    LiveSessionStatusSheet(store: store)
                        .navigationTitle("Session Status")
                        .navigationBarTitleDisplayMode(.inline)
                case .glasses:
                    GlassesView(runtimeEnabled: metaRuntimeEnabled)
                case .recordings:
                    RecordingsHistoryView()
                case .sessions:
                    LiveSessionsSheet(store: store) { file in
                        presentedSheet = .export(file)
                    }
                        .navigationTitle("Live Sessions")
                        .navigationBarTitleDisplayMode(.inline)
                case .summary:
                    LiveSummarySheet(store: store, container: container)
                case .detail(let entry):
                    LiveConversationDetailSheet(entry: entry)
                        .navigationTitle(entry.toolCall == nil ? "Message Detail" : "Tool Call")
                        .navigationBarTitleDisplayMode(.inline)
                case .export(let file):
                    LiveExportSheet(file: file)
                        .navigationTitle("Export Session")
                        .navigationBarTitleDisplayMode(.inline)
                }
            }
            .presentationDetents([.medium, .large])
        }
        // Renders the store's general user-error channel (`pendingUserAlert`) as
        // a centered soft-glass card — the "press → message" feedback that
        // replaces silently-disabled buttons and silent guard-returns.
        .overlay {
            ZStack {
                if let alert = store.pendingUserAlert {
                    Rectangle()
                        .fill(.black.opacity(0.35))
                        .ignoresSafeArea()
                        .contentShape(Rectangle())
                        .onTapGesture { dismissActionAlert() }
                        .accessibilityHidden(true)
                        .transition(.opacity)
                    LiveActionAlertCard(
                        alert: alert,
                        onOpenSettings: {
                            dismissActionAlert()
                            presentedSheet = .settings
                        },
                        onDismiss: { dismissActionAlert() }
                    )
                    .transition(.scale(scale: 0.92).combined(with: .opacity))
                }
            }
            .animation(
                reduceMotion ? nil : .spring(response: 0.34, dampingFraction: 0.82),
                value: store.pendingUserAlert?.id
            )
        }
        .onDisappear {
            cancelChromeAutoHide()
            // Don't leave a modal notice scrim pending across a tab switch — it
            // would block the stage (and may be stale) on return. (#673 review)
            store.dismissUserAlert()
            Task { await store.handleViewDisappear() }
        }
    }

    private func applyPendingLiveRouteIfNeeded() {
        guard let route = frontendTabs.consumePendingLiveRoute() else { return }
        switch route {
        case .root:
            break
        case .more:
            presentedSheet = .more
        case .settings:
            presentedSheet = .settings
        case .status:
            presentedSheet = .status
        case .glasses:
            presentedSheet = .glasses
        case .recordings:
            presentedSheet = .recordings
        case .sessions:
            presentedSheet = .sessions
        case .summary:
            presentedSheet = .summary
        }
    }

    private var liveSessionPane: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ZStack(alignment: .bottomTrailing) {
                    ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        if visibleConversationRows.isEmpty {
                            emptySessionView
                        } else {
                            ForEach(visibleConversationRows) { row in
                                conversationRow(row)
                                    .id(row.id)
                            }
                        }
                        Color.clear
                            .frame(height: 1)
                            .id("live.bottom")
                            .onAppear { shouldAutoScroll = true }
                            .onDisappear { shouldAutoScroll = false }
                    }
                    .padding(.horizontal, 16)
                    // Resting clearance so the first/last message isn't tucked
                    // under the status bar (top) or floating tab bar (bottom).
                    // Fixed values (no self-measurement → no layout loop): the top
                    // scrim fades scrolling text above this; the bottom needs no
                    // scrim, just room to clear the floating tab bar. (#583)
                    .padding(.top, 64)
                    .padding(.bottom, 80)
                    }
                    if !shouldAutoScroll {
                        Button {
                            shouldAutoScroll = true
                            withAnimation(.easeOut(duration: 0.2)) {
                                proxy.scrollTo("live.bottom", anchor: .bottom)
                            }
                        } label: {
                            Label("Latest", systemImage: "arrow.down.circle.fill")
                                .labelStyle(.iconOnly)
                                .font(.title2)
                                .padding(10)
                                .softGlass(in: Circle())
                        }
                        .padding(14)
                        .accessibilityLabel("Jump to latest message")
                        .accessibilityIdentifier("live.jumpToLatest")
                    }
                }
                .onChange(of: store.conversation) { _, _ in
                    if shouldAutoScroll {
                        withAnimation(.easeOut(duration: 0.2)) {
                            proxy.scrollTo("live.bottom", anchor: .bottom)
                        }
                    }
                }
                // Follow streaming text: the array doesn't change while a bubble
                // streams, so onChange(of: conversation) can't drive scroll —
                // the throttled scrollTick does. (#623)
                .onChange(of: store.streamingText.scrollTick) { _, _ in
                    if shouldAutoScroll {
                        withAnimation(.easeOut(duration: 0.2)) {
                            proxy.scrollTo("live.bottom", anchor: .bottom)
                        }
                    }
                }
                // When the composer gains focus (keyboard rising), pin the last
                // message just above the input bar — like scrollToBottom() on
                // textViewDidBeginEditing. The composer already rides the
                // keyboard via safeAreaInset, so the content only needs to
                // catch up to the bottom. (#417)
                .onChange(of: isComposerFocused) { _, focused in
                    guard focused else { return }
                    shouldAutoScroll = true
                    withAnimation(.easeOut(duration: 0.25)) {
                        proxy.scrollTo("live.bottom", anchor: .bottom)
                    }
                }
                // Drag the transcript down to dismiss the keyboard. Tapping the
                // stage background dismisses the keyboard and toggles the
                // floating call chrome (FaceTime-style); buttons and links keep
                // their own hit-testing and are unaffected.
                .scrollDismissesKeyboard(.interactively)
                .contentShape(Rectangle())
                .onTapGesture { handleStageTap() }
            }
        }
        // The composer is pinned via safeAreaInset so it rides above the
        // keyboard automatically (like a UIKit inputAccessoryView) and the
        // transcript reserves space for it. (#417)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            sessionComposer
        }
        .background(DesignTokens.background.ignoresSafeArea())
        // Top scrim: opaque across the status-bar / Dynamic Island zone, then a
        // short fade, so scrolling text is hidden behind the clock/battery instead
        // of overlapping it. Colour follows the stage backing; a FIXED height needs no
        // measurement, avoiding the GeometryReader→layout feedback loop that
        // heated the device (a `.mask` here was even worse). NOT glass: content
        // layer, iOS 17, GPU-cheap, Reduce-Transparency-safe. (#583)
        .overlay(alignment: .top) {
            LinearGradient(
                stops: [
                    .init(color: DesignTokens.background, location: 0),
                    .init(color: DesignTokens.background, location: 0.66),
                    .init(color: DesignTokens.background.opacity(0), location: 1)
                ],
                startPoint: .top, endPoint: .bottom
            )
            .frame(height: 90)
            .ignoresSafeArea(.container, edges: .top)
            .allowsHitTesting(false)
        }
        // No bottom scrim: the floating tab bar is already glass and content
        // scrolling faintly under it is the intended iOS 26 look; bottom clearance
        // is handled by content padding instead. (#583)
        // Floating FaceTime-style chrome over the full-bleed stage. Hidden
        // chrome fades out with a small slide and stops intercepting taps; any
        // chrome interaction restarts the auto-hide timer.
        .overlay(alignment: .top) {
            stageTopChrome
                .padding(.horizontal, DesignTokens.Spacing.page)
                .padding(.top, 8)
                .opacity(isChromeVisible ? 1 : 0)
                .offset(y: isChromeVisible ? 0 : -12)
                .allowsHitTesting(isChromeVisible)
                .simultaneousGesture(TapGesture().onEnded { scheduleChromeAutoHide() })
        }
        // Bottom chrome must NOT ride the keyboard. The one-shot keyboard prewarm
        // (ContentView) briefly raises+drops the keyboard ~0.4s after launch; with
        // a plain `.overlay(alignment: .bottom*)` that keyboard safe-area change
        // shoved these controls up ~235pt and back, reading as a two-stage entrance
        // pop (#600). `.ignoresSafeArea(.keyboard)` on the leaf alone doesn't help —
        // the overlay aligns to the parent frame, which has already shrunk. So the
        // alignment is done by a full-bleed `.frame(maxHeight: .infinity)` and the
        // ignore is applied to THAT, pinning the controls to the true screen bottom.
        .overlay {
            flipCameraControl
                .padding(.leading, DesignTokens.Spacing.page)
                .padding(.bottom, 12)
                .opacity(isChromeVisible ? 1 : 0)
                .offset(y: isChromeVisible ? 0 : 12)
                .allowsHitTesting(isChromeVisible)
                .simultaneousGesture(TapGesture().onEnded { scheduleChromeAutoHide() })
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
                .ignoresSafeArea(.keyboard, edges: .bottom)
        }
        .overlay {
            liveControlStack
                .padding(.trailing, DesignTokens.Spacing.page)
                .padding(.bottom, 12)
                .opacity(isChromeVisible ? 1 : 0)
                .offset(y: isChromeVisible ? 0 : 12)
                .allowsHitTesting(isChromeVisible)
                .simultaneousGesture(TapGesture().onEnded { scheduleChromeAutoHide() })
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
                .ignoresSafeArea(.keyboard, edges: .bottom)
        }
        // Chrome auto-hide lifecycle: only ticks while connected with the
        // composer hidden; idle/failed phases pin the chrome visible.
        .onChange(of: store.phase) { _, newPhase in
            if newPhase == .connected {
                scheduleChromeAutoHide()
            } else {
                setChromeVisible(true)
            }
        }
        .onChange(of: isTextComposerVisible) { _, _ in refreshChromeForComposer() }
        .onChange(of: isComposerFocused) { _, _ in refreshChromeForComposer() }
    }

    /// Top chrome: agent identity pill (left) and the More (•••) button (right)
    /// that opens the flat action list.
    private var stageTopChrome: some View {
        HStack(alignment: .center) {
            AgentIdentityPill(name: "Hawky", symbol: agentCardSymbol) {
                presentedSheet = .actions
            }
            .accessibilityLabel("Hawky session details")
            .accessibilityIdentifier("live.agentPill")
            Spacer()
            GlassCircleButton(
                icon: "ellipsis",
                size: DesignTokens.LiveControl.functionSize,
                iconSize: 17
            ) {
                presentedSheet = .more
            }
            .accessibilityLabel("More controls")
            .accessibilityIdentifier("live.more")
        }
    }

    /// Bottom-left flip-camera control, shown only while the iPhone camera is
    /// the active visual source (Ray-Ban has a single fixed feed).
    @ViewBuilder
    private var flipCameraControl: some View {
        if store.isStreamingVisual, store.visualCapture != nil {
            GlassCircleButton(icon: "arrow.triangle.2.circlepath.camera") {
                Task { await store.toggleCameraPosition() }
            }
            .accessibilityLabel("Flip camera")
            .accessibilityIdentifier("live.flipCamera")
        }
    }

    private func dismissKeyboard() {
        UIApplication.shared.sendAction(
            #selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil
        )
    }

    private var liveActionsMenu: some View {
        Button {
            presentedSheet = .actions
        } label: {
            Image(systemName: liveActionIcon)
        }
        .foregroundStyle(liveActionTint)
        .accessibilityLabel("Live actions")
        .accessibilityIdentifier("live.actions")
    }

    private var liveActionIcon: String {
        switch store.phase {
        case .connected: return "waveform.circle.fill"
        case .paused: return "pause.circle.fill"
        case .connecting, .stopping: return "waveform.circle"
        case .failed: return "exclamationmark.circle.fill"
        case .idle: return "ellipsis.circle"
        }
    }

    private var liveActionTint: Color {
        switch store.phase {
        case .connected: return DesignTokens.accent
        case .paused: return .orange
        case .failed: return .red
        case .connecting, .stopping: return .orange
        case .idle: return .primary
        }
    }

    private var emptySessionView: some View {
        VStack(spacing: 10) {
            Image(systemName: "waveform.circle")
                .font(.system(size: 48))
                .foregroundStyle(DesignTokens.accent)
            Text("Talk to Hawky")
                .font(DesignTokens.Font.liveHeroTitle)
                .accessibilityIdentifier("live.emptyStateTitle")
            Text("Start a live session when you are ready. Hawky will listen, see, and keep context while you talk.")
                .font(DesignTokens.Font.panelBody)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 12)
        }
        .frame(maxWidth: .infinity, minHeight: 280)
        .accessibilityIdentifier("live.emptyState")
    }

    @ViewBuilder
    private var sessionComposer: some View {
        if shouldShowSessionComposer {
            VStack(spacing: 8) {
                bridgeOfflineBanner
                failureBanner
                if shouldShowTextComposer {
                    HStack(alignment: .bottom, spacing: 12) {
                        composerPill
                            .transition(.move(edge: .bottom).combined(with: .opacity))
                        Spacer(minLength: 64)
                    }
                }
            }
            .padding(.horizontal, DesignTokens.Spacing.page)
            .padding(.vertical, 8)
        }
    }

    private var shouldShowSessionComposer: Bool {
        if case .failed = store.phase {
            return true
        }
        // Keep the composer slot mounted so the bridge-offline banner stays visible
        // through an otherwise voice-only connected session.
        if store.bridgeStatus.isOffline {
            return true
        }
        return shouldShowTextComposer
    }

    /// Prominent banner for a connected session whose Hawky gateway (your machine)
    /// is unreachable — the memory + tools leg is dead even though OpenAI Realtime
    /// connected. Suppressed when the phase already failed (failureBanner covers it).
    @ViewBuilder
    private var bridgeOfflineBanner: some View {
        if case .offline(let detail) = store.bridgeStatus, !isFailedPhase {
            HStack(alignment: .center, spacing: 8) {
                Image(systemName: "antenna.radiowaves.left.and.right.slash")
                    .foregroundStyle(DesignTokens.Status.warning)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Your Hawky machine is offline")
                        .errorCaption()
                    Text("Connected to OpenAI, but memory + tools are off until it's back.")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                Spacer(minLength: 8)
                Button {
                    presentedSheet = .status
                } label: {
                    Image(systemName: "doc.text.magnifyingglass")
                }
                .subtlePressAction()
                .accessibilityLabel("Open Live bridge diagnostics")
                .accessibilityIdentifier("live.bridgeOffline.status")
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background(DesignTokens.Status.warning.opacity(0.12), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .accessibilityIdentifier("live.bridgeOfflineBanner")
            .accessibilityValue(detail)
        }
    }

    private var isFailedPhase: Bool {
        if case .failed = store.phase { return true }
        return false
    }

    @ViewBuilder
    private var failureBanner: some View {
        if case .failed(let message) = store.phase {
            HStack(alignment: .center, spacing: 8) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(DesignTokens.Status.error)
                Text(message)
                    .errorCaption()
                    .lineLimit(2)
                Spacer(minLength: 8)
                Button {
                    presentedSheet = .status
                } label: {
                    Image(systemName: "doc.text.magnifyingglass")
                }
                .subtlePressAction()
                .accessibilityLabel("Open Live failure diagnostics")
                .accessibilityIdentifier("live.failure.status")
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background(DesignTokens.Status.error.opacity(0.12), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .accessibilityIdentifier("live.failureBanner")
        }
    }

    @ViewBuilder
    private var composerPill: some View {
        HStack(alignment: .bottom, spacing: 8) {
            idleTextInput
            sendTextButton
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .softGlass(in: RoundedRectangle(cornerRadius: DesignTokens.Radius.bubble, style: .continuous))
        .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.bubble, style: .continuous))
        .accessibilityElement(children: .contain)
    }

    private var shouldShowTextComposer: Bool {
        isTextComposerVisible || !testText.isEmpty || isComposerFocused
    }

    /// The send button stays enabled whenever there's text to send — even when
    /// not connected — so a tap can explain "start a session first" instead of
    /// being silently disabled. Emptiness is the only hard disable.
    private var hasComposerText: Bool {
        !testText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var idleTextInput: some View {
        Group {
            // Multi-line composer: Return inserts a newline (submitLabel .return);
            // sending happens only via the send button. (#417)
            TextField("Message Hawky...", text: $testText, axis: .vertical)
                .textInputAutocapitalization(.sentences)
                .submitLabel(.return)
                .textFieldStyle(.plain)
                .lineLimit(1...6)
                .focused($isComposerFocused)
                .accessibilityIdentifier("live.testText")
        }
    }

    private var sendTextButton: some View {
        Group {
            if shouldShowTextComposer {
                Button {
                    sendTestText()
                } label: {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.callout.weight(.semibold))
                        .foregroundStyle(hasComposerText ? DesignTokens.accent : Color(.tertiaryLabel))
                        .frame(width: 26, height: 26)
                        .minimumHitTarget()
                }
                .disabled(!hasComposerText)
                .accessibilityLabel("Send message")
                .accessibilityIdentifier("live.sendText")
            }
        }
    }

    /// FaceTime-style vertical control stack at the bottom-trailing corner:
    /// camera, mic, then the start/stop circle. (••• lives top-right now.)
    @ViewBuilder
    private var liveControlStack: some View {
        VStack(spacing: DesignTokens.LiveControl.stackSpacing) {
            if cameraInputMode {
                visualInputControl
            }
            audioInputControl
            keyboardControl
            if store.phase == .connected {
                staySilentControl
            }
            if store.phase == .connected && cameraInputMode {
                cocktailPartyControl
            }
            sessionActionControl
        }
        .accessibilityElement(children: .contain)
    }

    /// Stay Silent toggle: the model keeps listening + transcribing but stops
    /// responding while on; on release it gives one spoken recap of the window.
    private var staySilentControl: some View {
        let silent = store.staySilentActive
        return GlassCircleButton(
            icon: silent ? "ear.fill" : "ear",
            style: silent ? .solidWhite(iconTint: DesignTokens.LiveControl.confirmOnWhite) : .glass
        ) {
            Task { await store.toggleStaySilentIntent() }
        }
        .accessibilityLabel(silent ? "End Stay Silent and summarize" : "Stay Silent — keep listening without responding")
        .accessibilityIdentifier("live.toggleStaySilent")
    }

    /// Cocktail Party toggle: when on, the model watches the camera, recognizes
    /// people, and proactively recalls who they are / enrolls new faces.
    private var cocktailPartyControl: some View {
        let active = store.cocktailPartyActive
        return GlassCircleButton(
            icon: active ? "person.2.fill" : "person.2",
            style: active ? .solidWhite(iconTint: DesignTokens.LiveControl.confirmOnWhite) : .glass
        ) {
            Task { await store.toggleCocktailPartyIntent() }
        }
        .accessibilityLabel(active ? "Turn off Cocktail Party Mode" : "Cocktail Party Mode — recognize people on camera")
        .accessibilityIdentifier("live.toggleCocktailParty")
    }

    @ViewBuilder
    private var sessionActionControl: some View {
        switch store.phase {
        case .connecting, .stopping:
            GlassCircleButton(
                icon: "xmark",
                size: DesignTokens.LiveControl.endControlSize,
                style: .destructive,
                isBusy: true
            ) {}
            .accessibilityIdentifier("live.progress")
        case .connected:
            GlassCircleButton(
                icon: "phone.down.fill",
                size: DesignTokens.LiveControl.endControlSize,
                style: .destructive,
                role: .destructive
            ) {
                Task { await store.stop() }
            }
            .accessibilityLabel("Stop live session")
            .accessibilityIdentifier("live.stop")
        case .paused:
            GlassCircleButton(
                icon: "play.fill",
                size: DesignTokens.LiveControl.endControlSize,
                style: .confirm
            ) {
                Task { await store.resume() }
            }
            .accessibilityLabel("Resume live session")
            .accessibilityIdentifier("live.resume")
        case .idle, .failed:
            // Stays tappable even when blocked: a tap with an unmet precondition
            // (no API key, provider not wired) pops an explanatory alert instead
            // of doing nothing.
            GlassCircleButton(
                icon: "phone.fill",
                size: DesignTokens.LiveControl.endControlSize,
                style: .confirm
            ) {
                // start() is the single entry: it preflights `startBlockReason`
                // and raises the alert itself, so the button just calls it.
                Task { await store.start(recordingTransport: container.transport) }
            }
            .accessibilityLabel("Start live session")
            .accessibilityIdentifier("live.start")
        }
    }

    private var audioInputControl: some View {
        let audioEnabled = store.phase == .connected ? store.isStreamingAudio : store.config.audioInputEnabled
        return GlassCircleButton(
            icon: audioEnabled ? "mic.fill" : "mic.slash.fill",
            style: audioEnabled ? .solidWhite(iconTint: DesignTokens.LiveControl.micOnWhite) : .glass
        ) {
            Task { await store.toggleAudioInputIntent() }
        }
        .overlay(alignment: .topTrailing) {
            if store.phase == .connected && store.isStreamingAudio {
                SpeakingIndicator()
                    .scaleEffect(0.56)
                    .offset(x: 4, y: -4)
                    .accessibilityHidden(true)
            }
        }
        .accessibilityLabel(audioEnabled ? "Turn microphone off" : "Turn microphone on")
        .accessibilityIdentifier("live.toggleAudio")
    }

    private var visualInputControl: some View {
        let visualEnabled = store.phase == .connected ? store.isStreamingVisual : store.config.visualSource != .off
        return GlassCircleButton(
            icon: visualEnabled ? "video.fill" : "video.slash.fill",
            style: visualEnabled ? .solidWhite(iconTint: DesignTokens.LiveControl.confirmOnWhite) : .glass
        ) {
            Task { await store.toggleVisualInputIntent() }
        }
        .accessibilityLabel(visualEnabled ? "Turn camera off" : "Turn camera on")
        .accessibilityIdentifier("live.toggleVisual")
    }

    private var keyboardControl: some View {
        let keyboardVisible = isComposerFocused
        return GlassCircleButton(
            icon: keyboardVisible ? "keyboard.chevron.compact.down" : "keyboard",
            style: keyboardVisible ? .solidWhite(iconTint: DesignTokens.LiveControl.confirmOnWhite) : .glass
        ) {
            toggleKeyboard()
        }
        .accessibilityLabel(keyboardVisible ? "Hide keyboard" : "Show keyboard")
        .accessibilityIdentifier("live.toggleKeyboard")
    }

    // MARK: Chrome visibility (FaceTime tap-to-hide)

    /// Tap on the stage background: dismiss the keyboard, and toggle the
    /// floating chrome. While the composer is up — or no session is running —
    /// the chrome is pinned visible instead of toggling away.
    private func handleStageTap() {
        dismissKeyboard()
        if shouldShowTextComposer || store.phase != .connected {
            setChromeVisible(true)
            return
        }
        setChromeVisible(!isChromeVisible)
    }

    private func setChromeVisible(_ visible: Bool) {
        withAnimation(.easeInOut(duration: 0.25)) {
            isChromeVisible = visible
        }
        if visible {
            scheduleChromeAutoHide()
        } else {
            cancelChromeAutoHide()
        }
    }

    /// (Re)starts the ~5s auto-hide countdown. Only runs while a session is
    /// connected and the composer is hidden; otherwise any pending hide is
    /// cancelled so the chrome stays put.
    private func scheduleChromeAutoHide() {
        cancelChromeAutoHide()
        guard store.phase == .connected, !shouldShowTextComposer else { return }
        chromeAutoHideTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 5_000_000_000)
            guard !Task.isCancelled else { return }
            withAnimation(.easeInOut(duration: 0.25)) {
                isChromeVisible = false
            }
        }
    }

    private func cancelChromeAutoHide() {
        chromeAutoHideTask?.cancel()
        chromeAutoHideTask = nil
    }

    /// Showing the composer forces the chrome visible and suspends auto-hide;
    /// dismissing it re-arms the countdown.
    private func refreshChromeForComposer() {
        if shouldShowTextComposer {
            cancelChromeAutoHide()
            withAnimation(.easeInOut(duration: 0.25)) {
                isChromeVisible = true
            }
        } else {
            scheduleChromeAutoHide()
        }
    }

    private func toggleKeyboard() {
        if isComposerFocused {
            isComposerFocused = false
            dismissKeyboard()
            if !hasComposerText {
                withAnimation(.snappy) {
                    isTextComposerVisible = false
                }
            }
        } else {
            withAnimation(.snappy) {
                isTextComposerVisible = true
            }
            isComposerFocused = true
        }
    }

    @ViewBuilder
    private func conversationRow(_ row: LiveConversationRow) -> some View {
        switch row {
        case .entry(let entry):
            conversationEntryRow(entry)
        case .systemGroup(let id, let entries):
            systemGroupRow(id: id, entries: entries)
        }
    }


    @ViewBuilder
    private func conversationEntryRow(_ entry: LiveConversationEntry) -> some View {
        switch entry.role {
        case .system:
            systemEntryRow(entry)
        case .tool:
            toolRow(entry)
        case .user, .assistant:
            let isUser = entry.role == .user
            if isUser {
                HStack {
                    Spacer(minLength: 48)
                    messageContent(entry)
                        .padding(.horizontal, imageOnly(entry) ? 8 : 12)
                        .padding(.vertical, 9)
                        .background(bubbleBackground(for: entry, isUser: true))
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                }
                .accessibilityIdentifier("live.conversation.\(entry.id.uuidString)")
            } else {
                HStack(alignment: .top) {
                    messageContent(entry)
                        .padding(.horizontal, 2)
                        .padding(.vertical, 4)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityIdentifier("live.conversation.\(entry.id.uuidString)")
            }
        }
    }

    private func messageContent(_ entry: LiveConversationEntry) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            if let image = entry.uiImage {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth: 220, maxHeight: 164)
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .accessibilityLabel("Camera frame")
            }
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                // Reads the in-flight streaming text for this entry (#623): only
                // this bubble re-renders per token, not the whole transcript.
                LiveStreamingBubbleText(
                    entryID: entry.id,
                    committed: entry.text,
                    isError: entry.level == .error,
                    streaming: store.streamingText
                )
            }
            MessageTimestampText(date: entry.date)
        }
    }

    @ViewBuilder
    private func systemEntryRow(_ entry: LiveConversationEntry) -> some View {
        if entry.eventType == "safety.warning" {
            // Safety Check (#648): a hazard warning is rendered as a bold, full-width RED
            // BANNER (white text on solid red) so it's impossible to miss and unmistakably
            // distinct from the normal conversation. Its own dedicated view so no shared
            // system styling can wash out the color.
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(DesignTokens.Font.rowDetail.weight(.bold))
                Text(entry.text)
                    .font(DesignTokens.Font.rowDetail.weight(.bold))
                    .textSelection(.enabled)
                Spacer(minLength: 0)
            }
            .foregroundStyle(.white)
            .padding(.vertical, 8)
            .padding(.horizontal, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.red, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .padding(.vertical, 2)
            .accessibilityIdentifier("live.conversation.safety.\(entry.id.uuidString)")
        } else if entry.eventType == "hawky.boot_context.loaded" {
            NavigationLink {
                LiveLoadedMemoryPage(text: entry.detail ?? entry.text)
            } label: {
                systemEntryContent(entry, showsChevron: true)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("live.conversation.system.\(entry.id.uuidString)")
        } else {
            systemEntryContent(entry, showsChevron: false)
                .accessibilityIdentifier("live.conversation.system.\(entry.id.uuidString)")
        }
    }

    private func systemEntryContent(_ entry: LiveConversationEntry, showsChevron: Bool) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: systemIcon(for: entry))
                .font(DesignTokens.Font.metaStrong)
                .foregroundStyle(systemColor(for: entry))
                .padding(.top, 1)
            Text(entry.text)
                .font(DesignTokens.Font.rowDetail)
                .foregroundStyle(systemColor(for: entry))
                .textSelection(.enabled)
            Spacer(minLength: 0)
            if showsChevron {
                Image(systemName: "chevron.right")
                    .font(DesignTokens.Font.meta)
                    .foregroundStyle(.tertiary)
                    .padding(.top, 2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 3)
    }

    private func systemIcon(for entry: LiveConversationEntry) -> String {
        if entry.eventType == "safety.warning" {
            return "exclamationmark.triangle.fill"
        }
        if entry.eventType == "hawky.boot_context.loaded" {
            return "brain.head.profile"
        }
        return entry.level == .error ? "exclamationmark.triangle.fill" : "info.circle"
    }

    @ViewBuilder
    private func systemGroupRow(id: String, entries: [LiveConversationEntry]) -> some View {
        let isExpanded = expandedSystemGroups.contains(id)
        VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation(.smooth(duration: 0.18)) {
                    if isExpanded {
                        expandedSystemGroups.remove(id)
                    } else {
                        expandedSystemGroups.insert(id)
                    }
                }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                        .font(DesignTokens.Font.metaStrong)
                    Image(systemName: "info.circle")
                        .font(.footnote)
                    Text("Intermediate messages \(entries.count)")
                        .font(DesignTokens.Font.rowDetail.weight(.medium))
                    Spacer(minLength: 0)
                }
                .foregroundStyle(systemGroupColor(for: entries))
                .padding(.horizontal, 10)
                .padding(.vertical, 7)
                .paperSurface(in: RoundedRectangle(cornerRadius: 10, style: .continuous), inset: true)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("live.conversation.systemGroup.\(id)")

            if isExpanded {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(entries) { entry in
                        systemEntryRow(entry)
                    }
                }
                .padding(.leading, 10)
                .transition(.opacity.combined(with: .scale(scale: 0.98, anchor: .top)))
            }
        }
        .animation(.smooth(duration: 0.18), value: isExpanded)
    }

    @ViewBuilder
    private func toolRow(_ entry: LiveConversationEntry) -> some View {
        let info = entry.toolCall
        HStack(spacing: 8) {
            Image(systemName: toolIcon(for: info))
                .font(DesignTokens.Font.metaStrong)
                .foregroundStyle(toolColor(for: info))
            VStack(alignment: .leading, spacing: 1) {
                Text(entry.text)
                    .font(DesignTokens.Font.rowDetail.weight(.medium))
                    .foregroundStyle(.primary)
                if let info, info.status == .started {
                    Text("running…")
                        .font(DesignTokens.Font.meta)
                        .foregroundStyle(.secondary)
                } else if let duration = toolDurationLabel(for: info) {
                    Text(duration)
                        .font(DesignTokens.Font.meta)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 0)
            if info?.status == .started {
                ProgressView().scaleEffect(0.6)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(toolColor(for: info).opacity(0.10), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(toolColor(for: info).opacity(0.30), lineWidth: 1)
        )
        .accessibilityIdentifier("live.conversation.tool.\(entry.id.uuidString)")
        .onTapGesture { presentedSheet = .detail(entry) }
    }

    private func toolDurationLabel(for info: LiveToolCallInfo?) -> String? {
        guard let startedAt = info?.startedAt, let completedAt = info?.completedAt else { return nil }
        return "returned in \(durationLabel(from: startedAt, to: completedAt))"
    }

    private func durationLabel(from start: Date, to end: Date) -> String {
        let milliseconds = max(0, Int(end.timeIntervalSince(start) * 1000))
        if milliseconds < 1_000 {
            return "\(milliseconds) ms"
        }
        return String(format: "%.1f s", Double(milliseconds) / 1_000)
    }

    private func toolIcon(for info: LiveToolCallInfo?) -> String {
        guard let info else { return "wrench.and.screwdriver" }
        switch info.status {
        case .started: return "wrench.and.screwdriver.fill"
        case .ok: return "checkmark.seal.fill"
        case .error: return "exclamationmark.triangle.fill"
        }
    }

    private func toolColor(for info: LiveToolCallInfo?) -> Color {
        guard let info else { return .purple }
        switch info.status {
        case .started: return .purple
        case .ok: return .green
        case .error: return .red
        }
    }

    private func imageOnly(_ entry: LiveConversationEntry) -> Bool {
        entry.imageData != nil && entry.text.hasPrefix("Camera frame")
    }

    private func systemColor(for level: LiveEventLogEntry.Level) -> Color {
        switch level {
        case .info: return .secondary
        case .warning: return .orange.opacity(0.85)
        case .error: return .red
        }
    }

    private func systemColor(for entry: LiveConversationEntry) -> Color {
        if entry.eventType == "safety.warning" {
            return .red
        }
        if entry.eventType == "hawky.boot_context.loaded" {
            return DesignTokens.accent
        }
        return systemColor(for: entry.level)
    }

    private func systemGroupColor(for entries: [LiveConversationEntry]) -> Color {
        if entries.contains(where: { $0.level == .error }) { return .red }
        if entries.contains(where: { $0.level == .warning }) { return .orange.opacity(0.85) }
        return .secondary
    }

    /// Bubble tint. User stays accent-tinted; assistant final answers use the
    /// neutral grouped background, while commentary (think-aloud) gets a
    /// distinct subtle tint so it reads as separate from the final answer.
    private func bubbleBackground(for entry: LiveConversationEntry, isUser: Bool) -> Color {
        if isUser { return DesignTokens.userBubbleTint }
        if entry.phase == "commentary" { return Color.orange.opacity(0.12) }
        return DesignTokens.Surface.paperInset
    }

    private var visibleConversationEntries: [LiveConversationEntry] {
        // Read ONCE, outside the filter. `developerModeEnabled` decodes JSON
        // (AppTabConfiguration.load); evaluating it per system entry profiled as
        // the top main-thread hot path on long sessions once the bigger journal
        // decode was fixed. The config flags are hoisted for the same reason. (#580)
        let devMode = developerModeEnabled
        let showFrames = store.config.showVisualFramesInTranscript
        let showSystem = store.config.showSystemMessages
        return store.conversation.filter { entry in
            LiveConversationVisibility.isVisible(
                entry: entry,
                devMode: devMode,
                showSystem: showSystem,
                showFrames: showFrames,
                imageOnly: imageOnly(entry)
            )
        }
    }

    private var developerModeEnabled: Bool {
        AppTabConfiguration.load(
            encoded: tabConfigurationRaw,
            legacyRaw: legacyTabOrderRaw
        ).developerModeEnabled
    }

    private var visibleConversationRows: [LiveConversationRow] {
        LiveConversationRow.group(visibleConversationEntries)
    }

    private func byteLabel(_ bytes: Int) -> String {
        if bytes < 1024 {
            return "\(bytes) B"
        }
        return String(format: "%.1f KB", Double(bytes) / 1024.0)
    }

    private func dismissActionAlert() {
        withAnimation(reduceMotion ? nil : .spring(response: 0.3, dampingFraction: 0.86)) {
            store.dismissUserAlert()
        }
    }

    private func sendTestText() {
        let message = testText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !message.isEmpty else { return }
        // Sending needs a connected session. Pop the reason (and keep the typed
        // text) rather than letting the tap no-op.
        guard store.phase == .connected else {
            store.presentUserAlert(.notConnected)
            return
        }
        testText = ""
        Task { await store.sendTestText(message) }
    }

}

/// The "•••" sheet on the Live stage: quick transcript/composer actions only.
private struct LiveMoreSheet: View {
    @Environment(\.dismiss) private var dismiss
    let store: LiveSessionStore
    let onOpenSettings: () -> Void
    let onMockLocation: () -> Void

    @AppStorage(AppTabConfiguration.storageKey) private var tabConfigurationRaw: String = ""
    @AppStorage(AppTabConfiguration.legacyTabOrderKey) private var legacyTabOrderRaw: String = ""

    private var developerModeEnabled: Bool {
        AppTabConfiguration.load(
            encoded: tabConfigurationRaw,
            legacyRaw: legacyTabOrderRaw
        ).developerModeEnabled
    }

    var body: some View {
        List {
            Section {
                Button {
                    onOpenSettings()
                } label: {
                    LiveMoreRow(
                        title: "Live Settings",
                        systemImage: "gearshape",
                        assetName: "LiveMoreIconSettings"
                    )
                }
                .rowPressAction()
                .accessibilityIdentifier("live.moreSheet.settings")
            }

            Section {
                // Cocktail Party Mode (#627): browse the people the model has learned.
                NavigationLink {
                    LivePeopleDatabaseView(store: store)
                } label: {
                    LiveMoreRow(
                        title: "People Database",
                        systemImage: "person.2.crop.square.stack",
                        assetName: "LiveMoreIconPeople"
                    )
                }
                .accessibilityIdentifier("live.moreSheet.peopleDatabase")
            }

            if developerModeEnabled {
                Section("Developer") {
                    Button {
                        onMockLocation()
                    } label: {
                        LiveMoreRow(
                            title: "Mock location",
                            systemImage: "location.viewfinder",
                            assetName: "LiveMoreIconMockLocation"
                        )
                    }
                    .rowPressAction()
                    .accessibilityIdentifier("live.moreSheet.mockLocation")

                    // Memory feature (#653): inspect the four-tier memory system
                    // and manually trigger distillation/consolidation.
                    NavigationLink {
                        LiveMemoryTestingView(store: store)
                    } label: {
                        LiveMoreRow(
                            title: "Memory",
                            systemImage: "brain.head.profile",
                            assetName: "LiveMoreIconMemory"
                        )
                    }
                    .accessibilityIdentifier("live.moreSheet.memory")
                }
            }
        }
        .listStyle(.insetGrouped)
        .tint(DesignTokens.panelAccentInk)
        .foregroundStyle(.primary)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button {
                    dismiss()
                } label: {
                    Text("Done")
                        .font(DesignTokens.Font.rowTitle)
                        .foregroundStyle(DesignTokens.panelAccentInk)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("live.moreSheet.done")
            }
        }
    }
}

private struct LiveMoreRow: View {
    let title: String
    let systemImage: String
    let assetName: String?

    var body: some View {
        HStack(spacing: 12) {
            GeneratedIconTile(
                systemImage: systemImage,
                color: DesignTokens.accent,
                assetName: assetName,
                size: DesignTokens.IconTile.actionRow
            )
            Text(title)
                .font(DesignTokens.Font.rowTitle)
                .foregroundStyle(.primary)
            Spacer(minLength: 0)
        }
        .padding(.vertical, 4)
        .frame(minHeight: 50)
        .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

/// Developer-mode tool (#481): simulate device location on a real device so a
/// tester can verify that where reminders fire without physically traveling.
/// Two paths: (1) tap an armed region to simulate arriving there — runs the real
/// region-entry flow (local notification + gateway `region.entered` → intention
/// fires); (2) feed a raw lat/lon as a significant-location-change to exercise
/// the nearest-≤20 reprojection.
private struct LiveMockLocationSheet: View {
    @Environment(\.dismiss) private var dismiss
    let store: LiveSessionStore

    @State private var latitude: String = ""
    @State private var longitude: String = ""

    private var regions: [AmbientRegion] { store.mockableRegions }

    var body: some View {
        List {
            Section {
                if regions.isEmpty {
                    Text("No active where reminders. Create one (e.g. “remind me to buy milk when I get to Trader Joe’s”) and wait for it to arm, then it'll appear here.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(regions) { region in
                        Button {
                            store.devSimulateArrival(intentionId: region.id)
                            dismiss()
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(region.label)
                                    Text(region.isHard ? "hard · posts notification" : "soft")
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                Image(systemName: "figure.walk.arrival")
                                    .foregroundStyle(DesignTokens.accent)
                            }
                        }
                        .accessibilityIdentifier("live.mockLocation.arrive.\(region.id)")
                    }
                }
            } header: {
                Text("Simulate arrival")
            } footer: {
                Text("Runs the real region-entry path: fires the reminder via the gateway and posts a local notification for hard reminders.")
            }

            Section {
                TextField("Latitude", text: $latitude)
                    .keyboardType(.numbersAndPunctuation)
                    .accessibilityIdentifier("live.mockLocation.lat")
                TextField("Longitude", text: $longitude)
                    .keyboardType(.numbersAndPunctuation)
                    .accessibilityIdentifier("live.mockLocation.lon")
                Button {
                    guard let lat = Double(latitude.trimmingCharacters(in: .whitespaces)),
                          let lon = Double(longitude.trimmingCharacters(in: .whitespaces)) else { return }
                    store.devSimulateLocation(latitude: lat, longitude: lon)
                    dismiss()
                } label: {
                    Label("Feed location", systemImage: "location.fill")
                }
                .disabled(Double(latitude.trimmingCharacters(in: .whitespaces)) == nil
                          || Double(longitude.trimmingCharacters(in: .whitespaces)) == nil)
                .accessibilityIdentifier("live.mockLocation.feed")
            } header: {
                Text("Feed coordinate")
            } footer: {
                Text("Sends a significant-location-change so the nearest ≤20 regions reproject around this point.")
            }
        }
        .listStyle(.insetGrouped)
        .tint(DesignTokens.accent)
        .foregroundStyle(.primary)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Done") { dismiss() }
            }
        }
    }
}

/// The top-left agent entry point: session actions, the local Live history,
/// agent icon selection, and a compact status readout.
private struct LiveActionsListView: View {
    @Environment(\.dismiss) private var dismiss
    let store: LiveSessionStore
    @Binding var agentSymbol: String
    let onExport: (LiveExportFile) -> Void

    var body: some View {
        List {
            Section(
                header: Text("Sessions"),
                footer: Group {
                    if store.phase.isActive {
                        Text("Stop Live before creating or switching sessions.")
                    }
                }
            ) {
                Button {
                    store.startNewSession()
                    dismiss()
                } label: {
                    LiveActionRow(
                        title: "New Session",
                        subtitle: "Start a fresh Live context",
                        systemImage: "plus.circle"
                    )
                }
                .rowPressAction()
                .disabled(store.phase.isActive)
                .accessibilityIdentifier("live.actions.newSession")

                NavigationLink {
                    LiveSessionsSheet(store: store, onExport: onExport)
                        .navigationTitle("Live Sessions")
                        .navigationBarTitleDisplayMode(.inline)
                } label: {
                    LiveActionRow(
                        title: "History",
                        subtitle: "Review, pin, export, or switch sessions",
                        systemImage: "clock.arrow.circlepath"
                    )
                }
                .accessibilityIdentifier("live.actions.sessions")

                NavigationLink {
                    RecordingsHistoryView()
                } label: {
                    LiveActionRow(
                        title: "Recordings",
                        subtitle: "Audio and realtime capture archives",
                        systemImage: "waveform"
                    )
                }
                .accessibilityIdentifier("live.actions.recordings")
            }

            Section(header: Text("Status")) {
                LiveStatusSummaryRow(
                    provider: store.diagnostics.providerLabel,
                    status: store.diagnostics.providerStatus,
                    sessionTitle: currentSessionTitle,
                    isActive: store.phase.isActive
                )

                NavigationLink {
                    LiveSessionStatusSheet(store: store)
                        .navigationTitle("Session Status")
                        .navigationBarTitleDisplayMode(.inline)
                } label: {
                    LiveActionRow(
                        title: "Details",
                        subtitle: "Latency, audio route, visual stream, tool calls",
                        systemImage: "info.circle"
                    )
                }
                .accessibilityIdentifier("live.actions.status")
            }
        }
        .listStyle(.insetGrouped)
        .tint(DesignTokens.accent)
    }

    private var currentSessionTitle: String {
        store.localSessions.first(where: { $0.id == store.currentSessionID })?.title ?? "Live Session"
    }
}

private struct LiveActionRow: View {
    let title: String
    let subtitle: String
    let systemImage: String
    var tint: Color = DesignTokens.accent

    var body: some View {
        HStack(spacing: 12) {
            LiveActionSymbolIcon(systemImage: systemImage, tint: tint)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(DesignTokens.Font.rowTitle)
                    .foregroundStyle(.primary)
                Text(subtitle)
                    .font(DesignTokens.Font.rowDetail)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 4)
        .frame(minHeight: 52)
        .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

private struct LiveActionSymbolIcon: View {
    let systemImage: String
    let tint: Color

    var body: some View {
        Image(systemName: systemImage)
            .font(.system(size: 24, weight: .semibold))
            .symbolRenderingMode(.hierarchical)
            .foregroundStyle(tint)
            .frame(width: DesignTokens.IconTile.actionRow, height: DesignTokens.IconTile.actionRow)
            .accessibilityHidden(true)
    }
}

private struct LiveStatusSummaryRow: View {
    let provider: String
    let status: String
    let sessionTitle: String
    let isActive: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                Circle()
                    .fill(isActive ? DesignTokens.Status.success : DesignTokens.Status.neutral)
                    .frame(width: 8, height: 8)
                    .accessibilityHidden(true)
                Text(status.isEmpty ? "Idle" : status)
                    .font(DesignTokens.Font.rowTitle)
                    .foregroundStyle(.primary)
                Spacer(minLength: 0)
            }
            HStack(spacing: 8) {
                Text(provider)
                Text("•")
                    .foregroundStyle(DesignTokens.tertiaryText)
                Text(sessionTitle)
                    .lineLimit(1)
            }
            .font(DesignTokens.Font.rowDetail)
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }
}

private struct LiveSessionSettingsSheet: View {
    @Environment(\.dismiss) private var dismiss
    let store: LiveSessionStore
    let defaultBrokerURL: URL?

    var body: some View {
        Form {
            LiveSettingsFormContent(store: store)
        }
        .tint(DesignTokens.accent)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    dismiss()
                } label: {
                    Text("Done")
                        .font(DesignTokens.Font.rowTitle)
                        .foregroundStyle(DesignTokens.panelAccentInk)
                }
                .tint(DesignTokens.panelAccentInk)
            }
        }
    }
}

private struct LiveSessionsSheet: View {
    let store: LiveSessionStore
    let onExport: (LiveExportFile) -> Void
    @Environment(AppContainer.self) private var container
    @State private var renameTarget: LiveLocalSession?
    @State private var renameText = ""
    @State private var showSummary = false

    var body: some View {
        List {
            Section {
                ForEach(store.localSessions.filter { !$0.isArchived }) { session in
                    Button {
                        store.selectSession(session)
                    } label: {
                        HStack(spacing: 12) {
                            Image(systemName: session.isBookmarked ? "bookmark.fill" : "bubble.left")
                                .foregroundStyle(session.isBookmarked ? DesignTokens.accent : .secondary)
                                .frame(width: 22)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(session.title)
                                    .foregroundStyle(.primary)
                                    .lineLimit(1)
                                Text(sessionMetadata(session))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            if session.id == store.currentSessionID {
                                Image(systemName: "checkmark.circle.fill")
                                    .foregroundStyle(DesignTokens.accent)
                            }
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(store.phase.isActive)
                    .swipeActions(edge: .leading, allowsFullSwipe: false) {
                        Button {
                            store.toggleBookmark(session)
                        } label: {
                            Label(
                                session.isBookmarked ? "Unpin" : "Pin",
                                systemImage: session.isBookmarked ? "pin.slash" : "pin"
                            )
                        }
                        .tint(DesignTokens.accent)
                        Button {
                            renameText = session.title
                            renameTarget = session
                        } label: {
                            Label("Rename", systemImage: "pencil")
                        }
                        .tint(.blue)
                    }
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        Button(role: .destructive) {
                            store.deleteSession(session)
                        } label: {
                            Label("Delete", systemImage: "trash")
                        }
                    }
                    .accessibilityIdentifier("live.sessions.row.\(session.id.uuidString)")
                }
            } footer: {
                if store.phase.isActive {
                    Text("Stop Live before switching sessions.")
                }
            }
        }
        .listStyle(.insetGrouped)
        .tint(DesignTokens.accent)
        .accessibilityIdentifier("live.sessions.list")
        .alert("Rename session", isPresented: renameBinding) {
            TextField("Name", text: $renameText)
                .textInputAutocapitalization(.sentences)
                .autocorrectionDisabled(false)
            Button("Cancel", role: .cancel) { renameTarget = nil }
            Button("Save") {
                if let target = renameTarget {
                    store.renameSession(target, title: renameText)
                }
                renameTarget = nil
            }
        }
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button {
                    showSummary = true
                } label: {
                    Label("Summary", systemImage: "doc.text.magnifyingglass")
                }
                .disabled(store.localSessions.filter { !$0.isArchived }.isEmpty)
                .accessibilityLabel("Summarize sessions")
                .accessibilityIdentifier("live.sessions.summary")
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    store.startNewSession()
                } label: {
                    Image(systemName: "plus")
                }
                .disabled(store.phase.isActive)
                .accessibilityLabel("New Live session")
                .accessibilityIdentifier("live.sessions.new")
            }
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button {
                        if let session = store.localSessions.first(where: { $0.id == store.currentSessionID }),
                           let url = store.exportSessionDisplayJSONL(session) {
                            onExport(LiveExportFile(shareURL: url, title: "Display Log"))
                        }
                    } label: {
                        Label("Export display log", systemImage: "text.bubble")
                    }
                    Button {
                        if let session = store.localSessions.first(where: { $0.id == store.currentSessionID }),
                           let bundle = store.exportSessionRawBundle(session) {
                            onExport(LiveExportFile(
                                shareURL: bundle.archiveURL,
                                previewURL: bundle.previewURL,
                                title: "Session Export"
                            ))
                        }
                    } label: {
                        Label("Export session zip", systemImage: "archivebox")
                    }
                } label: {
                    Image(systemName: "square.and.arrow.up")
                }
                .accessibilityLabel("Export current session")
                .accessibilityIdentifier("live.sessions.export")
            }
        }
        .sheet(isPresented: $showSummary) {
            LiveSummarySheet(store: store, container: container)
        }
    }

    private var renameBinding: Binding<Bool> {
        Binding(
            get: { renameTarget != nil },
            set: { if !$0 { renameTarget = nil } }
        )
    }

    private func sessionMetadata(_ session: LiveLocalSession) -> String {
        let created = MessageTimestampFormatter.string(from: session.createdAt)
        let updated = MessageTimestampFormatter.string(from: session.updatedAt)
        if Calendar.current.isDate(session.createdAt, inSameDayAs: session.updatedAt) {
            return "Created \(created) · Updated \(updated)"
        }
        return "Created \(created) · Last used \(updated)"
    }
}

private struct LiveSessionStatusSheet: View {
    @Environment(\.dismiss) private var dismiss
    let store: LiveSessionStore

    var body: some View {
        Form {
            Section {
                LabeledContent("Provider", value: store.diagnostics.providerLabel)
                LabeledContent("Status", value: store.diagnostics.providerStatus)
                LabeledContent("Local session", value: currentSessionTitle)
                LabeledContent("Latency", value: latencyLabel)
                LabeledContent("Input audio chunks", value: "\(store.diagnostics.audioChunksSent)")
                LabeledContent("Mic captured", value: micCapturedLabel)
                LabeledContent("Last mic chunk", value: lastMicChunkLabel)
                LabeledContent("Output audio received", value: outputReceivedLabel)
                LabeledContent("Output audio played", value: outputPlayedLabel)
                LabeledContent("Output audio status", value: store.diagnostics.outputAudioStatus)
                LabeledContent("Visual status", value: store.diagnostics.visualStatus)
                LabeledContent("Visual captured", value: visualCapturedLabel)
                LabeledContent("Last visual frame", value: lastVisualFrameLabel)
                LabeledContent("Audio session", value: store.diagnostics.audioSessionStatus)
                LabeledContent("Audio route", value: store.diagnostics.audioRoute)
                LabeledContent("Audio interruptions", value: "\(store.diagnostics.audioInterruptions)")
                LabeledContent("Route changes", value: "\(store.diagnostics.audioRouteChanges)")
                LabeledContent("Lifecycle", value: store.diagnostics.lastLifecycleEvent)
                LabeledContent("Session config", value: store.diagnostics.sessionConfigStatus)
                    .accessibilityIdentifier("live.sessionConfigStatus")
                LabeledContent("Tool calls", value: toolCallsLabel)
                LabeledContent("Last tool", value: store.diagnostics.lastToolCall)
                LabeledContent("Frames", value: "\(store.diagnostics.framesSent)")
                LabeledContent("Reconnects", value: "\(store.diagnostics.reconnects)")
                if let error = store.diagnostics.lastError {
                    Text(error)
                        .errorCaption()
                        .textSelection(.enabled)
                        .accessibilityIdentifier("live.lastError")
                }
            } header: {
                Text("Session")
                    .accessibilityIdentifier("live.status.sheet")
            }

            Section("Audio Output") {
                Button {
                    store.playAudioOutputProbe()
                } label: {
                    Label("Play Output Probe", systemImage: "speaker.wave.2.fill")
                }
                .accessibilityIdentifier("live.audioOutputProbe")
            }

            if !store.eventLog.isEmpty {
                Section("Events") {
                    ForEach(store.eventLog.reversed()) { entry in
                        eventRow(entry)
                    }
                }
            }
        }
        .tint(DesignTokens.accent)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Done") {
                    dismiss()
                }
            }
        }
    }

    private var latencyLabel: String {
        guard let latency = store.diagnostics.lastLatencyMs else { return "None" }
        return String(format: "%.0f ms", latency)
    }

    private var currentSessionTitle: String {
        store.localSessions.first(where: { $0.id == store.currentSessionID })?.title ?? "Live Session"
    }

    private var outputReceivedLabel: String {
        "\(store.diagnostics.outputAudioChunksReceived) / \(byteLabel(store.diagnostics.outputAudioBytesReceived))"
    }

    private var outputPlayedLabel: String {
        "\(store.diagnostics.outputAudioChunksPlayed) / \(byteLabel(store.diagnostics.outputAudioBytesPlayed))"
    }

    private var micCapturedLabel: String {
        "\(store.diagnostics.micChunksCaptured) / \(byteLabel(store.diagnostics.micBytesCaptured))"
    }

    private var lastMicChunkLabel: String {
        guard let date = store.diagnostics.lastMicCaptureAt else { return "Never" }
        let seconds = max(0, Date().timeIntervalSince(date))
        if seconds < 1 { return "Now" }
        if seconds < 60 { return String(format: "%.0f s ago", seconds) }
        return String(format: "%.1f min ago", seconds / 60)
    }

    private var visualCapturedLabel: String {
        "\(store.diagnostics.visualFramesCaptured) / \(byteLabel(store.diagnostics.visualBytesCaptured))"
    }

    private var lastVisualFrameLabel: String {
        guard let date = store.diagnostics.lastVisualCaptureAt else { return "Never" }
        let seconds = max(0, Date().timeIntervalSince(date))
        if seconds < 1 { return "Now" }
        if seconds < 60 { return String(format: "%.0f s ago", seconds) }
        return String(format: "%.1f min ago", seconds / 60)
    }

    private var toolCallsLabel: String {
        "\(store.diagnostics.toolCallsCompleted) / \(store.diagnostics.toolCallsReceived)"
    }

    private func byteLabel(_ bytes: Int) -> String {
        if bytes < 1024 {
            return "\(bytes) B"
        }
        return String(format: "%.1f KB", Double(bytes) / 1024.0)
    }

    @ViewBuilder
    private func eventRow(_ entry: LiveEventLogEntry) -> some View {
        if let detail = entry.detail {
            DisclosureGroup {
                Text(detail)
                    .font(DesignTokens.Font.mono)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } label: {
                eventSummary(entry)
            }
            .accessibilityIdentifier("live.event.\(entry.id.uuidString)")
        } else {
            eventSummary(entry)
                .accessibilityIdentifier("live.event.\(entry.id.uuidString)")
        }
    }

    private func eventSummary(_ entry: LiveEventLogEntry) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(entry.message)
                .font(.caption)
                .foregroundStyle(color(for: entry.level))
                .textSelection(.enabled)
            Text(entry.date, style: .time)
                .font(.caption2.monospacedDigit())
                .foregroundStyle(.secondary)
        }
    }

    private func color(for level: LiveEventLogEntry.Level) -> Color {
        switch level {
        case .info: return .primary
        case .warning: return .orange
        case .error: return .red
        }
    }
}

private struct LiveConversationDetailSheet: View {
    @Environment(\.dismiss) private var dismiss
    let entry: LiveConversationEntry

    var body: some View {
        Form {
            if let tool = entry.toolCall {
                Section("Tool Call") {
                    LabeledContent("Name", value: tool.name)
                    LabeledContent("Source", value: tool.source == .gateway ? "Hawky background agent" : "Realtime model")
                    LabeledContent("Status", value: statusLabel(for: tool.status))
                    if let callID = tool.callID {
                        LabeledContent("Call ID", value: callID)
                    }
                }

                Section("Timing") {
                    if let startedAt = tool.startedAt {
                        LabeledContent("Fired") {
                            Text(timestampLabel(startedAt))
                                .textSelection(.enabled)
                        }
                    }
                    if let completedAt = tool.completedAt {
                        LabeledContent("Returned") {
                            Text(timestampLabel(completedAt))
                                .textSelection(.enabled)
                        }
                    }
                    LabeledContent("Latency", value: latencyLabel(for: tool))
                }
                if let args = tool.arguments, !args.isEmpty {
                    Section("Sent To Tool") {
                        JSONInspectorView(rawText: args)
                    }
                }
                if let output = tool.output, !output.isEmpty {
                    Section("Returned To Model") {
                        JSONInspectorView(rawText: output)
                    }
                }
            } else {
                Section("Message") {
                    LabeledContent("Role", value: entry.role.rawValue.capitalized)
                    LabeledContent("Time") {
                        Text(timestampLabel(entry.date))
                            .textSelection(.enabled)
                    }
                    if let image = entry.uiImage {
                        Image(uiImage: image)
                            .resizable()
                            .scaledToFit()
                            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                    }
                    Text(entry.text)
                        .textSelection(.enabled)
                }
            }

            if let eventType = entry.eventType {
                Section("Event") {
                    LabeledContent("Type", value: eventType)
                }
            }
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Done") {
                    dismiss()
                }
            }
        }
    }

    private func statusLabel(for status: LiveToolCallInfo.Status) -> String {
        switch status {
        case .started: return "Running"
        case .ok: return "Returned"
        case .error: return "Failed"
        }
    }

    private func latencyLabel(for tool: LiveToolCallInfo) -> String {
        guard let startedAt = tool.startedAt else { return "Unknown" }
        let end = tool.completedAt ?? Date()
        let suffix = tool.completedAt == nil ? " so far" : ""
        return "\(durationLabel(from: startedAt, to: end))\(suffix)"
    }

    private func durationLabel(from start: Date, to end: Date) -> String {
        let milliseconds = max(0, Int(end.timeIntervalSince(start) * 1000))
        if milliseconds < 1_000 {
            return "\(milliseconds) ms"
        }
        return String(format: "%.1f s", Double(milliseconds) / 1_000)
    }

    private func timestampLabel(_ date: Date) -> String {
        MessageTimestampFormatter.string(from: date)
    }
}

private struct LiveLoadedMemoryPage: View {
    let text: String

    var body: some View {
        ScrollView {
            Text(displayText)
                .font(.callout.monospaced())
                .foregroundStyle(.primary)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(16)
        }
        .navigationTitle("Loaded Memory")
        .navigationBarTitleDisplayMode(.inline)
        .background(Color(.systemBackground))
    }

    private var displayText: String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "No loaded memory detail captured." : trimmed
    }
}

private enum JSONInspectorMode: String, CaseIterable, Identifiable {
    case tree = "Tree"
    case pretty = "Pretty"
    case raw = "Raw"

    static let storageKey = "live.jsonInspectorMode"

    var id: String { rawValue }

    var systemImage: String {
        switch self {
        case .tree: return "list.bullet.indent"
        case .pretty: return "text.alignleft"
        case .raw: return "curlybraces"
        }
    }
}

private struct JSONInspectorView: View {
    let rawText: String
    @AppStorage(JSONInspectorMode.storageKey) private var storedMode: String = JSONInspectorMode.tree.rawValue
    @State private var copiedLabel: String?

    private var mode: JSONInspectorMode {
        get { JSONInspectorMode(rawValue: storedMode) ?? .tree }
        nonmutating set { storedMode = newValue.rawValue }
    }

    private var parsedValue: JSONInspectableValue? {
        JSONInspectableValue.parse(rawText)
    }

    private var prettyText: String {
        JSONInspectableValue.prettyPrinted(rawText) ?? rawText
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Menu {
                    Picker("Display", selection: $storedMode) {
                        ForEach(JSONInspectorMode.allCases) { mode in
                            Label(mode.rawValue, systemImage: mode.systemImage)
                                .tag(mode.rawValue)
                        }
                    }
                } label: {
                    Label(mode.rawValue, systemImage: mode.systemImage)
                        .font(DesignTokens.Font.metaStrong)
                }
                .secondaryPanelAction()
                .controlSize(.small)
                .accessibilityIdentifier("live.jsonInspector.modeMenu")

                Menu {
                    Button {
                        copy(textForCopy, label: mode.rawValue)
                    } label: {
                        Label("Copy \(mode.rawValue)", systemImage: "doc.on.doc")
                    }
                    Button {
                        copy(prettyText, label: "Pretty")
                    } label: {
                        Label("Copy Pretty JSON", systemImage: "text.alignleft")
                    }
                    Button {
                        copy(rawText, label: "Raw")
                    } label: {
                        Label("Copy Raw JSON", systemImage: "curlybraces")
                    }
                } label: {
                    Label(copiedLabel ?? "Copy", systemImage: copiedLabel == nil ? "doc.on.doc" : "checkmark")
                        .font(DesignTokens.Font.metaStrong)
                }
                .secondaryPanelAction()
                .controlSize(.small)
                .accessibilityLabel("Copy JSON")
                .accessibilityIdentifier("live.jsonInspector.copy")

                Spacer(minLength: 0)
            }

            if parsedValue == nil {
                Label("Invalid JSON, showing raw text", systemImage: "exclamationmark.triangle")
                    .warningBadge()
            }

            switch mode {
            case .tree:
                if let parsedValue {
                    JSONTreeValueView(name: "root", value: parsedValue)
                } else {
                    JSONCodeBlock(text: rawText, highlighted: false)
                }
            case .pretty:
                JSONCodeBlock(text: prettyText, highlighted: parsedValue != nil)
            case .raw:
                JSONCodeBlock(text: rawText, highlighted: false)
            }
        }
        .accessibilityIdentifier("live.jsonInspector")
    }

    private func copy(_ text: String, label: String) {
        UIPasteboard.general.string = text
        copiedLabel = "Copied"
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
            if copiedLabel == "Copied" {
                copiedLabel = nil
            }
        }
    }

    private var textForCopy: String {
        switch mode {
        case .tree, .pretty:
            return prettyText
        case .raw:
            return rawText
        }
    }
}

private struct JSONCodeBlock: View {
    let text: String
    var highlighted: Bool

    var body: some View {
        if highlighted {
            ScrollView(.horizontal, showsIndicators: true) {
                Text(JSONSyntaxHighlighter.highlight(text))
                    .font(DesignTokens.Font.mono)
                    .textSelection(.enabled)
                    .padding(.vertical, 4)
            }
        } else {
            TextEditor(text: .constant(text))
                .font(DesignTokens.Font.mono)
                .scrollContentBackground(.hidden)
                .frame(minHeight: min(260, max(96, CGFloat(text.split(separator: "\n", omittingEmptySubsequences: false).count) * 22)))
                .accessibilityIdentifier("live.jsonInspector.textEditor")
        }
    }
}

private struct JSONTreeValueView: View {
    let name: String
    let value: JSONInspectableValue
    @State private var isExpanded = false

    var body: some View {
        switch value {
        case .object(let fields):
            expandable(summary: "{\(fields.count)}") {
                ForEach(fields) { field in
                    JSONTreeValueView(name: field.name, value: field.value)
                }
            }
        case .array(let values):
            expandable(summary: "[\(values.count)]") {
                ForEach(values.indices, id: \.self) { index in
                    JSONTreeValueView(name: "[\(index)]", value: values[index])
                }
            }
        case .string(let string):
            JSONTreeLabel(name: name, summary: "\"\(string)\"", tint: .green)
        case .number(let string):
            JSONTreeLabel(name: name, summary: string, tint: .orange)
        case .bool(let value):
            JSONTreeLabel(name: name, summary: value ? "true" : "false", tint: .blue)
        case .null:
            JSONTreeLabel(name: name, summary: "null", tint: .purple)
        }
    }

    private func expandable<Content: View>(
        summary: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation(.smooth(duration: 0.16)) {
                    isExpanded.toggle()
                }
            } label: {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Image(systemName: "chevron.right")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .rotationEffect(.degrees(isExpanded ? 90 : 0))
                        .frame(width: 12)
                    JSONTreeLabel(name: name, summary: summary)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if isExpanded {
                VStack(alignment: .leading, spacing: 6) {
                    content()
                }
                .padding(.leading, 18)
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
    }
}

private struct JSONTreeLabel: View {
    let name: String
    let summary: String
    var tint: Color = .secondary

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(name)
                .font(DesignTokens.Font.mono.weight(.semibold))
                .foregroundStyle(DesignTokens.accent)
            Text(summary)
                .font(DesignTokens.Font.mono)
                .foregroundStyle(tint)
                .lineLimit(3)
                .truncationMode(.middle)
                .textSelection(.enabled)
            Spacer(minLength: 0)
        }
    }
}

private struct JSONTreeField: Identifiable {
    let id = UUID()
    let name: String
    let value: JSONInspectableValue
}

private indirect enum JSONInspectableValue {
    case object([JSONTreeField])
    case array([JSONInspectableValue])
    case string(String)
    case number(String)
    case bool(Bool)
    case null

    static func parse(_ text: String) -> JSONInspectableValue? {
        guard let data = text.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) else {
            return nil
        }
        return JSONInspectableValue(any: object)
    }

    static func prettyPrinted(_ text: String) -> String? {
        guard let data = text.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) else {
            return nil
        }
        if JSONSerialization.isValidJSONObject(object),
           let pretty = try? JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys]),
           let string = String(data: pretty, encoding: .utf8) {
            return string
        }
        return String(describing: object)
    }

    private init?(any value: Any) {
        switch value {
        case let object as [String: Any]:
            let fields = object.keys.sorted().compactMap { key -> JSONTreeField? in
                guard let value = JSONInspectableValue(any: object[key] ?? NSNull()) else { return nil }
                return JSONTreeField(name: key, value: value)
            }
            self = .object(fields)
        case let array as [Any]:
            self = .array(array.compactMap(JSONInspectableValue.init(any:)))
        case let string as String:
            self = .string(string)
        case let number as NSNumber:
            if CFGetTypeID(number) == CFBooleanGetTypeID() {
                self = .bool(number.boolValue)
            } else {
                self = .number(number.stringValue)
            }
        case _ as NSNull:
            self = .null
        default:
            return nil
        }
    }
}

private enum JSONSyntaxHighlighter {
    static func highlight(_ text: String) -> AttributedString {
        var result = AttributedString()
        var index = text.startIndex

        while index < text.endIndex {
            let character = text[index]
            if character == "\"" {
                let start = index
                index = text.index(after: index)
                var isEscaped = false
                while index < text.endIndex {
                    let current = text[index]
                    if current == "\"" && !isEscaped {
                        index = text.index(after: index)
                        break
                    }
                    isEscaped = current == "\\" && !isEscaped
                    if current != "\\" {
                        isEscaped = false
                    }
                    index = text.index(after: index)
                }
                let token = String(text[start..<index])
                append(token, color: isKeyToken(after: index, in: text) ? DesignTokens.accent : .green, to: &result)
            } else if character.isNumber || character == "-" {
                let start = index
                index = text.index(after: index)
                while index < text.endIndex, isNumberCharacter(text[index]) {
                    index = text.index(after: index)
                }
                append(String(text[start..<index]), color: .orange, to: &result)
            } else if character.isLetter {
                let start = index
                index = text.index(after: index)
                while index < text.endIndex, text[index].isLetter {
                    index = text.index(after: index)
                }
                let token = String(text[start..<index])
                let color: Color = ["true", "false", "null"].contains(token) ? .blue : .primary
                append(token, color: color, to: &result)
            } else {
                append(String(character), color: punctuationColor(for: character), to: &result)
                index = text.index(after: index)
            }
        }

        return result
    }

    private static func append(_ text: String, color: Color, to result: inout AttributedString) {
        var segment = AttributedString(text)
        segment.foregroundColor = color
        result += segment
    }

    private static func isKeyToken(after index: String.Index, in text: String) -> Bool {
        var cursor = index
        while cursor < text.endIndex, text[cursor].isWhitespace {
            cursor = text.index(after: cursor)
        }
        return cursor < text.endIndex && text[cursor] == ":"
    }

    private static func isNumberCharacter(_ character: Character) -> Bool {
        character.isNumber || character == "." || character == "e" || character == "E" || character == "+" || character == "-"
    }

    private static func punctuationColor(for character: Character) -> Color {
        switch character {
        case "{", "}", "[", "]", ":", ",":
            return .secondary
        default:
            return .primary
        }
    }
}

private struct LiveExportSheet: View {
    @Environment(\.dismiss) private var dismiss
    let file: LiveExportFile

    var body: some View {
        Form {
            Section(file.shareURL.pathExtension == "zip" ? "\(file.title) Zip" : file.title) {
                LabeledContent("File", value: file.shareURL.lastPathComponent)
                ShareLink(item: file.shareURL) {
                    Label("Share Export", systemImage: "square.and.arrow.up")
                }
                NavigationLink {
                    ExportPreviewView(rootURL: file.previewURL)
                } label: {
                    Label("Preview Files", systemImage: "folder")
                }
            }
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Done") {
                    dismiss()
                }
            }
        }
    }
}

private struct ExportPreviewView: View {
    let rootURL: URL
    @State private var node: ExportPreviewNode?
    @State private var errorMessage: String?

    var body: some View {
        Group {
            if let node {
                ExportPreviewNodeView(node: node)
            } else if let errorMessage {
                ContentUnavailableView("Preview unavailable", systemImage: "exclamationmark.triangle", description: Text(errorMessage))
            } else {
                ProgressView()
            }
        }
        .navigationTitle(rootURL.lastPathComponent)
        .navigationBarTitleDisplayMode(.inline)
        .task(id: rootURL) {
            do {
                node = try ExportPreviewNode.load(rootURL)
                errorMessage = nil
            } catch {
                node = nil
                errorMessage = error.localizedDescription
            }
        }
    }
}

private struct ExportPreviewNodeView: View {
    let node: ExportPreviewNode

    var body: some View {
        if node.isDirectory {
            List {
                if node.children.isEmpty {
                    Text("Empty folder")
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(node.children) { child in
                        NavigationLink {
                            ExportPreviewNodeView(node: child)
                        } label: {
                            ExportPreviewRow(node: child)
                        }
                    }
                }
            }
            .navigationTitle(node.name)
            .navigationBarTitleDisplayMode(.inline)
        } else {
            ExportFilePreview(node: node)
                .navigationTitle(node.name)
                .navigationBarTitleDisplayMode(.inline)
        }
    }
}

private struct ExportPreviewRow: View {
    let node: ExportPreviewNode

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: node.isDirectory ? "folder" : node.iconName)
                .foregroundStyle(node.isDirectory ? DesignTokens.accent : .secondary)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 2) {
                Text(node.name)
                    .lineLimit(1)
                Text(node.subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }
}

private struct ExportFilePreview: View {
    let node: ExportPreviewNode
    @State private var text: String?
    @State private var image: UIImage?
    @State private var errorMessage: String?

    var body: some View {
        Group {
            if let image {
                ScrollView([.horizontal, .vertical]) {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFit()
                        .padding()
                }
                .background(DesignTokens.groupedBackground)
            } else if let text {
                VStack(spacing: 0) {
                    HStack(spacing: 8) {
                        Image(systemName: "doc.text")
                            .foregroundStyle(.secondary)
                        Text(node.byteLabel)
                        Text(node.typeLabel)
                            .foregroundStyle(.secondary)
                        Spacer()
                    }
                    .font(.caption)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 8)
                    .background(.bar)

                    ExportTextFilePreview(text: text)
                        .ignoresSafeArea(.keyboard, edges: .bottom)
                }
            } else if let errorMessage {
                ContentUnavailableView("Preview unavailable", systemImage: node.iconName, description: Text(errorMessage))
            } else {
                ProgressView()
            }
        }
        .task(id: node.url) {
            loadPreview()
        }
    }

    private func loadPreview() {
        image = nil
        text = nil
        errorMessage = nil
        if node.isImage, let loaded = UIImage(contentsOfFile: node.url.path) {
            image = loaded
            return
        }
        guard node.isTextPreviewable else {
            errorMessage = "\(node.byteLabel) \(node.typeLabel)"
            return
        }
        do {
            let data = try Data(contentsOf: node.url, options: .mappedIfSafe)
            let previewData = data.prefix(240_000)
            var loaded = String(data: previewData, encoding: .utf8)
                ?? String(data: previewData, encoding: .ascii)
                ?? ""
            if data.count > previewData.count {
                loaded += "\n\n… truncated preview at \(ByteCountFormatter.string(fromByteCount: Int64(previewData.count), countStyle: .file))"
            }
            text = loaded
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

private struct ExportTextFilePreview: UIViewRepresentable {
    let text: String

    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.isEditable = false
        view.isSelectable = true
        view.isScrollEnabled = true
        view.alwaysBounceVertical = true
        view.backgroundColor = .systemBackground
        view.textColor = .label
        view.font = UIFontMetrics(forTextStyle: .caption1).scaledFont(
            for: .monospacedSystemFont(ofSize: 13, weight: .regular)
        )
        view.adjustsFontForContentSizeCategory = true
        view.textContainerInset = UIEdgeInsets(top: 16, left: 14, bottom: 24, right: 14)
        view.textContainer.lineFragmentPadding = 0
        view.keyboardDismissMode = .interactive
        view.accessibilityIdentifier = "live.export.preview.text"
        return view
    }

    func updateUIView(_ view: UITextView, context: Context) {
        if view.text != text {
            view.text = text
            view.setContentOffset(.zero, animated: false)
        }
        view.backgroundColor = .systemBackground
        view.textColor = .label
    }
}

private struct ExportPreviewNode: Identifiable {
    let id: String
    let url: URL
    let name: String
    let isDirectory: Bool
    let size: Int64
    let children: [ExportPreviewNode]

    var subtitle: String {
        isDirectory ? "\(children.count) items" : "\(byteLabel) \(typeLabel)"
    }

    var byteLabel: String {
        ByteCountFormatter.string(fromByteCount: size, countStyle: .file)
    }

    var typeLabel: String {
        let ext = url.pathExtension.lowercased()
        return ext.isEmpty ? "file" : ext.uppercased()
    }

    var isImage: Bool {
        ["jpg", "jpeg", "png", "heic", "gif"].contains(url.pathExtension.lowercased())
    }

    var isTextPreviewable: Bool {
        ["json", "jsonl", "txt", "md", "log", "csv", "xml", "yaml", "yml"].contains(url.pathExtension.lowercased())
    }

    var iconName: String {
        if isImage { return "photo" }
        if isTextPreviewable { return "doc.text" }
        return "doc"
    }

    static func load(_ url: URL) throws -> ExportPreviewNode {
        let values = try url.resourceValues(forKeys: [.isDirectoryKey, .fileSizeKey, .totalFileAllocatedSizeKey])
        let isDirectory = values.isDirectory == true
        let children: [ExportPreviewNode]
        if isDirectory {
            let childURLs = try FileManager.default.contentsOfDirectory(
                at: url,
                includingPropertiesForKeys: [.isDirectoryKey, .fileSizeKey, .totalFileAllocatedSizeKey],
                options: [.skipsHiddenFiles]
            )
            children = try childURLs
                .sorted { lhs, rhs in
                    let lhsIsDirectory = ((try? lhs.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) ?? false)
                    let rhsIsDirectory = ((try? rhs.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) ?? false)
                    if lhsIsDirectory != rhsIsDirectory { return lhsIsDirectory }
                    return lhs.lastPathComponent.localizedStandardCompare(rhs.lastPathComponent) == .orderedAscending
                }
                .map(load)
        } else {
            children = []
        }
        return ExportPreviewNode(
            id: url.path,
            url: url,
            name: url.lastPathComponent,
            isDirectory: isDirectory,
            size: Int64(values.fileSize ?? values.totalFileAllocatedSize ?? 0),
            children: children
        )
    }
}

private extension LiveConversationEntry {
    var uiImage: UIImage? {
        guard let imageData else { return nil }
        return UIImage(data: imageData)
    }
}

/// A small dot that gently pulses to signal an active Live audio stream — a
/// lightweight "you're live / listening" cue in place of a full waveform. (#417)
private struct SpeakingIndicator: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var pulsing = false

    var body: some View {
        Circle()
            .fill(DesignTokens.accent)
            .frame(width: 9, height: 9)
            .scaleEffect(pulsing ? 1.0 : 0.6)
            .opacity(pulsing ? 1.0 : 0.45)
            .frame(width: 26, height: 26)
            .onAppear { startPulsing() }
            // Honor a live toggle of the setting while the indicator is showing.
            .onChange(of: reduceMotion) { _, _ in
                startPulsing()
            }
    }

    // HIG (Motion): looping animation must stop/simplify under Reduce Motion.
    // When it's on, show a steady, fully-lit dot (a clear "speaking" state with
    // zero motion) instead of the forever pulse. (#575)
    private func startPulsing() {
        let shouldReduceMotion = reduceMotion

        withAnimation(nil) {
            pulsing = false
        }

        DispatchQueue.main.async {
            if shouldReduceMotion {
                withAnimation(nil) {
                    pulsing = true
                }
            } else {
                withAnimation(.easeInOut(duration: 0.7).repeatForever(autoreverses: true)) {
                    pulsing = true
                }
            }
        }
    }
}

#Preview {
    NavigationStack {
        LiveView(store: LiveSessionStore())
    }
}
