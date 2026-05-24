import SwiftUI
import UIKit

// Centralized visual tokens. Names cite their Secretary counterparts so the design
// intent stays traceable. Dark-first; light mode relies on system semantic colors.
enum DesignTokens {
    private static let darkCanvas = UIColor(red: 0.055, green: 0.066, blue: 0.061, alpha: 1)
    private static let darkGroupedCanvas = UIColor(red: 0.069, green: 0.080, blue: 0.074, alpha: 1)
    private static let darkPaper = UIColor(red: 0.094, green: 0.103, blue: 0.094, alpha: 1)
    private static let darkPaperInset = UIColor(red: 0.122, green: 0.131, blue: 0.119, alpha: 1)
    private static let darkPaperStroke = UIColor(red: 0.94, green: 0.74, blue: 0.43, alpha: 0.15)
    private static let darkGlassBase = UIColor(red: 0.075, green: 0.086, blue: 0.080, alpha: 0.46)
    private static let darkGlassTint = UIColor(red: 0.64, green: 0.52, blue: 0.35, alpha: 0.10)
    private static let darkGlassStroke = UIColor(red: 1.00, green: 0.86, blue: 0.58, alpha: 0.20)
    private static let darkPressed = UIColor(red: 1.00, green: 0.80, blue: 0.46, alpha: 0.14)

    // Secretary --bg (dark warm parchment). Resolves per trait.
    static let background = Color(UIColor { trait in
        trait.userInterfaceStyle == .dark
            ? darkCanvas
            : UIColor.systemBackground
    })

    static let groupedBackground = Color(UIColor { trait in
        trait.userInterfaceStyle == .dark
            ? darkGroupedCanvas
            : UIColor.systemGroupedBackground
    })

    // Secretary --accent: oklch(0.75 0.13 70) — warm amber.
    static let accent = SurfaceStyle.accent
    static let panelAccent = SurfaceStyle.accent
    static let panelAccentInk = Color(UIColor { trait in
        trait.userInterfaceStyle == .dark
            ? UIColor(red: 0.93, green: 0.72, blue: 0.38, alpha: 1)
            : UIColor(red: 0.659, green: 0.329, blue: 0.0, alpha: 1)
    })

    // Subtle amber tint layered over secondarySystemFill for user bubbles.
    // Matches Secretary chat.jsx:191 color-mix(... accent 22%, bubble-user).
    static let userBubbleTint = Color(UIColor { trait in
        let alpha = trait.userInterfaceStyle == .dark ? 0.22 : 0.14
        return UIColor(red: 0.93, green: 0.72, blue: 0.38, alpha: alpha)
    })

    // Secretary --fg-muted-2 — tertiary label used for eyebrows, captions.
    static let tertiaryText = Color(.tertiaryLabel)

    enum Status {
        static let success = Color(.systemGreen)
        static let warning = Color(.systemOrange)
        static let error = Color(.systemRed)
        static let neutral = Color(.secondaryLabel)
    }

    enum Radius {
        static let glass: CGFloat = 28     // Secretary --glass-radius
        static let bubble: CGFloat = 22    // --bubble-radius
        static let card: CGFloat = 20      // GlassCard radius
        static let pill: CGFloat = 14      // header pills
        static let panel: CGFloat = 14     // light paper-panel radius
    }

    enum Surface {
        static let paper = Color(UIColor { trait in
            trait.userInterfaceStyle == .dark
                ? darkPaper
                : UIColor(red: 1.000, green: 0.997, blue: 0.988, alpha: 1)
        })

        static let paperInset = Color(UIColor { trait in
            trait.userInterfaceStyle == .dark
                ? darkPaperInset
                : UIColor(red: 0.998, green: 0.994, blue: 0.982, alpha: 1)
        })

        static let paperStroke = Color(UIColor { trait in
            trait.userInterfaceStyle == .dark
                ? darkPaperStroke
                : UIColor(red: 0.64, green: 0.52, blue: 0.36, alpha: 0.10)
        })

        static let paperHighlight = Color(UIColor { trait in
            trait.userInterfaceStyle == .dark
                ? UIColor.white.withAlphaComponent(0.09)
                : UIColor.white.withAlphaComponent(0.24)
        })

