// STATIC REVIEW ONLY — no Xcode/simulator in CI; verified by contract-check against
// Apple's documented CoreLocation + UNUserNotificationCenter APIs.
//
// AmbientLocationManager — CoreLocation trigger layer for M3.
//
// Responsibilities:
//   • Hold the iOS CLLocationManager for region monitoring +
//     significant-location-change.
//   • Accept a projected region set (≤20 CLCircularRegion) from the gateway
//     and keep it loaded into CLLocationManager.
//   • On region entry: report up to the gateway AND (for hard `where` Intentions)
//     post an on-device local notification via UNUserNotificationCenter.
//   • On significant-location-change: request reprojection from the gateway
//     so the ≤20-region budget stays relevant.
//   • Always-authorization onboarding: request WhenInUse first; expose a
//     flag that the UI layer reads to show the value-prop screen before
//     escalating to Always. Never cold-prompt for Always.
//   • Degrade gracefully: when auth is denied, mark armed Intentions as arm_failed
//     (via the delegate callback) and surface a user-visible notice.
//
// CoreLocation contract notes (validated against Apple docs):
//   • Region monitoring requires Always authorization for background / killed
//     app wake. WhenInUse only fires regions while app is in foreground.
//   • CLLocationManager.startMonitoring(for:) cap is ~20 simultaneous regions.
//   • Significant-location-change also requires Always auth.
//   • CLLocationManagerDelegate callbacks may arrive on any thread; all
//     mutations are dispatched to @MainActor.
//   • UNUserNotificationCenter.add(_:) is async-safe.

import Foundation
import CoreLocation
import os
import UserNotifications

/// #481 CoreLocation diagnostics — visible in the device unified log.
/// log stream --predicate 'subsystem == "live.hawky" && category == "AmbientWhere"'
private let ambientCLLog = Logger(subsystem: "live.hawky", category: "AmbientWhere")

// MARK: - Supporting types

/// A region projected from the gateway arming payload.
struct AmbientRegion: Identifiable, Sendable {
    let id: String       // stable Intention ID — used as CLRegion.identifier prefix
    let center: CLLocationCoordinate2D
    let radiusMeters: Double
    /// true → hard `where` Intention; post a local notification on entry.
    let isHard: Bool
    /// Human-readable label (the place name) shown in the notification.
    let label: String
    /// #615: the intention content (e.g. "Buy milk"), used as the notification
    /// title on region entry. Empty string → fall back to the generic body.
    let content: String
}

/// Events the manager emits upward (to the bridge / gateway reporter).
/// Note: not `Sendable` because `Error` is not `Sendable`; the callback is
/// always dispatched to @MainActor before delivery, so this is safe.
enum AmbientLocationEvent {
    /// User entered a monitored region. Gateway should evaluate + fire the Intention.
    case regionEntered(regionID: String)
    /// Significant location change — gateway should reproject the region set.
    case significantLocationChange(coordinate: CLLocationCoordinate2D)
    /// Authorization changed — includes the new status.
    case authorizationChanged(CLAuthorizationStatus)
    /// An error from CLLocationManager.
    case monitoringError(regionID: String, error: Error)
}

// MARK: - AmbientLocationManager

/// Wraps CLLocationManager for ambient `where` trigger handling.
/// Instantiated and owned by LiveSessionStore (or AppDelegate for background wake).
@MainActor
final class AmbientLocationManager: NSObject {

    // MARK: Public state (read by UI and LiveSessionStore)

    /// Current authorization status.
    private(set) var authorizationStatus: CLAuthorizationStatus = .notDetermined

    /// True when the value-prop screen should be shown before escalating to Always.
    /// Set after WhenInUse is granted; consumed by the onboarding UX.
    private(set) var showAlwaysValueProp = false

    /// True when location auth has been denied — callers should surface a notice
    /// and mark in-flight Intentions arm_failed.
    private(set) var isDenied = false

    // MARK: Callbacks

    /// Called on the main actor when a location event occurs.
    var onEvent: ((AmbientLocationEvent) -> Void)?

    /// Fix 6: per-region arm callbacks, keyed by CLRegion identifier.
    /// Called from didStartMonitoringFor (ok:true) or monitoringDidFailFor (ok:false).
    var onRegionMonitoringResult: ((String, Bool, String?) -> Void)?

    // MARK: Private

