import Foundation
import Testing
@testable import hawky

@Suite @MainActor
struct RecordingManifestStoreTests {
    @Test func storesKeyframesWithOffsetsRelativeToRecordingStart() throws {
        let directory = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }

        let store = RecordingManifestStore(directory: directory)
        store.start(
            recordingID: "rec-20260528-120000",
            audioFileName: "rec-20260528-120000.wav",
            source: .rayBan,
            startNs: 10_000_000_000
        )

        let first = store.ingestKeyframe(jpegBytes: Data([0x01, 0x02]), capturedAtNs: 10_250_000_000)
        let second = store.ingestKeyframe(jpegBytes: Data([0x03, 0x04]), capturedAtNs: 12_000_000_000)
        store.stop()

        let manifest = try #require(store.load(recordingID: "rec-20260528-120000"))
        #expect(manifest.recordingID == "rec-20260528-120000")
        #expect(manifest.audioFileName == "rec-20260528-120000.wav")
        #expect(manifest.source == .rayBan)
        #expect(manifest.videoMode == .keyframes)
        #expect(manifest.keyframes.map(\.offsetMilliseconds) == [250, 2_000])
        #expect(first?.fileName == "rec-20260528-120000.frame0000.jpg")
        #expect(second?.fileName == "rec-20260528-120000.frame0001.jpg")
        #expect(FileManager.default.fileExists(atPath: directory.appendingPathComponent("rec-20260528-120000.frame0000.jpg").path))
        #expect(FileManager.default.fileExists(atPath: directory.appendingPathComponent("rec-20260528-120000.manifest.json").path))
    }

    @Test func deleteArtifactsRemovesManifestAndFramesWithAudio() throws {
        let directory = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }

        let store = RecordingManifestStore(directory: directory)
        let audioURL = directory.appendingPathComponent("rec-20260528-120001.wav")
        try Data([0xAA]).write(to: audioURL)

        store.start(
            recordingID: "rec-20260528-120001",
            audioFileName: audioURL.lastPathComponent,
            source: .iPhone,
            startNs: 100
        )
        _ = store.ingestKeyframe(jpegBytes: Data([0xBB]), capturedAtNs: 200)
        store.stop()

        let manifest = try #require(store.load(forAudioURL: audioURL))
        store.deleteArtifacts(forAudioURL: audioURL, manifest: manifest)

        #expect(!FileManager.default.fileExists(atPath: audioURL.path))
        #expect(!FileManager.default.fileExists(atPath: directory.appendingPathComponent("rec-20260528-120001.frame0000.jpg").path))
        #expect(!FileManager.default.fileExists(atPath: directory.appendingPathComponent("rec-20260528-120001.manifest.json").path))
    }

    private func makeTemporaryDirectory() throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("RecordingManifestStoreTests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }
}
