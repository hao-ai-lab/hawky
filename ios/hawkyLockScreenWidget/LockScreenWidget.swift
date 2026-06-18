import ActivityKit
import SwiftUI
import WidgetKit

struct LockScreenEntry: TimelineEntry {
    let date: Date
    let status: WidgetStatus
}

struct LockScreenProvider: TimelineProvider {
    func placeholder(in context: Context) -> LockScreenEntry {
        LockScreenEntry(date: .now, status: .idle)
    }

    func getSnapshot(in context: Context, completion: @escaping (LockScreenEntry) -> Void) {
        completion(LockScreenEntry(date: .now, status: WidgetStatusStore.read()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<LockScreenEntry>) -> Void) {
        let entry = LockScreenEntry(date: .now, status: WidgetStatusStore.read())
        completion(Timeline(entries: [entry], policy: .after(.now.addingTimeInterval(5 * 60))))
    }
}

struct LockScreenWidgetView: View {
    @Environment(\.widgetFamily) private var widgetFamily

    let entry: LockScreenEntry

    var body: some View {
        content
            .containerBackground(for: .widget) {
                containerBackground
            }
    }

    @ViewBuilder
    private var containerBackground: some View {
        switch widgetFamily {
        case .systemSmall, .systemMedium:
            SurfaceStyle.widgetPanelBackground
        default:
            Color.clear
        }
    }