        static let glassBase = Color(UIColor { trait in
            trait.userInterfaceStyle == .dark
                ? darkGlassBase
                : UIColor(red: 1.000, green: 0.997, blue: 0.988, alpha: 0.24)
        })

        static let glassTint = Color(UIColor { trait in
            trait.userInterfaceStyle == .dark
                ? darkGlassTint
                : UIColor(red: 1.000, green: 0.997, blue: 0.988, alpha: 0.18)
        })

        static let glassStroke = Color(UIColor { trait in
            trait.userInterfaceStyle == .dark
                ? darkGlassStroke
                : UIColor.separator.withAlphaComponent(0.50)
        })

        static let rowPressed = Color(UIColor { trait in
            trait.userInterfaceStyle == .dark
                ? darkPressed
                : UIColor.secondarySystemFill.withAlphaComponent(0.34)
        })
    }

    // FaceTime-style Live call controls: solid state colors + circle sizing for
    // the floating glass buttons on the Live stage.
    enum LiveControl {
        static let confirm = SurfaceStyle.liveConfirm  // FaceTime green
        static let end = SurfaceStyle.liveEnd          // FaceTime red
        static let mic = SurfaceStyle.liveMic          // mic-on orange
        // Darkened mic/camera tints for the active `.solidWhite` toggle (tinted
        // glyph on a white circle). The vibrant `mic`/`confirm` above are for
        // FILLED circles with a white glyph and stay bright; on white they only
        // hit ~2.1:1, so the white-circle active state uses these AA-compliant
        // tints instead. (#574)
        static let micOnWhite = SurfaceStyle.liveMicOnWhite       // #A85400 — 5.34:1 on white
        static let confirmOnWhite = SurfaceStyle.liveConfirmOnWhite // #1E7B34 — 5.33:1 on white
        static let controlSize: CGFloat = 52      // standard circle
        static let endControlSize: CGFloat = 56   // start/stop circle
        static let functionSize: CGFloat = 44     // top-right function button
        static let iconSize: CGFloat = 20         // SF Symbol point size in circles
        static let stackSpacing: CGFloat = 14     // vertical gap in the control stack
    }

    enum Spacing {
        static let page: CGFloat = 16      // horizontal page padding
        static let message: CGFloat = 12   // inter-message gap
        static let rowV: CGFloat = 11      // list row vertical padding
        static let rowH: CGFloat = 14      // list row horizontal padding
    }

    enum IconTile {
        static let row: CGFloat = 28
        static let sidePane: CGFloat = 34
        static let actionRow: CGFloat = 36
        static let account: CGFloat = 54
        static let detailHeader: CGFloat = 64

        static func cornerRadius(for size: CGFloat) -> CGFloat {
            max(7, size * 0.25)
        }

        static func symbolSize(for size: CGFloat) -> CGFloat {
            size * 0.58
        }

        static func assetScale(for size: CGFloat) -> CGFloat {
            size >= actionRow ? 1.30 : 1.22
        }
    }

    enum Font {
        static let liveHeroTitle: SwiftUI.Font = .system(.title3, design: .rounded).weight(.semibold)
        static let screenTitle: SwiftUI.Font = .system(.headline, design: .rounded).weight(.semibold)
        static let panelTitle: SwiftUI.Font = .system(.headline, design: .rounded).weight(.semibold)
        static let panelBody: SwiftUI.Font = .system(.subheadline, design: .rounded)
        static let rowTitle: SwiftUI.Font = .system(.subheadline, design: .rounded).weight(.semibold)
        static let rowBody: SwiftUI.Font = .system(.subheadline, design: .rounded)
        static let rowDetail: SwiftUI.Font = .system(.footnote, design: .rounded)
        static let meta: SwiftUI.Font = .system(.caption, design: .rounded)
        static let metaStrong: SwiftUI.Font = .system(.caption, design: .rounded).weight(.semibold)
        static let status: SwiftUI.Font = .system(.callout, design: .monospaced).weight(.semibold)
        static let assistant: SwiftUI.Font = .system(.body, design: .rounded)
        // Mono meta text (URLs, tokens, timestamps) — Secretary --font-mono.
        static let mono: SwiftUI.Font = .system(.footnote, design: .monospaced)
        // "CHANNEL" eyebrow above chat title — ui-primitives.jsx GlassCard title.
        static let eyebrow: SwiftUI.Font = .system(size: 10, weight: .bold)
    }
}

