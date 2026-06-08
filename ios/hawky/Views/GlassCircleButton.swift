import SwiftUI

struct AppMark: View {
    @Environment(\.colorScheme) private var colorScheme

    var size: CGFloat = 28
    var compact: Bool = false

    var body: some View {
        ZStack {
            Circle()
                .fill(
                    LinearGradient(
                        colors: [
                            Color(red: 0.04, green: 0.20, blue: 0.22),
                            Color(red: 0.02, green: 0.10, blue: 0.12)
                        ],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )
            Circle()
                .strokeBorder(markBorderColor, lineWidth: markBorderWidth)
            Image("AppPaperMark")
                .resizable()
                .scaledToFill()
                .frame(width: size * 0.9, height: size * 0.9)
                .clipShape(Circle())
                .saturation(0.96)
                .shadow(color: DesignTokens.accent.opacity(0.35), radius: size * 0.08, x: 0, y: size * 0.03)
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    private var markBorderColor: Color {
        DesignTokens.accent.opacity(colorScheme == .light ? 0.28 : 0.55)
    }

    private var markBorderWidth: CGFloat {
        colorScheme == .light ? max(0.65, size * 0.026) : max(1, size * 0.045)
    }
}

/// FaceTime-style "liquid glass" circular control used across the Live stage and
/// the fullscreen video chrome. iOS 17 target, so the glass look is hand-built:
/// ultra-thin material over a dim plate, a top-to-bottom rim-light stroke, and a
/// soft top highlight that sells the curvature. Press feedback is a spring scale.
struct GlassCircleButton: View {
    @Environment(\.colorScheme) private var colorScheme

    enum Style {
        /// Dim translucent glass with a white icon (inactive toggles, utility).
        case glass
        /// Solid white circle with a tinted icon (active toggles, FaceTime-style).
        case solidWhite(iconTint: Color)
        /// Solid FaceTime red with a white icon (end call).
        case destructive
        /// Solid FaceTime green with a white icon (start / resume).
        case confirm
    }

    let icon: String
    var size: CGFloat = DesignTokens.LiveControl.controlSize
    var iconSize: CGFloat = DesignTokens.LiveControl.iconSize
    var style: Style = .glass
    /// Shows a ProgressView in place of the icon (connecting / stopping).
    var isBusy: Bool = false
    var isDisabled: Bool = false
    var role: ButtonRole?
    let action: () -> Void

    var body: some View {
        Button(role: role, action: action) {
            ZStack {
                backgroundFill
                if isBusy {
                    ProgressView()
                        .tint(iconColor)
                } else {
                    Image(systemName: icon)
                        .font(.system(size: iconSize, weight: .semibold))
                        .foregroundStyle(iconColor)
                }
            }
            .frame(width: size, height: size)
            .overlay(rimLight)
            .overlay(topHighlight)
            .clipShape(Circle())
            .shadow(
                color: .black.opacity(colorScheme == .light ? 0.18 : 0.20),
                radius: colorScheme == .light ? 12 : 14,
                x: 0,
                y: colorScheme == .light ? 5 : 6
            )
            .opacity(isDisabled ? 0.45 : 1)
            .contentShape(Circle())
        }
        .buttonStyle(GlassCirclePressStyle())
        .disabled(isDisabled)
    }

    @ViewBuilder
    private var backgroundFill: some View {
        switch style {
        case .glass:
            ZStack {
                Circle().fill(DesignTokens.Surface.glassBase)
                Circle().fill(.ultraThinMaterial)
                Circle().fill(DesignTokens.Surface.glassTint)
                Circle().fill(
                    LinearGradient(
                        colors: [
                            Color.white.opacity(colorScheme == .light ? 0.26 : 0.13),
                            Color.white.opacity(0.02)
                        ],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )
            }
        case .solidWhite:
            Circle().fill(Color.white)
        case .destructive:
            Circle().fill(DesignTokens.LiveControl.end)
        case .confirm:
            Circle().fill(DesignTokens.LiveControl.confirm)
        }
    }

    private var iconColor: Color {
        switch style {
        case .glass: return colorScheme == .light ? .primary.opacity(0.62) : .white.opacity(0.92)
        case .solidWhite(let iconTint): return iconTint
        case .destructive, .confirm: return .white
        }
    }

    /// Top-lit rim stroke: bright at the top edge, fading toward the bottom.
    private var rimLight: some View {
        Circle()
            .strokeBorder(
                LinearGradient(
                    colors: [
                        Color.white.opacity(colorScheme == .light ? 0.72 : 0.38),
                        DesignTokens.Surface.glassStroke.opacity(colorScheme == .light ? 0.28 : 0.72)
                    ],
                    startPoint: .top,
                    endPoint: .bottom
                ),
                lineWidth: 1
            )
    }

    /// Soft white sheen across the upper third of the circle.
    private var topHighlight: some View {
        Circle()
            .fill(
                LinearGradient(
                    stops: [
                        .init(color: Color.white.opacity(colorScheme == .light ? 0.22 : 0.10), location: 0.0),
                        .init(color: Color.clear, location: 0.38)
                    ],
                    startPoint: .top,
                    endPoint: .bottom
                )
            )
            .allowsHitTesting(false)
    }
}

/// Springy press-down scale shared by the glass controls.
struct GlassCirclePressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.955 : 1)
            .brightness(configuration.isPressed ? -0.02 : 0)
            .animation(.spring(response: 0.24, dampingFraction: 0.78), value: configuration.isPressed)
    }
}

/// Lighter press response for glass capsules. The old circular-control press
/// compressed this pill too much and made the top chrome feel jumpy.
struct GlassPillPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.982 : 1)
            .opacity(configuration.isPressed ? 0.84 : 1)
            .brightness(configuration.isPressed ? -0.012 : 0)
            .animation(.spring(response: 0.22, dampingFraction: 0.86), value: configuration.isPressed)
    }
}

