import AVFoundation
import SwiftUI
import UIKit

/// Standalone recordings browser + player. Lifted out of the old Recording tab
/// (removed in favor of recording inside Live, #368) and presented from the
/// Live actions menu ("Recordings"). Self-contained: it owns its own playback
/// `Recorder`, `RecordingLibrary`, and `RecordingManifestStore` — playback is
/// independent of any active capture, so it never touches a live session.
struct RecordingsHistoryView: View {
    @Environment(\.dismiss) private var dismiss
    @StateObject private var recorder = Recorder()
    @StateObject private var library = RecordingLibrary()
    @State private var manifestStore = RecordingManifestStore()

    @State private var playingURL: URL?
    @State private var playingManifest: RecordingManifest?
    @State private var errorMessage: String?

    @State private var pendingDelete: RecordingLibrary.Item?
    // Bumped on a confirmed delete so `.sensoryFeedback` fires a success tap. (#577)
    @State private var deleteHaptic = 0
    @State private var pendingShare: RecordingLibrary.Item?
    @State private var compressingItems: [URL: Double] = [:]
    @State private var compressError: String?

    @State private var scrubbing = false
    @State private var scrubValue: TimeInterval = 0

    var body: some View {
        VStack(spacing: 0) {
            playerPanel
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
            Divider()
            itemList
        }
        .accessibilityIdentifier("screen.recordingsHistory")
        .navigationTitle("Recordings")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Done") { dismiss() }
            }
        }
        .task { library.refresh() }
        .onDisappear {
            if recorder.state == .playing || recorder.state == .paused {
                recorder.stopPlayback()
            }
        }
        .confirmationDialog(
            "Delete recording?",
            isPresented: Binding(
                get: { pendingDelete != nil },
                set: { if !$0 { pendingDelete = nil } }
            ),
            presenting: pendingDelete
        ) { item in
            Button("Delete \(item.name)", role: .destructive) {
                library.delete(item)
                deleteHaptic &+= 1
                if playingURL == item.url {
                    if recorder.state == .playing || recorder.state == .paused {
                        recorder.stopPlayback()
                    }
                    playingURL = nil
                    playingManifest = nil
                }
            }
            Button("Cancel", role: .cancel) {}
        }
        .sheet(item: $pendingShare) { item in
            ActivityView(activityItems: manifestStore.shareItems(forAudioURL: item.url, manifest: item.manifest))
                .ignoresSafeArea()
        }
        .errorAlert($errorMessage)
        .sensoryFeedback(.success, trigger: deleteHaptic)
    }

    // MARK: - Player panel

    private var selectedItem: RecordingLibrary.Item? {
        guard let playingURL else { return nil }
        return library.items.first { $0.url == playingURL }
    }

    private var playerPanel: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .center, spacing: 12) {
                Image(systemName: recorder.state == .playing ? "waveform" : "waveform.circle")
                    .font(.title2)
                    .foregroundStyle(recorder.state == .playing ? .green : .blue)
                    .frame(width: 32)
                VStack(alignment: .leading, spacing: 3) {
                    Text(selectedItem?.name ?? "Select a recording")
                        .font(DesignTokens.Font.rowTitle)
                        .lineLimit(1)
                        .accessibilityIdentifier("recordings.history.player.title")
                    Text(selectedItem.map(Self.rowSubtitle) ?? "Choose an item below to play it here.")
                        .font(DesignTokens.Font.meta)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                Spacer()
            }

            if recorder.state == .playing || recorder.state == .paused {
                playbackStrip
            } else {
                RoundedRectangle(cornerRadius: 8)
                    .fill(Color.secondary.opacity(0.08))
                    .frame(height: 96)
                    .overlay {
                        VStack(spacing: 6) {
                            Image(systemName: "play.circle")
                                .font(.title2)
                                .foregroundStyle(.secondary)
                            Text("Tap a recording below")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                    }
            }

            if let compressError {
                Text(compressError)
                    .font(.footnote)
                    .foregroundStyle(.red)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityIdentifier("recordings.history.player")
    }

    private var itemList: some View {
        List {
            ForEach(library.items) { item in
                row(item)
            }
        }
        .listStyle(.plain)
        .accessibilityIdentifier("recordings.history.list")
        .overlay {
            if library.items.isEmpty {
                ContentUnavailableView(
                    "No Recordings",
                    systemImage: "waveform",
                    description: Text("Recordings you capture during a Live session show up here.")
                )
                .accessibilityIdentifier("recordings.history.empty")
            }
        }
    }

    @ViewBuilder
    private func row(_ item: RecordingLibrary.Item) -> some View {
        let isCurrentlyPlaying = (playingURL == item.url) && recorder.state == .playing
        let isCompressing = compressingItems[item.url] != nil
        let isWav = item.url.pathExtension.lowercased() == "wav"
        HStack {
            Image(systemName: isCurrentlyPlaying ? "waveform" : "waveform.circle")
                .foregroundStyle(isCurrentlyPlaying ? .green : .secondary)
            VStack(alignment: .leading, spacing: 2) {
                Text(item.name)
                    .font(.footnote.monospaced())
                    .lineLimit(1)
                Text(Self.rowSubtitle(item))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                Label(item.mediaLabel, systemImage: item.keyframeCount > 0 ? "photo.stack" : "waveform")
                    .font(.caption2)
                    .foregroundStyle(item.keyframeCount > 0 ? .blue : .secondary)
            }
            Spacer()
            if isCompressing {
                ProgressView()
                    .controlSize(.small)
            }
        }
        .contentShape(Rectangle())
        .onTapGesture { playItem(item) }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button(role: .destructive) {
                pendingDelete = item
            } label: {
                Label("Delete", systemImage: "trash")
            }
            Button {
                pendingShare = item
            } label: {
                Label("Share", systemImage: "square.and.arrow.up")
            }
            .tint(.blue)
        }
        .contextMenu {
            Button {
                playItem(item)
            } label: {
                Label("Play", systemImage: "play")
            }
            Button {
                pendingShare = item
            } label: {
                Label("Share", systemImage: "square.and.arrow.up")
            }
            if isWav {
                Button {
                    compress(item)
                } label: {
                    Label("Compress to M4A", systemImage: "arrow.down.circle")
                }
                .disabled(isCompressing)
            }
            Button(role: .destructive) {
                pendingDelete = item
            } label: {
                Label("Delete", systemImage: "trash")
            }
        }
        .accessibilityIdentifier("recordings.history.row.\(item.name)")
    }

    // MARK: - Playback

    private var playbackStrip: some View {
        let duration = max(recorder.playbackDuration, 0.01)
        let position = scrubbing ? scrubValue : recorder.playbackPosition
        let remaining = max(0, duration - position)
        let positionBinding = Binding<Double>(
            get: { scrubbing ? scrubValue : min(recorder.playbackPosition, duration) },
            set: { scrubValue = $0 }
        )

        return VStack(spacing: 8) {
            playbackVisualPreview(position: position)

            HStack(spacing: 32) {
                Button { recorder.skipBackward(15) } label: {
                    Image(systemName: "gobackward.15").font(.title2).minimumHitTarget()
                }
                Button {
                    if recorder.state == .playing {
                        recorder.pausePlayback()
                    } else if recorder.state == .paused {
                        recorder.resumePlayback()
                    }
                } label: {
                    Image(systemName: recorder.state == .playing ? "pause.fill" : "play.fill")
                        .font(.title)
                        .minimumHitTarget()
                }
                Button { recorder.skipForward(15) } label: {
                    Image(systemName: "goforward.15").font(.title2).minimumHitTarget()
                }
            }
            .buttonStyle(.plain)
            .foregroundStyle(.primary)

            Slider(
                value: positionBinding,
                in: 0...duration,
                onEditingChanged: { editing in
                    if editing {
                        scrubbing = true
                        scrubValue = recorder.playbackPosition
                    } else {
                        scrubbing = false
                        recorder.seek(to: scrubValue)
                    }
                }
            )
            // Without these VoiceOver only announces "slider, N%". (#576)
            .accessibilityLabel("Playback position")
            .accessibilityValue("\(Self.formatTime(position)) of \(Self.formatTime(duration))")

            HStack {
                Text(Self.formatTime(position))
                Spacer()
                Text("-" + Self.formatTime(remaining))
            }
            .font(.caption.monospacedDigit())
            .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private func playbackVisualPreview(position: TimeInterval) -> some View {
        if let keyframe = nearestPlaybackKeyframe(position: position),
           let image = UIImage(contentsOfFile: manifestStore.keyframeURL(keyframe).path) {
            ZStack(alignment: .bottomTrailing) {
                Image(uiImage: image)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
                    .frame(height: 180)
                    .frame(maxWidth: .infinity)
                    .clipped()
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                Text("+\(Self.formatTime(Double(keyframe.offsetMilliseconds) / 1000.0))")
                    .font(.caption2.monospacedDigit())
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .softGlass(in: Capsule())
                    .padding(8)
            }
        }
    }

    private func nearestPlaybackKeyframe(position: TimeInterval) -> RecordingManifest.Keyframe? {
        guard let frames = playingManifest?.keyframes, !frames.isEmpty else { return nil }
        let targetMs = Int((position * 1000).rounded())
        return frames.min { abs($0.offsetMilliseconds - targetMs) < abs($1.offsetMilliseconds - targetMs) }
    }

    private func playItem(_ item: RecordingLibrary.Item) {
        errorMessage = nil
        if recorder.state == .playing {
            recorder.stopPlayback()
        }
        guard recorder.state == .idle else { return }
        recorder.lastRecordingURL = item.url
        playingURL = item.url
        playingManifest = item.manifest
        do {
            try recorder.playLastRecording()
        } catch {
            errorMessage = "Playback failed: \(error.localizedDescription)"
            playingURL = nil
            playingManifest = nil
        }
    }

    // MARK: - Compress

    private func compress(_ item: RecordingLibrary.Item) {
        guard compressingItems[item.url] == nil else { return }
        compressError = nil

        let source = item.url
        let base = source.deletingPathExtension().lastPathComponent
        let outURL = source.deletingLastPathComponent().appendingPathComponent("\(base)-compressed.m4a")
        try? FileManager.default.removeItem(at: outURL)

        let asset = AVURLAsset(url: source)
        guard let export = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetAppleM4A) else {
            compressError = "Compress: cannot create export session"
            return
        }
        export.outputURL = outURL
        export.outputFileType = .m4a
        compressingItems[source] = 0.0

        let progressTask = Task { [weak export] in
            while let e = export, !Task.isCancelled {
                let p = Double(e.progress)
                await MainActor.run { compressingItems[source] = p }
                if e.status == .completed || e.status == .failed || e.status == .cancelled { break }
                try? await Task.sleep(nanoseconds: 200_000_000)
            }
        }

        nonisolated(unsafe) let sessionRef = export
        export.exportAsynchronously {
            let status = sessionRef.status
            let errMsg = sessionRef.error?.localizedDescription
            Task { @MainActor in
                progressTask.cancel()
                compressingItems.removeValue(forKey: source)
                switch status {
                case .completed: library.refresh()
                case .failed, .cancelled: compressError = "Compress failed: \(errMsg ?? "unknown")"
                default: break
                }
            }
        }
    }

    // MARK: - Helpers

    private static func formatTime(_ t: TimeInterval) -> String {
        let total = Int(t.rounded())
        return String(format: "%d:%02d", total / 60, total % 60)
    }

    private static func rowSubtitle(_ item: RecordingLibrary.Item) -> String {
        let fmt = DateFormatter()
        fmt.dateStyle = .short
        fmt.timeStyle = .short
        return String(format: "%@ • %.1fs • %.0f KB", fmt.string(from: item.createdAt), item.duration, item.sizeKB)
    }
}

/// UIActivityViewController wrapper presented via `.sheet`. Avoids the
/// `_UIReparentingView` warnings that occur when SwiftUI `ShareLink` is
/// embedded inside `swipeActions` / `contextMenu` rows on iOS 17/18.
struct ActivityView: UIViewControllerRepresentable {
    let activityItems: [Any]
    var applicationActivities: [UIActivity]? = nil

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: activityItems, applicationActivities: applicationActivities)
    }

    func updateUIViewController(_ vc: UIActivityViewController, context: Context) {}
}

private extension View {
    /// Small alert helper so this view doesn't depend on RecordingView's.
    func errorAlert(_ message: Binding<String?>) -> some View {
        alert("Recordings", isPresented: Binding(
            get: { message.wrappedValue != nil },
            set: { if !$0 { message.wrappedValue = nil } }
        )) {
            Button("OK") { message.wrappedValue = nil }
        } message: {
            Text(message.wrappedValue ?? "")
        }
    }
}