enum MessageTimestampFormatter {
    private static let todayFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = .autoupdatingCurrent
        formatter.timeStyle = .medium
        formatter.dateStyle = .none
        return formatter
    }()

    private static let datedFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = .autoupdatingCurrent
        formatter.timeStyle = .medium
        formatter.dateStyle = .medium
        return formatter
    }()

    static func string(from date: Date) -> String {
        Calendar.current.isDateInToday(date)
            ? todayFormatter.string(from: date)
            : datedFormatter.string(from: date)
    }
}

struct MessageTimestampText: View {
    let date: Date

    var body: some View {
        Text(MessageTimestampFormatter.string(from: date))
            .font(.caption2.monospacedDigit())
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .minimumScaleFactor(0.85)
            .accessibilityLabel(Text("Sent \(MessageTimestampFormatter.string(from: date))"))
    }
}

extension View {
    /// Expands the tappable region to at least the HIG 44×44pt minimum without
    /// changing the content's visual size. Apply to a button (or its icon label)
    /// whose glyph renders smaller than 44pt. (#573)
    func minimumHitTarget(_ side: CGFloat = 44) -> some View {
        frame(minWidth: side, minHeight: side)
            .contentShape(Rectangle())
    }

    /// A cleaner, more see-through "glass" than a raw `.ultraThinMaterial`.
    /// iOS's thinnest built-in material still reads milky in light mode, so there
    /// we drive a `UIVisualEffectView` to a *fractional* blur — an even, genuinely
    /// translucent surface (the ChatGPT look the team asked for) — finished with a
    /// hairline for definition. Dark mode keeps the standard material (its frost
    /// already reads well); Reduce Transparency falls back to a solid fill. (#583)
    func softGlass<S: InsettableShape>(in shape: S) -> some View {
        modifier(SoftGlassBackground(shape: shape))
    }

    func paperSurface<S: InsettableShape>(in shape: S, inset: Bool = false) -> some View {
        modifier(PaperSurfaceBackground(shape: shape, inset: inset))
    }

    func primaryPanelAction(tint: Color = DesignTokens.panelAccent, foreground: Color? = nil) -> some View {
        font(DesignTokens.Font.rowTitle)
            .buttonStyle(PanelActionButtonStyle(tint: tint, prominence: .primary, foregroundOverride: foreground))
    }

    func secondaryPanelAction() -> some View {
        font(DesignTokens.Font.rowTitle)
            .buttonStyle(
                PanelActionButtonStyle(
                    tint: DesignTokens.panelAccent,
                    prominence: .secondary,
                    foregroundOverride: DesignTokens.panelAccentInk
                )
            )
    }

    func secondaryPanelAction(tint: Color, foreground: Color? = nil) -> some View {
        font(DesignTokens.Font.rowTitle)
            .buttonStyle(PanelActionButtonStyle(tint: tint, prominence: .secondary, foregroundOverride: foreground))
    }

    func destructivePanelAction() -> some View {
        secondaryPanelAction(tint: DesignTokens.Status.error)
    }

    func helperCaption() -> some View {
        font(DesignTokens.Font.meta)
            .foregroundStyle(.secondary)
    }

    func errorCaption() -> some View {
        font(DesignTokens.Font.meta)
            .foregroundStyle(DesignTokens.Status.error)
    }

    func warningBadge() -> some View {
        font(DesignTokens.Font.metaStrong)
            .foregroundStyle(DesignTokens.Status.warning)
    }

    func subtlePressAction() -> some View {
        buttonStyle(SubtlePressButtonStyle())
    }

    func rowPressAction() -> some View {
        buttonStyle(RowPressButtonStyle())
    }
}

struct GeneratedIconTile: View {
    let systemImage: String
    let color: Color
    var assetName: String?
    var size: CGFloat = DesignTokens.IconTile.row

