import SwiftUI

// Root chat screen: message list + composer. Reads from AppContainer via @Environment.
struct ChatView: View {
    @Environment(AppContainer.self) private var container
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @ObservedObject private var frontendTabs = FrontendTabStore.shared

    @State private var composerText: String = ""
    @State private var showingSessionList = false
    @State private var selectedCarouselPane: ChatCarouselPane = .chat
    @State private var sessionSwitchError: String?
    @State private var isReloadingHistory = false
    @State private var sessionSearchText = ""
    @FocusState private var isComposerFocused: Bool
    @FocusState private var isSessionSearchFocused: Bool
    // Viewport tracking: true when the bottom sentinel row is visible. Gates
    // auto-scroll-to-bottom so we don't yank the user away when they're reading
    // older messages. Starts true so first-load snaps to bottom as expected.
    @State private var isAtBottom: Bool = true

    private var isConnected: Bool {
        if case .connected = container.connectionStore.status { return true }
        return false
    }

    private var activeDisplayName: String {
        container.sessionStore.activeSummary?.displayName
            ?? SessionStore.defaultDisplayName(for: container.sessionStore.activeSessionKey)
    }

    var body: some View {
        Group {
            if horizontalSizeClass == .compact {
                mobileCarousel
            } else {
                chatPane
            }
        }
        .navigationTitle(navigationTitle)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                leadingToolbarItem
            }
            ToolbarItem(placement: .principal) {
                compactChatTitle
            }
            ToolbarItem(placement: .topBarTrailing) {
                trailingToolbarItem
            }
        }
        .sheet(isPresented: $showingSessionList) {
            SessionListView()
                .environment(container)
        }
        .alert("Switch failed", isPresented: sessionSwitchErrorBinding) {
            Button("OK", role: .cancel) { sessionSwitchError = nil }
        } message: {
            Text(sessionSwitchError ?? "")
        }
        .onAppear {
            applyPendingChatRouteIfNeeded()
        }
        .onChange(of: frontendTabs.chatRouteRequestID) { _, _ in
            applyPendingChatRouteIfNeeded()
        }
    }

    private var chatPane: some View {
        VStack(spacing: 0) {
            messageList
            Divider()
            ComposerView(
                text: $composerText,
                isEnabled: isConnected,
                onSend: sendTapped,
                focusBinding: $isComposerFocused
            )
        }
    }

    private var mobileCarousel: some View {
        TabView(selection: $selectedCarouselPane) {
            sessionsPane
                .tag(ChatCarouselPane.sessions)
                .accessibilityIdentifier("chatCarousel.sessions")
            chatPane
                .tag(ChatCarouselPane.chat)
                .accessibilityIdentifier("chatCarousel.chat")
            contextPane
                .tag(ChatCarouselPane.context)
                .accessibilityIdentifier("chatCarousel.context")
        }
        .tabViewStyle(.page(indexDisplayMode: .never))
        .onAppear {
            selectedCarouselPane = .chat
        }
    }

    private var navigationTitle: String {
        horizontalSizeClass == .compact ? selectedCarouselPane.title(activeDisplayName: activeDisplayName) : activeDisplayName
    }

    @ViewBuilder
    private var leadingToolbarItem: some View {
        if horizontalSizeClass != .compact {
            Button {
                showingSessionList = true
            } label: {
                Image(systemName: "list.bullet")
            }
            .accessibilityIdentifier("chatView.sessionsButton")
        }
    }

    @ViewBuilder
    private var trailingToolbarItem: some View {
        ConnectionStatusDot(
            status: container.connectionStore.status,
            lastError: container.connectionStore.lastError
        )
    }

    @ViewBuilder
    private var compactChatTitle: some View {
        if horizontalSizeClass == .compact {
            Text(activeDisplayName)
                .font(.headline.weight(.semibold))
                .lineLimit(1)
                .accessibilityLabel("Chat session \(activeDisplayName)")
        }
    }

    private var sessionSwitchErrorBinding: Binding<Bool> {
        Binding(get: { sessionSwitchError != nil }, set: { if !$0 { sessionSwitchError = nil } })
    }

    @ViewBuilder
    private var messageList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: DesignTokens.Spacing.message) {
                    if container.chatStore.messages.isEmpty {
                        emptyState
                    } else {
                        // Top sentinel: auto-loads older history when it scrolls
                        // into view. Replaces the old "Load older" button with a
                        // gesture-driven pattern (iMessage/Telegram/WhatsApp).
                        // Only rendered while more history exists on the server.
                        if container.chatStore.hasMoreHistory {
                            loadOlderSentinel
                        }
                        ForEach(container.chatStore.messages) { msg in
                            MessageBubbleView(message: msg)
                                .id(msg.id)
                        }
                        // Bottom sentinel: doubles as scroll-to-bottom target AND
                        // viewport probe. onAppear/onDisappear drive `isAtBottom`
                        // which gates auto-scroll so streaming deltas don't yank
                        // the user away when they've scrolled up to read history.
                        Color.clear
                            .frame(height: 1)
                            .id("__bottom__")
                            .onAppear { isAtBottom = true }
                            .onDisappear { isAtBottom = false }
                    }
                }
                .padding(.vertical, 12)
            }
            .scrollDismissesKeyboard(.interactively)
            .contentShape(Rectangle())
            .onTapGesture {
                isComposerFocused = false
            }
            .onChange(of: container.chatStore.messages.count) { oldCount, newCount in
                // Suppress auto-scroll when older history was prepended (count
                // grew but user is viewing older content) OR when the user has
                // scrolled up to read. Only snap to bottom for tail growth while
                // the bottom sentinel is visible.
                guard newCount > oldCount, isAtBottom else { return }
                scrollToBottom(proxy: proxy)
            }
            .onChange(of: lastMessageText) { _, _ in
                // Streaming deltas: only follow the tail if the user is parked
                // near the bottom. Otherwise preserve their reading position.
                guard isAtBottom else { return }
                scrollToBottom(proxy: proxy)
            }
            .onChange(of: container.sessionStore.activeSessionKey) { _, _ in
                // Fresh session: assume we want to be at the bottom until the
                // user scrolls. Prevents a stale "false" from the previous
                // session's scroll state leaking into the new one.
                isAtBottom = true
            }
        }
    }

    // Gesture-driven pagination: when this row scrolls into view at the top of
    // the list, fire off a request for the next older history window. Replaces
    // the old explicit "Load older" button — the scroll gesture itself loads.
    // loadOlderHistory() is itself guarded against concurrent / exhausted
    // fetches (hasMoreHistory + isLoadingOlder), so redundant onAppear fires
    // from LazyVStack recycling are safe.
    @ViewBuilder
    private var loadOlderSentinel: some View {
        HStack {
            Spacer()
            if container.chatStore.isLoadingOlder {
                ProgressView()
                    .controlSize(.small)
                    .accessibilityIdentifier("chatView.loadOlderProgress")
            } else {
                Color.clear.frame(height: 1)
            }
            Spacer()
        }
        .frame(height: container.chatStore.isLoadingOlder ? 28 : 1)
        .accessibilityIdentifier("chatView.loadOlderSentinel")
        .onAppear {
            Task { try? await container.loadOlderHistory() }
        }
    }

    private var lastMessageText: String {
        container.chatStore.messages.last?.text ?? ""
    }

    private func scrollToBottom(proxy: ScrollViewProxy) {
        withAnimation(.linear(duration: 0.1)) {
            proxy.scrollTo("__bottom__", anchor: .bottom)
        }
    }

    private var emptyState: some View {
        // Secretary empty-state treatment: serif headline + mono meta. Quiet.
        VStack(spacing: 6) {
            Spacer(minLength: 80)
            Text("Start a conversation")
                .font(DesignTokens.Font.assistant)
                .foregroundStyle(Color(.secondaryLabel))
                .accessibilityIdentifier("chatView.emptyState")
            Text(sessionLabel)
                .font(DesignTokens.Font.mono)
                .foregroundStyle(DesignTokens.tertiaryText)
                .accessibilityIdentifier("chatView.sessionName")
            Spacer()
        }
        .frame(maxWidth: .infinity)
    }

    private var sessionLabel: String {
        container.sessionStore.activeSessionKey
    }

    private func sendTapped() {
        let text = composerText
        composerText = ""
        Task {
            await container.sendMessage(text)
        }
    }

    private var sessionsPane: some View {
        List {
            Section {
                ForEach(filteredChatSessions) { summary in
                    Button {
                        dismissSessionSearch()
                        switchSession(to: summary.key)
                    } label: {
                        ChatCarouselSessionRow(
                            summary: summary,
                            isActive: summary.key == container.sessionStore.activeSessionKey
                        )
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("chatCarousel.session.\(summary.key)")
                }
            } header: {
                Text("Sessions")
            }
        }
        .listStyle(.insetGrouped)
        .overlay {
            if filteredChatSessions.isEmpty {
                if sessionSearchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    ContentUnavailableView(
                        "No Chats",
                        systemImage: "bubble.left.and.bubble.right",
                        description: Text("Tap Chat below to start a conversation.")
                    )
                } else {
                    ContentUnavailableView.search(text: sessionSearchText)
                }
            }
        }
        .simultaneousGesture(TapGesture().onEnded { dismissSessionSearch(keepingText: true) })
        .safeAreaInset(edge: .bottom) {
            SessionSearchCreateBar(
                searchText: $sessionSearchText,
                placeholder: "Search Chats",
                actionTitle: "Chat",
                actionIcon: "square.and.pencil",
                isActionDisabled: false,
                focusBinding: $isSessionSearchFocused,
                onCancelSearch: { dismissSessionSearch() },
                action: createChatSession
            )
        }
    }

    private var filteredChatSessions: [SessionStore.SessionSummary] {
        let query = sessionSearchText.trimmingCharacters(in: .whitespacesAndNewlines)
        let sessions = SessionStore.sorted(container.sessionStore.sessions.filter { !$0.isArchived })
        guard !query.isEmpty else { return sessions }
        return sessions.filter { summary in
            summary.displayName.localizedCaseInsensitiveContains(query)
                || summary.key.localizedCaseInsensitiveContains(query)
        }
    }

    private var contextPane: some View {
        List {
            Section {
                ChatSidePaneHeader(
                    icon: connectionStatusIcon,
                    title: connectionStatusTitle,
                    subtitle: container.gatewayURL.host() ?? container.gatewayURL.absoluteString
                )
            }
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets(top: 10, leading: 16, bottom: 4, trailing: 16))

            Section("Connection") {
                HStack {
                    Text("Gateway")
                    Spacer()
                    Text(container.gatewayURL.host() ?? container.gatewayURL.absoluteString)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                HStack {
                    Text("Session")
                    Spacer()
                    Text(activeDisplayName)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            Section("Actions") {
                Button {
                    reloadHistory()
                } label: {
                    HStack {
                        Label("Reload history", systemImage: "arrow.clockwise")
                        Spacer()
                        if isReloadingHistory {
                            ProgressView()
                                .controlSize(.small)
                        }
                    }
                }
                .disabled(isReloadingHistory)
                .accessibilityIdentifier("chatCarousel.reloadHistory")

                NavigationLink {
                    TestView()
                        .navigationTitle("Probes")
                        .navigationBarTitleDisplayMode(.inline)
                } label: {
                    Label("Open probes", systemImage: "waveform.path.ecg")
                }
                .accessibilityIdentifier("chatCarousel.openProbes")
            }
        }
        .listStyle(.insetGrouped)
    }

    private var connectionStatusIcon: String {
        if case .connected = container.connectionStore.status {
            return "checkmark.circle.fill"
        }
        return "exclamationmark.circle.fill"
    }

    private var connectionStatusTitle: String {
        if case .connected = container.connectionStore.status {
            return "Connected"
        }
        return "Connection issue"
    }

    private func reloadHistory() {
        guard !isReloadingHistory else { return }
        isReloadingHistory = true
        Task {
            defer { isReloadingHistory = false }
            do {
                _ = try await container.reloadHistory()
            } catch let error as AppContainerError {
                if case .switchFailed(let reason) = error {
                    sessionSwitchError = reason
                }
            } catch {
                sessionSwitchError = "Reload failed"
            }
        }
    }

    private func createChatSession() {
        let stamp = Int(Date().timeIntervalSince1970)
        let key = "ios:chat-\(stamp)"
        dismissSessionSearch()
        Task {
            do {
                try await container.newSession(key: key, displayName: "New Chat")
                withAnimation(.snappy) { selectedCarouselPane = .chat }
            } catch let error as AppContainerError {
                if case .switchFailed(let reason) = error {
                    sessionSwitchError = reason
                }
            } catch {
                sessionSwitchError = "Create failed"
            }
        }
    }

    private func dismissSessionSearch(keepingText: Bool = false) {
        isSessionSearchFocused = false
        if !keepingText {
            sessionSearchText = ""
        }
    }

    private func switchSession(to key: String) {
        Task {
            do {
                try await container.switchSession(to: key)
                await MainActor.run {
                    withAnimation(.snappy) { selectedCarouselPane = .chat }
                }
            } catch let error as AppContainerError {
                if case .switchFailed(let reason) = error {
                    sessionSwitchError = reason
                }
            } catch {
                sessionSwitchError = "Switch failed"
            }
        }
    }

    private func applyPendingChatRouteIfNeeded() {
        guard let sessionKey = frontendTabs.consumePendingChatSessionKey(),
              !sessionKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return
        }
        switchSession(to: sessionKey)
    }
}

