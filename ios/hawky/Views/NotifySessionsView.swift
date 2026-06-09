import SwiftUI

// NotifySessionsView — dedicated subpage for the ntfy per-session allowlist.
//
// Presentation split from SettingsView so the parent Settings screen stays
// short and scannable. The parent pushes this view via NavigationLink; this
// view owns only the search UI + filtering. Toggle semantics and candidate
// enumeration match the previous inline section verbatim, so behaviour is
// unchanged — only the navigation shape moved.
//
// Empty selection (`ntfy.sessions.isEmpty`) means "All sessions" (server
// default). A non-empty set restricts ntfy pushes to those session keys.
struct NotifySessionsView: View {
    @Environment(AppContainer.self) private var container

    // Store is owned by SettingsView and passed in directly. NtfyConfigStore
    // is @Observable, so SwiftUI re-renders on mutation without @Bindable.
    let ntfy: NtfyConfigStore

    @State private var searchText: String = ""

    var body: some View {
        Form {
            if allCandidates.isEmpty {
                Section {
                    Text("No sessions yet — open a chat to populate this list.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            } else {
                Section {
                    if ntfy.sessions.isEmpty {
                        HStack(spacing: 6) {
                            Image(systemName: "info.circle")
                                .foregroundStyle(.secondary)
                            Text("All sessions — select one or more to filter.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        .accessibilityIdentifier("settings.ntfy.sessions.allBadge")
                    }

                    let filtered = filteredCandidates
                    if filtered.isEmpty {
                        Text("No sessions match \"\(searchText)\"")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .accessibilityIdentifier("settings.ntfy.sessions.emptyFilter")
                    } else {
                        ForEach(filtered, id: \.self) { key in
                            Toggle(isOn: Binding(
                                get: { ntfy.sessions.contains(key) },
                                set: { isOn in
                                    guard let transport = container.transport else { return }
                                    var next = ntfy.sessions
                                    if isOn {
                                        if !next.contains(key) { next.append(key) }
                                    } else {
                                        next.removeAll { $0 == key }
                                    }
                                    Task { await ntfy.setSessions(next, transport: transport) }
                                }
                            )) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(displayName(for: key))
                                    Text(key)
                                        .font(DesignTokens.Font.mono)
                                        .foregroundStyle(.secondary)
                                }
                            }
                            .accessibilityIdentifier("settings.ntfy.sessions.toggle.\(key)")
                            .disabled(container.transport == nil)
                        }
                    }
                } footer: {
                    Text("Selected sessions forward ntfy pushes to your subscription.")
                }
            }
        }
        .tint(DesignTokens.accent)
        .navigationTitle("Sessions to notify")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(
            text: $searchText,
            placement: .navigationBarDrawer(displayMode: .always),
            prompt: "Search sessions"
        )
        .accessibilityIdentifier("settings.ntfy.sessions.subpage")
    }

    // Merges SessionStore (live + recently persisted from `session.list`) with
    // any keys already in the allowlist but not yet rehydrated locally — keeps
    // toggling off a stale entry possible. Same logic as the old inline view.
    private var allCandidates: [String] {
        var seen = Set<String>()
        var out: [String] = []
        for s in container.sessionStore.sessions where !s.isArchived {
            if seen.insert(s.key).inserted { out.append(s.key) }
        }
        for key in ntfy.sessions where seen.insert(key).inserted {
            out.append(key)
        }
        return out
    }

    private var filteredCandidates: [String] {
        let q = searchText.trimmingCharacters(in: .whitespaces).lowercased()
        guard !q.isEmpty else { return allCandidates }
        return allCandidates.filter { key in
            if key.lowercased().contains(q) { return true }
            return displayName(for: key).lowercased().contains(q)
        }
    }

    private func displayName(for key: String) -> String {
        if let match = container.sessionStore.sessions.first(where: { $0.key == key }) {
            return match.displayName
        }
        return SessionStore.defaultDisplayName(for: key)
    }
}