    private var tileShape: RoundedRectangle {
        RoundedRectangle(
            cornerRadius: DesignTokens.IconTile.cornerRadius(for: size),
            style: .continuous
        )
    }

    var body: some View {
        ZStack {
            if let assetName {
                Image(assetName)
                    .resizable()
                    .scaledToFit()
                    .frame(
                        width: size * DesignTokens.IconTile.assetScale(for: size),
                        height: size * DesignTokens.IconTile.assetScale(for: size)
                    )
                    .shadow(color: .black.opacity(0.08), radius: 1.5, x: 0, y: 1)
            } else {
                tileShape
                    .fill(Color(.secondarySystemGroupedBackground))
                tileShape
                    .fill(color.opacity(0.11))
                tileShape
                    .strokeBorder(color.opacity(0.16), lineWidth: 0.7)
                Image(systemName: systemImage)
                    .symbolRenderingMode(.hierarchical)
                    .font(.system(size: DesignTokens.IconTile.symbolSize(for: size), weight: .semibold))
                    .foregroundStyle(color)
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

private struct SubtlePressButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.985 : 1)
            .opacity(isEnabled ? (configuration.isPressed ? 0.78 : 1) : 0.45)
            .brightness(configuration.isPressed ? -0.015 : 0)
            .animation(.spring(response: 0.22, dampingFraction: 0.82), value: configuration.isPressed)
    }
}

private struct RowPressButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .background {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(configuration.isPressed ? DesignTokens.Surface.rowPressed : .clear)
            }
            .scaleEffect(configuration.isPressed ? 0.985 : 1)
            .opacity(isEnabled ? 1 : 0.45)
            .animation(.spring(response: 0.22, dampingFraction: 0.84), value: configuration.isPressed)
    }
}

