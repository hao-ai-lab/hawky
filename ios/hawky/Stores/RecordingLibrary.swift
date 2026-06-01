import AVFoundation
import Combine
import Foundation

/// Scans `Documents/recordings/` for `rec-*` and `live-*` media files and exposes
/// them to the Recording history as a sorted, observable list.
///
/// Duration is computed per-file: WAVs use the 16 kHz mono PCM16 size heuristic
/// (good enough for the display — same bitrate used by the Record tab's
/// file-info row); M4A/AAC use `AVAudioFile` so the real container duration
/// is shown. Keeping WAV duration as a heuristic avoids spinning up an asset
/// for every list refresh.
///
/// Intentionally simple: no indexing, no iCloud sync, no thumbnails. Refresh is
/// explicit (`refresh()`) — callers hit it on view-appear and after a recording
/// completes. Deletion is filesystem-only and one-step (no undo, no trash).
@MainActor
final class RecordingLibrary: ObservableObject {
    struct Item: Identifiable, Equatable {
        let url: URL
        let createdAt: Date
        let sizeBytes: Int
        /// Cached duration in seconds. Computed at refresh time so the row
        /// render doesn't hit the filesystem.
        let duration: TimeInterval
        let manifest: RecordingManifest?

        var id: URL { url }
        var name: String { url.lastPathComponent }

        var sizeKB: Double { Double(sizeBytes) / 1024.0 }
        var keyframeCount: Int { manifest?.keyframes.count ?? 0 }

        var mediaLabel: String {
            guard let manifest, !manifest.keyframes.isEmpty else { return "Audio only" }
            let noun = manifest.keyframes.count == 1 ? "frame" : "frames"
            return "Audio + \(manifest.keyframes.count) \(noun)"
        }
    }

    @Published private(set) var items: [Item] = []

    private let fm = FileManager.default
    private let manifestStore = RecordingManifestStore()

    /// Extensions we recognize as recordings. WAV = uncompressed PCM we
    /// produce directly; M4A = AAC path (either recorded natively or produced
    /// by the Compress action).
    static let knownExtensions: Set<String> = ["wav", "m4a"]

    var directory: URL {
        fm.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("recordings", isDirectory: true)
    }

    func refresh() {
        let dir = directory
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)

        let keys: [URLResourceKey] = [.contentModificationDateKey, .fileSizeKey, .isRegularFileKey]
        let urls = (try? fm.contentsOfDirectory(at: dir,
                                                includingPropertiesForKeys: keys,
                                                options: [.skipsHiddenFiles])) ?? []

        let found: [Item] = urls.compactMap { url in
            let ext = url.pathExtension.lowercased()
            guard Self.knownExtensions.contains(ext) else { return nil }
            // Accept both historical Recording-tab `rec-*` names and Live-session
            // `live-*` media captured by LiveRecordingSink.
            guard Self.knownPrefixes.contains(where: { url.lastPathComponent.hasPrefix($0) }) else { return nil }
            let values = try? url.resourceValues(forKeys: Set(keys))
            let size = values?.fileSize ?? 0
            let mtime = values?.contentModificationDate ?? Date.distantPast
            let dur = Self.duration(for: url, ext: ext, sizeBytes: size)
            let manifest = manifestStore.load(forAudioURL: url)
            return Item(url: url, createdAt: mtime, sizeBytes: size, duration: dur, manifest: manifest)
        }

        self.items = found.sorted { $0.createdAt > $1.createdAt }
    }

    private static let knownPrefixes: [String] = ["rec-", "live-"]

    /// Duration for a recording. WAV: 16 kHz mono PCM16 heuristic (matches the
    /// project's default recording format). M4A: container metadata via
    /// `AVURLAsset` — covers any sample rate / bitrate the AAC encoder chose.
    private static func duration(for url: URL, ext: String, sizeBytes: Int) -> TimeInterval {
        switch ext {
        case "wav":
            let bytesPerSec = 16_000 * 2
            let payload = max(0, sizeBytes - 44)
            return Double(payload) / Double(bytesPerSec)
        case "m4a":
            guard let file = try? AVAudioFile(forReading: url) else { return 0 }
            let rate = file.processingFormat.sampleRate
            guard rate > 0 else { return 0 }
            let seconds = Double(file.length) / rate
            return seconds.isFinite && seconds > 0 ? seconds : 0
        default:
            return 0
        }
    }

    /// Best-effort delete. Refreshes the list either way so a ghost row can't
    /// linger if the file already vanished.
    func delete(_ item: Item) {
        manifestStore.deleteArtifacts(forAudioURL: item.url, manifest: item.manifest)
        refresh()
    }
}
