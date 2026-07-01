import SwiftUI

/// Floating live-camera preview overlaid on the Live tab. A single, always-mounted
/// `VideoPreviewView` shows the iPhone camera in real time (not the 1fps keyframes
/// that feed the model). Tapping the small window expands it to fullscreen by
/// simply animating its frame from the top-right corner down to fill the screen;
/// tapping the minimize button (or the video) shrinks it back.
///
/// Deliberately simple: one preview layer, one animated frame. No second preview
/// view, no `matchedGeometryEffect`, no `fullScreenCover` — those rebuild the
/// `AVCaptureVideoPreviewLayer` and stall. While small, the window snaps to the
/// nearest corner on release. Ray-Ban preview + video-stream parity are Phase 2. (#415)
struct LivePiPView: View {
    let store: LiveSessionStore
    /// Owned by `LiveView` so it can hide the nav bar / status bar while the
    /// video is fullscreen.
    @Binding var isFullscreen: Bool

    /// Which side the window is docked to. Determines the snap-to X position and
    /// the direction it hides toward.
    @State private var edge: HorizontalEdge = .trailing
    /// Vertical center of the window as a fraction of the container height
    /// (0…1). The window snaps horizontally to an edge but stays at whatever
    /// height it was dropped.
    @State private var verticalFraction: CGFloat = 0.12
    /// True once the user has swiped the window off its docked edge. Only a thin
    /// peek tab shows; tapping it (or the tab) brings the window back. (#415)
    @State private var isHidden = false
    @GestureState private var activeDrag: CGSize = .zero

    private let pipSize = CGSize(width: 120, height: 160)
    private let edgeInset: CGFloat = 16
    private let pipCornerRadius: CGFloat = 14

    private enum HorizontalEdge { case leading, trailing }

    var body: some View {
        if store.isStreamingVisual, hasVideoSource {
            GeometryReader { proxy in
                let frame = videoFrame(in: proxy.size)

                ZStack {
                    if isFullscreen {
                        Color.black.ignoresSafeArea()
                    }

                    if isHidden && !isFullscreen {
                        // Hidden: don't render the video at all — just a small
                        // gray tab with an arrow pointing inward. Tap to restore.
                        hiddenTab(in: proxy.size)
                    } else {
                        // The single video surface. Only its frame / corner /
                        // position change between PiP and fullscreen — the
                        // preview layer is never rebuilt, so the expand stays
                        // smooth.
                        videoContent
                            .frame(width: frame.width, height: frame.height)
                            .clipShape(RoundedRectangle(cornerRadius: isFullscreen ? 0 : pipCornerRadius, style: .continuous))
                            .overlay {
                                if !isFullscreen {
                                    RoundedRectangle(cornerRadius: pipCornerRadius, style: .continuous)
                                        .strokeBorder(Color.white.opacity(0.3), lineWidth: 1)
                                }
                            }
                            .overlay(alignment: .topLeading) {
                                if !isFullscreen { liveBadge }
                            }
                            .overlay(alignment: .bottomTrailing) {
                                if !isFullscreen { flipCameraButton(size: 32, iconSize: 14) }
                            }
                            .shadow(color: .black.opacity(isFullscreen ? 0 : 0.5), radius: 8, y: 4)
                            .contentShape(Rectangle())
                            // Tap the small window to expand; in fullscreen a
                            // single tap does nothing — use the controls below.
                            .onTapGesture { if !isFullscreen { setFullscreen(true) } }
                            .position(frame.center)
                            .gesture(isFullscreen ? nil : pipDragGesture(in: proxy.size))
                    }

                    if isFullscreen {
                        fullscreenOverlay(in: proxy.size)
                    }
                }
                .animation(.spring(response: 0.4, dampingFraction: 0.85), value: isFullscreen)
                .animation(.spring(response: 0.35, dampingFraction: 0.8), value: edge)
                .animation(.spring(response: 0.35, dampingFraction: 0.8), value: isHidden)
                .animation(.interactiveSpring(), value: activeDrag)
            }
            .ignoresSafeArea(isFullscreen ? .all : [])
            .ignoresSafeArea(.keyboard)
        }
    }

    // MARK: - Video source

    /// True when there's something to preview: the iPhone capture session, or a
    /// streaming Ray-Ban feed.
    private var hasVideoSource: Bool {
        store.visualCapture != nil || store.rayBanVideo != nil
    }

    /// iPhone uses an `AVCaptureVideoPreviewLayer`; Ray-Ban has no capture
    /// session, so we render its published `latestFrame` as an aspect-fill Image
    /// that updates as new frames arrive. (#415)
    @ViewBuilder
    private var videoContent: some View {
        if let capture = store.visualCapture {
            VideoPreviewView(capture: capture)
        } else if let glasses = store.rayBanVideo {
            GlassesPreview(stream: glasses)
        } else {
            Color.black
        }
    }