    @ViewBuilder
    private var content: some View {
        switch widgetFamily {
        case .accessoryCircular:
            VStack(spacing: 2) {
                OwlStatusGlyph(mood: .from(entry.status), size: 24)
                Text(shortStatus)
                    .font(SurfaceStyle.WidgetFont.compactStatus)
            }
            .widgetAccentable()
        case .accessoryRectangular:
            HStack(alignment: .center, spacing: 8) {
                OwlStatusGlyph(mood: .from(entry.status), size: 24)
                    .widgetAccentable()
                VStack(alignment: .leading, spacing: 1) {
                    Text(SurfaceStyle.brandName)
                        .font(SurfaceStyle.WidgetFont.eyebrow)
                        .textCase(.uppercase)
                    Text(entry.status.primaryLabel)
                        .font(SurfaceStyle.WidgetFont.detail)
                        .lineLimit(1)
                }
            }
        case .accessoryInline:
            Label(entry.status.primaryLabel, systemImage: iconName)
        case .systemSmall:
            VStack(alignment: .leading, spacing: 8) {
                OwlStatusGlyph(mood: .from(entry.status), size: 32)
                Text(SurfaceStyle.brandName)
                    .font(SurfaceStyle.WidgetFont.title)
                Text(entry.status.primaryLabel)
                    .font(SurfaceStyle.WidgetFont.status)
                    .lineLimit(1)
                Text(entry.status.secondaryLabel)
                    .font(SurfaceStyle.WidgetFont.detail)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            .foregroundStyle(.primary)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .padding()
        case .systemMedium:
            HStack(alignment: .center, spacing: 12) {
                OwlStatusGlyph(mood: .from(entry.status), size: 42)
                VStack(alignment: .leading, spacing: 4) {
                    Text(SurfaceStyle.brandName)
                        .font(SurfaceStyle.WidgetFont.title)
                    Text(entry.status.primaryLabel)
                        .font(SurfaceStyle.WidgetFont.status)
                        .lineLimit(1)
                    Text(entry.status.secondaryLabel)
                        .font(SurfaceStyle.WidgetFont.detail)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                Spacer(minLength: 0)
            }
            .foregroundStyle(.primary)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
            .padding()
        default:
            Label(entry.status.primaryLabel, systemImage: iconName)
        }
    }

    private var iconName: String {
        if entry.status.liveState == .off, entry.status.recordingState == .on {
            return "record.circle"
        }
        switch entry.status.liveState {
        case .off:
            return "waveform"
        case .connecting:
            return "antenna.radiowaves.left.and.right"
        case .on:
            return "waveform.circle.fill"
        case .paused:
            return "pause.circle.fill"
        case .failed:
            return "exclamationmark.triangle"
        }
    }

    private var shortStatus: String {
        if entry.status.liveState == .off, entry.status.recordingState == .on {
            return "REC"
        }
        switch entry.status.liveState {
        case .off: return "OFF"
        case .connecting: return "..."
        case .on: return "ON"
        case .paused: return "PAUSE"
        case .failed: return "ERR"
        }
    }
}

struct LockScreenWidget: Widget {
    private let kind = "HawkyLockScreenWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: LockScreenProvider()) { entry in
            LockScreenWidgetView(entry: entry)
        }
        .configurationDisplayName(SurfaceStyle.brandName)
        .description("Shows a lightweight voice loop status.")
        .supportedFamilies([
            .accessoryCircular,
            .accessoryRectangular,
            .accessoryInline,
            .systemSmall,
            .systemMedium,
        ])
    }
}

struct LiveActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: LiveActivityAttributes.self) { context in
            LiveActivityLockScreenView(context: context)
                // The card tint (liveActivityBackground) is a FIXED dark colour, but
                // .primary/.secondary text is adaptive → it renders black in light mode,
                // giving black-on-dark. Pin the content to dark so the text + bordered
                // controls stay light against the dark card in both system appearances.
                .environment(\.colorScheme, .dark)
                .activityBackgroundTint(SurfaceStyle.liveActivityBackground)
                .activitySystemActionForegroundColor(SurfaceStyle.accent)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    let mood = OwlMood.from(context.state)
                    HStack(spacing: 8) {
                        OwlStatusGlyph(mood: mood, size: 40)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(SurfaceStyle.brandName)
                                .font(SurfaceStyle.WidgetFont.eyebrow)
                                .textCase(.uppercase)
                                .foregroundStyle(.secondary)
                            Text(context.state.primaryLabel)
                                .font(SurfaceStyle.WidgetFont.status)
                                .lineLimit(1)
                        }
                    }
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Text(context.state.secondaryLabel)
                        .font(SurfaceStyle.WidgetFont.detail)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 8) {
                        // Live Activities can't scroll (only Button/Toggle are
                        // interactive), so show MORE of the latest reply inline
                        // instead; full text via tapping to open the app. (#583)
                        Text(context.state.contextSummary)
                            .font(.footnote)
                            .lineLimit(4)
                        HStack(spacing: 10) {
                            if context.state.liveState == .on {
                                liveControlButton(.toggleMute, title: context.state.audioInputEnabled ? "Mute" : "Unmute", systemImage: context.state.audioInputEnabled ? "mic.slash" : "mic")
                            }
                            if showsPauseResumeButton(for: context.state) {
                                pauseResumeButton(for: context.state)
                            }
                            liveControlButton(.stopLive, title: "Stop", systemImage: "stop.fill", role: .destructive)
                        }
                    }
                }
            } compactLeading: {
                OwlStatusGlyph(mood: .from(context.state), size: 26)
            } compactTrailing: {
                Text(shortStatus(for: context.state))
                    .font(SurfaceStyle.WidgetFont.compactStatus)
                    .foregroundStyle(OwlMood.from(context.state).color)
            } minimal: {
                OwlStatusGlyph(mood: .from(context.state), size: 22)
            }
            .keylineTint(SurfaceStyle.accent)
        }
    }
}

private struct LiveActivityLockScreenView: View {
    let context: ActivityViewContext<LiveActivityAttributes>

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            // Compact single-line header: the owl glyph already encodes live/mic state
            // by colour, so the title and elapsed time share one slim row (no separate
            // status line, smaller owl + time).
            HStack(alignment: .center, spacing: 8) {
                OwlStatusGlyph(mood: .from(context.state), size: 28)
                    .frame(width: 28, height: 28)

                Text(context.attributes.sessionTitle)
                    .font(SurfaceStyle.WidgetFont.title)
                    .lineLimit(1)

                Spacer(minLength: 0)

                if showsElapsedTime {
                    Text(timerInterval: context.state.startedAt ... Date.distantFuture, countsDown: false)
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                        .contentTransition(.numericText())
                }
            }

            // The latest reply is the main content — let it breathe across 2–3 lines.
            Text(context.state.contextSummary)
                .font(SurfaceStyle.WidgetFont.liveBody)
                .lineLimit(3)
                .frame(maxWidth: .infinity, alignment: .leading)