    private lazy var manager: CLLocationManager = {
        // Created LAZILY — not at construction. AmbientLocationManager is built
        // during LiveSessionStore init, which runs in ContentView's @State at app
        // launch. Creating CLLocationManager + reading authorizationStatus does
        // synchronous XPC to locationd; on the launch path that froze the first
        // frame (white screen). The manager is first touched only when the
        // where-feature actually arms a region / requests auth — off the launch path.
        let m = CLLocationManager()
        m.delegate = self
        return m
    }()
    /// Regions currently loaded into CLLocationManager, keyed by identifier.
    private var monitoredRegions: [String: AmbientRegion] = [:]
    /// Fix 4: cache coords for already-monitored regions to survive transient geocode failures.
    private var coordCache: [String: CLLocationCoordinate2D] = [:]
    /// #481: full set of geocoded `where` regions for the session, NOT capped at 20.
    /// CoreLocation only monitors the nearest ≤20 (the "projection"); on significant
    /// location change we reproject from this superset so regions dropped by the cap
    /// can come back when the user moves toward them. Keyed by intention id.
    private var desiredRegions: [String: AmbientRegion] = [:]
    /// #481: most recent device location, used as the origin when projecting the
    /// nearest ≤20 regions. Updated by significant-location-change updates.
    private var lastKnownLocation: CLLocationCoordinate2D?
    /// CoreLocation monitors at most ~20 simultaneous regions.
    private let maxMonitoredRegions = 20

    // MARK: Init

    override init() {
        super.init()
        // Intentionally NO CoreLocation work — the CLLocationManager is created
        // lazily (see `manager`). authorizationStatus stays .notDetermined until the
        // manager is first used, at which point the delegate updates it. This keeps
        // app launch (ContentView @State → LiveSessionStore init) off CoreLocation.
    }

    // MARK: Authorization onboarding (never cold-prompt for Always)

    /// Step 1: request WhenInUse (called from the first onboarding screen).
    /// The OS will present the WhenInUse prompt; delegate updates `authorizationStatus`.
    func requestWhenInUseAuthorization() {
        guard manager.authorizationStatus == .notDetermined else { return }
        manager.requestWhenInUseAuthorization()
    }

    /// Step 2: called from the value-prop screen after the user taps "Allow always".
    /// Only escalates if WhenInUse is already granted — never skips step 1.
    func requestAlwaysAuthorization() {
        guard manager.authorizationStatus == .authorizedWhenInUse else { return }
        showAlwaysValueProp = false
        manager.requestAlwaysAuthorization()
    }

    /// Fix 1: request Always authorization before arming a background where region.
    /// Drives WhenInUse → value-prop → Always. Call before updateRegions when the
    /// intention is a hard/background where arm. Returns true if Always is already
    /// granted (caller may proceed); false if escalation is still in progress
    /// (caller should report arm_failed for a hard background requirement and let
    /// the onboarding UX re-arm after the user grants Always).
    @discardableResult
    func ensureAlwaysForBackgroundArm() -> Bool {
        switch manager.authorizationStatus {
        case .authorizedAlways:
            return true
        case .notDetermined:
            // Start the two-step flow: request WhenInUse first.
            manager.requestWhenInUseAuthorization()
            return false
        case .authorizedWhenInUse:
            // Show value-prop screen so the user can opt in to Always.
            showAlwaysValueProp = true
            return false
        case .denied, .restricted:
            isDenied = true
            return false
        @unknown default:
            return false
        }
    }

    // MARK: Region projection (called by gateway response handler)

    /// Replace the active region set with the gateway's projected regions (≤20).
    /// Regions already monitored with the same id are left unchanged to avoid
    /// re-arming churn. Regions absent from the new descriptor set are stopped.
    ///
    /// Fix 4: Only stop regions whose intentionId is NOT present in `regions` —
    /// not all regions that fail geocode. The cache preserves coords for existing
    /// monitored regions so a transient geocode failure does not remove them.
    ///
    /// Fix 6: arm callbacks (`onRegionMonitoringResult`) are NOT called here; they
    /// are delivered from `didStartMonitoringFor` / `monitoringDidFailFor` so the
    /// ack reflects actual OS registration, not just the startMonitoring call.
    func updateRegions(_ regions: [AmbientRegion]) {
        // Stop only regions whose intentionId is no longer in the incoming descriptor set.
        // Fix 4: don't stop a still-armed region just because geocode failed transiently.
        let incomingIntentionIDs = Set(regions.map { $0.id })
        for (id, ambient) in monitoredRegions where !incomingIntentionIDs.contains(ambient.id) {
            if let clRegion = manager.monitoredRegions.first(where: { $0.identifier == id }) {
                manager.stopMonitoring(for: clRegion)
            }
            monitoredRegions.removeValue(forKey: id)
            coordCache.removeValue(forKey: id)
        }

        // Start regions not yet monitored.
        for region in regions {
            let id = regionIdentifier(for: region.id)
            if monitoredRegions[id] != nil {
                // Already monitored — update isHard/label in place but don't re-arm.
                monitoredRegions[id] = region
                coordCache[id] = region.center
                continue
            }
            let clRegion = CLCircularRegion(
                center: region.center,
                radius: min(region.radiusMeters, manager.maximumRegionMonitoringDistance),
                identifier: id
            )
            clRegion.notifyOnEntry = true
            clRegion.notifyOnExit = false
            ambientCLLog.notice("startMonitoring CLCircularRegion id=\(id, privacy: .public) center=\(region.center.latitude),\(region.center.longitude) r=\(clRegion.radius)")
            manager.startMonitoring(for: clRegion)
            monitoredRegions[id] = region
            // Fix 4: cache the coord so a future geocode failure doesn't lose it.
            coordCache[id] = region.center
        }
    }