private enum ChatCarouselPane: Int, CaseIterable, Identifiable {
    case sessions
    case chat
    case context

    var id: Int { rawValue }

    var label: String {
        switch self {
        case .sessions: return "Sessions"
        case .chat: return "Chat"
        case .context: return "Status"
        }
    }

    func title(activeDisplayName: String) -> String {
        switch self {
        case .sessions: return "Sessions"
        case .chat: return activeDisplayName
        case .context: return "Context"
        }
    }
}

private struct ChatSidePaneHeader: View {
    let icon: String
    let title: String
    let subtitle: String

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .font(.system(
                    size: DesignTokens.IconTile.symbolSize(for: DesignTokens.IconTile.sidePane),
                    weight: .semibold
                ))
                .foregroundStyle(DesignTokens.accent)
                .frame(width: DesignTokens.IconTile.sidePane, height: DesignTokens.IconTile.sidePane)
                .paperSurface(in: Circle(), inset: true)
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(DesignTokens.Font.panelTitle)
                    .lineLimit(1)
                Text(subtitle)
                    .font(DesignTokens.Font.mono)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 4)
    }
}

private struct ChatCarouselSessionRow: View {
    let summary: SessionStore.SessionSummary
    let isActive: Bool

    var body: some View {
        HStack(spacing: 10) {
            if summary.isPinned {
                Image(systemName: "pin.fill")
                    .font(.caption2)
                    .foregroundStyle(.orange)
            }
            VStack(alignment: .leading, spacing: 3) {
                Text(summary.displayName)
                    .fontWeight(isActive ? .semibold : .regular)
                    .foregroundStyle(isActive ? DesignTokens.accent : Color(.label))
                    .lineLimit(1)
                Text(summary.key)
                    .font(DesignTokens.Font.mono)
                    .foregroundStyle(DesignTokens.tertiaryText)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
            if isActive {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(DesignTokens.accent)
            }
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
    }
}
