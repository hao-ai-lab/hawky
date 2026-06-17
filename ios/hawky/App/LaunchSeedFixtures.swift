import Foundation

@MainActor
struct LaunchSeedData: Equatable {
    let connectionID: String
    let activeSessionKey: String
    let sessions: [SessionStore.SessionSummary]
    let messagesBySession: [String: [ChatStore.Message]]
    let connectionError: String?

    func messages(for sessionKey: String) -> [ChatStore.Message] {
        messagesBySession[sessionKey] ?? []
    }
}

#if DEBUG

@MainActor
enum LaunchSeedFixtures {
    static func data(
        for profile: LaunchConfiguration.SeedProfile,
        fallbackSession: LaunchConfiguration.SeededSession?
    ) -> LaunchSeedData {
        let base = baseSession(fallbackSession)
        switch profile {
        case .none, .empty, .recordings:
            return LaunchSeedData(
                connectionID: base.connectionID,
                activeSessionKey: base.sessionKey,
                sessions: [summary(base.sessionKey, base.displayName, minutesAgo: 4)],
                messagesBySession: [:],
                connectionError: nil
            )
        case .chatPopulated:
            return LaunchSeedData(
                connectionID: base.connectionID,
                activeSessionKey: base.sessionKey,
                sessions: [summary(base.sessionKey, base.displayName, minutesAgo: 1)],
                messagesBySession: [
                    base.sessionKey: mainMessages()
                ],
                connectionError: nil
            )
        case .sessions:
            return LaunchSeedData(
                connectionID: base.connectionID,
                activeSessionKey: base.sessionKey,
                sessions: sessionList(base: base),
                messagesBySession: [:],
                connectionError: nil
            )
        case .mixed:
            return LaunchSeedData(
                connectionID: base.connectionID,
                activeSessionKey: base.sessionKey,
                sessions: sessionList(base: base),
                messagesBySession: [
                    base.sessionKey: mainMessages(),
                    "ios:research": researchMessages()
                ],
                connectionError: nil
            )
        case .error:
            return LaunchSeedData(
                connectionID: base.connectionID,
                activeSessionKey: base.sessionKey,
                sessions: [summary(base.sessionKey, base.displayName, minutesAgo: 4)],
                messagesBySession: [:],
                connectionError: "Seeded gateway error"
            )
        }
    }

    static func installRecordings(for profile: LaunchConfiguration.SeedProfile, fileManager: FileManager = .default) {
        let directory = fileManager
            .urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("recordings", isDirectory: true)
        try? fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        removeSeedRecordings(in: directory, fileManager: fileManager)

        guard profile == .recordings || profile == .mixed else { return }

        let recordingID = "live-seed-ui-coverage"
        let audioFileName = "\(recordingID).wav"
        let audioURL = directory.appendingPathComponent(audioFileName)
        try? wavFixtureData().write(to: audioURL, options: [.atomic])
        try? fileManager.setAttributes([.modificationDate: fixedNow], ofItemAtPath: audioURL.path)

        let manifest = RecordingManifest(
            recordingID: recordingID,
            audioFileName: audioFileName,
            source: .iPhone,
            videoMode: .none,
            keyframes: [],
            videoFileName: nil
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        if let data = try? encoder.encode(manifest) {
            let manifestURL = directory.appendingPathComponent("\(recordingID).manifest.json")
            try? data.write(to: manifestURL, options: [.atomic])
            try? fileManager.setAttributes([.modificationDate: fixedNow], ofItemAtPath: manifestURL.path)
        }
    }

    private static func baseSession(_ fallback: LaunchConfiguration.SeededSession?) -> LaunchConfiguration.SeededSession {
        fallback ?? .init(
            connectionID: "local-seed",
            sessionKey: "ios:main",
            displayName: "main"
        )
    }

    private static func sessionList(base: LaunchConfiguration.SeededSession) -> [SessionStore.SessionSummary] {
        [
            summary(base.sessionKey, base.displayName, pinned: true, minutesAgo: 1),
            summary("ios:research", "Research Notes", unreadCount: 2, minutesAgo: 8),
            summary("ios:client-demo", "Client Demo", minutesAgo: 18),
            summary("ios:archived", "Archived Follow-up", archived: true, minutesAgo: 45)
        ]
    }

    private static func mainMessages() -> [ChatStore.Message] {
        [
            message(
                id: "00000000-0000-0000-0000-000000000101",
                role: .user,
                text: "Seeded intake note for UI coverage.",
                minutesAgo: 3
            ),
            message(
                id: "00000000-0000-0000-0000-000000000102",
                role: .assistant,
                text: "Seeded assistant response with deterministic content.",
                minutesAgo: 2
            ),
            message(
                id: "00000000-0000-0000-0000-000000000103",
                role: .system,
                text: "Seeded system notice for local UI mode.",
                minutesAgo: 1
            )
        ]
    }

    private static func researchMessages() -> [ChatStore.Message] {
        [
            message(
                id: "00000000-0000-0000-0000-000000000201",
                role: .user,
                text: "Research session user question.",
                minutesAgo: 9
            ),
            message(
                id: "00000000-0000-0000-0000-000000000202",
                role: .assistant,
                text: "Research session assistant answer.",
                minutesAgo: 8
            )
        ]
    }

    private static func summary(
        _ key: String,
        _ displayName: String,
        unreadCount: Int = 0,
        pinned: Bool = false,
        archived: Bool = false,
        minutesAgo: TimeInterval
    ) -> SessionStore.SessionSummary {
        .init(
            key: key,
            displayName: displayName,
            unreadCount: unreadCount,
            isPinned: pinned,
            isArchived: archived,
            lastActivity: fixedNow.addingTimeInterval(-minutesAgo * 60)
        )
    }

    private static func message(
        id: String,
        role: ChatStore.Role,
        text: String,
        minutesAgo: TimeInterval
    ) -> ChatStore.Message {
        .init(
            id: UUID(uuidString: id)!,
            role: role,
            text: text,
            isStreaming: false,
            timestamp: fixedNow.addingTimeInterval(-minutesAgo * 60)
        )
    }

    private static func removeSeedRecordings(in directory: URL, fileManager: FileManager) {
        let urls = (try? fileManager.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        )) ?? []
        for url in urls where url.lastPathComponent.hasPrefix("live-seed-") {
            try? fileManager.removeItem(at: url)
        }
    }