    /// Fix 4: return the cached coordinate for an already-monitored region, if any.
    func cachedCoordinate(for intentionId: String) -> CLLocationCoordinate2D? {
        let id = regionIdentifier(for: intentionId)
        return coordCache[id]
    }

    /// #481: best available current-location hint for biasing a place-name search.
    /// Prefers CoreLocation's last fix; falls back to the significant-change location.
    /// Used so a bare POI name like "Trader Joe's" resolves to the NEAREST one rather
    /// than failing (a bare-name geocode with no region returns nothing).
    func currentLocationHint() -> CLLocationCoordinate2D? {
        manager.location?.coordinate ?? lastKnownLocation
    }

    // MARK: Reprojection (#481)

    /// #481: Replace the full desired-region superset (all geocoded `where`
    /// regions for the session, uncapped) and immediately project the nearest
    /// ≤20 around the last known location into CLLocationManager. The caller
    /// (LiveSessionStore) geocodes every region — including ones beyond the cap —
    /// and hands them all here so reprojection on movement has the full set to
    /// choose from. Passing an empty array clears monitoring.
    func setDesiredRegions(_ regions: [AmbientRegion]) {
        desiredRegions = Dictionary(regions.map { ($0.id, $0) }, uniquingKeysWith: { _, new in new })
        projectNearest()
    }

    /// #481: Recompute the monitored ≤20 around a new device location. Called when
    /// a significant-location-change arrives so the budget tracks the nearest
    /// regions as the user moves. No-op if there is no desired set yet.
    func reproject(around coordinate: CLLocationCoordinate2D) {
        lastKnownLocation = coordinate
        projectNearest()
    }

    /// Project the nearest `maxMonitoredRegions` of `desiredRegions` (relative to
    /// `lastKnownLocation`) into CLLocationManager via `updateRegions`. When the
    /// desired set already fits the cap, ordering is irrelevant and all are kept.
    /// With no known location yet, we keep a stable prefix so monitoring still
    /// arms — the first significant-location-change will reproject by distance.
    private func projectNearest() {
        let selected = Self.selectNearest(
            from: Array(desiredRegions.values),
            around: lastKnownLocation,
            limit: maxMonitoredRegions
        )
        updateRegions(selected)
    }

    /// Pure selection logic (no CoreLocation side effects), extracted so it can be
    /// unit-tested without a live CLLocationManager. Given the full desired set,
    /// returns the subset CoreLocation should monitor:
    ///   • If the set fits `limit`, return all (order irrelevant).
    ///   • With an `origin`, return the `limit` nearest by great-circle distance —
    ///     this is what lets a region dropped by the cap come back as the user
    ///     moves toward it (#481).
    ///   • With no `origin` yet, return a stable id-sorted prefix so arming is
    ///     deterministic until the first location fix reprojects by distance.
    nonisolated static func selectNearest(
        from regions: [AmbientRegion],
        around origin: CLLocationCoordinate2D?,
        limit: Int
    ) -> [AmbientRegion] {
        guard regions.count > limit else { return regions }
        guard let origin else {
            return regions.sorted { $0.id < $1.id }.prefix(limit).map { $0 }
        }
        let originLoc = CLLocation(latitude: origin.latitude, longitude: origin.longitude)
        func distance(_ r: AmbientRegion) -> CLLocationDistance {
            originLoc.distance(from: CLLocation(latitude: r.center.latitude, longitude: r.center.longitude))
        }
        return regions
            // Tie-break by id so the result is deterministic when distances are equal.
            .sorted { lhs, rhs in
                let dl = distance(lhs), dr = distance(rhs)
                return dl == dr ? lhs.id < rhs.id : dl < dr
            }
            .prefix(limit)
            .map { $0 }
    }

