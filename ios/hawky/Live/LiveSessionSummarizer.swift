import Foundation

/// What to summarize. (#537 V1 — transcript only.)
enum LiveSummaryScope: String, CaseIterable, Identifiable, Equatable {
    case currentSession = "current_session"
    case pastDay = "past_day"

    var id: String { rawValue }

    var label: String {
        switch self {
        case .currentSession: return "Current session"
        case .pastDay: return "Past day"
        }
    }

    var subtitle: String {
        switch self {
        case .currentSession: return "Summarize the session you have open now."
        case .pastDay: return "Summarize all Live sessions from the past 24 hours."
        }
    }
}

enum LiveSummaryError: LocalizedError {
    case noSessions
    case notConnected
    case agent(String)
    case empty

    var errorDescription: String? {
        switch self {
        case .noSessions: return "No Live sessions found for this range."
        case .notConnected: return "Couldn't reach the Hawky gateway."
        case .agent(let m): return m
        case .empty: return "The summary came back empty. Try again."
        }
    }
}

/// V1 of the Live session summary (#537): builds a prompt from the session
/// transcript(s) — user/assistant turns and tool calls — and asks the gateway
/// agent to produce a readable recap. Audio/visual media are intentionally not
/// used yet (V2/V3); the spoken audio is already represented in the transcript
/// when input transcription is on.
@MainActor
struct LiveSessionSummarizer {
    let container: AppContainer
    let store: LiveSessionStore

    /// A dedicated session so the summary turn doesn't pollute the user's main
    /// chat history.
    private let summarySessionKey = "ios:live-summary"

    func summarize(scope: LiveSummaryScope, now: Date = Date()) async throws -> String {
        let sessions = sessions(for: scope, now: now)
        guard !sessions.isEmpty else { throw LiveSummaryError.noSessions }

        let prompt = Self.buildPrompt(scope: scope, sessions: sessions)

        try await container.ensureConnected()
        guard let transport = container.transport else { throw LiveSummaryError.notConnected }

        let client = ChatClient(transport: transport, sessionKey: summarySessionKey)
        var collected = ""
        do {
            for await event in try await client.send(prompt) {
                switch event {
                case .text(content: let chunk, replace: let replace):
                    collected = replace ? chunk : collected + chunk
                case .error(_, let message):
                    throw LiveSummaryError.agent(message)
                case .done:
                    break
                default:
                    continue
                }
            }
        } catch let error as LiveSummaryError {
            throw error
        } catch {
            throw LiveSummaryError.agent("\(error)")
        }

        let trimmed = collected.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw LiveSummaryError.empty }
        return trimmed
    }

    // MARK: - Scope selection

    private func sessions(for scope: LiveSummaryScope, now: Date) -> [LiveLocalSession] {
        let all = store.localSessions
            .filter { !$0.isArchived }
            .sorted { $0.updatedAt > $1.updatedAt }

        switch scope {
        case .currentSession:
            // The session the user has open now, not just the most recent one.
            if let current = all.first(where: { $0.id == store.currentSessionID }) {
                return [current]
            }
            return Array(all.prefix(1))
        case .pastDay:
            let cutoff = now.addingTimeInterval(-24 * 60 * 60)
            return all.filter { $0.updatedAt >= cutoff || $0.createdAt >= cutoff }
        }
    }

    // MARK: - Prompt assembly

    static func buildPrompt(scope: LiveSummaryScope, sessions: [LiveLocalSession]) -> String {
        var lines: [String] = []
        lines.append(
            """
            Summarize the following Hawky Live session transcript\(sessions.count > 1 ? "s" : "") for me. \
            Write a concise, readable recap: the key topics discussed, any decisions or \
            answers, and concrete follow-ups or to-dos. Use short headers and bullets. \
            Ignore system noise and incomplete fragments. If little of substance was said, say so briefly.
            """
        )
        lines.append("")

        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .short

        for session in sessions {
            if sessions.count > 1 {
                lines.append("=== Session: \(session.title) — \(formatter.string(from: session.createdAt)) ===")
            }
            for entry in session.conversation {
                guard let line = transcriptLine(entry) else { continue }
                lines.append(line)
            }
            lines.append("")
        }

        return lines.joined(separator: "\n")
    }

    /// One transcript line per meaningful entry. Skips system chatter and the
    /// camera-frame placeholders (no real vision in V1).
    private static func transcriptLine(_ entry: LiveConversationEntry) -> String? {
        let text = entry.text.trimmingCharacters(in: .whitespacesAndNewlines)
        switch entry.role {
        case .user:
            guard !text.isEmpty, entry.imageData == nil else { return nil }
            return "User: \(text)"
        case .assistant:
            guard !text.isEmpty else { return nil }
            return "Assistant: \(text)"
        case .tool:
            if let name = entry.toolCall?.name {
                return "[tool: \(name)]"
            }
            return nil
        case .system:
            return nil
        }
    }
}
