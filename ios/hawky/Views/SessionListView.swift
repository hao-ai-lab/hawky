import SwiftUI

// Sheet presented from ChatView: pick an existing session, create a new one, or refresh from server.
// Swipe actions wire to Hawky session.rename/pin/unpin/archive/delete.
struct SessionListView: View {
    @Environment(AppContainer.self) private var container
    @Environment(\.dismiss) private var dismiss

    @State private var showingNewAlert = false
    @State private var newName: String = ""
    @State private var isRefreshing = false
    @State private var errorMessage: String?

    @State private var showArchived = false

    @State private var searchText: String = ""
    @State private var useRegex: Bool = false

    @State private var renameTarget: SessionStore.SessionSummary?
    @State private var renameText: String = ""

    @State private var deleteTarget: SessionStore.SessionSummary?

    @State private var pendingKey: String?
    @State private var rowErrors: [String: String] = [:]

    var body: some View {
        NavigationStack {
            List {
                if useRegex, !searchText.isEmpty, !SessionListView.isValidRegex(searchText) {
                    Text("Invalid regex")
                        .font(.caption)
                        .foregroundStyle(.red)
                        .accessibilityIdentifier("sessionList.invalidRegex")
                }
                ForEach(visibleSessions) { summary in
                    SessionRowView(
                        summary: summary,
                        isActive: summary.key == container.sessionStore.activeSessionKey,
                        isPending: pendingKey == summary.key,
                        inlineError: rowErrors[summary.key]
                    )
                    .contentShape(Rectangle())
                    .onTapGesture { select(summary.key) }
                    .accessibilityIdentifier("sessionList.row.\(summary.key)")
                    .swipeActions(edge: .leading, allowsFullSwipe: false) {
                        Button {
                            renameText = summary.displayName
                            renameTarget = summary
                        } label: {
                            Label("Rename", systemImage: "pencil")
                        }
                        .tint(.blue)
                    }
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        Button(role: .destructive) {
                            deleteTarget = summary
                        } label: {
                            Label("Delete", systemImage: "trash")
                        }
                        Button {
                            perform(.archiveToggle, on: summary)
                        } label: {
                            Label(
                                summary.isArchived ? "Unarchive" : "Archive",
                                systemImage: summary.isArchived ? "tray.and.arrow.up" : "archivebox"
                            )
                        }
                        .tint(.gray)
                        Button {
                            perform(.pinToggle, on: summary)
                        } label: {
                            Label(
                                summary.isPinned ? "Unpin" : "Pin",
                                systemImage: summary.isPinned ? "pin.slash" : "pin"
                            )
                        }
                        .tint(.orange)
                    }
                }
            }
            .listStyle(.insetGrouped)
            .overlay {
                if visibleSessions.isEmpty {
                    if searchText.isEmpty {
                        ContentUnavailableView(
                            "No Sessions",
                            systemImage: "bubble.left.and.bubble.right",
                            description: Text("Conversations you start show up here.")
                        )
                    } else {
                        ContentUnavailableView.search(text: searchText)
                    }
                }
            }
            .navigationTitle("Sessions")
            .navigationBarTitleDisplayMode(.inline)
            .searchable(text: $searchText, prompt: "Search sessions")
            .autocorrectionDisabled()
            .textInputAutocapitalization(.never)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Done") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Toggle("Show archived", isOn: $showArchived)
                        Toggle("Regex (.*)", isOn: $useRegex)
                    } label: {
                        Image(systemName: "line.3.horizontal.decrease.circle")
                    }
                    .accessibilityIdentifier("sessionList.filter")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        refresh()
                    } label: {
                        if isRefreshing {
                            ProgressView()
                        } else {
                            Image(systemName: "arrow.clockwise")
                        }
                    }
                    .accessibilityIdentifier("sessionList.refresh")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        newName = ""
                        showingNewAlert = true
                    } label: {
                        Image(systemName: "plus")
                    }
                    .accessibilityIdentifier("sessionList.new")
                }
            }
            .alert("New session", isPresented: $showingNewAlert) {
                TextField("name", text: $newName)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.asciiCapable)
                    .textContentType(.none)
                    .submitLabel(.done)
                Button("Cancel", role: .cancel) {}
                Button("Create") { createTapped() }
            } message: {
                Text("Creates ios:<slug>. Slug is lowercased, spaces become hyphens.")
            }
            .alert("Rename session", isPresented: renameBinding) {
                TextField("name", text: $renameText)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.asciiCapable)
                    .textContentType(.none)
                    .submitLabel(.done)
                Button("Cancel", role: .cancel) { renameTarget = nil }
                Button("Save") { renameConfirmed() }
            }
            .confirmationDialog(
                deleteTarget.map { "Delete \($0.displayName)?" } ?? "Delete?",
                isPresented: deleteBinding,
                titleVisibility: .visible
            ) {
                Button("Delete", role: .destructive) { deleteConfirmed() }
                Button("Cancel", role: .cancel) { deleteTarget = nil }
            } message: {
                Text("This removes the session and its history on the gateway. Cannot be undone.")
            }
            .alert("Error", isPresented: errorBinding) {
                Button("OK", role: .cancel) { errorMessage = nil }
            } message: {
                Text(errorMessage ?? "")
            }
        }
    }

    // MARK: - Derived

    private var visibleSessions: [SessionStore.SessionSummary] {
        let all = container.sessionStore.sessions
        let archiveFiltered = showArchived ? all : all.filter { !$0.isArchived }
        let searched = SessionListView.filter(archiveFiltered, query: searchText, useRegex: useRegex)
        let sorted = SessionStore.sorted(searched)
        if showArchived {
            let live = sorted.filter { !$0.isArchived }
            let gone = sorted.filter { $0.isArchived }
            return live + gone
        }
        return sorted
    }

    // Pure filter, extracted for unit tests. Matches displayName OR sessionKey.
    // Invalid regex → return input unchanged (caller shows "Invalid regex" caption).
    static func filter(_ input: [SessionStore.SessionSummary], query: String, useRegex: Bool) -> [SessionStore.SessionSummary] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        if q.isEmpty { return input }
        if useRegex {
            guard let re = try? NSRegularExpression(pattern: q, options: [.caseInsensitive]) else {
                return input
            }
            return input.filter { s in
                let name = s.displayName; let key = s.key
                let r1 = NSRange(name.startIndex..., in: name)
                let r2 = NSRange(key.startIndex..., in: key)
                return re.firstMatch(in: name, range: r1) != nil || re.firstMatch(in: key, range: r2) != nil
            }
        }
        let lq = q.lowercased()
        return input.filter { $0.displayName.lowercased().contains(lq) || $0.key.lowercased().contains(lq) }
    }

    static func isValidRegex(_ pattern: String) -> Bool {
        (try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive])) != nil
    }

    private var errorBinding: Binding<Bool> {
        Binding(get: { errorMessage != nil }, set: { if !$0 { errorMessage = nil } })
    }
    private var renameBinding: Binding<Bool> {
        Binding(get: { renameTarget != nil }, set: { if !$0 { renameTarget = nil } })
    }
    private var deleteBinding: Binding<Bool> {
        Binding(get: { deleteTarget != nil }, set: { if !$0 { deleteTarget = nil } })
    }

    // MARK: - Actions

    private enum SwipeAction { case pinToggle, archiveToggle }

    private func perform(_ action: SwipeAction, on summary: SessionStore.SessionSummary) {
        let key = summary.key
        pendingKey = key
        Task {
            defer { if pendingKey == key { pendingKey = nil } }
            do {
                switch action {
                case .pinToggle:
                    if summary.isPinned { try await container.unpin(key: key) }
                    else { try await container.pin(key: key) }
                case .archiveToggle:
                    if summary.isArchived { try await container.unarchive(key: key) }
                    else { try await container.archive(key: key) }
                }
            } catch {
                flashRowError(key: key, message: shortError(error))
            }
        }
    }

    private func renameConfirmed() {
        guard let target = renameTarget else { return }
        let newText = renameText.trimmingCharacters(in: .whitespacesAndNewlines)
        renameTarget = nil
        guard !newText.isEmpty else { return }
        pendingKey = target.key
        Task {
            defer { if pendingKey == target.key { pendingKey = nil } }
            do {
                try await container.rename(key: target.key, to: newText)
            } catch {
                flashRowError(key: target.key, message: shortError(error))
            }
        }
    }

    private func deleteConfirmed() {
        guard let target = deleteTarget else { return }
        deleteTarget = nil
        pendingKey = target.key
        Task {
            defer { if pendingKey == target.key { pendingKey = nil } }
            do {
                try await container.delete(key: target.key)
            } catch {
                flashRowError(key: target.key, message: shortError(error))
            }
        }
    }

    private func select(_ key: String) {
        Task {
            do {
                try await container.switchSession(to: key)
                dismiss()
            } catch let e as AppContainerError {
                if case .switchFailed(let reason) = e { errorMessage = reason }
            } catch {
                errorMessage = "Switch failed"
            }
        }
    }

    private func refresh() {
        guard !isRefreshing else { return }
        isRefreshing = true
        Task {
            defer { isRefreshing = false }
            do {
                try await container.refreshSessionList()
            } catch {
                errorMessage = "Refresh failed: \(error)"
            }
        }
    }

    private func createTapped() {
        let trimmed = newName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let slug = slugify(trimmed)
        guard !slug.isEmpty else {
            errorMessage = "Invalid name"
            return
        }
        let key = "ios:\(slug)"
        Task {
            do {
                try await container.newSession(key: key, displayName: trimmed)
                dismiss()
            } catch {
                errorMessage = "Create failed: \(error)"
            }
        }
    }

    private func flashRowError(key: String, message: String) {
        rowErrors[key] = message
        Task {
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            if rowErrors[key] == message { rowErrors[key] = nil }
        }
    }

    private func shortError(_ error: Error) -> String {
        let s = "\(error)"
        return s.count > 120 ? String(s.prefix(120)) + "…" : s
    }

    private func slugify(_ s: String) -> String {
        let lower = s.lowercased()
        var out = ""
        for ch in lower {
            if ch.isLetter || ch.isNumber {
                out.append(ch)
            } else if ch == " " || ch == "_" || ch == "-" {
                out.append("-")
            }
        }
        while out.contains("--") { out = out.replacingOccurrences(of: "--", with: "-") }
        return out.trimmingCharacters(in: CharacterSet(charactersIn: "-"))
    }
}