    // MARK: Significant-location-change monitoring

    /// Start significant-location-change updates so the gateway can reproject
    /// the region budget when the user moves far away.
    /// Requires Always authorization; no-op if not granted.
    func startSignificantLocationChangeMonitoring() {
        guard manager.authorizationStatus == .authorizedAlways else { return }
        manager.startMonitoringSignificantLocationChanges()
    }

    func stopSignificantLocationChangeMonitoring() {
        manager.stopMonitoringSignificantLocationChanges()
    }

    // MARK: Developer testing (#481) — mock location

    /// All `where` regions known for the session (the uncapped superset), regardless
    /// of whether they're currently among the monitored ≤20. Exposed for the
    /// developer-mode "Mock location" tool so a tester can pick one to arrive at.
    var allDesiredRegions: [AmbientRegion] {
        Array(desiredRegions.values)
    }

    /// Developer tool: simulate arriving at a known region WITHOUT physically moving.
    /// Runs the exact same path as a real CoreLocation `didEnterRegion`: posts the
    /// local notification (for hard regions) and fires `.regionEntered`, which the
    /// bridge reports to the gateway as `region.entered` to fire the intention.
    func simulateArrival(intentionId: String) async {
        onEvent?(.regionEntered(regionID: intentionId))
        let id = regionIdentifier(for: intentionId)
        if let region = desiredRegions[intentionId] ?? monitoredRegions[id], region.isHard {
            await postRegionEntryNotification(for: region)
        }
    }

    /// Developer tool: feed a mock device coordinate, exactly as a real
    /// significant-location-change would. Drives reprojection of the nearest ≤20.
    func simulateLocationChange(_ coordinate: CLLocationCoordinate2D) {
        lastKnownLocation = coordinate
        onEvent?(.significantLocationChange(coordinate: coordinate))
    }

    // MARK: Local notification for hard `where` Intentions

    /// Post an immediate local notification for a hard `where` Intention on region entry.
    /// Reuses the same UNUserNotificationCenter pattern as NotificationShowCommand.
    func postRegionEntryNotification(for region: AmbientRegion) async {
        let center = UNUserNotificationCenter.current()
        let settings = await center.notificationSettings()
        guard settings.authorizationStatus == .authorized
                || settings.authorizationStatus == .provisional else {
            // Notification permission denied; fire the degradation callback only —
            // the Intention will be delivered in-session / next foreground (§7 fallback).
            onEvent?(.authorizationChanged(manager.authorizationStatus))
            return
        }
        let notification = UNMutableNotificationContent()
        // #615: show the reminder itself. Title = what to do ("Buy milk"),
        // body = arrival context. Fall back to the generic alert when the
        // gateway didn't supply content (older builds / empty content).
        if region.content.isEmpty {
            notification.title = region.label
            notification.body = "You've arrived."
        } else {
            notification.title = region.content
            notification.body = "You've arrived at \(region.label)"
        }
        notification.sound = .default
        // Unique identifier so multiple Intentions don't collide.
        let identifier = "ambient.region.\(region.id)"
        let trigger = UNTimeIntervalNotificationTrigger(timeInterval: 0.1, repeats: false)
        let request = UNNotificationRequest(identifier: identifier, content: notification, trigger: trigger)
        try? await center.add(request)
    }

    // MARK: Schedule a hard `when` local notification at arm time

    /// Schedule an on-device local notification for a hard `when` Intention.
    /// `fireDate` is the absolute UTC date; notification fires at that wall-clock time.
    /// Call this at arm time (from the gateway arming ack handler).
    func scheduleWhenNotification(intentionID: String, title: String, body: String, fireDate: Date) async {
        let center = UNUserNotificationCenter.current()
        let settings = await center.notificationSettings()
        // Request auth if not yet determined (mirrors NotificationShowCommand pattern).
        let authorized: Bool
        switch settings.authorizationStatus {
        case .notDetermined:
            authorized = (try? await center.requestAuthorization(options: [.alert, .sound])) ?? false
        case .denied:
            authorized = false
        case .authorized, .provisional, .ephemeral:
            authorized = true
        @unknown default:
            authorized = false
        }
        guard authorized else {
            // Notify the caller so it can mark the Intention arm_failed (limited) and
            // surface a user-visible notice per §7 degradation.
            onEvent?(.authorizationChanged(.denied))
            return
        }
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        // #589: time-sensitive so the banner shows promptly even in the
        // foreground / under Focus, not just silently in Notification Center.
        content.interruptionLevel = .timeSensitive
        let components = Calendar.current.dateComponents(
            [.year, .month, .day, .hour, .minute, .second],
            from: fireDate
        )
        let trigger = UNCalendarNotificationTrigger(dateMatching: components, repeats: false)
        let identifier = "ambient.when.\(intentionID)"
        let request = UNNotificationRequest(identifier: identifier, content: content, trigger: trigger)
        // Cancel any prior notification for this Intention (re-arm / time change).
        center.removePendingNotificationRequests(withIdentifiers: [identifier])
        try? await center.add(request)
    }

