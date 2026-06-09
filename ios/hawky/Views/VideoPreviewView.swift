import AVFoundation
import SwiftUI

/// Lightweight UIViewRepresentable that renders the live camera feed from a
/// VideoCapture session. Read-only — no controls, just the preview layer.
///
/// The `AVCaptureVideoPreviewLayer` is a *sublayer*, not the view's backing
/// layer, and it is resized in `layoutSubviews` with implicit CALayer
/// animations disabled. That matters during the PiP→fullscreen resize: if the
/// preview were the backing layer, UIKit would attach its own implicit
/// animation to every frame change and fight SwiftUI's animation, producing the
/// jittery "抽搐" stutter. Keeping the layer resize instantaneous (no implicit
/// animation) lets SwiftUI's frame spring drive a smooth expand. (#415)
struct VideoPreviewView: UIViewRepresentable {
    let capture: VideoCapture

    func makeUIView(context: Context) -> PreviewUIView {
        let view = PreviewUIView()
        view.backgroundColor = .black
        view.accessibilityIdentifier = "videoPreview.camera"
        view.isAccessibilityElement = true
        view.accessibilityLabel = "Camera preview"
        view.previewLayer.videoGravity = .resizeAspectFill
        view.previewLayer.session = capture.captureSession
        return view
    }

    func updateUIView(_ uiView: PreviewUIView, context: Context) {
        // Only re-wire the session when it actually changed (e.g. capture
        // restarted). Re-assigning every update is expensive and can hitch the
        // feed mid-resize.
        if uiView.previewLayer.session !== capture.captureSession {
            uiView.previewLayer.session = capture.captureSession
        }
    }
}

final class PreviewUIView: UIView {
    let previewLayer = AVCaptureVideoPreviewLayer()

    override init(frame: CGRect) {
        super.init(frame: frame)
        layer.addSublayer(previewLayer)
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        layer.addSublayer(previewLayer)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        // Resize the preview layer to fill the view with NO implicit animation,
        // so a SwiftUI-animated frame change doesn't double-animate the layer.
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        previewLayer.frame = bounds
        CATransaction.commit()
    }
}
