import Foundation

enum JSONValue: Codable, Equatable {
    case object([String: JSONValue])
    case array([JSONValue])
    case string(String)
    case number(Double)
    case bool(Bool)
    case null

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null; return }
        if let b = try? c.decode(Bool.self) { self = .bool(b); return }
        if let n = try? c.decode(Double.self) { self = .number(n); return }
        if let s = try? c.decode(String.self) { self = .string(s); return }
        if let a = try? c.decode([JSONValue].self) { self = .array(a); return }
        if let o = try? c.decode([String: JSONValue].self) { self = .object(o); return }
        throw DecodingError.dataCorruptedError(in: c, debugDescription: "Unsupported JSON value")
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let b): try c.encode(b)
        case .number(let n): try c.encode(n)
        case .string(let s): try c.encode(s)
        case .array(let a): try c.encode(a)
        case .object(let o): try c.encode(o)
        }
    }
}

struct RequestFrame: Encodable {
    let type: String
    let id: String
    let method: String
    let params: [String: JSONValue]?

    init(id: String, method: String, params: [String: JSONValue]? = nil) {
        self.type = "req"
        self.id = id
        self.method = method
        self.params = params
    }
}

struct ErrorPayload: Codable, Equatable {
    let code: String
    let message: String
}

struct ResponseFrame: Decodable {
    let type: String
    let id: String
    let ok: Bool
    let payload: JSONValue?
    let error: ErrorPayload?
}

struct EventFrame: Decodable {
    let type: String
    let event: String
    let payload: JSONValue?
    let seq: Int?
}

// IncomingFrame maps unknown `type` values to `.unknown` instead of throwing.
// Hardening note: silently swallowed malformed frames hid real protocol drift.
// Callers log `.unknown` so we surface drift without crashing the socket reader.
enum IncomingFrame: Decodable {
    case response(ResponseFrame)
    case event(EventFrame)
    case unknown(rawJSON: String)

    private enum PeekKeys: String, CodingKey { case type }

    init(from decoder: Decoder) throws {
        let peek = try decoder.container(keyedBy: PeekKeys.self)
        let type = try peek.decode(String.self, forKey: .type)
        switch type {
        case "res":
            self = .response(try ResponseFrame(from: decoder))
        case "event":
            self = .event(try EventFrame(from: decoder))
        default:
            let raw = try JSONValue(from: decoder)
            let data = try JSONEncoder().encode(raw)
            self = .unknown(rawJSON: String(data: data, encoding: .utf8) ?? "")
        }
    }
}
