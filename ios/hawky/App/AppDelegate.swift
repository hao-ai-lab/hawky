import UIKit
import UserNotifications

/// UIKit app delegate, adapted into the SwiftUI lifecycle via
/// `@UIApplicationDelegateAdaptor`. Its only job today is to install the
/// `UNUserNotificationCenter` delegate at `didFinishLaunching` — the earliest
/// reliable point, before any notification can be delivered. (Setting the
/// delegate from SwiftUI `App.init()` is timing-fragile; `didFinishLaunching`
/// is Apple's documented place for it.)
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = ForegroundNotificationDelegate.shared
        return true
    }
}
