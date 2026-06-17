import Foundation
import UIKit

struct LaunchConfiguration: Equatable {
    enum OnboardingMode: Equatable {
        case automatic
        case completed
        case forceFirstRun
    }

    enum FirstRunIntroMode: Equatable {
        case automatic
        case completed
        case forceFirstRun
    }

    enum GlassesStepMode: Equatable {
        case registration
        case staticPreview
    }

    enum GatewayMode: Equatable {
        case live
        case seededLocal
    }

    enum LiveProviderMode: Equatable {
        case configured
        case mock
    }

    enum IntroMode: Equatable {
        case userDefault
        case disabled
    }

    enum SeedProfile: String, Equatable {
        case none
        case empty
        case chatPopulated = "chat-populated"
        case recordings
        case sessions
        case mixed
        case error

        init(environmentValue: String?) {
            guard let environmentValue else {
                self = .empty
                return
            }
            switch environmentValue.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
            case "", "empty":
                self = .empty
            case "chat-populated", "chat_populated", "chat":
                self = .chatPopulated
            case "recordings":
                self = .recordings
            case "sessions":
                self = .sessions
            case "mixed":
                self = .mixed
            case "error":
                self = .error
            case "none":
                self = .none
            default:
                self = .empty
            }
        }
    }

    struct SeededSession: Equatable {
        let connectionID: String
        let sessionKey: String
        let displayName: String
    }

    let onboarding: OnboardingMode
    let firstRunIntro: FirstRunIntroMode
    let glassesStep: GlassesStepMode
    let gateway: GatewayMode
    let liveProvider: LiveProviderMode
    let intro: IntroMode
    let metaRuntimeEnabled: Bool
    let cameraAutostartEnabled: Bool
    let animationsEnabled: Bool
    let seedProfile: SeedProfile
    let seededSession: SeededSession?
    let defaultGatewayURLString: String?
    let defaultDeviceName: String?
    let tabConfigurationOverride: AppTabConfiguration?

    static let production = LaunchConfiguration(
        onboarding: .automatic,
        firstRunIntro: .automatic,
        glassesStep: .registration,
        gateway: .live,
        liveProvider: .configured,
        intro: .userDefault,
        metaRuntimeEnabled: true,
        cameraAutostartEnabled: true,
        animationsEnabled: true,
        seedProfile: .none,
        seededSession: nil,
        defaultGatewayURLString: nil,
        defaultDeviceName: nil,
        tabConfigurationOverride: nil
    )

    static func current(processInfo: ProcessInfo = .processInfo) -> LaunchConfiguration {
        #if DEBUG
        UITestingSupport.launchConfiguration(processInfo: processInfo) ?? .production
        #else
        .production
        #endif
    }

    var shouldShowIntro: Bool {
        intro == .userDefault && IntroSettings.isEnabled
    }

    var forcesOnboardingOverlay: Bool {
        onboarding == .forceFirstRun
    }

    var forcesFirstRunIntroOverlay: Bool {
        firstRunIntro == .forceFirstRun
    }

    var suppressesAutomaticOnboarding: Bool {
        onboarding != .automatic
    }

    func applyLaunchDefaults(defaults: UserDefaults = .standard) {
        if !animationsEnabled {
            UIView.setAnimationsEnabled(false)
        }

        guard gateway == .seededLocal || onboarding != .automatic || firstRunIntro != .automatic || tabConfigurationOverride != nil else {
            return
        }

        if intro == .disabled {
            defaults.set(false, forKey: IntroSettings.enabledKey)
        }
        switch onboarding {
        case .automatic:
            break
        case .completed:
            defaults.set(true, forKey: OnboardingState.completedKey)
            defaults.set(false, forKey: OnboardingState.skippedKey)
            defaults.set(false, forKey: OnboardingState.presentKey)
        case .forceFirstRun:
            defaults.set(false, forKey: OnboardingState.completedKey)
            defaults.set(false, forKey: OnboardingState.skippedKey)
            defaults.set(false, forKey: OnboardingState.presentKey)
        }
        switch firstRunIntro {
        case .automatic:
            break
        case .completed:
            defaults.set(true, forKey: FirstRunIntroState.completedKey)
            defaults.set(false, forKey: FirstRunIntroState.presentKey)
        case .forceFirstRun:
            defaults.set(false, forKey: FirstRunIntroState.completedKey)
            defaults.set(false, forKey: FirstRunIntroState.presentKey)
        }

        if let defaultGatewayURLString {
            if onboarding == .forceFirstRun {
                defaults.removeObject(forKey: "gatewayURL")
            } else {
                defaults.set(defaultGatewayURLString, forKey: "gatewayURL")
            }
        }
        if let defaultDeviceName {
            defaults.set(defaultDeviceName, forKey: "deviceName")
        }
        defaults.set(false, forKey: "actAsNode")
        defaults.set(LiveLockScreenMode.off.rawValue, forKey: "live.lockScreenMode")

        if let tabConfigurationOverride {
            defaults.removeObject(forKey: AppTabConfiguration.legacyTabOrderKey)
            defaults.set(tabConfigurationOverride.encodedStorageValue, forKey: AppTabConfiguration.storageKey)
        }
    }
}