    // MARK: - Frame (size + center) for the current state

    private func videoFrame(in container: CGSize) -> (width: CGFloat, height: CGFloat, center: CGPoint) {
        if isFullscreen {
            return (container.width, container.height, CGPoint(x: container.width / 2, y: container.height / 2))
        }
        return (pipSize.width, pipSize.height, pipCenter(in: container))
    }

    // MARK: - Interaction

    private func setFullscreen(_ value: Bool) {
        withAnimation(.spring(response: 0.4, dampingFraction: 0.85)) {
            isFullscreen = value
        }
    }

    private func setHidden(_ value: Bool) {
        withAnimation(.spring(response: 0.35, dampingFraction: 0.8)) {
            isHidden = value
        }
    }

    /// The marker shown when the window is hidden: a small gray tab flush to the
    /// docked edge with a chevron pointing back toward the screen. Tap to bring
    /// the video window back. (#415, ref: chayanforyou/calling-app-pip-demo-ios)
    private func hiddenTab(in container: CGSize) -> some View {
        let tabWidth: CGFloat = 22
        let hitWidth: CGFloat = 44
        let tabHeight: CGFloat = 54
        let isTrailing = edge == .trailing
        // Half-pill: rounded on the inner side, flush to the screen edge.
        let centerX = isTrailing
            ? container.width - hitWidth / 2
            : hitWidth / 2
        let centerY = min(max(container.height * verticalFraction, tabHeight),
                          container.height - tabHeight)

        return Button {
            setHidden(false)
        } label: {
            Image(systemName: isTrailing ? "chevron.left" : "chevron.right")
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(.white.opacity(0.9))
                .frame(width: tabWidth, height: tabHeight)
                .background(Color(white: 0.35).opacity(0.9))
                .clipShape(
                    .rect(
                        topLeadingRadius: isTrailing ? 12 : 0,
                        bottomLeadingRadius: isTrailing ? 12 : 0,
                        bottomTrailingRadius: isTrailing ? 0 : 12,
                        topTrailingRadius: isTrailing ? 0 : 12
                    )
                )
                .shadow(color: .black.opacity(0.3), radius: 4, x: isTrailing ? -2 : 2)
                .frame(width: hitWidth, height: tabHeight, alignment: isTrailing ? .trailing : .leading)
        }
            .buttonStyle(.plain)
            .frame(width: hitWidth, height: tabHeight)
            .contentShape(Rectangle())
            .position(x: centerX, y: centerY)
            .transition(.opacity)
            .accessibilityLabel("Show camera preview")
            .accessibilityIdentifier("live.pip.hiddenTab")
    }

    private func pipDragGesture(in container: CGSize) -> some Gesture {
        DragGesture()
            .updating($activeDrag) { value, state, _ in
                state = value.translation
            }
            .onEnded { value in
                let dockedX = dockedX(for: edge, in: container)
                let releasedX = dockedX + value.translation.width

                // Pick the side: nearest edge by released X, unless the drag was
                // clearly a flick toward one side.
                let snappedEdge: HorizontalEdge = releasedX < container.width / 2 ? .leading : .trailing
                edge = snappedEdge

                // Remember the vertical position so it stays where it was dropped.
                let centerY = container.height * verticalFraction + value.translation.height
                verticalFraction = clampVerticalFraction(centerY, in: container)

                // Swiping outward past a threshold past the docked edge hides the
                // window to a peek; an outward flick does the same.
                let pushedOutward = (snappedEdge == .trailing && value.translation.width > 60)
                    || (snappedEdge == .leading && value.translation.width < -60)
                withAnimation(.spring(response: 0.35, dampingFraction: 0.8)) {
                    isHidden = pushedOutward
                }
            }
    }

    private var liveBadge: some View {
        Text("LIVE")
            .font(.system(size: 9, weight: .bold))
            .foregroundStyle(.white)
            .padding(.horizontal, 6)
            .padding(.vertical, 3)
            .background(Color.red.opacity(0.85), in: Capsule())
            .padding(6)
    }

    // MARK: - Fullscreen chrome

    /// Overlaid controls + transcript for the fullscreen video, mirroring
    /// the video-stream overlay shape: a top status row with a minimize button,
    /// the latest transcript lines that don't block the video, and a bottom
    /// control bar (hang up + flip). (#415)
    private func fullscreenOverlay(in container: CGSize) -> some View {
        VStack(spacing: 0) {
            // Top row: minimize button, nudged down so it clears the notch /
            // Dynamic Island.
            HStack {
                statusPill
                Spacer()
                GlassCircleButton(
                    icon: "arrow.down.right.and.arrow.up.left",
                    size: DesignTokens.LiveControl.functionSize,
                    iconSize: 16
                ) {
                    setFullscreen(false)
                }
                .accessibilityLabel("Minimize video")
                .accessibilityIdentifier("live.fullscreenVideo.minimize")
            }
            .padding(.horizontal, 16)
            .padding(.top, 56)

            Spacer()

            transcriptOverlay

            controlBar
                .padding(.bottom, 36)
        }
        .frame(width: container.width, height: container.height)
    }

