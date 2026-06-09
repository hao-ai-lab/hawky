import AVKit
import SwiftUI
import UIKit

/// SwiftUI wrapper around `AVRoutePickerView` — the system-blessed picker used
/// by Apple's own apps to select an audio output (built-in speaker, AirPods,
/// paired BT/HFP devices, AirPlay). iOS owns the actual routing; we just
/// present the sheet. Programmatically enumerating outputs is intentionally
/// not supported by iOS, so this is the correct primitive.
struct RoutePickerButton: UIViewRepresentable {
    var activeTintColor: UIColor? = nil
    var tintColor: UIColor? = nil

    func makeUIView(context: Context) -> AVRoutePickerView {
        let view = AVRoutePickerView()
        view.prioritizesVideoDevices = false
        view.setContentHuggingPriority(.required, for: .horizontal)
        view.setContentCompressionResistancePriority(.required, for: .horizontal)
        view.isAccessibilityElement = true
        view.accessibilityLabel = "Audio output"
        view.accessibilityIdentifier = "recording.outputPicker"
        return view
    }

    func updateUIView(_ view: AVRoutePickerView, context: Context) {
        if let tint = tintColor { view.tintColor = tint }
        if let active = activeTintColor { view.activeTintColor = active }
    }
}