    // MARK: Helpers

    private func regionIdentifier(for intentionID: String) -> String {
        "ambient.region.\(intentionID)"
    }

    private func intentionID(from regionIdentifier: String) -> String? {
        let prefix = "ambient.region."
        guard regionIdentifier.hasPrefix(prefix) else { return nil }
        return String(regionIdentifier.dropFirst(prefix.count))
    }
}

// MARK: - CLLocationManagerDelegate

extension AmbientLocationManager: CLLocationManagerDelegate {

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let status = manager.authorizationStatus
        Task { @MainActor in
            self.authorizationStatus = status
            switch status {
            case .authorizedWhenInUse:
                // Prompt granted WhenInUse — show value-prop screen before escalating.
                self.showAlwaysValueProp = true
                self.isDenied = false
            case .authorizedAlways:
                self.showAlwaysValueProp = false
                self.isDenied = false
                self.manager.startMonitoringSignificantLocationChanges()
            case .denied, .restricted:
                self.isDenied = true
                self.showAlwaysValueProp = false
            case .notDetermined:
                self.isDenied = false
            @unknown default:
                break
            }
            self.onEvent?(.authorizationChanged(status))
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager,
                                     didEnterRegion region: CLRegion) {
        guard let circularRegion = region as? CLCircularRegion else { return }
        let id = circularRegion.identifier
        Task { @MainActor in
            // Report region entry to the gateway.
            if let intentionID = self.intentionID(from: id) {
                self.onEvent?(.regionEntered(regionID: intentionID))
                // Post a local notification for hard `where` Intentions.
                if let ambient = self.monitoredRegions[id], ambient.isHard {
                    await self.postRegionEntryNotification(for: ambient)
                }
            }
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager,
                                     didStartMonitoringFor region: CLRegion) {
        let id = region.identifier
        ambientCLLog.notice("didStartMonitoringFor id=\(id, privacy: .public) → arm OK")
        Task { @MainActor in
            // Fix 6: report arm success from the OS confirmation callback, not from startMonitoring().
            guard let intentionID = self.intentionID(from: id) else { return }
            self.onRegionMonitoringResult?(intentionID, true, nil)
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager,
                                     monitoringDidFailFor region: CLRegion?,
                                     withError error: Error) {
        let id = region?.identifier ?? "unknown"
        ambientCLLog.error("monitoringDidFailFor id=\(id, privacy: .public): \(error.localizedDescription, privacy: .public)")
        Task { @MainActor in
            guard let intentionID = self.intentionID(from: id) else {
                self.onEvent?(.monitoringError(regionID: id, error: error))
                return
            }
            // Fix 6: report arm failure from the OS failure callback; roll back the region.
            self.monitoredRegions.removeValue(forKey: id)
            self.coordCache.removeValue(forKey: id)
            self.onRegionMonitoringResult?(intentionID, false, error.localizedDescription)
            self.onEvent?(.monitoringError(regionID: intentionID, error: error))
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager,
                                     didUpdateLocations locations: [CLLocation]) {
        guard let loc = locations.last else { return }
        let coordinate = loc.coordinate
        Task { @MainActor in
            // #481: record the new origin so reprojection (triggered below) picks the
            // nearest regions. Kept in sync even if the bridge handler is slow.
            self.lastKnownLocation = coordinate
            // Significant-location-change fired; reproject the local region budget.
            self.onEvent?(.significantLocationChange(coordinate: coordinate))
        }
    }
}

// MARK: - Who/scene trigger stub

/// STUB — session-gated; build in a later milestone (§6 `who`/scene trigger).
/// Placeholder so callers can reference the API without a build break.
enum AmbientWhoTrigger {
    /// Start watching for `who`/scene triggers during a live session.
    /// Not implemented; always no-ops.
    static func startSessionGated() {
        // TODO(M3+): implement when perception stream is available.
    }
}
