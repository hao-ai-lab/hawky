import Foundation

/// Audio container/encoding formats supported by sinks and sources.
///
/// Recording always produces raw PCM16 WAV at whatever sample rate the mic
/// hardware delivers. No on-device resampling. The `sampleRate` field is
/// informational only; the actual written rate comes from the live tap.
enum AudioFormat {
    /// WAV, mono PCM16, arbitrary hardware sample rate.
    case wavMono(sampleRate: Double)

    var fileExtension: String { "wav" }

    var sampleRate: Double {
        switch self {
        case .wavMono(let rate): return rate
        }
    }

    var channelCount: UInt32 { 1 }
}
