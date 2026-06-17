import SwiftUI

enum FirstRunIntroState {
    static let completedKey = "firstRunIntro.completed"
    static let presentKey = "firstRunIntro.present"

    static func shouldAutoPresent(defaults: UserDefaults = .standard) -> Bool {
        !defaults.bool(forKey: completedKey)
    }

    static func markCompleted(defaults: UserDefaults = .standard) {
        defaults.set(true, forKey: completedKey)
        defaults.set(false, forKey: presentKey)
    }
}

private enum FirstRunIntroStep: Int, CaseIterable, Identifiable {
    case overview
    case liveMode
    case setup
    case privacy
    case begin

    var id: Int { rawValue }

    var title: String {
        switch self {
        case .overview: return "Hawky"
        case .liveMode: return "Live Mode"
        case .setup: return "Setup"
        case .privacy: return "Access"
        case .begin: return "Set Up"
        }
    }
}

struct FirstRunIntroView: View {
    let onRunSetup: () -> Void
    let onEnterApp: () -> Void

    @State private var step: FirstRunIntroStep = .overview
    @State private var isMovingForward = true

    private let stepAnimation = Animation.easeOut(duration: 0.14)

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                progressHeader

                ZStack {
                    currentCard
                        .id(step)
                        .transition(cardTransition)
                }
                .clipped()
            }
            .safeAreaInset(edge: .bottom) {
                bottomControls
                    .transaction { transaction in
                        transaction.animation = nil
                    }
            }
            .navigationTitle(step.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    if step != .overview {
                        Button {
                            goBack()
                        } label: {
                            Label("Back", systemImage: "chevron.left")
                        }
                        .accessibilityIdentifier("firstRunIntro.back")
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    if step != .begin {
                        Button("Skip") {
                            enterApp()
                        }
                        .accessibilityIdentifier("firstRunIntro.skip")
                    }
                }
            }
        }
        .tint(DesignTokens.accent)
        .interactiveDismissDisabled()
        .accessibilityIdentifier("screen.firstRunIntro")
    }

    private var cardTransition: AnyTransition {
        .asymmetric(
            insertion: .opacity.combined(with: .move(edge: isMovingForward ? .trailing : .leading)),
            removal: .opacity.combined(with: .move(edge: isMovingForward ? .leading : .trailing))
        )
    }

    private var progressHeader: some View {
        HStack(spacing: 8) {
            ForEach(FirstRunIntroStep.allCases) { item in
                Capsule()
                    .fill(item.rawValue <= step.rawValue ? DesignTokens.accent : Color.secondary.opacity(0.25))
                    .frame(height: 4)
                    .animation(stepAnimation, value: step)
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 12)
        .padding(.bottom, 4)
        .accessibilityElement()
        .accessibilityLabel("Intro step \(step.rawValue + 1) of \(FirstRunIntroStep.allCases.count)")
    }

    @ViewBuilder
    private var currentCard: some View {
        switch step {
        case .overview:
            card(
                identifier: "firstRunIntro.card.overview",
                icon: "sparkles",
                title: "Meet Hawky",
                message: "Use this iPhone as the voice, camera, and control surface for your Hawky agent.",
                rows: [
                    ("waveform", "Talk live", "Start a realtime voice session when you want to work hands-free."),
                    ("video", "Show context", "Share the iPhone camera or Ray-Ban Meta view only when you choose."),
                    ("brain.head.profile", "Keep continuity", "Your Hawky machine provides memory, tools, and sessions.")
                ]
            )
        case .liveMode:
            liveModeCard
        case .setup:
            card(
                identifier: "firstRunIntro.card.setup",
                icon: "checklist",
                title: "What setup needs",
                message: "Hawky has two parts: this iPhone for Live, and your Hawky machine for memory, tools, and sessions.",
                rows: [
                    ("waveform", "iPhone Live", "Add an OpenAI API key on this iPhone for realtime voice."),
                    ("desktopcomputer", "Hawky machine", "Run Hawky gateway on a machine this phone can reach."),
                    ("brain.head.profile", "Backend provider", "Configure Anthropic, OpenAI, or an OpenAI-compatible provider there."),
                    ("network", "Network access", "Use local network, Tailscale, or Cloudflare Access to connect.")
                ]
            )
        case .privacy:
            card(
                identifier: "firstRunIntro.card.privacy",
                icon: "hand.raised.fill",
                title: "You approve each connection",
                message: "Setup checks only what you choose. Live asks for device access when a feature actually needs it.",
                rows: [
                    ("mic", "Microphone", "Requested when you start Live audio."),
                    ("camera.viewfinder", "Camera", "Requested only if you enable visual context."),
                    ("checkmark.shield", "Gateway", "Verified before memory and tools are used."),
                    ("key.fill", "Keys", "The Live key stays on this iPhone; backend keys stay with Hawky.")
                ]
            )
        case .begin:
            beginCard
        }
    }

    private var liveModeCard: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text("How Live mode works")
                    .font(.largeTitle.bold())
                    .tracking(-0.2)
                    .accessibilityIdentifier("firstRunIntro.card.liveMode")

                Text("Use the marked controls to open options, share visual context, toggle listening, type instead of talk, and start Live.")
                    .font(.callout)
                    .foregroundStyle(.secondary)

                VStack(alignment: .center, spacing: 10) {
                    liveModeScreenshotGuide

                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: 12) {
                            liveLegendRow("1", "More")
                            liveLegendRow("2", "Camera")
                            liveLegendRow("3", "Mic")
                            liveLegendRow("4", "Keyboard")
                            liveLegendRow("5", "Start")
                        }

                        LazyVGrid(
                            columns: [
                                GridItem(.flexible(), spacing: 10),
                                GridItem(.flexible(), spacing: 10)
                            ],
                            alignment: .leading,
                            spacing: 8
                        ) {
                            liveLegendRow("1", "More")
                            liveLegendRow("2", "Camera")
                            liveLegendRow("3", "Mic")
                            liveLegendRow("4", "Keyboard")
                            liveLegendRow("5", "Start")
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .center)
                }
                .padding(.top, 4)
            }
            .padding(.horizontal, 24)
            .padding(.vertical, 16)
            .padding(.bottom, 88)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var liveModeScreenshotGuide: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .fill(Color(.secondarySystemBackground))
                .shadow(color: .black.opacity(0.12), radius: 16, y: 8)

            Image("FirstRunLiveModeIntro")
                .resizable()
                .scaledToFill()
                .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
                .padding(4)

            GeometryReader { proxy in
                liveCallout(
                    "1",
                    target: CGPoint(x: proxy.size.width * 0.90, y: proxy.size.height * 0.108),
                    badge: CGPoint(x: proxy.size.width * 0.56, y: proxy.size.height * 0.108)
                )
                liveCallout(
                    "2",
                    target: CGPoint(x: proxy.size.width * 0.890, y: proxy.size.height * 0.628),
                    badge: CGPoint(x: proxy.size.width * 0.56, y: proxy.size.height * 0.593)
                )
                liveCallout(
                    "3",
                    target: CGPoint(x: proxy.size.width * 0.890, y: proxy.size.height * 0.705),
                    badge: CGPoint(x: proxy.size.width * 0.56, y: proxy.size.height * 0.690)
                )
                liveCallout(
                    "4",
                    target: CGPoint(x: proxy.size.width * 0.890, y: proxy.size.height * 0.782),
                    badge: CGPoint(x: proxy.size.width * 0.56, y: proxy.size.height * 0.782)
                )
                liveCallout(
                    "5",
                    target: CGPoint(x: proxy.size.width * 0.890, y: proxy.size.height * 0.860),
                    badge: CGPoint(x: proxy.size.width * 0.56, y: proxy.size.height * 0.880)
                )
            }
            .padding(4)
        }
        .frame(width: 200, height: 435)
        .accessibilityElement()
        .accessibilityLabel("Live mode screenshot with numbered controls: More, Camera, Mic, Keyboard, and Start.")
    }

    private func liveCallout(_ number: String, target: CGPoint, badge: CGPoint) -> some View {
        ZStack {
            Path { path in
                path.move(to: badge)
                path.addLine(to: target)
            }
            .stroke(DesignTokens.accent.opacity(0.8), style: StrokeStyle(lineWidth: 1.5, lineCap: .round))

            Circle()
                .stroke(DesignTokens.accent, lineWidth: 3)
                .background(Circle().fill(DesignTokens.accent.opacity(0.08)))
                .frame(width: 30, height: 30)
                .position(target)

            Text(number)
                .font(.caption2.bold())
                .foregroundStyle(.white)
                .frame(width: 18, height: 18)
                .background(DesignTokens.accent, in: Circle())
                .overlay(Circle().stroke(.white, lineWidth: 1.5))
                .shadow(color: .black.opacity(0.18), radius: 3, y: 1)
                .position(badge)
        }
    }

    private func liveLegendRow(_ number: String, _ title: String) -> some View {
        HStack(alignment: .center, spacing: 8) {
            Text(number)
                .font(.caption2.bold())
                .foregroundStyle(.white)
                .frame(width: 18, height: 18)
                .background(DesignTokens.accent, in: Circle())
            Text(title)
                .font(.caption.weight(.semibold))
                .lineLimit(1)
                .minimumScaleFactor(0.85)
        }
    }

    @ViewBuilder
    private var bottomControls: some View {
        if step == .begin {
            VStack(spacing: 10) {
                Button {
                    runSetup()
                } label: {
                    Text("Set up now")
                        .frame(maxWidth: .infinity)
                }
                .primaryPanelAction()
                .controlSize(.large)
                .accessibilityIdentifier("firstRunIntro.runSetup")

                Button {
                    enterApp()
                } label: {
                    Text("Explore first")
                        .frame(maxWidth: .infinity)
                }
                .secondaryPanelAction()
                .controlSize(.large)
                .accessibilityIdentifier("firstRunIntro.enterApp")
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 12)
            .padding(.top, 8)
            .background(.regularMaterial)
        } else {
            Button {
                goNext()
            } label: {
                Text("Continue")
                    .frame(maxWidth: .infinity)
            }
            .primaryPanelAction()
            .controlSize(.large)
            .accessibilityIdentifier("firstRunIntro.continue")
            .padding(.horizontal, 20)
            .padding(.bottom, 12)
            .padding(.top, 8)
            .background(.regularMaterial)
        }
    }

    private var beginCard: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                introIcon("arrow.forward.circle.fill")

                Text("Set up Hawky")
                    .font(.largeTitle.bold())
                    .tracking(-0.2)
                    .accessibilityIdentifier("firstRunIntro.card.begin")

                Text("Start with the connection and Live key. If your Hawky machine is not ready yet, you can enter the app and finish later.")
                    .font(.body)
                    .foregroundStyle(.secondary)

                VStack(alignment: .leading, spacing: 14) {
                    introRow("wand.and.sparkles", "Set up now", "Connect the gateway, add the Live OpenAI key, and choose optional inputs.")
                    introRow("rectangle.stack", "Explore first", "Open the app now and finish setup later from Settings.")
                }
                .padding(.top, 4)
            }
            .padding(.horizontal, 24)
            .padding(.vertical, 16)
            .padding(.bottom, 136)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func card(
        identifier: String,
        icon: String,
        title: String,
        message: String,
        rows: [(String, String, String)]
    ) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                introIcon(icon)

                Text(title)
                    .font(.largeTitle.bold())
                    .tracking(-0.2)
                    .accessibilityIdentifier(identifier)

                Text(message)
                    .font(.body)
                    .foregroundStyle(.secondary)

                VStack(alignment: .leading, spacing: 14) {
                    ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                        introRow(row.0, row.1, row.2)
                    }
                }
                .padding(.top, 4)
            }
            .padding(.horizontal, 24)
            .padding(.vertical, 16)
            .padding(.bottom, 88)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func introIcon(_ icon: String) -> some View {
        Image(systemName: icon)
            .font(.system(size: 38, weight: .semibold))
            .foregroundStyle(DesignTokens.accent)
            .frame(width: 76, height: 76)
            .background(DesignTokens.accent.opacity(0.12), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .stroke(DesignTokens.accent.opacity(0.18), lineWidth: 1)
            }
            .frame(maxWidth: .infinity, alignment: .center)
            .padding(.top, 8)
    }

    private func introRow(_ icon: String, _ title: String, _ subtitle: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(DesignTokens.accent)
                .frame(width: 34, height: 34)
                .background(DesignTokens.accent.opacity(0.1), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.headline)
                Text(subtitle)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.vertical, 2)
    }

    private func goNext() {
        guard let next = FirstRunIntroStep(rawValue: step.rawValue + 1) else { return }
        isMovingForward = true
        withAnimation(stepAnimation) { step = next }
    }

    private func goBack() {
        guard let previous = FirstRunIntroStep(rawValue: step.rawValue - 1) else { return }
        isMovingForward = false
        withAnimation(stepAnimation) { step = previous }
    }

    private func runSetup() {
        FirstRunIntroState.markCompleted()
        onRunSetup()
    }

    private func enterApp() {
        FirstRunIntroState.markCompleted()
        onEnterApp()
    }
}