            // Tapping the activity already opens the app, so no "Open" button — just the
            // live controls. The row is omitted entirely when there's nothing to control.
            if showsLiveControls {
                HStack(spacing: 10) {
                    if context.state.liveState == .on {
                        liveControlButton(.toggleMute, title: context.state.audioInputEnabled ? "Mute" : "Unmute", systemImage: context.state.audioInputEnabled ? "mic.slash" : "mic")
                    }
                    if showsPauseResumeButton(for: context.state) {
                        pauseResumeButton(for: context.state)
                    }
                    liveControlButton(.stopLive, title: "Stop", systemImage: "stop.fill", role: .destructive)
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
            }
        }
        .padding()
    }

    private var showsLiveControls: Bool {
        context.state.liveState == .connecting ||
            context.state.liveState == .on ||
            context.state.liveState == .paused ||
            context.state.recordingState == .on
    }

    private var showsElapsedTime: Bool {
        context.state.liveState == .connecting ||
            context.state.liveState == .on ||
            context.state.liveState == .paused ||
            context.state.recordingState == .on
    }

}

@ViewBuilder
private func liveControlButton(
    _ action: LiveControlAction,
    title: String,
    systemImage: String,
    role: ButtonRole? = nil
) -> some View {
    Button(intent: LiveControlIntent(action: action)) {
        Label(title, systemImage: systemImage)
            .font(SurfaceStyle.WidgetFont.status)
    }
    .tint(role == .destructive ? SurfaceStyle.liveEnd : SurfaceStyle.accent)
}

@ViewBuilder
private func pauseResumeButton(for state: LiveActivityAttributes.ContentState) -> some View {
    if state.liveState == .paused {
        liveControlButton(.resumeLive, title: "Resume", systemImage: "play.fill")
    } else {
        liveControlButton(.pauseLive, title: "Pause", systemImage: "pause.fill")
    }
}

private func showsPauseResumeButton(for state: LiveActivityAttributes.ContentState) -> Bool {
    state.liveState == .on || state.liveState == .paused
}

private func iconName(for state: LiveActivityAttributes.ContentState) -> String {
    if state.liveState == .off, state.recordingState == .on {
        return "record.circle.fill"
    }
    switch state.liveState {
    case .off:
        return "waveform"
    case .connecting:
        return "antenna.radiowaves.left.and.right"
    case .on:
        return state.audioInputEnabled ? "waveform.circle.fill" : "mic.slash.circle.fill"
    case .paused:
        return "pause.circle.fill"
    case .failed:
        return "exclamationmark.triangle.fill"
    }
}

private func shortStatus(for state: LiveActivityAttributes.ContentState) -> String {
    if state.liveState == .off, state.recordingState == .on {
        return "REC"
    }
    switch state.liveState {
    case .off: return "OFF"
    case .connecting: return ""   // colour-only (yellow owl) — no text, space is tight (#583)
    case .on: return state.audioInputEnabled ? "ON" : "MUTE"
    case .paused: return "PAUSE"
    case .failed: return "ERR"
    }
}

// MARK: - Hawky owl character (#583, DRAFT)
//
// Live Activities can't run continuous animations (the system ignores
// withAnimation/.animation and caps any transition at 2s), so personality has to
// come from STATE: each session state is a distinct owl expression, and the
// system's built-in content transition animates the swap when the state changes.
// This is a SwiftUI-shapes PROTOTYPE to show the direction — final art would be a
// proper illustrated owl asset set. "speaking" needs an `isAssistantSpeaking`
// field on the ContentState (not wired yet); for now it reuses the listening look.

private enum OwlMood {
    case ready, connecting, listening, muted, paused, recording, failed

    static func from(_ s: LiveActivityAttributes.ContentState) -> OwlMood {
        switch s.liveState {
        case .off: return s.recordingState == .on ? .recording : .ready
        case .connecting: return .connecting
        case .on: return s.audioInputEnabled ? .listening : .muted
        case .paused: return .paused
        case .failed: return .failed
        }
    }

    static func from(_ s: WidgetStatus) -> OwlMood {
        switch s.liveState {
        case .off: return s.recordingState == .on ? .recording : .ready
        case .connecting: return .connecting
        case .on: return .listening
        case .paused: return .paused
        case .failed: return .failed
        }
    }