    private static func wavFixtureData() -> Data {
        let sampleRate: UInt32 = 16_000
        let channels: UInt16 = 1
        let bitsPerSample: UInt16 = 16
        let seconds: UInt32 = 1
        let byteRate = sampleRate * UInt32(channels) * UInt32(bitsPerSample / 8)
        let blockAlign = channels * (bitsPerSample / 8)
        let pcmBytes = sampleRate * UInt32(channels) * UInt32(bitsPerSample / 8) * seconds

        var data = Data()
        data.append(contentsOf: "RIFF".utf8)
        appendLittleEndian(UInt32(36 + pcmBytes), to: &data)
        data.append(contentsOf: "WAVE".utf8)
        data.append(contentsOf: "fmt ".utf8)
        appendLittleEndian(UInt32(16), to: &data)
        appendLittleEndian(UInt16(1), to: &data)
        appendLittleEndian(channels, to: &data)
        appendLittleEndian(sampleRate, to: &data)
        appendLittleEndian(byteRate, to: &data)
        appendLittleEndian(blockAlign, to: &data)
        appendLittleEndian(bitsPerSample, to: &data)
        data.append(contentsOf: "data".utf8)
        appendLittleEndian(pcmBytes, to: &data)
        data.append(Data(repeating: 0, count: Int(pcmBytes)))
        return data
    }

    private static func appendLittleEndian(_ value: UInt16, to data: inout Data) {
        var littleEndian = value.littleEndian
        withUnsafeBytes(of: &littleEndian) { data.append(contentsOf: $0) }
    }

    private static func appendLittleEndian(_ value: UInt32, to data: inout Data) {
        var littleEndian = value.littleEndian
        withUnsafeBytes(of: &littleEndian) { data.append(contentsOf: $0) }
    }

    private static let fixedNow = Date(timeIntervalSince1970: 1_735_689_600)
}

#else

@MainActor
enum LaunchSeedFixtures {
    static func data(
        for profile: LaunchConfiguration.SeedProfile,
        fallbackSession: LaunchConfiguration.SeededSession?
    ) -> LaunchSeedData {
        let session = fallbackSession ?? .init(
            connectionID: "local",
            sessionKey: "ios:main",
            displayName: "main"
        )
        return LaunchSeedData(
            connectionID: session.connectionID,
            activeSessionKey: session.sessionKey,
            sessions: [
                .init(
                    key: session.sessionKey,
                    displayName: session.displayName,
                    unreadCount: 0
                )
            ],
            messagesBySession: [:],
            connectionError: nil
        )
    }

    static func installRecordings(
        for profile: LaunchConfiguration.SeedProfile,
        fileManager: FileManager = .default
    ) {}
}

#endif
