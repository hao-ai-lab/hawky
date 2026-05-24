import Foundation
import UserNotifications

/// Presents local notifications as a banner + sound even when the app is in the
/// foreground.
///
/// iOS suppresses banners for local notifications while the app is active by
/// default (they go silently to Notification Center). Ambient timed reminders
/// (#482/#589) need to alert the user whether the app is open or closed — when
/// the Live app is open the in-session surface is voice-only and easy to miss,
/// so the system banner is the reliable signal. Returning `.banner`/`.sound`
/// from `willPresent` opts every local notification into foreground display.
final class ForegroundNotificationDelegate: NSObject, UNUserNotificationCenterDelegate {
    static let shared = ForegroundNotificationDelegate()

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound, .list])
    }
}
