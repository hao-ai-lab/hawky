import WebRTC
import PipecatClientIOS

extension RTCAudioTrack {
    func toRtvi() -> MediaTrackId {
        return MediaTrackId(id: trackId)
    }
}