private struct SessionRowView: View {
    let summary: SessionStore.SessionSummary
    let isActive: Bool
    let isPending: Bool
    let inlineError: String?

    var body: some View {
        HStack(spacing: 8) {
            if summary.isPinned {
                Image(systemName: "pin.fill")
                    .font(.caption2)
                    .foregroundStyle(.orange)
            }
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(summary.displayName)
                        .font(.body)
                        .fontWeight(isActive ? .semibold : .regular)
                        .foregroundStyle(rowTint)
                    if summary.isArchived {
                        Text("archived")
                            .font(.caption2)
                            .foregroundStyle(DesignTokens.tertiaryText)
                    }
                }
                Text(summary.key)
                    .font(DesignTokens.Font.mono)
                    .foregroundStyle(DesignTokens.tertiaryText)
                if let err = inlineError {
                    Text(err)
                        .font(.caption2)
                        .foregroundStyle(.red)
                        .lineLimit(2)
                }
            }
            Spacer(minLength: 0)
            if isPending {
                ProgressView().controlSize(.small)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .opacity(summary.isArchived ? 0.55 : 1.0)
    }

    private var rowTint: Color {
        if summary.isArchived { return DesignTokens.tertiaryText }
        return isActive ? DesignTokens.accent : Color(.label)
    }
}
