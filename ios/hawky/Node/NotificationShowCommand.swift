import Foundation
#if canImport(UserNotifications)
import UserNotifications

protocol NotificationScheduling {
    func notificationAuthorizationStatus() async -> UNAuthorizationStatus
    func requestNotificationAuthorization(options: UNAuthorizationOptions) async throws -> Bool
    func addNotification(title: String, body: String) async throws
}

extension UNUserNotificationCenter: NotificationScheduling {
    func notificationAuthorizationStatus() async -> UNAuthorizationStatus {
        await notificationSettings().authorizationStatus
    }

    func requestNotificationAuthorization(options: UNAuthorizationOptions) async throws -> Bool {
        try await requestAuthorization(options: options)
    }

    func addNotification(title: String, body: String) async throws {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        let trigger = UNTimeIntervalNotificationTrigger(timeInterval: 0.1, repeats: false)
        let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: trigger)
        try await add(request)
    }
}
#endif

// NotificationShowCommand — schedules a local notification.
// Requests .alert + .sound authorization on first call. If denied, returns
// {shown:false, reason:"unauthorized"} cleanly — callers (and tests) should
// not be blocked by the OS prompt.
struct NotificationShowCommand: NodeCommand {
    static let name = "notification.show"

    func invoke(args: JSONValue) async throws -> JSONValue {
        var title = "Notification"
        var body = ""
        if case let .object(obj) = args {
            if case let .some(.string(s)) = obj["title"] { title = s }
            if case let .some(.string(s)) = obj["body"] { body = s }
        }
        #if canImport(UserNotifications)
        return await Self.schedule(
            title: title,
            body: body,
            center: UNUserNotificationCenter.current()
        )
        #else
        return .object([
            "shown": .bool(false),
            "reason": .string("unsupported"),
        ])
        #endif
    }

    #if canImport(UserNotifications)
    static func schedule(
        title: String,
        body: String,
        center: NotificationScheduling
    ) async -> JSONValue {
        let status = await center.notificationAuthorizationStatus()
        let authorized: Bool
        switch status {
        case .notDetermined:
            // Will prompt the user the first time.
            authorized = (try? await center.requestNotificationAuthorization(options: [.alert, .sound])) ?? false
        case .denied:
            authorized = false
        case .authorized, .provisional, .ephemeral:
            authorized = true
        @unknown default:
            authorized = false
        }
        if !authorized {
            return .object([
                "shown": .bool(false),
                "reason": .string("unauthorized"),
            ])
        }
        do {
            try await center.addNotification(title: title, body: body)
            return .object([
                "shown": .bool(true),
                "reason": .null,
            ])
        } catch {
            return .object([
                "shown": .bool(false),
                "reason": .string("add_failed: \(error.localizedDescription)"),
            ])
        }
    }
    #endif
}
