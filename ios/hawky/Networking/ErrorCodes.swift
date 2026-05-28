import Foundation

enum GatewayErrorCode: Equatable {
    case invalidRequest
    case unauthorized
    case notFound
    case noSession
    case gatewayDraining
    case internalError
    case methodNotFound
    case handshakeRequired
    case unknown(String)

    init(rawValue: String) {
        switch rawValue {
        case "INVALID_REQUEST": self = .invalidRequest
        case "UNAUTHORIZED": self = .unauthorized
        case "NOT_FOUND": self = .notFound
        case "NO_SESSION": self = .noSession
        case "GATEWAY_DRAINING": self = .gatewayDraining
        case "INTERNAL_ERROR": self = .internalError
        case "METHOD_NOT_FOUND": self = .methodNotFound
        case "HANDSHAKE_REQUIRED": self = .handshakeRequired
        default: self = .unknown(rawValue)
        }
    }

    var rawValue: String {
        switch self {
        case .invalidRequest: return "INVALID_REQUEST"
        case .unauthorized: return "UNAUTHORIZED"
        case .notFound: return "NOT_FOUND"
        case .noSession: return "NO_SESSION"
        case .gatewayDraining: return "GATEWAY_DRAINING"
        case .internalError: return "INTERNAL_ERROR"
        case .methodNotFound: return "METHOD_NOT_FOUND"
        case .handshakeRequired: return "HANDSHAKE_REQUIRED"
        case .unknown(let s): return s
        }
    }
}
