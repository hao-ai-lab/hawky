import SwiftUI
import UIKit

// Launch branding assets, in one place so the view and its tests resolve the
// exact same image. The asset is a relative symlink to AppIcon's source, so
// swapping the app icon updates this launch mark automatically.
enum LaunchBranding {
    static let assetName = "LaunchIcon"

    /// The bundle that ships the launch icon (the app bundle, even under a test host).
    static var bundle: Bundle { Bundle(for: Anchor.self) }

    static var icon: UIImage? { UIImage(named: assetName, in: bundle, with: nil) }

    private final class Anchor {}
}

// User-facing launch-intro settings (Settings ▸ Appearance). Persisted in
// UserDefaults so AgentApp can read them synchronously at launch.
enum IntroSettings {
    static let enabledKey = "introEnabled"

    /// Whether to play the launch intro at all. Default OFF while in active
    /// development — opt in from Settings ▸ Appearance. The intro follows the
    /// system light/dark appearance.
    static var isEnabled: Bool {
        UserDefaults.standard.object(forKey: enabledKey) as? Bool ?? false
    }
}

// HawkIntroView - launch reveal modeled on the iOS app-launch transition.
//
// SMOOTHNESS CONTRACT (hard-won — keep it):
//   • Every animated property is a transform (scale / offset / rotation of a
//     NON-blurred layer) or opacity. The glow is a RadialGradient — never
//     re-blurred — so nothing animates blur, shadow radius, or colour filters.
//   • The intro NEVER mounts the heavy host (ContentView) while it animates, so
//     it owns the main thread and the motion can't be starved or stuttered.
//   • `.ignoresSafeArea(.keyboard)` so a later keyboard prewarm can't shove the
//     mark around. The hand-off commits the fade to Core Animation BEFORE the
//     host mounts (see AgentApp), so the cross-fade is render-server-side.
//
// APPEARANCE: fully themed for light AND dark so both seams are seamless — the
// system launch screen (white/black) flows into the intro, and the intro flows
// into the (light/dark) app. The dark theme glows additively (.plusLighter) on
// a deep field; the light theme uses a normally-blended warm halo on a soft
// near-white so the colours actually read against white.
//
// Beats: pull-in → flourish (light-catch + ember burst + wordmark) → breathing
// hold → hand-off (lunge + glow bloom + cross-fade). Honors Reduce Motion.
struct HawkIntroView: View {
    /// Fired as the hand-off begins. The host owns mount timing (after the fade
    /// is committed) so this view never contends with ContentView's mount.
    var onComplete: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var colorScheme

    @State private var appeared = false        // pull-in (scale + offset + opacity)
    @State private var glowIn = false          // glow bloom (opacity)
    @State private var breathe = false         // gentle hold-phase pulse (scale)
    @State private var flare = false           // one-shot light-catch as the sweep crosses
    @State private var wordIn = false          // wordmark reveal (opacity + rise)
    @State private var sweep: CGFloat = 0       // specular travel (offset)
    @State private var sweeping = false         // gates the highlight
    @State private var sparksLive = false       // gates the sparks
    @State private var sparkT: CGFloat = 0       // spark flight (offset + scale)
    @State private var sparkAlpha: CGFloat = 1   // spark fade
    @State private var exiting = false          // hand-off lunge (scale)

    // 120pt reads as a confident launch mark; the continuous corner radius
    // matches the iOS app-icon squircle (~0.2237).
    private let iconSize: CGFloat = 120
    private var cornerRadius: CGFloat { iconSize * 0.2237 }
    private var iconShape: RoundedRectangle {
        RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
    }

    // Base palette sampled from the app icon (warm gold owl on a teal field).
    private let gold = Color(red: 1.00, green: 0.83, blue: 0.46)
    private let amber = Color(red: 0.96, green: 0.66, blue: 0.27)
    private let ember = Color(red: 1.00, green: 0.52, blue: 0.18)
    private let cream = Color(red: 1.00, green: 0.95, blue: 0.86)
    private let teal = Color(red: 0.40, green: 0.71, blue: 0.69)
    private let deepTeal = Color(red: 0.09, green: 0.28, blue: 0.27)

    private let sparkCount = 16

    private var isDark: Bool { colorScheme == .dark }