    /// Glanceable state colour (HIG allows conveying state with colour).
    var color: Color {
        switch self {
        case .ready:
            return .secondary
        case .connecting, .paused:
            return SurfaceStyle.accent
        case .listening:
            return SurfaceStyle.liveConfirm
        case .muted:
            return SurfaceStyle.liveMic
        case .recording, .failed:
            return SurfaceStyle.liveEnd
        }
    }

    enum Eyes { case open, wide, closed, half }
    var eyes: Eyes {
        switch self {
        case .listening, .recording: return .wide   // alert, perked
        case .ready, .connecting: return .open
        case .muted: return .closed                 // eyes shut while muted
        case .paused: return .half                  // resting
        case .failed: return .open
        }
    }
}

private struct OwlEarTuft: Shape {
    func path(in r: CGRect) -> Path {
        var p = Path()
        p.move(to: CGPoint(x: r.midX, y: r.minY))
        p.addLine(to: CGPoint(x: r.maxX, y: r.maxY))
        p.addLine(to: CGPoint(x: r.minX, y: r.maxY))
        p.closeSubpath()
        return p
    }
}

private struct OwlBeak: Shape {
    func path(in r: CGRect) -> Path {
        var p = Path()
        p.move(to: CGPoint(x: r.minX, y: r.minY))
        p.addLine(to: CGPoint(x: r.maxX, y: r.minY))
        p.addLine(to: CGPoint(x: r.midX, y: r.maxY))
        p.closeSubpath()
        return p
    }
}

/// A tiny owl whose face reflects the session state. Reads at Dynamic Island
/// sizes as "round head + two ear tufts + two eyes" = unmistakably an owl. (#583)
private struct OwlStatusGlyph: View {
    let mood: OwlMood
    var size: CGFloat = 24
    // StandBy / always-on display dim the screen; pure white eyes glare there, so we
    // soften the sclera when the system reduces luminance.
    @Environment(\.isLuminanceReduced) private var isLuminanceReduced

    private var scleraColor: Color {
        isLuminanceReduced ? Color.white.opacity(0.55) : .white
    }

    var body: some View {
        let tint = mood.color
        let eyeD = size * 0.30
        ZStack {
            // Ear tufts
            HStack(spacing: size * 0.30) {
                OwlEarTuft().fill(tint).frame(width: size * 0.16, height: size * 0.22)
                OwlEarTuft().fill(tint).frame(width: size * 0.16, height: size * 0.22)
            }
            .offset(y: -size * 0.40)

            // Head
            Circle()
                .fill(tint.opacity(0.20))
                .overlay(Circle().strokeBorder(tint, lineWidth: max(1, size * 0.06)))
                .frame(width: size * 0.92, height: size * 0.92)

            // Eyes
            HStack(spacing: size * 0.12) {
                owlEye(eyeD)
                owlEye(eyeD)
            }
            .offset(y: -size * 0.05)

            // Beak
            OwlBeak().fill(tint)
                .frame(width: size * 0.12, height: size * 0.12)
                .offset(y: size * 0.16)
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    @ViewBuilder
    private func owlEye(_ d: CGFloat) -> some View {
        switch mood.eyes {
        case .open, .wide:
            let scale: CGFloat = mood.eyes == .wide ? 1.15 : 1.0
            ZStack {
                Circle().fill(scleraColor)
                Circle().fill(.black).frame(width: d * 0.5, height: d * 0.5)
            }
            .frame(width: d * scale, height: d * scale)
        case .closed:
            Capsule().fill(mood.color).frame(width: d, height: max(1.5, d * 0.16))
        case .half:
            ZStack {
                Circle().fill(scleraColor)
                Circle().fill(.black).frame(width: d * 0.5, height: d * 0.5)
            }
            .frame(width: d, height: d)
            .mask(Rectangle().frame(width: d, height: d * 0.55).offset(y: d * 0.22))
        }
    }
}

@main
struct AppWidgetBundle: WidgetBundle {
    var body: some Widget {
        LockScreenWidget()
        LiveActivityWidget()
    }
}