    private var statusPill: some View {
        Text(store.phase.label)
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(.white)
            .shadow(color: .black.opacity(0.55), radius: 2, y: 1)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .softGlass(in: Capsule())
    }

    /// The last few transcript lines, faded over the video like a caption track
    /// so they read without blocking the feed.
    private var transcriptOverlay: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(recentTranscript) { entry in
                Text(liveText(for: entry))
                    .font(.system(size: 15, weight: entry.role == .assistant ? .semibold : .regular))
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .shadow(color: .black.opacity(0.7), radius: 3, y: 1)
            }
        }
        .padding(.horizontal, 20)
        .padding(.bottom, 16)
        .allowsHitTesting(false)
    }

    private var controlBar: some View {
        HStack(spacing: 28) {
            GlassCircleButton(
                icon: "phone.down.fill",
                size: 68,
                iconSize: 26,
                style: .destructive,
                role: .destructive
            ) {
                Task { await store.stop() }
                setFullscreen(false)
            }
            .accessibilityLabel("End Live session")
            .accessibilityIdentifier("live.fullscreenVideo.hangup")

            // Flip only applies to the iPhone camera; Ray-Ban has a single feed.
            if store.visualCapture != nil {
                flipCameraButton(size: 56, iconSize: 22, filled: true)
            }
        }
    }

    @ViewBuilder
    private func flipCameraButton(size: CGFloat, iconSize: CGFloat, filled: Bool = false) -> some View {
        if store.visualCapture != nil {
            GlassCircleButton(
                icon: filled ? "arrow.triangle.2.circlepath.camera.fill" : "arrow.triangle.2.circlepath.camera",
                size: size,
                iconSize: iconSize
            ) {
                Task { await store.toggleCameraPosition() }
            }
            .padding(filled ? 0 : 8)
            .accessibilityLabel("Flip camera")
            .accessibilityIdentifier(filled ? "live.fullscreenVideo.flipCamera" : "live.pip.flipCamera")
        }
    }

    /// Up to the last 3 user/assistant lines for the caption overlay.
    private var recentTranscript: [LiveConversationEntry] {
        store.conversation
            .filter { ($0.role == .user || $0.role == .assistant) && $0.imageData == nil && !liveText(for: $0).isEmpty }
            .suffix(3)
    }

    /// In-flight streamed text for an entry, else its committed text (#623).
    private func liveText(for entry: LiveConversationEntry) -> String {
        store.streamingText.text[entry.id] ?? entry.text
    }

    // MARK: - Edge geometry

    /// Live PiP center while small (and visible): snapped to the docked edge
    /// horizontally, free vertically, plus any in-flight drag. (When hidden the
    /// window isn't drawn — `hiddenTab` shows instead.)
    private func pipCenter(in container: CGSize) -> CGPoint {
        let proposedX = dockedX(for: edge, in: container) + activeDrag.width
        let proposedY = container.height * verticalFraction + activeDrag.height

        let minX = pipSize.width / 2 + edgeInset
        let maxX = container.width - pipSize.width / 2 - edgeInset
        let minY = pipSize.height / 2 + edgeInset
        let maxY = container.height - pipSize.height / 2 - edgeInset
        return CGPoint(
            x: min(max(proposedX, minX), maxX),
            y: min(max(proposedY, minY), maxY)
        )
    }

    /// X of the window center when docked to the given edge (not hidden).
    private func dockedX(for edge: HorizontalEdge, in container: CGSize) -> CGFloat {
        switch edge {
        case .leading: return pipSize.width / 2 + edgeInset
        case .trailing: return container.width - pipSize.width / 2 - edgeInset
        }
    }

    private func clampVerticalFraction(_ centerY: CGFloat, in container: CGSize) -> CGFloat {
        let minY = pipSize.height / 2 + edgeInset
        let maxY = container.height - pipSize.height / 2 - edgeInset
        let clamped = min(max(centerY, minY), maxY)
        return container.height > 0 ? clamped / container.height : verticalFraction
    }
}

/// Renders a Ray-Ban Meta feed by observing `GlassesVideoStream.latestFrame`.
/// Glasses frames don't come from an `AVCaptureSession`, so there's no preview
/// layer — we draw the most recent decoded `UIImage`, aspect-fill, and let
/// `@ObservedObject` refresh it as new frames are published. (#415)
private struct GlassesPreview: View {
    @ObservedObject var stream: GlassesVideoStream

    var body: some View {
        ZStack {
            Color.black
            if let frame = stream.latestFrame {
                Image(uiImage: frame)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
            }
        }
        .clipped()
    }
}
