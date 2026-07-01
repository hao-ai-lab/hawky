import Foundation

enum LiveGatewayBridgeError: LocalizedError {
    case missingToken
    case notConfigured
    case gateway(String)

    var errorDescription: String? {
        switch self {
        case .missingToken:
            return "No Hawky gateway token is stored on this phone."
        case .notConfigured:
            return "Hawky bridge is not configured."
        case .gateway(let message):
            return message
        }
    }
}

struct LiveGatewayBridgeResponse {
    var sessionKey: String
    var text: String
    var systemMessages: [String]
    var toolEvents: [String]
    var error: String? = nil
}

/// Result of the `intention.create` RPC: either a stored+armed intention, or a
/// precision-gate bounce asking the model to clarify the trigger time.
struct LiveIntentionCreateResult {
    var ok: Bool
    var intentionId: String?
    var state: String?
    var needsClarification: Bool
    var ask: String?
}

enum LiveGatewayBridgeStreamEvent: Equatable {
    /// The feed websocket handshake just completed (initial connect or a reconnect).
    /// Emitted by `stream()` so the consumer can clear the offline state when the
    /// gateway comes back mid-session — "received first data" is not a reliable
    /// signal because a healthy gateway may stay silent.
    case connected
    case text(content: String, replace: Bool)
    case toolStart(String)
    case toolResult(name: String, ok: Bool)
    case system(String)
    case done
    case error(String)
    case intentionSurface(intentionId: String?, text: String, speak: Bool, whenBusy: String, cautious: Bool)
    /// M8 where-trigger: gateway pushes region arming descriptors for CLRegion monitoring.
    case regionsUpdate(regions: [RegionsUpdateRegion])
    /// #482: gateway armed a hard timed intention — device should schedule local notification fallback.
    case whenArmed(intentionId: String, fireDate: String, title: String, body: String)
    /// #482: gateway disarmed or delivered a timed intention — device should cancel pending notification.
    case whenDisarmed(intentionId: String)
}

struct LiveFrontendBootContextResponse {
    var context: String
    var sources: [String]
    var warnings: [String]
    var toolbox: String?
    var firstContact: LiveFrontendFirstContactState
}

struct LiveFrontendFirstContactState {
    var active: Bool
    var reason: String
    var markerFile: String?
}

