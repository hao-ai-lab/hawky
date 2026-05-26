import Foundation

struct RegionsUpdateRegion: Sendable, Equatable {
    let intentionId: String
    let place: String
    /// Fix 5: true for hard/obvious intentions — device should post a local notification on entry.
    let isHard: Bool
    /// Fix 5: human-readable label (the place name).
    let label: String
    /// #615: the intention content (e.g. "Buy milk"), shown as the region-entry
    /// notification title so the alert says what to do, not just "You've arrived".
    let content: String
}

enum ChatEvent: Sendable, Equatable {
    case text(content: String, replace: Bool)
    case toolStart(name: String)
    case toolResult(name: String, ok: Bool)
    case systemMessage(String)
    case permissionRequest(raw: JSONValue)
    case error(code: String, message: String)
    case done
    case intentionSurface(intentionId: String?, text: String, speak: Bool, whenBusy: String, cautious: Bool)
    /// M8 where-trigger: gateway pushes a region set for CLRegion monitoring.
    case regionsUpdate(regions: [RegionsUpdateRegion])
    /// #482: gateway armed a hard timed intention — device should schedule a local notification fallback.
    case whenArmed(intentionId: String, fireDate: String, title: String, body: String)
    /// #482: gateway disarmed or delivered a timed intention — device should cancel the pending notification.
    case whenDisarmed(intentionId: String)
}

// Maps a raw EventFrame to a ChatEvent. Unknown `event` names return nil so the
// caller can log drift (Hardening note: unknown frames) without crashing the read loop.
enum EventFrameDecoder {
    static func decode(_ frame: EventFrame) -> ChatEvent? {
        guard frame.event.hasPrefix("agent.") else { return nil }
        let suffix = String(frame.event.dropFirst("agent.".count))
        let obj = frame.payload?.asObject

        switch suffix {
        case "text":
            // Payload: { type: "text", content: <delta chunk>, replace?: <bool> }
            guard let s = obj?["content"]?.asString else { return nil }
            return .text(content: s, replace: obj?["replace"]?.asBool ?? false)
        case "done":
            return .done
        case "intention_surface":
            // { type:"intention_surface", intentionId?:<string>, body:<text>, speak:<bool>, whenBusy:<string>, cautious?:<bool> }
            guard let body = obj?["body"]?.asString else { return nil }
            let intentionId = obj?["intentionId"]?.asString
            let speak = obj?["speak"]?.asBool ?? false
            let whenBusy = obj?["whenBusy"]?.asString ?? "queue"
            let cautious = obj?["cautious"]?.asBool ?? false
            return .intentionSurface(intentionId: intentionId, text: body, speak: speak, whenBusy: whenBusy, cautious: cautious)
        case "regions.update":
            // { type:"regions.update", regions:[{intentionId, place, isHard?, label?}] }
            // M8: gateway emits this to push CLRegion arming descriptors to the device.
            // Fix 5: parse isHard + label so hard intentions can post local notifications.
            let rawRegions = obj?["regions"]?.asArray ?? []
            let regions = rawRegions.compactMap { v -> RegionsUpdateRegion? in
                guard let o = v.asObject,
                      let intentionId = o["intentionId"]?.asString,
                      let place = o["place"]?.asString
                else { return nil }
                let isHard = o["isHard"]?.asBool ?? false
                let label = o["label"]?.asString ?? place
                // #615: content is optional on the wire; default to "" (notification
                // falls back to the generic body when content is empty).
                let content = o["content"]?.asString ?? ""
                return RegionsUpdateRegion(intentionId: intentionId, place: place, isHard: isHard, label: label, content: content)
            }
            return .regionsUpdate(regions: regions)
        case "when.armed":
            // #482: { type:"when.armed", intentionId, fireDate, title, body }
            guard let intentionId = obj?["intentionId"]?.asString,
                  let fireDate = obj?["fireDate"]?.asString,
                  let title = obj?["title"]?.asString,
                  let body = obj?["body"]?.asString
            else { return nil }
            return .whenArmed(intentionId: intentionId, fireDate: fireDate, title: title, body: body)
        case "when.disarmed":
            // #482: { type:"when.disarmed", intentionId }
            guard let intentionId = obj?["intentionId"]?.asString else { return nil }
            return .whenDisarmed(intentionId: intentionId)
        case "error":
            // { type, content, code? }
            let msg = obj?["content"]?.asString ?? ""
            let code = obj?["code"]?.asString ?? "unknown"
            return .error(code: code, message: msg)
        case "system_message":
            guard let s = obj?["content"]?.asString else { return nil }
            return .systemMessage(s)
        case "tool_use_start":
            guard let n = obj?["name"]?.asString else { return nil }
            return .toolStart(name: n)
        case "tool_result":
            guard let n = obj?["name"]?.asString else { return nil }
            let isError = obj?["is_error"]?.asBool ?? false
            return .toolResult(name: n, ok: !isError)
        case "permission_request":
            guard let p = frame.payload else { return nil }
            return .permissionRequest(raw: p)
        default:
            return nil
        }
    }
}

private extension JSONValue {
    var asObject: [String: JSONValue]? {
        if case .object(let o) = self { return o }
        return nil
    }
    var asString: String? {
        if case .string(let s) = self { return s }
        return nil
    }
    var asBool: Bool? {
        if case .bool(let b) = self { return b }
        return nil
    }
    var asArray: [JSONValue]? {
        if case .array(let a) = self { return a }
        return nil
    }
}