    var body: some View {
        ZStack {
            background.ignoresSafeArea()

            auroraGlow
            sparkRing

            iconMark
                .frame(width: iconSize, height: iconSize)
                .clipShape(iconShape)
                // Constant shadow — radius never animates, rasterized once.
                .shadow(color: .black.opacity(isDark ? 0.35 : 0.18), radius: 24, x: 0, y: 14)
                .scaleEffect(reduceMotion ? 1.0 : (exiting ? 1.55 : (appeared ? 1.0 : 0.82)))
                .offset(y: (reduceMotion || appeared) ? 0 : 26)
                .opacity(appeared ? 1.0 : 0.0)

            wordmark
        }
        // Don't let a later keyboard prewarm (in the app) shift the mark.
        .ignoresSafeArea(.keyboard)
        .contentShape(Rectangle())
        .onTapGesture { finish() }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("hawk")
        .onAppear(perform: run)
    }

    // Warm halo that echoes the icon. Dark: additive glow on a deep field.
    // Light: a normally-blended sunlit warm halo that reads against near-white.
    // Soft by construction (RadialGradient) — no blur. Blooms in, breathes
    // gently in the hold, catches the sweep once, then exhales on hand-off.
    private var auroraGlow: some View {
        let base: CGFloat = (reduceMotion || appeared) ? 1.0 : 0.5
        let pulse: CGFloat = (!reduceMotion && breathe) ? 1.04 : 1.0
        let scale: CGFloat = exiting ? 1.32 : (base * pulse * (flare ? 1.06 : 1.0))
        let peak = isDark ? 0.90 : 0.85
        return Circle()
            .fill(RadialGradient(gradient: Gradient(stops: glowStops),
                                 center: .center,
                                 startRadius: 0,
                                 endRadius: iconSize * 1.5))
            .frame(width: iconSize * 3.0, height: iconSize * 3.0)
            .scaleEffect(scale)
            .opacity(glowIn ? (flare ? min(1.0, peak + 0.12) : peak) : 0.0)
            .blendMode(isDark ? .plusLighter : .normal)
            .allowsHitTesting(false)
    }

    private var glowStops: [Gradient.Stop] {
        if isDark {
            return [
                .init(color: gold.opacity(0.95), location: 0.00),
                .init(color: amber.opacity(0.72), location: 0.30),
                .init(color: teal.opacity(0.40), location: 0.62),
                .init(color: teal.opacity(0.10), location: 0.82),
                .init(color: .clear, location: 1.00),
            ]
        } else {
            // Saturated enough to read as a warm halo on near-white.
            return [
                .init(color: gold.opacity(0.55), location: 0.00),
                .init(color: amber.opacity(0.42), location: 0.30),
                .init(color: teal.opacity(0.26), location: 0.60),
                .init(color: teal.opacity(0.08), location: 0.82),
                .init(color: .clear, location: 1.00),
            ]
        }
    }

    // Warm sparks that shoot out from the icon edge once, like embers. Sizes,
    // distances and angles vary per index (deterministic) so the burst reads as
    // organic rather than a mechanical ring.
    private var sparkRing: some View {
        // On near-white, cream/gold vanish — use saturated warm tones instead.
        let palette: [Color] = isDark
            ? [gold, amber, ember, cream]
            : [amber, ember, Color(red: 0.80, green: 0.55, blue: 0.12), teal]
        return ZStack {
            ForEach(0..<sparkCount, id: \.self) { i in
                let seed = Double(i) * 2.399963        // golden-angle hash
                let baseAngle = Double(i) / Double(sparkCount) * 2 * .pi
                let angle = baseAngle + sin(seed) * 0.20    // jitter
                let dist = 0.78 + 0.42 * abs(sin(seed * 1.7))  // 0.78…1.20
                let sizeK = 0.70 + 0.60 * abs(sin(seed * 2.3)) // 0.70…1.30
                let radius = iconSize * 0.5 + sparkT * iconSize * 0.95 * dist
                sparkCapsule(
                    color: palette[i % palette.count],
                    sizeK: sizeK,
                    angle: angle,
                    radius: radius
                )
            }
        }
        .allowsHitTesting(false)
    }

    private func sparkCapsule(color: Color, sizeK: Double, angle: Double, radius: Double) -> some View {
        Capsule()
            .fill(color)
            .frame(width: 3.2 * sizeK, height: 11 * sizeK)
            .scaleEffect(1.0 - sparkT * 0.4)
            .rotationEffect(.radians(angle + .pi / 2)) // long axis points outward
            .offset(x: CGFloat(cos(angle)) * radius,
                    y: CGFloat(sin(angle)) * radius)
            .opacity(sparksLive ? Double(sparkAlpha) : 0)
    }

    // Icon plus the one-shot specular sweep, clipped together so the light never
    // spills past the squircle. The sweep is a cheap offset over a 120pt region.
    private var iconMark: some View {
        Image(LaunchBranding.assetName, bundle: LaunchBranding.bundle)
            .resizable()
            .interpolation(.high)
            .scaledToFill()
            .overlay { if sweeping { specularBand } }
    }

