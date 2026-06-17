import CoreGraphics
import Foundation
import ImageIO

/// Decides whether a freshly-captured visual frame differs enough from the last
/// frame we actually sent to be worth sending again.
///
/// Extracted from `LiveSessionStore` so the dedup algorithm can be swapped
/// (e.g. dHash, SSIM, semantic embeddings) without touching the streaming loop.
/// The deduplicator sees frames *after* cadence downsampling, so it only ever
/// reduces the send rate below the configured cadence — never above it. (#612)
protocol VisualFrameDeduplicator: AnyObject {
    /// Returns `true` if `jpeg` should be sent, and updates the internal baseline
    /// when it decides to send. Returns `true` for the first frame and for any
    /// frame that has changed beyond the implementation's threshold.
    func shouldSend(_ jpeg: Data) -> Bool

    /// Clear baseline state when a visual stream stops or restarts.
    func reset()
}

/// Pass-through deduplicator: never skips. Used when frame dedup is toggled off,
/// so cadence alone governs the send rate (the pre-#612 behaviour).
final class PassThroughDeduplicator: VisualFrameDeduplicator {
    func shouldSend(_ jpeg: Data) -> Bool { true }
    func reset() {}
}

/// 8×8 average-hash (aHash) deduplicator. Computes a cheap perceptual hash from
/// an ImageIO thumbnail (no full-resolution decode) and skips frames within a
/// small Hamming distance of the last frame actually sent. A static scene
/// otherwise floods the realtime conversation with redundant `input_image`
/// items, which makes the model fixate and repeat itself.
final class AverageHashDeduplicator: VisualFrameDeduplicator {
    /// Frames within this Hamming distance of the last sent frame are skipped.
    let hammingThreshold: Int
    private var lastSentHash: UInt64?

    init(hammingThreshold: Int = 6) {
        self.hammingThreshold = hammingThreshold
    }

    func shouldSend(_ jpeg: Data) -> Bool {
        guard let hash = Self.perceptualHash(jpeg: jpeg) else {
            // Can't hash this frame → don't drop it; let cadence decide.
            return true
        }
        if let last = lastSentHash,
           (last ^ hash).nonzeroBitCount <= hammingThreshold {
            return false
        }
        lastSentHash = hash
        return true
    }

    func reset() { lastSentHash = nil }

    /// 8×8 grayscale average hash via an ImageIO thumbnail (max 16px), packed
    /// into a UInt64 where each bit is "this cell ≥ frame mean".
    static func perceptualHash(jpeg data: Data) -> UInt64? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceThumbnailMaxPixelSize: 16,
            kCGImageSourceCreateThumbnailWithTransform: true,
        ]
        guard let thumb = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        let side = 8
        var pixels = [UInt8](repeating: 0, count: side * side)
        guard let context = CGContext(
            data: &pixels,
            width: side,
            height: side,
            bitsPerComponent: 8,
            bytesPerRow: side,
            space: CGColorSpaceCreateDeviceGray(),
            bitmapInfo: CGImageAlphaInfo.none.rawValue
        ) else { return nil }
        context.interpolationQuality = .low
        context.draw(thumb, in: CGRect(x: 0, y: 0, width: side, height: side))
        let mean = pixels.reduce(0) { $0 + Int($1) } / pixels.count
        var hash: UInt64 = 0
        for (index, value) in pixels.enumerated() where Int(value) >= mean {
            hash |= (UInt64(1) << UInt64(index))
        }
        return hash
    }
}
