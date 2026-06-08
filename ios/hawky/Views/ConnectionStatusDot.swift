import SwiftUI

// Small colored dot reflecting ConnectionStore.status. Tap opens a debug
// sheet with status text, connection id, and Refresh/Reconnect actions.
struct ConnectionStatusDot: View {
    let status: ConnectionStore.Status
    let lastError: String?

    @Environment(AppContainer.self) private var container
    @State private var showSheet = false

    private var color: Color {
        switch status {
        case .idle: return DesignTokens.Status.neutral
        case .connecting: return DesignTokens.Status.warning
        case .connected: return DesignTokens.Status.success
        case .error, .abandoned: return DesignTokens.Status.error
        }
    }

    private var statusText: String {
        switch status {
        case .idle: return "Not connected"
        case .connecting: return "Connecting…"
        case .connected(let id): return "Connected (\(id.prefix(8)))"
        case .error(let msg): return "Error: \(msg)"
        case .abandoned: return "Abandoned"
        }
    }

    private var connectionId: String? {
        if case .connected(let id) = status { return id }
        return nil
    }

    var body: some View {
        Button {
            showSheet = true
        } label: {
            Circle()
                .fill(color)
                .frame(width: 10, height: 10)
                .accessibilityLabel("Connection status: \(statusText)")
        }
        .accessibilityIdentifier("connectionStatusDot")
        .sheet(isPresented: $showSheet) {
            ConnectionDebugSheet(
                statusText: statusText,
                connectionId: connectionId,
                lastError: lastError,
                dotColor: color
            )
            .environment(container)
            .presentationDetents([.medium])
            .presentationDragIndicator(.visible)
        }
    }
}

// The sheet body is a separate view so it can be exercised in isolation
// (see ConnectionDebugSheetTests). Amber-accent buttons match DesignTokens.
struct ConnectionDebugSheet: View {
    let statusText: String
    let connectionId: String?
    let lastError: String?
    let dotColor: Color

    @Environment(AppContainer.self) private var container
    @Environment(\.dismiss) private var dismiss

    @State private var isBusy = false
    @State private var actionMessage: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            header
            statusBlock
            if let lastError {
                errorBlock(lastError)
            }
            if let actionMessage {
                Text(actionMessage)
                    .font(DesignTokens.Font.mono)
                    .foregroundStyle(DesignTokens.tertiaryText)
                    .accessibilityIdentifier("connectionDebugSheet.actionMessage")
            }
            Spacer()
            buttons
        }
        .padding(20)
    }

    private var header: some View {
        HStack(spacing: 10) {
            Circle().fill(dotColor).frame(width: 10, height: 10)
            Text("Connection")
                .font(DesignTokens.Font.assistant)
                .accessibilityIdentifier("connectionDebugSheet")
        }
    }

    private var statusBlock: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(statusText)
                .font(DesignTokens.Font.assistant)
                .accessibilityIdentifier("connectionDebugSheet.statusText")
            if let connectionId {
                Text("conn-id: \(connectionId)")
                    .font(DesignTokens.Font.mono)
                    .foregroundStyle(DesignTokens.tertiaryText)
                    .accessibilityIdentifier("connectionDebugSheet.connectionId")
            }
        }
    }

    private func errorBlock(_ msg: String) -> some View {
        Text(msg)
            .font(DesignTokens.Font.mono)
            .foregroundStyle(DesignTokens.Status.error)
            .accessibilityIdentifier("connectionDebugSheet.lastError")
    }

    private var buttons: some View {
        VStack(spacing: 10) {
            Button {
                Task { await reloadHistoryTapped() }
            } label: {
                Text("Refresh session")
                    .frame(maxWidth: .infinity)
            }
            .secondaryPanelAction()
            .accessibilityIdentifier("connectionDebugSheet.refreshButton")
            .disabled(isBusy)

            Button {
                Task { await reconnectTapped() }
            } label: {
                Text("Reconnect")
                    .frame(maxWidth: .infinity)
            }
            .primaryPanelAction()
            .accessibilityIdentifier("connectionDebugSheet.reconnectButton")
            .disabled(isBusy)

            Button(role: .cancel) {
                dismiss()
            } label: {
                Text("Close")
                    .frame(maxWidth: .infinity)
            }
            .secondaryPanelAction()
            .accessibilityIdentifier("connectionDebugSheet.closeButton")
        }
    }

    private func reloadHistoryTapped() async {
        isBusy = true
        defer { isBusy = false }
        actionMessage = "Refreshing…"
        do {
            let n = try await container.reloadHistory()
            actionMessage = "Loaded \(n) messages."
        } catch {
            actionMessage = "Refresh failed: \(error.localizedDescription)"
        }
    }

    private func reconnectTapped() async {
        isBusy = true
        defer { isBusy = false }
        actionMessage = "Reconnecting…"
        do {
            try await container.ensureConnected()
            actionMessage = "Reconnected."
        } catch {
            actionMessage = "Reconnect failed: \(error.localizedDescription)"
        }
    }
}