    private var specularBand: some View {
        let travel = iconSize * 1.9
        // Warm cream gleam over the icon (same on both themes — it rides the
        // icon's own colours, not the page).
        return Rectangle()
            .fill(LinearGradient(
                colors: [.clear, cream.opacity(0.72), .clear],
                startPoint: .leading, endPoint: .trailing))
            .frame(width: iconSize * 0.5, height: iconSize * 2.2)
            .rotationEffect(.degrees(22))
            .offset(x: -travel / 2 + sweep * travel)
            .blendMode(.plusLighter)
            .allowsHitTesting(false)
    }

    // "Hawk" wordmark — rises in after the icon settles. Decorative (the root
    // already carries the accessibility label). Ink colour flips with appearance.
    private var wordmark: some View {
        let fill: LinearGradient = isDark
            ? LinearGradient(colors: [cream, gold.opacity(0.92)], startPoint: .top, endPoint: .bottom)
            : LinearGradient(colors: [deepTeal, Color(red: 0.04, green: 0.14, blue: 0.14)],
                             startPoint: .top, endPoint: .bottom)
        return Text(verbatim: "Hawk")
            .font(.system(size: 33, weight: .medium, design: .serif))
            .tracking(2)
            .foregroundStyle(fill)
            .shadow(color: .black.opacity(isDark ? 0.35 : 0.10), radius: 8, y: 3)
            .offset(y: iconSize * 0.86)                 // sit below the icon
            .offset(y: (reduceMotion || wordIn) ? 0 : 10) // gentle rise-in
            .opacity(wordIn ? 1 : 0)
            .allowsHitTesting(false)
    }

    private var background: some View {
        let colors: [Color] = isDark
            ? [Color(red: 0.04, green: 0.07, blue: 0.08),   // deep teal-charcoal
               Color(red: 0.01, green: 0.02, blue: 0.03)]
            : [Color(red: 0.985, green: 0.99, blue: 0.99),  // bright near-white, faint teal
               Color(red: 0.93, green: 0.955, blue: 0.955)]
        return LinearGradient(colors: colors, startPoint: .top, endPoint: .bottom)
    }

    private func run() {
        guard !reduceMotion else {
            // Reduce Motion: pure fade, no travel/scale/sparks.
            withAnimation(.easeOut(duration: 0.4)) { appeared = true; glowIn = true; wordIn = true }
            schedule(1.0, finish)
            return
        }

        // Beat 1 — pull-in + glow bloom. Nothing heavy is mounted → the spring
        // owns the main thread and runs clean.
        withAnimation(.spring(response: 0.7, dampingFraction: 0.76)) { appeared = true }
        withAnimation(.easeOut(duration: 0.8)) { glowIn = true }

        // Beat 2 — specular sweep + organic ember burst + light-catch flare as
        // the icon settles, with a soft landing tap.
        schedule(0.56) {
            sweeping = true
            sparksLive = true
            haptic(.soft, intensity: 0.6)
            withAnimation(.easeInOut(duration: 0.55)) { sweep = 1 }
            withAnimation(.easeOut(duration: 0.8)) { sparkT = 1 }
            withAnimation(.easeIn(duration: 0.85)) { sparkAlpha = 0 }
            withAnimation(.easeOut(duration: 0.22)) { flare = true }   // light hits
        }
        schedule(0.8) { withAnimation(.easeIn(duration: 0.5)) { flare = false } } // and eases off
        schedule(0.78) { withAnimation(.spring(response: 0.55, dampingFraction: 0.8)) { wordIn = true } }
        schedule(1.18) { sweeping = false }

        // Hold — a barely-there breathe keeps it alive (safe: nothing mounts
        // during the intro, so this can't be stuttered).
        schedule(1.0) {
            withAnimation(.easeInOut(duration: 1.6).repeatForever(autoreverses: true)) {
                breathe = true
            }
        }

        // Beat 3 — hand off. No mid-intro mount, so no settle window is needed.
        schedule(1.95, finish)
    }

    private func finish() {
        guard !exiting else { return }
        haptic(.rigid, intensity: 0.7)
        guard !reduceMotion else { onComplete(); return }
        // Gentle forward lunge + glow exhale; the host commits the cross-fade and
        // mounts after.
        withAnimation(.easeInOut(duration: 0.55)) { exiting = true }
        onComplete()
    }

    private func haptic(_ style: UIImpactFeedbackGenerator.FeedbackStyle, intensity: CGFloat) {
        let generator = UIImpactFeedbackGenerator(style: style)
        generator.impactOccurred(intensity: intensity)
    }

    private func schedule(_ seconds: Double, _ action: @escaping () -> Void) {
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            action()
        }
    }
}
