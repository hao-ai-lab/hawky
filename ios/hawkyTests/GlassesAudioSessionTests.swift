import AVFoundation
import Testing
@testable import hawky

@Suite struct GlassesAudioSessionTests {
    /// Locks the option set used by `GlassesAudioSession.activate()` so a
    /// future edit can't silently drop `.allowBluetoothHFP` and break
    /// Ray-Ban Meta routing.
    @Test @MainActor func requiredOptionsIncludeBluetoothHFP() {
        let opts = GlassesAudioSession.requiredOptions
        #expect(opts.contains(.allowBluetoothHFP))
        #expect(opts.contains(.duckOthers))
        #expect(opts.contains(.defaultToSpeaker))
    }
}
