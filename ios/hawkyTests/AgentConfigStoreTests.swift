import Foundation
import Testing
@testable import hawky

final class AgentConfigMockTransport: GatewayTransport, @unchecked Sendable {
    private(set) var sentFrames: [RequestFrame] = []
    var responseProvider: (RequestFrame) throws -> ResponseFrame

    init(responseProvider: @escaping (RequestFrame) throws -> ResponseFrame) {
        self.responseProvider = responseProvider
    }

    func connect(url: URL, connectParams: ConnectParams) async throws -> HelloPayload {
        HelloPayload(connId: "mock", serverVersion: "test", methods: [])
    }

    func send(_ frame: RequestFrame) async throws -> ResponseFrame {
        sentFrames.append(frame)
        return try responseProvider(frame)
    }

    func events() -> AsyncStream<EventFrame> {
        AsyncStream { $0.finish() }
    }

    func disconnect() async {}
}

@Suite @MainActor
struct AgentConfigStoreTests {
    @Test func loadReadsProviderModelAndVertexConfig() async throws {
        let transport = AgentConfigMockTransport { frame in
            #expect(frame.method == "config.get")
            return try Self.response(
                id: frame.id,
                json: #"{"type":"res","id":"ID","ok":true,"payload":{"provider":"vertex","model":"claude-opus-4-7","api_base_url":"https://api.anthropic.com","vertex":{"project_id":"hawky","region":"global"}}}"#
            )
        }
        let store = AgentConfigStore()

        await store.load(transport: transport)

        #expect(store.provider == "vertex")
        #expect(store.model == "claude-opus-4-7")
        #expect(store.apiBaseURL == "https://api.anthropic.com")
        #expect(store.vertexProjectID == "hawky")
        #expect(store.vertexRegion == "global")
        #expect(store.loadState == .loaded)
    }

    @Test func saveSwapsProviderAndModelThroughGateway() async throws {
        let transport = AgentConfigMockTransport { frame in
            #expect(frame.method == "gateway.swapProvider")
            let params = try #require(frame.params)
            #expect(params["provider"] == .string("openai"))
            #expect(params["model"] == .string("gpt-5.5"))
            #expect(params["openai_base_url"] == .string("https://control.example/internal/provider/openai/v1"))
            #expect(params["api_base_url"] == nil)
            return try Self.response(
                id: frame.id,
                json: #"{"type":"res","id":"ID","ok":true,"payload":{"ok":true}}"#
            )
        }
        let store = AgentConfigStore()

        await store.save(
            provider: "openai",
            model: "gpt-5.5",
            apiBaseURL: "https://control.example/internal/provider/openai/v1",
            transport: transport
        )

        #expect(store.provider == "openai")
        #expect(store.model == "gpt-5.5")
        #expect(store.apiBaseURL == "https://control.example/internal/provider/openai/v1")
        #expect(store.saveState == .saved(nil))
    }

    @Test func saveSurfacesProviderCompatibilityWhenBackendIgnoresProvider() async throws {
        let transport = AgentConfigMockTransport { frame in
            try Self.response(
                id: frame.id,
                json: #"{"type":"res","id":"ID","ok":true,"payload":{"config":{"provider":"anthropic","model":"claude-sonnet-4-6"}}}"#
            )
        }
        let store = AgentConfigStore()

        await store.save(provider: "vertex", model: "claude-sonnet-4-6", apiBaseURL: "", transport: transport)

        #expect(store.provider == "anthropic")
        #expect(store.model == "claude-sonnet-4-6")
        #expect(store.saveState == .saved("Model saved. This gateway does not support provider updates yet."))
    }

    @Test func invalidRequestRevertsDraftState() async throws {
        let transport = AgentConfigMockTransport { frame in
            try Self.response(
                id: frame.id,
                json: #"{"type":"res","id":"ID","ok":false,"error":{"code":"INVALID_REQUEST","message":"model must be a non-empty string"}}"#
            )
        }
        let store = AgentConfigStore()

        await store.save(provider: "vertex", model: "bad", apiBaseURL: "https://api.anthropic.com", transport: transport)

        #expect(store.provider == "anthropic")
        #expect(store.model == "")
        #expect(store.saveState == .error("model must be a non-empty string"))
    }

    private static func response(id: String, json: String) throws -> ResponseFrame {
        let patched = json.replacingOccurrences(of: #""id":"ID""#, with: #""id":"\#(id)""#)
        return try JSONDecoder().decode(ResponseFrame.self, from: Data(patched.utf8))
    }
}
