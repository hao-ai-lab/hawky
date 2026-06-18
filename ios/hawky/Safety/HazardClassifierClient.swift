import Foundation

// =============================================================================
// BridgeHazardClassifier — production HazardClassifier for Safety Check (#648).
//
// Runs OFF the realtime model: sends a base64 frame to the gateway's assess_hazard
// tool (→ vision service), which returns {severity, kind, warning}. Returns .safe on
// any failure so a missing service just means "no warning" (never blocks the session).
// =============================================================================

struct BridgeHazardClassifier: HazardClassifier {
    let bridge: LiveGatewayBridge
    let sessionKey: String

    func assess(jpeg: Data) async -> HazardAssessment {
        await bridge.assessHazard(imageBase64: jpeg.base64EncodedString(), sessionKey: sessionKey)
    }
}
