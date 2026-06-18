import Foundation
#if canImport(Vision)
import Vision
#endif
#if canImport(CoreImage)
import CoreImage
#endif

// =============================================================================
// FaceCropper — on-device face detection + cropping (Cocktail Party Mode, #627).
//
// DeepFace owns matching, so iOS only needs to find faces in a frame and hand a
// tight crop to the gateway. Detection/cropping stays on-device (Vision) — only a
// face crop ever leaves the phone. Behind a protocol so tests inject a fake.
// =============================================================================

/// A detected face crop ready to send to the recognition service.
struct FaceCrop: Equatable {
    /// JPEG bytes of the cropped (+margin) face.
    var jpeg: Data
    /// Normalized [0,1] bounding box (Vision convention, origin bottom-left).
    var boundingBox: CGRect
    var confidence: Float
}

protocol FaceCropper: Sendable {
    /// Detect faces in a JPEG frame and return a crop per face (empty if none).
    func cropFaces(in jpeg: Data) async -> [FaceCrop]
    /// The single best (largest) face as a generously-padded, upscaled crop suitable
    /// for the recognition service — or nil if no face. Sending this instead of the
    /// raw frame gives InsightFace a big, well-framed face (live frames otherwise put
    /// the face at only 50–100px in a cluttered 640×360 frame → weak embeddings).
    func bestFaceCrop(in jpeg: Data) async -> Data?
}

#if canImport(Vision) && canImport(CoreImage)
final class VisionFaceCropper: FaceCropper, @unchecked Sendable {
    private let ciContext = CIContext(options: nil)
    /// Skip faces smaller than this normalized width (too small to recognize well).
    private let minFaceWidth: CGFloat

    init(minFaceWidth: CGFloat = 0.06) {
        self.minFaceWidth = minFaceWidth
    }

    func cropFaces(in jpeg: Data) async -> [FaceCrop] {
        guard let ciImage = CIImage(data: jpeg) else { return [] }
        let observations = detectFaces(in: ciImage)
        var crops: [FaceCrop] = []
        for obs in observations {
            guard let data = cropJPEG(ciImage: ciImage, normalizedBox: obs.boundingBox, upscaleTo: nil) else { continue }
            crops.append(FaceCrop(jpeg: data, boundingBox: obs.boundingBox, confidence: obs.confidence))
        }
        return crops
    }

    func bestFaceCrop(in jpeg: Data) async -> Data? {
        guard let ciImage = CIImage(data: jpeg) else { return nil }
        // Largest detected face (the subject the user is showing).
        guard let best = detectFaces(in: ciImage).max(by: { $0.boundingBox.width < $1.boundingBox.width }) else {
            return nil
        }
        // Generous margin (context helps the SCRFD detector on the server) + upscale
        // so the face lands well above the server's min-size gate.
        return cropJPEG(ciImage: ciImage, normalizedBox: best.boundingBox, upscaleTo: 480)
    }

    private func detectFaces(in ciImage: CIImage) -> [VNFaceObservation] {
        let request = VNDetectFaceRectanglesRequest()
        let handler = VNImageRequestHandler(ciImage: ciImage, options: [:])
        do { try handler.perform([request]) } catch { return [] }
        return (request.results ?? []).filter { $0.boundingBox.width >= minFaceWidth }
    }

    /// Crop a normalized face box (+margin) out of the image; optionally upscale the
    /// shortest side to `upscaleTo` px so a small live-frame face becomes large.
    private func cropJPEG(ciImage: CIImage, normalizedBox: CGRect, upscaleTo: CGFloat?) -> Data? {
        let extent = ciImage.extent
        let margin: CGFloat = 0.5
        let bx = (normalizedBox.origin.x - normalizedBox.width * margin) * extent.width
        let by = (normalizedBox.origin.y - normalizedBox.height * margin) * extent.height
        let bw = normalizedBox.width * (1 + margin * 2) * extent.width
        let bh = normalizedBox.height * (1 + margin * 2) * extent.height
        let rect = CGRect(x: bx, y: by, width: bw, height: bh).intersection(extent)
        guard !rect.isNull, rect.width > 1, rect.height > 1 else { return nil }
        var cropped = ciImage.cropped(to: rect).transformed(by: CGAffineTransform(translationX: -rect.origin.x, y: -rect.origin.y))
        if let target = upscaleTo {
            let shortest = min(cropped.extent.width, cropped.extent.height)
            if shortest > 0, shortest < target {
                let scale = target / shortest
                cropped = cropped.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
            }
        }
        guard let colorSpace = cropped.colorSpace ?? CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
        return ciContext.jpegRepresentation(of: cropped, colorSpace: colorSpace, options: [:])
    }
}
#endif