/// FaceTime-style identity capsule pinned to the top-left of the Live stage:
/// [mini avatar][agent name][chevron]. Tapping opens the session detail sheet.
struct AgentIdentityPill: View {
    @Environment(\.colorScheme) private var colorScheme

    let name: String
    /// SF Symbol for the mini avatar; user-chosen via `AgentIconPickerView`.
    let symbol: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 9) {
                AppMark(size: 31, compact: true)
                Text(name)
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
            .padding(.leading, 7)
            .padding(.trailing, 13)
            .padding(.vertical, 7)
            .softGlass(in: Capsule())
            .overlay(
                Capsule()
                    .strokeBorder(
                        LinearGradient(
                            colors: [
                                DesignTokens.Surface.paperHighlight.opacity(colorScheme == .light ? 0.62 : 1),
                                DesignTokens.Surface.glassStroke.opacity(colorScheme == .light ? 0.34 : 0.72)
                            ],
                            startPoint: .top,
                            endPoint: .bottom
                        ),
                        lineWidth: colorScheme == .light ? 0.7 : 1
                    )
            )
            .shadow(color: .black.opacity(colorScheme == .light ? 0.10 : 0.18), radius: 10, x: 0, y: 4)
            .contentShape(Capsule())
        }
        .buttonStyle(GlassPillPressStyle())
    }
}

/// Small SF Symbol grid for picking the agent's mini-avatar shown in the
/// identity pill. Persists via the caller's `@AppStorage("agentCardSymbol")`.
struct AgentIconPickerView: View {
    @Binding var selection: String

    static let symbols: [String] = [
        "sparkles", "bolt.fill", "brain.head.profile", "pawprint.fill",
        "bird.fill", "hare.fill", "tortoise.fill", "leaf.fill",
        "flame.fill", "moon.stars.fill", "waveform", "cpu"
    ]

    private let columns = [GridItem(.adaptive(minimum: 48), spacing: 10)]

    var body: some View {
        LazyVGrid(columns: columns, spacing: 10) {
            ForEach(Self.symbols, id: \.self) { symbol in
                Button {
                    selection = symbol
                } label: {
                    ZStack {
                        Circle()
                            .fill(symbol == selection
                                  ? DesignTokens.accent.opacity(0.28)
                                  : Color(.tertiarySystemFill))
                        Image(systemName: symbol)
                            .font(.system(size: 17, weight: .semibold))
                            .foregroundStyle(symbol == selection ? DesignTokens.accent : .secondary)
                    }
                    .frame(width: 44, height: 44)
                    .overlay {
                        if symbol == selection {
                            Circle().strokeBorder(DesignTokens.accent, lineWidth: 1.5)
                        }
                    }
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Agent icon \(symbol)")
                .accessibilityAddTraits(symbol == selection ? .isSelected : [])
            }
        }
        .padding(.vertical, 4)
        .accessibilityIdentifier("live.agentIconPicker")
    }
}
