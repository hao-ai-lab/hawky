import SwiftUI

@main
struct AgentApp: App {
    // Installs the UNUserNotificationCenter delegate at didFinishLaunching so
    // foreground reminder notifications show a banner (#589).
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @Environment(\.colorScheme) private var colorScheme
    @State private var container: AppContainer
    @State private var showIntro: Bool
    @State private var mountContent: Bool
    @State private var introOpacity = 1.0
    private let launchConfiguration: LaunchConfiguration

    init() {
        let launchConfiguration = LaunchConfiguration.current()
        launchConfiguration.applyLaunchDefaults()
        self.launchConfiguration = launchConfiguration
        _container = State(initialValue: AppContainer(launchConfiguration: launchConfiguration))
        if launchConfiguration.metaRuntimeEnabled {
            MetaWearablesRuntime.configure()
        }
        // Honor the Settings toggle at launch: when the intro is off, skip
        // straight to the app (mount it immediately, never show the intro).
        let introOn = launchConfiguration.shouldShowIntro
        _showIntro = State(initialValue: introOn)
        _mountContent = State(initialValue: !introOn)
    }

    var body: some Scene {
        WindowGroup {
            ZStack {
                // Persistent base that matches the launch screen + intro field, so
                // no white window ever shows through — not before the intro's first
                // frame, nor in the hand-off gap before ContentView paints.
                (colorScheme == .dark
                    ? Color(red: 0.04, green: 0.07, blue: 0.08)
                    : Color(red: 0.975, green: 0.982, blue: 0.982))
                    .ignoresSafeArea()

                // ContentView is NOT mounted while the intro animates — the intro
                // owns the main thread so its motion can't be starved. It mounts
                // only at hand-off, AFTER the fade animation below is committed to
                // Core Animation, so its (expensive) build + keyboard-prewarm +
                // gateway connect spike lands behind the still-opaque fading intro
                // and never stutters the cross-fade.
                if mountContent {
                    ContentView(launchConfiguration: launchConfiguration)
                        .environment(container)
                        .onOpenURL { url in
                            guard launchConfiguration.metaRuntimeEnabled else { return }
                            Task {
                                _ = await MetaWearablesRuntime.handleOpenURL(url)
                            }
                        }
                }

                if showIntro {
                    HawkIntroView(onComplete: handOff)
                        .opacity(introOpacity)
                        .zIndex(100)
                }
            }
        }
    }

    // Hand-off: commit the intro's fade FIRST (so it runs render-server-side),
    // then mount the host on the next run loop, then drop the faded-out intro.
    private func handOff() {
        withAnimation(.easeInOut(duration: 0.55)) { introOpacity = 0 }
        DispatchQueue.main.async { mountContent = true }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { showIntro = false }
    }
}