actor LiveGatewayBridge {
    private let gatewayURL: URL
    private let transportFactory: @Sendable () -> any GatewayTransport
    /// Ambient mode for this bridge connection (M6 §3.6). Set from config.mode on bootstrap.
    /// Sent as ConnectParams.mode on every connection. Defaults to "quiet".
    private var currentMode: String = "quiet"

    init(
        gatewayURL: URL,
        transportFactory: @escaping @Sendable () -> any GatewayTransport = { URLSessionGatewayTransport() }
    ) {
        self.gatewayURL = gatewayURL
        self.transportFactory = transportFactory
    }

    func bootstrap(sessionKey: String, config: LiveSessionConfig) async -> LiveGatewayBridgeResponse {
        // M6 §3.6: store mode so stream/send/createIntention all send the same mode.
        currentMode = config.mode.rawValue
        let message = Self.bootstrapPrompt(sessionKey: sessionKey, config: config)
        do {
            return try await send(message: message, sessionKey: sessionKey, timeoutSeconds: 60)
        } catch {
            return LiveGatewayBridgeResponse(
                sessionKey: sessionKey,
                text: "",
                systemMessages: [],
                toolEvents: [],
                error: error.localizedDescription
            )
        }
    }

    func fetchBootContext(sessionKey: String, config: LiveSessionConfig) async throws -> LiveFrontendBootContextResponse {
        let token = try KeychainStore.load(for: gatewayURL)
        guard let token, !token.isEmpty else {
            throw LiveGatewayBridgeError.missingToken
        }

        let transport = transportFactory()
        let wsURL = Self.websocketURL(from: gatewayURL)
        let params = ConnectParams(
            version: "1",
            platform: "ios-live-boot-context",
            token: token,
            sessionKey: sessionKey,
            role: "client"
        )

        _ = try await transport.connect(url: wsURL, connectParams: params)
        defer {
            Task { await transport.disconnect() }
        }

        let availableTools = config.toolsEnabled ? LiveToolRegistry.default.definitionsWithMetadata(config: config) : []
        let toolDefinitions = try Self.jsonArray(from: availableTools)
        let frame = RequestFrame(
            id: UUID().uuidString,
            method: "frontend.boot_context",
            params: [
                "channel_id": .string(sessionKey),
                "session_key": .string(sessionKey),
                "participant_id": .string("ios-live"),
                "mode": .string("realtime"),
                "capabilities": .array([
                    .string(config.audioInputEnabled ? "audio_input" : "audio_input_off"),
                    .string(config.responseModality == .audio ? "audio_output" : "text_output"),
                    .string(config.visualSource == .off ? "visual_off" : "visual_input"),
                    .string(config.toolsEnabled ? "tools" : "tools_off"),
                ]),
                "tools": toolDefinitions,
            ]
        )
        let response = try await transport.send(frame)
        guard response.ok else {
            throw LiveGatewayBridgeError.gateway(response.error?.message ?? "frontend.boot_context failed")
        }
        guard let payload = response.payload?.asObject else {
            throw LiveGatewayBridgeError.gateway("frontend.boot_context returned an invalid payload")
        }
        let context = payload["context"]?.asString?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !context.isEmpty else {
            throw LiveGatewayBridgeError.gateway("frontend.boot_context returned an empty context")
        }
        return LiveFrontendBootContextResponse(
            context: context,
            sources: payload["sources"]?.asStringArray ?? [],
            warnings: payload["warnings"]?.asStringArray ?? [],
            toolbox: payload["toolbox"].map(Self.prettyJSONString),
            firstContact: Self.firstContactState(from: payload["first_contact"])
        )
    }

    func stream(sessionKey: String) -> AsyncThrowingStream<LiveGatewayBridgeStreamEvent, Error> {
        let modeSnapshot = currentMode
        let makeTransport = transportFactory
        return AsyncThrowingStream { continuation in
            let holder = LiveGatewayBridgeTransportHolder()
            let task = Task {
                do {
                    let token = try KeychainStore.load(for: gatewayURL)
                    guard let token, !token.isEmpty else {
                        throw LiveGatewayBridgeError.missingToken
                    }

                    let transport = makeTransport()
                    let wsURL = Self.websocketURL(from: gatewayURL)
                    let params = ConnectParams(
                        version: "1",
                        platform: "ios-live-bridge-stream",
                        token: token,
                        sessionKey: sessionKey,
                        role: "client",
                        mode: modeSnapshot
                    )
                    _ = try await transport.connect(url: wsURL, connectParams: params)
                    holder.transport = transport
                    // Handshake done — signal reachability so the consumer can clear a
                    // prior offline state on (re)connect, even before any data arrives.
                    continuation.yield(.connected)

                    for await frame in transport.events() {
                        guard let event = EventFrameDecoder.decode(frame) else { continue }
                        switch event {
                        case .text(content: let chunk, replace: let replace):
                            continuation.yield(.text(content: chunk, replace: replace))
                        case .toolStart(let name):
                            continuation.yield(.toolStart(name))
                        case .toolResult(let name, let ok):
                            continuation.yield(.toolResult(name: name, ok: ok))
                        case .systemMessage(let message):
                            continuation.yield(.system(message))
                        case .permissionRequest:
                            continuation.yield(.system("Background agent requested permission."))
                        case .done:
                            continuation.yield(.done)
                        case .intentionSurface(let intentionId, let text, let speak, let whenBusy, let cautious):
                            continuation.yield(.intentionSurface(intentionId: intentionId, text: text, speak: speak, whenBusy: whenBusy, cautious: cautious))
                        case .regionsUpdate(let regions):
                            continuation.yield(.regionsUpdate(regions: regions))
                        case .whenArmed(let intentionId, let fireDate, let title, let body):
                            continuation.yield(.whenArmed(intentionId: intentionId, fireDate: fireDate, title: title, body: body))
                        case .whenDisarmed(let intentionId):
                            continuation.yield(.whenDisarmed(intentionId: intentionId))
                        case .error(let code, let message):
                            continuation.yield(.error("[\(code)] \(message)"))
                        }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }

            continuation.onTermination = { _ in
                task.cancel()
                Task { await holder.transport?.disconnect() }
            }
        }
    }

    func send(message: String, sessionKey: String, timeoutSeconds: TimeInterval = 120) async throws -> LiveGatewayBridgeResponse {
        let token = try KeychainStore.load(for: gatewayURL)
        guard let token, !token.isEmpty else {
            throw LiveGatewayBridgeError.missingToken
        }

        let transport = transportFactory()
        let wsURL = Self.websocketURL(from: gatewayURL)
        let params = ConnectParams(
            version: "1",
            platform: "ios-live-bridge",
            token: token,
            sessionKey: sessionKey,
            role: "client",
            mode: currentMode
        )

        _ = try await transport.connect(url: wsURL, connectParams: params)
        defer {
            Task { await transport.disconnect() }
        }

        let events = transport.events()
        let collector = Task { () -> LiveGatewayBridgeResponse in
            var text = ""
            var systemMessages: [String] = []
            var toolEvents: [String] = []
            for await frame in events {
                guard let event = EventFrameDecoder.decode(frame) else { continue }
                switch event {
                case .text(content: let chunk, replace: let replace):
                    text = replace ? chunk : text + chunk
                case .systemMessage(let message):
                    systemMessages.append(message)
                case .toolStart(let name):
                    toolEvents.append("start:\(name)")
                case .toolResult(let name, let ok):
                    toolEvents.append("\(ok ? "ok" : "error"):\(name)")
                case .done:
                    return LiveGatewayBridgeResponse(
                        sessionKey: sessionKey,
                        text: text,
                        systemMessages: systemMessages,
                        toolEvents: toolEvents
                    )
                case .error(let code, let message):
                    return LiveGatewayBridgeResponse(
                        sessionKey: sessionKey,
                        text: text,
                        systemMessages: systemMessages,
                        toolEvents: toolEvents,
                        error: "[\(code)] \(message)"
                    )
                case .permissionRequest:
                    systemMessages.append("Background agent requested permission.")
                case .intentionSurface:
                    // One-shot send() path: surface injection is handled by stream(); ignore here.
                    break
                case .regionsUpdate:
                    // Region arming is handled by the live stream loop, not this one-shot path.
                    break
                case .whenArmed:
                    // Notification scheduling is handled by the live stream loop, not this one-shot path.
                    break
                case .whenDisarmed:
                    // Notification cancellation is handled by the live stream loop, not this one-shot path.
                    break
                }
            }
            return LiveGatewayBridgeResponse(
                sessionKey: sessionKey,
                text: text,
                systemMessages: systemMessages,
                toolEvents: toolEvents,
                error: "Bridge event stream ended before agent.done."
            )
        }

        let frame = RequestFrame(
            id: UUID().uuidString,
            method: "chat.send",
            params: [
                "message": .string(message),
                "sessionKey": .string(sessionKey),
            ]
        )
        // chat.send's RPC response only arrives after a full background agent
        // turn, which can far exceed the correlator's 30s default. Use this
        // call's own budget so the RPC waiter doesn't time out mid-turn (the
        // bug that surfaced as GatewayTransportError on send_message).
        let response = try await transport.send(frame, timeout: timeoutSeconds + 10)
        guard response.ok else {
            collector.cancel()
            throw LiveGatewayBridgeError.gateway(response.error?.message ?? "chat.send failed")
        }

        let timeout = Task {
            try await Task.sleep(nanoseconds: UInt64(timeoutSeconds * 1_000_000_000))
            await transport.disconnect()
            collector.cancel()
        }
        let result = await collector.value
        timeout.cancel()
        if let error = result.error {
            throw LiveGatewayBridgeError.gateway(error)
        }
        return result
    }

    /// Structured obvious-intention write. Sends the `intention.create` RPC with
    /// explicit slots and reads the synchronous result payload (no event stream;
    /// the intention fires later via the long-lived bridge stream()).
    /// M8: `where_` is an optional named place for location-triggered intentions.
    func createIntention(
        content: String,
        when: String?,
        where_: String? = nil,
        sessionKey: String,
        timeoutSeconds: TimeInterval = 30
    ) async throws -> LiveIntentionCreateResult {
        let token = try KeychainStore.load(for: gatewayURL)
        guard let token, !token.isEmpty else {
            throw LiveGatewayBridgeError.missingToken
        }

        let transport = transportFactory()
        let wsURL = Self.websocketURL(from: gatewayURL)
        let params = ConnectParams(
            version: "1",
            platform: "ios-live-bridge-intention",
            token: token,
            sessionKey: sessionKey,
            role: "client",
            mode: currentMode
        )
        _ = try await transport.connect(url: wsURL, connectParams: params)
        defer {
            Task { await transport.disconnect() }
        }

        var frameParams: [String: JSONValue] = [
            "content": .string(content),
            "sessionKey": .string(sessionKey),
            "timezone": .string(TimeZone.current.identifier),
        ]
        if let when, !when.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            frameParams["when"] = .string(when)
        }
        if let where_, !where_.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            frameParams["where"] = .string(where_)
        }

        let frame = RequestFrame(
            id: UUID().uuidString,
            method: "intention.create",
            params: frameParams
        )

        let timeout = Task {
            try await Task.sleep(nanoseconds: UInt64(timeoutSeconds * 1_000_000_000))
            await transport.disconnect()
        }
        defer { timeout.cancel() }

        let response = try await transport.send(frame)
        guard response.ok else {
            throw LiveGatewayBridgeError.gateway(response.error?.message ?? "intention.create failed")
        }
        return Self.parseIntentionResult(response.payload)
    }

    /// Fetch a prompt's resolved text from the gateway prompt registry (#512) by
    /// id. Returns nil on any failure (offline, missing token, unknown id) so the
    /// caller can fall back to its bundled default — prompts must never break a
    /// session. Short-lived connection, mirroring intention.create.
    func fetchPrompt(id: String, sessionKey: String, timeoutSeconds: TimeInterval = 8) async -> String? {
        do {
            let token = try KeychainStore.load(for: gatewayURL)
            guard let token, !token.isEmpty else { return nil }

            let transport = transportFactory()
            let wsURL = Self.websocketURL(from: gatewayURL)
            let params = ConnectParams(
                version: "1",
                platform: "ios-live-prompts",
                token: token,
                sessionKey: sessionKey,
                role: "client",
                mode: currentMode
            )
            _ = try await transport.connect(url: wsURL, connectParams: params)
            defer { Task { await transport.disconnect() } }

            let frame = RequestFrame(
                id: UUID().uuidString,
                method: "prompts.get",
                params: ["id": .string(id)]
            )

            let timeout = Task {
                try await Task.sleep(nanoseconds: UInt64(timeoutSeconds * 1_000_000_000))
                await transport.disconnect()
            }
            defer { timeout.cancel() }

            let response = try await transport.send(frame, timeout: timeoutSeconds + 2)
            guard response.ok else { return nil }
            let text = response.payload?.asObject?["text"]?.asString
            guard let text, !text.isEmpty else { return nil }
            return text
        } catch {
            return nil
        }
    }

    // MARK: - Cocktail Party Mode (#627): shared person contract over DeepFace

    /// Identify a person from a base64 face crop via the gateway `person.*`
    /// contract. Distinguishes a plain miss from a suppressed/rejected candidate so
    /// the recognizer does not re-enroll a face the user explicitly rejected.
    func identifyFaceResult(imageBase64: String, sessionKey: String) async -> FaceIdentifyResult {
        let payload = await invokeMethod(
            "person.identify_current_frame",
            params: ["image_base64": .string(imageBase64), "session_key": .string(sessionKey)],
            sessionKey: sessionKey,
            timeoutSeconds: 15
        )
        guard case let .object(root)? = payload,
              case let .bool(found)? = root["found"]
        else { return .noMatch }
        if found {
            guard let person = LivePerson(metadata: root["person"]) else { return .noMatch }
            return .person(person)
        }
        let reason: String?
        if case let .string(value)? = root["reason"] { reason = value } else { reason = nil }
        let candidateID: String?
        if case let .string(value)? = root["candidate_id"] { candidateID = value } else { candidateID = nil }
        let suppressed: Bool
        if case let .bool(value)? = root["suppressed"] {
            suppressed = value
        } else if case let .bool(value)? = root["no_enroll"] {
            suppressed = value
        } else {
            suppressed = reason == "candidate_rejected"
        }
        if suppressed {
            return .suppressed(candidateID: candidateID, reason: reason)
        }
        if let candidate = LivePerson(candidate: root["candidate"]) {
            return .person(candidate)
        }
        return .noMatch
    }

    /// Compatibility helper for call sites that only need a matched person/candidate.
    func identifyFace(imageBase64: String, sessionKey: String) async -> LivePerson? {
        if case let .person(person) = await identifyFaceResult(imageBase64: imageBase64, sessionKey: sessionKey) {
            return person
        }
        return nil
    }

    /// Enroll a face. Named new-person writes use the gateway `person.*` contract.
    /// Provisional Unknown/add-crop writes stay on the legacy face tool until the
    /// candidate store lands.
    @discardableResult
    func enrollFace(imageBase64: String, name: String, personId: String?, sessionKey: String) async -> LivePerson? {
        if personId == nil && name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() != "unknown" {
            let payload = await invokeMethod(
                "person.update_profile",
                params: [
                    "image_base64": .string(imageBase64),
                    "name": .string(name),
                    "session_key": .string(sessionKey),
                ],
                sessionKey: sessionKey,
                timeoutSeconds: 15
            )
            guard case let .object(root)? = payload else { return nil }
            return LivePerson(metadata: root["person"])
        }
        var args: [String: JSONValue] = ["image_base64": .string(imageBase64), "name": .string(name)]
        if let personId { args["person_id"] = .string(personId) }
        let meta = await invokeFaceTool("face_enroll", args: args, sessionKey: sessionKey)
        return LivePerson(metadata: meta?["person"])
    }

    /// Update a person: set name, add facts, or append a conversation recap.
    @discardableResult
    func updatePerson(personId: String, name: String?, facts: [String], recap: String?, sessionKey: String) async -> LivePerson? {
        var params: [String: JSONValue] = ["id": .string(personId), "session_key": .string(sessionKey)]
        if let name { params["name"] = .string(name) }
        if !facts.isEmpty { params["facts"] = .array(facts.map { .string($0) }) }
        if let recap { params["recap"] = .string(recap) }
        let payload = await invokeMethod(
            "person.update_profile",
            params: params,
            sessionKey: sessionKey,
            timeoutSeconds: 15
        )
        guard case let .object(root)? = payload else { return nil }
        return LivePerson(metadata: root["person"])
    }

    /// Confirm a provisional identity candidate after the user explicitly names it.
    @discardableResult
    func confirmIdentityCandidate(candidateId: String, name: String, personId: String?, reason: String?, sessionKey: String) async -> LivePerson? {
        var params: [String: JSONValue] = [
            "candidate_id": .string(candidateId),
            "name": .string(name),
            "session_key": .string(sessionKey),
        ]
        if let personId, !personId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            params["person_id"] = .string(personId)
        }
        if let reason, !reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            params["reason"] = .string(reason)
        }
        let payload = await invokeMethod(
            "person.confirm_candidate",
            params: params,
            sessionKey: sessionKey,
            timeoutSeconds: 15
        )
        guard case let .object(root)? = payload else { return nil }
        return LivePerson(metadata: root["person"])
    }

    /// Reject a provisional identity candidate so future list/identify flows can suppress it.
    @discardableResult
    func rejectIdentityCandidate(candidateId: String, reason: String?, sessionKey: String) async -> Bool {
        var params: [String: JSONValue] = [
            "candidate_id": .string(candidateId),
            "session_key": .string(sessionKey),
        ]
        if let reason, !reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            params["reason"] = .string(reason)
        }
        let payload = await invokeMethod(
            "person.reject_candidate",
            params: params,
            sessionKey: sessionKey,
            timeoutSeconds: 15
        )
        guard case let .object(root)? = payload else { return false }
        if case let .bool(ok)? = root["ok"] { return ok }
        return root["candidate"] != nil
    }

    /// List confirmed people and reviewable candidates from the person service.
    func listPeople(sessionKey: String) async -> [LivePerson] {
        let payload = await invokeMethod(
            "person.list",
            params: ["session_key": .string(sessionKey), "include_candidates": .bool(true)],
            sessionKey: sessionKey,
            timeoutSeconds: 15
        )
        guard case let .object(root)? = payload else { return [] }
        var people: [LivePerson] = []
        if case let .array(arr)? = root["people"] {
            people.append(contentsOf: arr.compactMap { LivePerson(metadata: $0) })
        }
        if case let .array(candidates)? = root["candidates"] {
            people.append(contentsOf: candidates.compactMap { LivePerson(candidate: $0) })
        }
        return people
    }

    /// Wipe the entire person database (People Database tab Clear button). Returns
    /// true on success.
    @discardableResult
    func clearPeople(sessionKey: String) async -> Bool {
        let payload = await invokeMethod(
            "person.clear",
            params: ["session_key": .string(sessionKey)],
            sessionKey: sessionKey,
            timeoutSeconds: 15
        )
        guard case let .object(root)? = payload else { return false }
        if case let .bool(ok)? = root["ok"] { return ok }
        return false
    }

    /// Safety Check (#648): classify a frame for hazards via the assess_hazard tool
    /// (gateway → vision service), OFF the realtime model. Returns .safe on any
    /// failure (no service / offline) so it never warns spuriously or blocks.
    func assessHazard(imageBase64: String, sessionKey: String) async -> HazardAssessment {
        let meta = await invokeFaceTool("assess_hazard", args: ["image_base64": .string(imageBase64)], sessionKey: sessionKey)
        guard let meta else { return .safe }
        let severityStr: String
        if case let .string(s)? = meta["severity"] { severityStr = s } else { severityStr = "none" }
        let kind: String
        if case let .string(k)? = meta["kind"] { kind = k } else { kind = "" }
        let warning: String
        if case let .string(w)? = meta["warning"] { warning = w } else { warning = "" }
        return HazardAssessment(severity: HazardSeverity(label: severityStr), kind: kind, warning: warning)
    }

    // -------------------------------------------------------------------------
    // Memory feature (#653): memory.snapshot + memory.distill RPCs for the Live
    // testing tab. These talk to the gateway over a short-lived connection,
    // mirroring invokeFaceTool but for the memory.* methods (whose results sit
    // at the payload root, not under result.metadata).
    // -------------------------------------------------------------------------

    /// Read the four-tier memory snapshot (soul / identity / global / daily).
    /// Returns nil on any failure (no gateway / offline).
    func memorySnapshot(sessionKey: String, dailyLimit: Int = 5) async -> LiveMemorySnapshot? {
        let payload = await invokeMethod(
            "memory.snapshot",
            params: ["daily_limit": .number(Double(dailyLimit))],
            sessionKey: sessionKey
        )
        guard case let .object(root)? = payload,
              case let .object(snap)? = root["snapshot"] else { return nil }
        return LiveMemorySnapshot(object: snap)
    }

    /// Trigger distillation. scope is "daily" or "global"; mock skips the LLM.
    /// Returns the result (which may be ok:false with a note) or nil on transport failure.
    /// Trigger distillation. When `targetSessionKey` is provided, scope=daily
    /// distills THAT session; when nil, the gateway picks the most-recently-active
    /// realtime session (used by session-end auto-distill, where the just-ended
    /// session is the newest one and exact-key matching is brittle).
    func memoryDistill(
        sessionKey: String,
        scope: String,
        mock: Bool,
        targetSessionKey: String? = nil
    ) async -> LiveMemoryDistillResult? {
        var params: [String: JSONValue] = ["scope": .string(scope), "mock": .bool(mock)]
        if let targetSessionKey, !targetSessionKey.isEmpty {
            params["session_key"] = .string(targetSessionKey)
        }
        let payload = await invokeMethod("memory.distill", params: params, sessionKey: sessionKey)
        guard case let .object(root)? = payload else { return nil }
        return LiveMemoryDistillResult(object: root)
    }

    /// Invoke an arbitrary gateway method over a short-lived connection and return
    /// its raw payload, or nil on any failure. Mirrors invokeFaceTool's lifecycle.
    private func invokeMethod(
        _ method: String,
        params: [String: JSONValue],
        sessionKey: String,
        timeoutSeconds: TimeInterval = 30
    ) async -> JSONValue? {
        do {
            let token = try KeychainStore.load(for: gatewayURL)
            guard let token, !token.isEmpty else { return nil }

            let transport = transportFactory()
            let wsURL = Self.websocketURL(from: gatewayURL)
            let connectParams = ConnectParams(
                version: "1", platform: "ios-live-rpc", token: token,
                sessionKey: sessionKey, role: "client", mode: currentMode
            )
            _ = try await transport.connect(url: wsURL, connectParams: connectParams)
            defer { Task { await transport.disconnect() } }

            let frame = RequestFrame(id: UUID().uuidString, method: method, params: params)
            let timeout = Task {
                try await Task.sleep(nanoseconds: UInt64(timeoutSeconds * 1_000_000_000))
                await transport.disconnect()
            }
            defer { timeout.cancel() }

            let response = try await transport.send(frame, timeout: timeoutSeconds + 2)
            guard response.ok else { return nil }
            return response.payload
        } catch {
            return nil
        }
    }

    /// Invoke a whitelisted face tool and return its result `metadata` object, or
    /// nil on any failure. Short-lived connection, mirroring fetchPrompt.
    private func invokeFaceTool(
        _ toolName: String,
        args: [String: JSONValue],
        sessionKey: String,
        timeoutSeconds: TimeInterval = 15
    ) async -> [String: JSONValue]? {
        do {
            let token = try KeychainStore.load(for: gatewayURL)
            guard let token, !token.isEmpty else { return nil }

            let transport = transportFactory()
            let wsURL = Self.websocketURL(from: gatewayURL)
            let params = ConnectParams(
                version: "1", platform: "ios-live-face", token: token,
                sessionKey: sessionKey, role: "client", mode: currentMode
            )
            _ = try await transport.connect(url: wsURL, connectParams: params)
            defer { Task { await transport.disconnect() } }

            let frame = RequestFrame(
                id: UUID().uuidString,
                method: "tool.invoke",
                params: [
                    "tool_name": .string(toolName),
                    "session_key": .string(sessionKey),
                    "args": .object(args),
                ]
            )
            let timeout = Task {
                try await Task.sleep(nanoseconds: UInt64(timeoutSeconds * 1_000_000_000))
                await transport.disconnect()
            }
            defer { timeout.cancel() }

            let response = try await transport.send(frame, timeout: timeoutSeconds + 2)
            guard response.ok,
                  case let .object(root)? = response.payload,
                  case let .object(result)? = root["result"],
                  case let .object(metadata)? = result["metadata"]
            else { return nil }
            return metadata
        } catch {
            return nil
        }
    }

    /// M6 §3.2 / §9 H1 — send finalized transcript turns to the gateway for latent recognition.
    /// Mirrors the `intention.create` RPC pattern: open a short-lived connection,
    /// fire `transcript.append`, and disconnect.
    func appendTranscript(
        turns: [(role: String, text: String, ts: String)],
        sessionKey: String,
        mode: String,
        timeoutSeconds: TimeInterval = 10
    ) async throws {
        guard !turns.isEmpty else { return }
        // Sync the bridge's cached mode with the caller's live config mode, so the
        // transcript connection reports the real ambient mode instead of the
        // "quiet" default that holds until bootstrap() runs. Without this, the
        // gateway gates latent recognition off (treats every turn as quiet).
        currentMode = mode
        let token = try KeychainStore.load(for: gatewayURL)
        guard let token, !token.isEmpty else {
            throw LiveGatewayBridgeError.missingToken
        }

        let transport = transportFactory()
        let wsURL = Self.websocketURL(from: gatewayURL)
        let params = ConnectParams(
            version: "1",
            platform: "ios-live-bridge-transcript",
            token: token,
            sessionKey: sessionKey,
            role: "client",
            mode: mode
        )
        _ = try await transport.connect(url: wsURL, connectParams: params)
        defer {
            Task { await transport.disconnect() }
        }

        let turnsValue: JSONValue = .array(turns.map { turn in
            .object([
                "role": .string(turn.role),
                "text": .string(turn.text),
                "ts": .string(turn.ts),
            ])
        })

        let frame = RequestFrame(
            id: UUID().uuidString,
            method: "transcript.append",
            params: [
                "sessionKey": .string(sessionKey),
                "turns": turnsValue,
            ]
        )

        let timeout = Task {
            try await Task.sleep(nanoseconds: UInt64(timeoutSeconds * 1_000_000_000))
            await transport.disconnect()
        }
        defer { timeout.cancel() }

        let response = try await transport.send(frame)
        guard response.ok else {
            throw LiveGatewayBridgeError.gateway(response.error?.message ?? "transcript.append failed")
        }
    }

    /// M10 model-pull latent surfacing. Sends the `intention.scan` RPC and returns
    /// the list of context-matched armed latent intentions (read-only; no state
    /// transitions). Returns [[String: Any]] suitable for JSON serialization in
    /// the tool output.
    func scanIntentions(
        sessionKey: String,
        mode: String,
        timeoutSeconds: TimeInterval = 30
    ) async throws -> [[String: Any]] {
        let token = try KeychainStore.load(for: gatewayURL)
        guard let token, !token.isEmpty else {
            throw LiveGatewayBridgeError.missingToken
        }

        let transport = transportFactory()
        let wsURL = Self.websocketURL(from: gatewayURL)
        let params = ConnectParams(
            version: "1",
            platform: "ios-live-bridge-scan",
            token: token,
            sessionKey: sessionKey,
            role: "client"
        )
        _ = try await transport.connect(url: wsURL, connectParams: params)
        defer {
            Task { await transport.disconnect() }
        }

        let frame = RequestFrame(
            id: UUID().uuidString,
            method: "intention.scan",
            params: ["sessionKey": .string(sessionKey), "mode": .string(mode)]
        )

        let timeout = Task {
            try await Task.sleep(nanoseconds: UInt64(timeoutSeconds * 1_000_000_000))
            await transport.disconnect()
        }
        defer { timeout.cancel() }

        let response = try await transport.send(frame)
        guard response.ok else {
            throw LiveGatewayBridgeError.gateway(response.error?.message ?? "intention.scan failed")
        }
        return Self.parseScanMatches(response.payload)
    }

    private static func parseScanMatches(_ payload: JSONValue?) -> [[String: Any]] {
        guard case .object(let object)? = payload,
              case .array(let matchValues)? = object["matches"] else {
            return []
        }
        return matchValues.compactMap { value -> [String: Any]? in
            guard case .object(let m) = value else { return nil }
            var dict: [String: Any] = [:]
            if case .string(let s)? = m["id"] { dict["id"] = s }
            if case .string(let s)? = m["content"] { dict["content"] = s }
            if case .number(let n)? = m["confidence"] { dict["confidence"] = n }
            if case .array(let terms)? = m["matchedTerms"] {
                dict["matchedTerms"] = terms.compactMap { v -> String? in
                    if case .string(let s) = v { return s }
                    return nil
                }
            }
            return dict.isEmpty ? nil : dict
        }
    }

    /// Respond to a surfaced latent intention: confirm (resolved) or decline (suppressed).
    /// Called by the IntentionRespondTool when the user verbally accepts or declines a suggestion.
    /// Any bound session may respond — latents are user-global.
    func reportIntentionResponse(
        intentionId: String,
        action: String,
        sessionKey: String,
        timeoutSeconds: TimeInterval = 10
    ) async throws {
        let token = try KeychainStore.load(for: gatewayURL)
        guard let token, !token.isEmpty else { throw LiveGatewayBridgeError.missingToken }

        let transport = transportFactory()
        _ = try await transport.connect(
            url: Self.websocketURL(from: gatewayURL),
            connectParams: ConnectParams(version: "1", platform: "ios-intention-respond", token: token, sessionKey: sessionKey, role: "client", mode: currentMode)
        )
        defer { Task { await transport.disconnect() } }

        let timeout = Task { try await Task.sleep(nanoseconds: UInt64(timeoutSeconds * 1_000_000_000)); await transport.disconnect() }
        defer { timeout.cancel() }

        let response = try await transport.send(RequestFrame(
            id: UUID().uuidString,
            method: "intention.respond",
            params: [
                "intentionId": .string(intentionId),
                "response": .string(action),
            ]
        ))
        guard response.ok else {
            throw LiveGatewayBridgeError.gateway(response.error?.message ?? "intention.respond failed")
        }
    }

    /// M8 where-trigger: report geocode result back to the gateway after receiving
    /// `agent.regions.update`. Called after CoreLocation resolves the named place
    /// and CLRegion monitoring is registered. `ok:false` + reason on failure.
    /// Device build note: call after AmbientLocationManager.updateRegions completes.
    func reportRegionArmed(
        intentionId: String,
        ok: Bool,
        reason: String? = nil,
        sessionKey: String,
        timeoutSeconds: TimeInterval = 10
    ) async throws {
        let token = try KeychainStore.load(for: gatewayURL)
        guard let token, !token.isEmpty else { throw LiveGatewayBridgeError.missingToken }

        let transport = transportFactory()
        _ = try await transport.connect(
            url: Self.websocketURL(from: gatewayURL),
            connectParams: ConnectParams(version: "1", platform: "ios-region-armed", token: token, sessionKey: sessionKey, role: "client")
        )
        defer { Task { await transport.disconnect() } }

        var frameParams: [String: JSONValue] = [
            "intentionId": .string(intentionId),
            "ok": .bool(ok),
        ]
        if let reason { frameParams["reason"] = .string(reason) }

        let timeout = Task { try await Task.sleep(nanoseconds: UInt64(timeoutSeconds * 1_000_000_000)); await transport.disconnect() }
        defer { timeout.cancel() }

        let response = try await transport.send(RequestFrame(id: UUID().uuidString, method: "region.armed", params: frameParams))
        guard response.ok else { throw LiveGatewayBridgeError.gateway(response.error?.message ?? "region.armed failed") }
    }

    /// M8 where-trigger: report region entry to the gateway. Called by
    /// AmbientLocationManager.onEvent(.regionEntered) from CLLocationManagerDelegate.
    /// Device build note: the gateway will call fireIntention for the armed where-intention.
    func reportRegionEntered(
        intentionId: String,
        sessionKey: String,
        timeoutSeconds: TimeInterval = 10
    ) async throws {
        let token = try KeychainStore.load(for: gatewayURL)
        guard let token, !token.isEmpty else { throw LiveGatewayBridgeError.missingToken }

        let transport = transportFactory()
        _ = try await transport.connect(
            url: Self.websocketURL(from: gatewayURL),
            connectParams: ConnectParams(version: "1", platform: "ios-region-entered", token: token, sessionKey: sessionKey, role: "client")
        )
        defer { Task { await transport.disconnect() } }

        let timeout = Task { try await Task.sleep(nanoseconds: UInt64(timeoutSeconds * 1_000_000_000)); await transport.disconnect() }
        defer { timeout.cancel() }

        let response = try await transport.send(RequestFrame(
            id: UUID().uuidString,
            method: "region.entered",
            params: ["intentionId": .string(intentionId), "sessionKey": .string(sessionKey)]
        ))
        guard response.ok else { throw LiveGatewayBridgeError.gateway(response.error?.message ?? "region.entered failed") }
    }

    /// M8 where-trigger: report location authorization status to the gateway.
    /// On "denied" or "restricted", the gateway transitions armed where-intentions
    /// to arm_failed. Called from AmbientLocationManager.onEvent(.authorizationChanged).
    /// Device build note: wire in LiveSessionStore when AmbientLocationManager is integrated.
    func reportLocationAuth(
        status: String,
        sessionKey: String,
        timeoutSeconds: TimeInterval = 10
    ) async throws {
        let token = try KeychainStore.load(for: gatewayURL)
        guard let token, !token.isEmpty else { throw LiveGatewayBridgeError.missingToken }

        let transport = transportFactory()
        _ = try await transport.connect(
            url: Self.websocketURL(from: gatewayURL),
            connectParams: ConnectParams(version: "1", platform: "ios-location-auth", token: token, sessionKey: sessionKey, role: "client")
        )
        defer { Task { await transport.disconnect() } }

        let timeout = Task { try await Task.sleep(nanoseconds: UInt64(timeoutSeconds * 1_000_000_000)); await transport.disconnect() }
        defer { timeout.cancel() }

        let response = try await transport.send(RequestFrame(
            id: UUID().uuidString,
            method: "location.auth",
            params: ["status": .string(status)]
        ))
        guard response.ok else { throw LiveGatewayBridgeError.gateway(response.error?.message ?? "location.auth failed") }
    }

    private static func parseIntentionResult(_ payload: JSONValue?) -> LiveIntentionCreateResult {
        guard case .object(let object)? = payload else {
            return LiveIntentionCreateResult(ok: false, intentionId: nil, state: nil, needsClarification: false, ask: nil)
        }
        func string(_ key: String) -> String? {
            if case .string(let s)? = object[key] { return s }
            return nil
        }
        func bool(_ key: String) -> Bool {
            if case .bool(let b)? = object[key] { return b }
            return false
        }
        return LiveIntentionCreateResult(
            ok: bool("ok"),
            intentionId: string("intentionId"),
            state: string("state"),
            needsClarification: bool("needsClarification"),
            ask: string("ask")
        )
    }

    private static func websocketURL(from gatewayURL: URL) -> URL {
        var components = URLComponents(url: gatewayURL, resolvingAgainstBaseURL: false)
        switch components?.scheme {
        case "https": components?.scheme = "wss"
        case "http": components?.scheme = "ws"
        default: break
        }
        return components?.url ?? gatewayURL
    }

    private static func jsonArray(from values: [[String: Any]]) throws -> JSONValue {
        try .array(values.map(jsonValue(from:)))
    }

    private static func firstContactState(from value: JSONValue?) -> LiveFrontendFirstContactState {
        guard let object = value?.asObject else {
            return LiveFrontendFirstContactState(active: false, reason: "unknown", markerFile: nil)
        }
        return LiveFrontendFirstContactState(
            active: object["active"]?.asBool ?? false,
            reason: object["reason"]?.asString ?? "unknown",
            markerFile: object["marker_file"]?.asString
        )
    }

    private static func jsonValue(from value: Any) throws -> JSONValue {
        switch value {
        case let value as JSONValue:
            return value
        case let value as String:
            return .string(value)
        case let value as Bool:
            return .bool(value)
        case let value as Int:
            return .number(Double(value))
        case let value as Double:
            return .number(value)
        case let value as Float:
            return .number(Double(value))
        case let value as [Any]:
            return try .array(value.map(jsonValue(from:)))
        case let value as [String: Any]:
            return try .object(value.mapValues(jsonValue(from:)))
        case _ as NSNull:
            return .null
        default:
            throw LiveGatewayBridgeError.gateway("Could not encode Live tool definition for boot context")
        }
    }

    private static func prettyJSONString(_ value: JSONValue) -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        guard let data = try? encoder.encode(value),
              let text = String(data: data, encoding: .utf8) else {
            return "{}"
        }
        return text
    }

    private static func bootstrapPrompt(sessionKey: String, config: LiveSessionConfig) -> String {
        """
        You are the Hawky background agent for a frontend realtime voice session.

        Session key: \(sessionKey)

        The user is currently speaking with a separate low-latency realtime model on iPhone. That realtime model can call tools to ask you for help. Treat future messages in this channel as requests from the frontend realtime agent unless the message says otherwise.

        Collaboration contract:
        - You are the background agent. You can use Hawky tools, files, nodes, memory, and longer-running reasoning.
        - The realtime model is the frontend agent. It owns immediate speech to the user.
        - If you need to talk back to the phone UI outside your normal response, use Hawky's nodes tool against the connected iOS node when available. The iOS node exposes frontend.message and frontend.open_tab.
        - Not every answer you produce should be spoken verbatim. When helpful, label content as one of:
          - context_only: for the realtime model to use silently.
          - stream_to_frontend: concise text suitable for showing/saying to the user.
          - urgent_frontend: important enough for the realtime model to interrupt or speak immediately.
        - Keep responses structured and concise. Prefer JSON-ish headings when possible.
        - If a request needs a tool permission or will take a long time, say that plainly.
        - SENDING MESSAGES: when asked to send a message (e.g. send_message to Slack), actually call the tool and send it. Do this EVERY time it is requested, even if you already sent an identical message earlier in this conversation. Sending duplicates is allowed — the user may want to send the same thing again. NEVER reply that a message was "already sent" and skip the tool call; if you didn't call the tool this turn, it was NOT sent. You may note in your reply that an identical message was sent before, but still send it. Only ask first for genuine ambiguity (e.g. the recipient name matches multiple people) — ask one short question, then send.

        Current realtime settings:
        - provider: \(config.provider.label)
        - model: \(config.model)
        - response_modality: \(config.responseModality.rawValue)
        - reasoning_effort: \(config.reasoningEffort.rawValue)
        - visual_source: \(config.visualSource.rawValue)
        - visual_fps: \(config.effectiveVisualFPS)

        Acknowledge this setup in one short sentence and wait for requests.
        """
    }
}

private final class LiveGatewayBridgeTransportHolder: @unchecked Sendable {
    var transport: (any GatewayTransport)?
}

private extension JSONValue {
    var asObject: [String: JSONValue]? {
        if case .object(let value) = self { return value }
        return nil
    }

    var asString: String? {
        if case .string(let value) = self { return value }
        return nil
    }

    var asBool: Bool? {
        if case .bool(let value) = self { return value }
        return nil
    }

    var asStringArray: [String]? {
        guard case .array(let values) = self else { return nil }
        return values.compactMap { $0.asString }
    }
}