private struct PanelActionButtonStyle: ButtonStyle {
    enum Prominence {
        case primary
        case secondary
    }

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.isEnabled) private var isEnabled

    let tint: Color
    let prominence: Prominence
    var foregroundOverride: Color?

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .lineLimit(1)
            .minimumScaleFactor(0.82)
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .frame(minHeight: 36)
            .foregroundStyle(foreground)
            .background {
                background
                    .clipShape(Capsule(style: .continuous))
            }
            .overlay {
                Capsule(style: .continuous)
                    .strokeBorder(stroke, lineWidth: 1)
            }
            .contentShape(Capsule(style: .continuous))
            .scaleEffect(configuration.isPressed ? 0.965 : 1)
            .brightness(configuration.isPressed ? -0.025 : 0)
            .shadow(
                color: shadowColor(configuration: configuration),
                radius: configuration.isPressed ? 1 : 4,
                x: 0,
                y: configuration.isPressed ? 1 : 2
            )
            .opacity(isEnabled ? 1 : 0.45)
            .animation(.spring(response: 0.24, dampingFraction: 0.74), value: configuration.isPressed)
    }

    private var foreground: Color {
        if let foregroundOverride {
            return foregroundOverride
        }
        switch prominence {
        case .primary:
            return Color.black.opacity(colorScheme == .dark ? 0.84 : 0.78)
        case .secondary:
            return tint
        }
    }

    @ViewBuilder
    private var background: some View {
        switch prominence {
        case .primary:
            LinearGradient(
                colors: [
                    tint.opacity(colorScheme == .dark ? 0.92 : 0.84),
                    tint.opacity(colorScheme == .dark ? 0.80 : 0.70)
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
        case .secondary:
            ZStack {
                Capsule(style: .continuous)
                    .fill(tint.opacity(colorScheme == .dark ? 0.10 : 0.13))
                Capsule(style: .continuous)
                    .fill(Color.white.opacity(colorScheme == .dark ? 0.035 : 0.18))
            }
        }
    }

    private var stroke: Color {
        switch prominence {
        case .primary:
            return Color.white.opacity(colorScheme == .dark ? 0.20 : 0.35)
        case .secondary:
            return tint.opacity(colorScheme == .dark ? 0.22 : 0.22)
        }
    }

    private func shadowColor(configuration: Configuration) -> Color {
        guard isEnabled else { return .clear }
        switch prominence {
        case .primary:
            return Color.black.opacity(colorScheme == .dark ? 0.16 : 0.06)
        case .secondary:
            return configuration.isPressed ? .clear : Color.black.opacity(colorScheme == .dark ? 0.05 : 0.025)
        }
    }
}

private struct PaperSurfaceBackground<S: InsettableShape>: ViewModifier {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    let shape: S
    let inset: Bool

    func body(content: Content) -> some View {
        content
            .background(surfaceFill)
            .overlay(
                shape
                    .strokeBorder(
                        LinearGradient(
                            colors: [
                                DesignTokens.Surface.paperHighlight,
                                DesignTokens.Surface.paperStroke
                            ],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        ),
                        lineWidth: colorScheme == .dark ? 0.5 : 0.55
                    )
            )
            .shadow(
                color: Color.black.opacity(colorScheme == .dark ? 0.12 : 0.03),
                radius: inset ? 0 : 5,
                x: 0,
                y: inset ? 0 : 2
            )
    }

    @ViewBuilder
    private var surfaceFill: some View {
        if colorScheme == .dark && !reduceTransparency {
            ZStack {
                shape.fill(.ultraThinMaterial)
                shape.fill((inset ? DesignTokens.Surface.paperInset : DesignTokens.Surface.paper).opacity(inset ? 0.62 : 0.54))
            }
        } else {
            shape.fill(inset ? DesignTokens.Surface.paperInset : DesignTokens.Surface.paper)
        }
    }
}

private struct SoftGlassBackground<S: InsettableShape>: ViewModifier {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    let shape: S

    /// Light-mode blur strength (0…1), set below `.ultraThinMaterial`'s built-in
    /// level so the surface stays clearly translucent. Tune here.
    private let lightIntensity: CGFloat = 0.5

    func body(content: Content) -> some View {
        content
            .background(fill)
            .overlay(border)
    }

    @ViewBuilder
    private var fill: some View {
        if reduceTransparency {
            shape.fill(DesignTokens.Surface.paper)
        } else if colorScheme == .light {
            SoftBlurView(style: .systemUltraThinMaterialLight, intensity: lightIntensity)
                .clipShape(shape)
        } else {
            ZStack {
                shape.fill(.ultraThinMaterial)
                shape.fill(DesignTokens.Surface.glassBase)
                shape.fill(DesignTokens.Surface.glassTint)
            }
        }
    }

    @ViewBuilder
    private var border: some View {
        if !reduceTransparency {
            shape.strokeBorder(DesignTokens.Surface.glassStroke, lineWidth: colorScheme == .dark ? 0.65 : 0.5)
        }
    }
}

/// A blur whose strength can be dialed below `.ultraThinMaterial`. Drives a
/// `UIVisualEffectView` with a property animator paused at a fractional point —
/// the standard way to get sub-material blur intensity on iOS 17. The live blur
/// itself is no costlier than a system material; the one perf trap is rebuilding
/// the effect on every layout pass, which the coordinator guards against. (#583)
private struct SoftBlurView: UIViewRepresentable {
    let style: UIBlurEffect.Style
    let intensity: CGFloat

    func makeUIView(context: Context) -> UIVisualEffectView {
        UIVisualEffectView(effect: nil)
    }

    func updateUIView(_ uiView: UIVisualEffectView, context: Context) {
        context.coordinator.apply(style: style, intensity: intensity, to: uiView)
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator {
        private var animator: UIViewPropertyAnimator?
        private var applied: (style: UIBlurEffect.Style, intensity: CGFloat)?

        func apply(style: UIBlurEffect.Style, intensity: CGFloat, to view: UIVisualEffectView) {
            // updateUIView can fire on every layout pass; only rebuild the (GPU)
            // blur effect when the inputs actually change.
            if let applied, applied.style == style, applied.intensity == intensity { return }
            applied = (style, intensity)
            animator?.stopAnimation(true)
            view.effect = nil
            let animator = UIViewPropertyAnimator(duration: 1, curve: .linear) {
                view.effect = UIBlurEffect(style: style)
            }
            animator.pausesOnCompletion = true
            animator.fractionComplete = intensity
            self.animator = animator
        }

        deinit { animator?.stopAnimation(true) }
    }
}
