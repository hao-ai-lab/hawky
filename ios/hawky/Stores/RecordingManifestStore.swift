import Foundation

struct RecordingManifest: Codable, Equatable {
    enum VideoSource: String, Codable, Equatable {
        case iPhone = "iphone"
        case rayBan = "rayban"
    }

    enum VideoMode: String, Codable, Equatable {
        case none
        case keyframes
        case segments
        case movie
    }

    struct Keyframe: Codable, Equatable, Identifiable {
        let fileName: String
        let offsetMilliseconds: Int

        var id: String { fileName }
    }

    var recordingID: String
    var audioFileName: String
    var source: VideoSource
    var videoMode: VideoMode
    var keyframes: [Keyframe]
    var videoFileName: String?
}

@MainActor
final class RecordingManifestStore {
    private let directory: URL
    private let fm: FileManager
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder

    private var activeRecordingID: String?
    private var activeStartNs: UInt64?
    private var activeNextKeyframeIndex: Int = 0

    init(directory: URL? = nil, fileManager: FileManager = .default) {
        self.fm = fileManager
        self.directory = directory ?? fileManager
            .urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("recordings", isDirectory: true)
        self.encoder = JSONEncoder()
        self.encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        self.decoder = JSONDecoder()
    }

    func start(recordingID: String, audioFileName: String, source: RecordingManifest.VideoSource, startNs: UInt64) {
        try? fm.createDirectory(at: directory, withIntermediateDirectories: true)
        activeRecordingID = recordingID
        activeStartNs = startNs

        let existing = load(recordingID: recordingID)
        activeNextKeyframeIndex = existing?.keyframes.count ?? 0

        var manifest = existing ?? RecordingManifest(
            recordingID: recordingID,
            audioFileName: audioFileName,
            source: source,
            videoMode: .none,
            keyframes: [],
            videoFileName: nil
        )
        manifest.audioFileName = audioFileName
        manifest.source = source
        manifest.videoMode = manifest.keyframes.isEmpty ? .none : .keyframes
        save(manifest)
    }

    @discardableResult
    func ingestKeyframe(jpegBytes: Data, capturedAtNs: UInt64) -> RecordingManifest.Keyframe? {
        guard let recordingID = activeRecordingID, let startNs = activeStartNs else { return nil }
        let fileName = String(format: "%@.frame%04d.jpg", recordingID, activeNextKeyframeIndex)
        activeNextKeyframeIndex += 1

        let fileURL = directory.appendingPathComponent(fileName)
        do {
            try fm.createDirectory(at: directory, withIntermediateDirectories: true)
            try jpegBytes.write(to: fileURL, options: [.atomic])
        } catch {
            print("[RecordingManifestStore] keyframe write failed: \(error)")
            return nil
        }

        var manifest = load(recordingID: recordingID) ?? RecordingManifest(
            recordingID: recordingID,
            audioFileName: "\(recordingID).wav",
            source: .iPhone,
            videoMode: .none,
            keyframes: [],
            videoFileName: nil
        )
        let offsetNs = capturedAtNs >= startNs ? capturedAtNs - startNs : 0
        let keyframe = RecordingManifest.Keyframe(
            fileName: fileName,
            offsetMilliseconds: Int(offsetNs / 1_000_000)
        )
        manifest.videoMode = .keyframes
        manifest.keyframes.append(keyframe)
        save(manifest)
        return keyframe
    }

    func stop() {
        activeRecordingID = nil
        activeStartNs = nil
        activeNextKeyframeIndex = 0
    }

    func discardActiveRecording() {
        guard let recordingID = activeRecordingID else {
            stop()
            return
        }
        deleteArtifacts(recordingID: recordingID)
        stop()
    }

    func load(forAudioURL audioURL: URL) -> RecordingManifest? {
        load(recordingID: audioURL.deletingPathExtension().lastPathComponent)
    }

    func load(recordingID: String) -> RecordingManifest? {
        let url = manifestURL(recordingID: recordingID)
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? decoder.decode(RecordingManifest.self, from: data)
    }

    func keyframeURL(_ keyframe: RecordingManifest.Keyframe) -> URL {
        directory.appendingPathComponent(keyframe.fileName)
    }

    func shareItems(forAudioURL audioURL: URL, manifest: RecordingManifest?) -> [Any] {
        guard let manifest else { return [audioURL] }
        var items: [Any] = [audioURL, manifestURL(recordingID: manifest.recordingID)]
        items.append(contentsOf: manifest.keyframes.map { keyframeURL($0) })
        if let videoFileName = manifest.videoFileName {
            items.append(directory.appendingPathComponent(videoFileName))
        }
        return items
    }

    func deleteArtifacts(forAudioURL audioURL: URL, manifest: RecordingManifest?) {
        try? fm.removeItem(at: audioURL)
        if let manifest {
            deleteArtifacts(recordingID: manifest.recordingID)
        } else {
            try? fm.removeItem(at: manifestURL(recordingID: audioURL.deletingPathExtension().lastPathComponent))
        }
    }

    private func save(_ manifest: RecordingManifest) {
        do {
            let data = try encoder.encode(manifest)
            try data.write(to: manifestURL(recordingID: manifest.recordingID), options: [.atomic])
        } catch {
            print("[RecordingManifestStore] manifest save failed: \(error)")
        }
    }

    private func deleteArtifacts(recordingID: String) {
        if let manifest = load(recordingID: recordingID) {
            for keyframe in manifest.keyframes {
                try? fm.removeItem(at: keyframeURL(keyframe))
            }
            if let videoFileName = manifest.videoFileName {
                try? fm.removeItem(at: directory.appendingPathComponent(videoFileName))
            }
        }
        try? fm.removeItem(at: manifestURL(recordingID: recordingID))
    }

    private func manifestURL(recordingID: String) -> URL {
        directory.appendingPathComponent("\(recordingID).manifest.json")
    }
}
