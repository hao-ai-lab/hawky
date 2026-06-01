import Foundation
import Observation

enum AgentProvider: String, CaseIterable, Identifiable {
    case anthropic
    case vertex
    case openaiCompatible = "openai_compatible"

    var id: String { rawValue }

    var label: String {
        switch self {
        case .anthropic: return "Anthropic"
        case .vertex: return "Vertex"
        case .openaiCompatible: return "OpenAI-compatible"
        }
    }

    static func label(for rawValue: String) -> String {
        Self(rawValue: rawValue)?.label ?? rawValue
    }
}

struct AgentModelOption: Identifiable, Equatable {
    let id: String
    let label: String
    let provider: String?
}

let kAgentModelOptions: [AgentModelOption] = [
    AgentModelOption(id: "claude-opus-4-7", label: "Claude Opus 4.7", provider: nil),
    AgentModelOption(id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", provider: nil),
    AgentModelOption(id: "claude-haiku-4-5", label: "Claude Haiku 4.5", provider: nil),
    AgentModelOption(id: "Qwen/Qwen3-Omni-30B-A3B-Instruct", label: "Qwen3 Omni 30B", provider: AgentProvider.openaiCompatible.rawValue),
    AgentModelOption(id: "Qwen/Qwen3.6-27B", label: "Qwen3.6 27B", provider: AgentProvider.openaiCompatible.rawValue),
]

@MainActor
@Observable
final class AgentConfigStore {
    private(set) var provider: String = AgentProvider.anthropic.rawValue
    private(set) var model: String = ""
    private(set) var apiBaseURL: String = "https://api.anthropic.com"
    private(set) var vertexProjectID: String = ""
    private(set) var vertexRegion: String = "global"
    private(set) var loadState: LoadState = .idle
    private(set) var saveState: SaveState = .idle

    enum LoadState: Equatable {
        case idle
        case loading
        case loaded
        case error(String)
    }

    enum SaveState: Equatable {
        case idle
        case saving
        case saved(String?)
        case error(String)
    }

    var modelOptions: [AgentModelOption] {
        var options = kAgentModelOptions.filter { $0.provider == nil || $0.provider == provider }
        if !model.isEmpty && !options.contains(where: { $0.id == model }) {
            options.insert(AgentModelOption(id: model, label: model, provider: provider), at: 0)
        }
        return options
    }

    func load(transport: GatewayTransport) async {
        loadState = .loading
        let frame = RequestFrame(id: UUID().uuidString, method: "config.get", params: nil)
        do {
            let resp = try await transport.send(frame)
            guard resp.ok else {
                loadState = .error(message(for: resp.error, fallback: "config.get failed"))
                return
            }
            apply(payload: resp.payload)
            loadState = .loaded
        } catch {
            loadState = .error("\(error)")
        }
    }

    func save(provider newProvider: String, model newModel: String, apiBaseURL newAPIBaseURL: String, transport: GatewayTransport) async {
        let trimmedProvider = newProvider.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedModel = newModel.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedAPIBaseURL = newAPIBaseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedProvider.isEmpty, !trimmedModel.isEmpty, !trimmedAPIBaseURL.isEmpty else {
            saveState = .error("Provider, model, and API base URL are required.")
            return
        }

        let previousProvider = provider
        let previousModel = model
        let previousAPIBaseURL = apiBaseURL
        provider = trimmedProvider
        model = trimmedModel
        apiBaseURL = trimmedAPIBaseURL
        saveState = .saving

        let params: [String: JSONValue] = [
            "provider": .string(trimmedProvider),
            "model": .string(trimmedModel),
            "api_base_url": .string(trimmedAPIBaseURL),
        ]
        let frame = RequestFrame(id: UUID().uuidString, method: "config.update", params: params)
        do {
            let resp = try await transport.send(frame)
            guard resp.ok else {
                provider = previousProvider
                model = previousModel
                apiBaseURL = previousAPIBaseURL
                saveState = .error(message(for: resp.error, fallback: "config.update failed"))
                return
            }

            apply(payload: resp.payload)
            if provider != trimmedProvider {
                saveState = .saved("Model saved. This gateway does not support provider updates yet.")
            } else {
                saveState = .saved(nil)
            }
        } catch {
            provider = previousProvider
            model = previousModel
            apiBaseURL = previousAPIBaseURL
            saveState = .error("\(error)")
        }
    }

    private func message(for error: ErrorPayload?, fallback: String) -> String {
        guard let error else { return fallback }
        switch GatewayErrorCode(rawValue: error.code) {
        case .methodNotFound:
            return "This gateway does not support config RPCs yet."
        case .invalidRequest:
            return error.message.isEmpty ? "The gateway rejected this provider/model." : error.message
        default:
            return error.message.isEmpty ? fallback : error.message
        }
    }

    private func apply(payload: JSONValue?) {
        guard let config = configObject(from: payload) else { return }
        if case .some(.string(let s)) = config["provider"], !s.isEmpty {
            provider = s
        }
        if case .some(.string(let s)) = config["model"] {
            model = s
        }
        if case .some(.string(let s)) = config["api_base_url"], !s.isEmpty {
            apiBaseURL = s
        }
        if case .some(.object(let vertex)) = config["vertex"] {
            if case .some(.string(let s)) = vertex["project_id"] { vertexProjectID = s }
            if case .some(.string(let s)) = vertex["region"], !s.isEmpty { vertexRegion = s }
        }
    }

    private func configObject(from payload: JSONValue?) -> [String: JSONValue]? {
        guard case .object(let root) = payload ?? .null else { return nil }
        if case .some(.object(let config)) = root["config"] {
            return config
        }
        return root
    }
}
