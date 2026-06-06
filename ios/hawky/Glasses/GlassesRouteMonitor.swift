import AVFoundation
import Combine
import Foundation

/// Observes `AVAudioSession.currentRoute` and publishes a debounced view of
/// whether the user's glasses (or any HFP peripheral) are currently the
/// active audio route.
///
/// Phase A only: we do not try to distinguish Ray-Ban Meta from a generic
/// bluetooth headset beyond what `portName` tells us. "Glasses paired" here
/// means: any input port whose `portType` is `.bluetoothHFP`. If someone
/// pairs AirPods, the label will say "AirPods" and `isGlassesPaired` will be
/// true — that's fine for the pairing-proof milestone.
@MainActor
final class GlassesRouteMonitor: ObservableObject {
    /// Human-readable name of the active input port (e.g. "Ray-Ban Meta",
    /// "iPhone Microphone"). Falls back to "No input" when none is routed.
    @Published private(set) var routeName: String = "No input"

    /// True when the active input port is an HFP bluetooth device.
    @Published private(set) var isGlassesPaired: Bool = false

    /// True when the system lists at least one HFP input in `availableInputs`
    /// — useful to show "paired but not selected" hints in a later phase.
    @Published private(set) var hfpAvailable: Bool = false

    private let session = AVAudioSession.sharedInstance()
    private var observers: [NSObjectProtocol] = []
    private var debounceTask: Task<Void, Never>?
    private let debounce: Duration = .milliseconds(1500)

    init() {
        let center = NotificationCenter.default
        let routeObs = center.addObserver(
            forName: AVAudioSession.routeChangeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            // Hop back onto the main actor for @Published mutation + debounce.
            Task { @MainActor [weak self] in self?.scheduleRefresh() }
        }
        observers.append(routeObs)
        // First pass: hop off the current call so @StateObject init (which
        // runs on the main thread during view mount) doesn't block the
        // tab-transition animation on first tap. Querying
        // AVAudioSession.currentRoute + availableInputs is cheap but not
        // free; coalescing with the Glasses tab's other first-frame work
        // caused a visible glitch. A Task hop lands us back on MainActor
        // after SwiftUI has committed the transition frame.
        Task { @MainActor [weak self] in self?.refreshNow() }
    }

    deinit {
        for obs in observers {
            NotificationCenter.default.removeObserver(obs)
        }
    }

    /// Debounce route flaps (glasses sleeping on the user's head triggers a
    /// rapid disconnect/reconnect). We coalesce to the last value after
    /// `debounce` of quiet.
    private func scheduleRefresh() {
        debounceTask?.cancel()
        debounceTask = Task { [weak self, debounce] in
            try? await Task.sleep(for: debounce)
            guard !Task.isCancelled else { return }
            await MainActor.run { self?.refreshNow() }
        }
    }

    private func refreshNow() {
        let route = session.currentRoute
        let activeInput = route.inputs.first
        let name = activeInput?.portName ?? "No input"
        let paired = activeInput?.portType == .bluetoothHFP
        let available = (session.availableInputs ?? [])
            .contains { $0.portType == .bluetoothHFP }

        if routeName != name { routeName = name }
        if isGlassesPaired != paired { isGlassesPaired = paired }
        if hfpAvailable != available { hfpAvailable = available }
    }
}
