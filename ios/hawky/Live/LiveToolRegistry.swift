import AVFoundation
import CoreLocation
import Foundation
import UserNotifications
#if canImport(UIKit)
import UIKit
#endif

protocol LiveTool {
    var name: String { get }
    var kind: LiveToolKind { get }
    var definition: [String: Any] { get }
    var instructions: String? { get }
    var metadata: LiveToolMetadata { get }
    var executor: LiveToolExecutor { get }

    func isAvailable(config: LiveSessionConfig) -> Bool
    func execute(arguments: [String: Any], context: LiveToolContext) async throws -> [String: Any]
}

extension LiveTool {
    var kind: LiveToolKind { .tool }
    var instructions: String? { nil }
    func isAvailable(config: LiveSessionConfig) -> Bool { true }

    var metadata: LiveToolMetadata {
        LiveToolMetadata(
            category: .shortcut,
            latency: .fast,
            durability: .ephemeral,
            risk: .low,
            visibility: .model
        )
    }

    var executor: LiveToolExecutor {
        LiveToolExecutor(runtime: .iosSwift, binding: String(describing: Self.self), hotLoadable: false)
    }
}

enum LiveToolSource: String, Codable, Equatable {
    case frontend
    case backend
}

enum LiveToolKind: String, Codable, Equatable {
    case tool
    case skill
}

enum LiveToolExecutorRuntime: String, Codable, Equatable {
    case iosSwift = "ios_swift"
    case iosNode = "ios_node"
    case gatewayBackend = "gateway_backend"
    case instructionOnly = "instruction_only"
}

enum LiveToolCategory: String, Codable, Equatable {
    case localContext = "local_context"
    case deviceDiagnostics = "device_diagnostics"
    case sessionBridge = "session_bridge"
    case memory
    case media
    case shortcut
}

enum LiveToolLatency: String, Codable, Equatable {
    case instant
    case fast
    case slow
    case background
}

enum LiveToolDurability: String, Codable, Equatable {
    case ephemeral
    case session
    case durable
}

enum LiveToolRisk: String, Codable, Equatable {
    case low
    case medium
    case high
}

enum LiveToolVisibility: String, Codable, Equatable {
    case model
    case debug
    case hidden
}

struct LiveToolMetadata: Codable, Equatable {
    var category: LiveToolCategory
    var latency: LiveToolLatency
    var durability: LiveToolDurability
    var risk: LiveToolRisk
    var visibility: LiveToolVisibility
    var whenToUse: [String] = []
    var whenNotToUse: [String] = []
}

struct LiveToolExecutor: Codable, Equatable {
    var runtime: LiveToolExecutorRuntime
    var binding: String
    var hotLoadable: Bool
}

struct LiveToolManifestItem: Identifiable, Codable, Equatable {
    var source: LiveToolSource
    var kind: LiveToolKind
    var name: String
    var description: String
    var available: Bool
    var metadata: LiveToolMetadata
    var executor: LiveToolExecutor
    var instructions: String?
    var definitionJSON: String
    var rawDefinitionJSON: String

    var id: String { "\(source.rawValue):\(kind.rawValue):\(name)" }
}

struct LiveToolContext {
    var config: LiveSessionConfig
    var gatewayBridge: LiveGatewayBridge?
    /// Awaits any in-flight transcript append so scan tools see a current window.
    var awaitPendingTranscriptAppend: (() async -> Void)?
    /// Set by LiveSessionStore so the summarize tool can run LiveSessionSummarizer
    /// (which needs the store + gateway container) without threading those types
    /// through the provider. Takes a scope string ("current_session"/"past_day"),
    /// returns the summary text. nil when summarization isn't available.
    var summarize: ((String) async throws -> String)?
    /// Stay Silent: returns a recap of the transcript captured while Stay Silent
    /// was on. Set by LiveSessionStore; called by SummarizeSilenceTool so the
    /// release recap goes through a real tool call (visible bubble). nil outside
    /// a Stay Silent window.
    var silenceSummary: (() async -> String)?
    /// Cocktail Party Mode (#627): true while the mode is active. Person tools
    /// (list/recall/update) use `gatewayBridge` + config.gatewayBridgeSessionKey to
    /// reach the DeepFace service; they report the mode is off when this is false.
    var cocktailPartyActive: Bool = false
    /// Cocktail Party Mode (#627): identify whoever is on the camera RIGHT NOW.
    /// Set by LiveSessionStore; crops the latest frame + calls DeepFace identify.
    /// Returns the matched person, a suppressed candidate, or no match. Lets the
    /// model answer "who is this?" without treating rejected faces as new people.
    var identifyOnCamera: (() async -> FaceIdentifyResult)?
    /// Cocktail Party Mode (#627): resolve the person on camera for a profile write —
    /// identify them, enroll the current frame (with the given name) if new, or
    /// preserve a suppressed candidate so stale ids cannot be used for writes.
    var resolveCameraPerson: ((_ name: String?) async -> FaceIdentifyResult)?
}

struct LiveToolRegistry {
    static let `default` = LiveToolRegistry(tools: [
        CurrentTimeLiveTool(),
        LiveSessionSettingsTool(),
        DeviceLocationLiveTool(),
        DevicePermissionsLiveTool(),
        NodeCommandLiveTool(
            name: "device_info",
            description: "Return iOS device metadata such as model, OS version, device name, and battery level.",
            command: DeviceInfoCommand()
        ),
        NodeCommandLiveTool(
            name: "device_battery",
            description: "Return the phone battery level, charging state, and low power mode.",
            command: BatteryCommand()
        ),
        NodeCommandLiveTool(
            name: "device_storage",
            description: "Return the phone app container filesystem total, free, and used bytes.",
            command: StorageCommand()
        ),
        NodeCommandLiveTool(
            name: "device_network",
            description: "Return the phone network connection type and whether the path is expensive or constrained.",
            command: NetworkCommand()
        ),
        SessionGetInfoTool(),
        SessionSendMessageTool(),
        SummarizeSessionTool(),
        SummarizeSilenceTool(),
        IdentifyPersonTool(),
        ListPeopleTool(),
        RecallPersonTool(),
        UpdatePersonProfileTool(),
        ConfirmIdentityCandidateTool(),
        RejectIdentityCandidateTool(),
        MemorySearchTool(),
        MemoryAppendTool(),
        ToolboxListToolsTool(),
        CreateIntentionTool(),
        ScanIntentionTool(),
        IntentionRespondTool(),
        LiveSkillManifestItem(
            name: "remember_user_preference",
            description: "Instruction skill for saving durable facts about the USER (their own preferences, identity, project context) through memory tools.",
            instructions: "When the user states a durable preference, project context, or correction ABOUT THEMSELVES, confirm briefly and call memory_append with the smallest useful fact. When they introduce or name ANOTHER PERSON (someone on camera, 'this is X', 'he/she is …'), do NOT use memory_append — use update_person_profile instead. Do not save transient filler.",
            metadata: LiveToolMetadata(
                category: .memory,
                latency: .fast,
                durability: .durable,
                risk: .medium,
                visibility: .debug,
                whenToUse: ["durable user preference", "identity fact", "project context worth remembering"],
                whenNotToUse: ["temporary mood", "one-off phrasing", "uncertain inference"]
            )
        ),
        LiveSkillManifestItem(
            name: "use_backend_agent",
            description: "Instruction skill for delegating complex or durable work to the Hawky backend agent.",
            instructions: "For research, file work, long-running reasoning, backend memory, or tool orchestration, call session_send_message with concise context and the right frontend_delivery priority. Keep realtime speech brief while the backend works.",
            metadata: LiveToolMetadata(
                category: .sessionBridge,
                latency: .background,
                durability: .durable,
                risk: .medium,
                visibility: .debug,
                whenToUse: ["complex work", "long-running backend task", "files or durable memory"],
                whenNotToUse: ["simple device state", "direct realtime answer"]
            )
        ),
    ])

    private let toolsByName: [String: LiveTool]

    init(tools: [LiveTool]) {
        toolsByName = Dictionary(uniqueKeysWithValues: tools.map { ($0.name, $0) })
    }

    func definitions(config: LiveSessionConfig) -> [[String: Any]] {
        toolsByName.values
            .filter { $0.kind == .tool }
            .filter { $0.isAvailable(config: config) }
            .sorted { $0.name < $1.name }
            .map(\.definition)
    }

    func definitionsWithMetadata(config: LiveSessionConfig) -> [[String: Any]] {
        toolsByName.values
            .filter { $0.kind == .tool }
            .filter { $0.isAvailable(config: config) }
            .sorted { $0.name < $1.name }
            .map { tool in
                var definition = tool.definition
                definition["x_tool_metadata"] = Self.metadataDictionary(tool.metadata, source: .frontend)
                return definition
            }
    }

    func manifest(config: LiveSessionConfig) -> [LiveToolManifestItem] {
        toolsByName.values
            .sorted { $0.name < $1.name }
            .map { tool in
                LiveToolManifestItem(
                    source: .frontend,
                    kind: tool.kind,
                    name: tool.name,
                    description: Self.stringValue(tool.definition["description"]),
                    available: tool.isAvailable(config: config),
                    metadata: tool.metadata,
                    executor: tool.executor,
                    instructions: tool.instructions,
                    definitionJSON: Self.prettyJSONString(Self.manifestDefinition(for: tool)),
                    rawDefinitionJSON: Self.jsonString(Self.manifestDefinition(for: tool))
                )
            }
    }

    func definitionJSON(name: String) -> String? {
        toolsByName[name].map { Self.prettyJSONString($0.definition) }
    }

    func execute(name: String, argumentsJSON: String, context: LiveToolContext) async -> String {
        let arguments = Self.parseJSONObject(argumentsJSON)
        guard let tool = toolsByName[name] else {
            return Self.jsonString([
                "ok": false,
                "tool": name,
                "arguments": arguments,
                "error": "Unknown local Live tool.",
            ])
        }

        do {
            guard tool.kind == .tool else {
                return Self.jsonString([
                    "ok": false,
                    "tool": name,
                    "arguments": arguments,
                    "error": "Skills are instruction-only and cannot be executed as tools.",
                ])
            }
            guard tool.isAvailable(config: context.config) else {
                return Self.jsonString([
                    "ok": false,
                    "tool": name,
                    "arguments": arguments,
                    "error": "Tool is not available for the current Live session settings.",
                ])
            }
            var output = try await tool.execute(arguments: arguments, context: context)
            output["ok"] = output["ok"] ?? true
            output["tool"] = output["tool"] ?? name
            output["arguments"] = output["arguments"] ?? arguments
            return Self.jsonString(output)
        } catch {
            return Self.jsonString([
                "ok": false,
                "tool": name,
                "arguments": arguments,
                "error": error.localizedDescription,
            ])
        }
    }

    private static func parseJSONObject(_ raw: String) -> [String: Any] {
        guard let data = raw.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return [:]
        }
        return object
    }

    static func jsonString(_ object: [String: Any]) -> String {
        guard JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
              let text = String(data: data, encoding: .utf8) else {
            return "{\"ok\":false,\"error\":\"Could not encode tool output\"}"
        }
        return text
    }

    static func prettyJSONString(_ object: [String: Any]) -> String {
        guard JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys]),
              let text = String(data: data, encoding: .utf8) else {
            return "{}"
        }
        return text
    }

    private static func stringValue(_ value: Any?) -> String {
        (value as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }

    static func manifestDictionary(_ item: LiveToolManifestItem) -> [String: Any] {
        [
            "source": item.source.rawValue,
            "kind": item.kind.rawValue,
            "name": item.name,
            "description": item.description,
            "available": item.available,
            "metadata": metadataDictionary(item.metadata, source: item.source),
            "executor": [
                "runtime": item.executor.runtime.rawValue,
                "binding": item.executor.binding,
                "hotLoadable": item.executor.hotLoadable,
            ],
            "instructions": item.instructions ?? NSNull(),
        ]
    }

    private static func manifestDefinition(for tool: LiveTool) -> [String: Any] {
        if tool.kind == .tool {
            return tool.definition
        }
        return [
            "kind": tool.kind.rawValue,
            "name": tool.name,
            "description": stringValue(tool.definition["description"]),
            "instructions": tool.instructions ?? "",
            "x_tool_metadata": metadataDictionary(tool.metadata, source: .frontend),
            "executor": [
                "runtime": tool.executor.runtime.rawValue,
                "binding": tool.executor.binding,
                "hotLoadable": tool.executor.hotLoadable,
            ],
        ]
    }

    private static func metadataDictionary(_ metadata: LiveToolMetadata, source: LiveToolSource) -> [String: Any] {
        [
            "source": source.rawValue,
            "category": metadata.category.rawValue,
            "latency": metadata.latency.rawValue,
            "durability": metadata.durability.rawValue,
            "risk": metadata.risk.rawValue,
            "visibility": metadata.visibility.rawValue,
            "whenToUse": metadata.whenToUse,
            "whenNotToUse": metadata.whenNotToUse,
        ]
    }
}

/// Summarize the Live session transcript(s) and return a readable recap. Runs
/// the same path as the Summary UI button (LiveSessionSummarizer → gateway
/// agent) via a context hook the store provides — so the realtime model can
/// summarize on request (e.g. "recap what we just covered" / "summarize today").
private struct SummarizeSessionTool: LiveTool {
    let name = "summarize_session"

    var definition: [String: Any] {
        [
            "type": "function",
            "name": name,
            "description": "Summarize the Live session transcript and return a concise recap (topics, decisions, follow-ups). Use when the user asks to recap/summarize the current conversation or the past day.",
            "parameters": [
                "type": "object",
                "properties": [
                    "scope": [
                        "type": "string",
                        "enum": ["current_session", "past_day"],
                        "description": "current_session = the session open now; past_day = all Live sessions from the last 24h. Default current_session.",
                    ],
                ],
                "additionalProperties": false,
            ],
        ]
    }

    var instructions: String? {
        "When the user asks to recap or summarize the conversation, call summarize_session (scope=current_session). For \"summarize my day / today's sessions\", use scope=past_day. Then read the returned summary back to the user."
    }

    var metadata: LiveToolMetadata {
        LiveToolMetadata(
            category: .shortcut,
            latency: .slow,
            durability: .ephemeral,
            risk: .low,
            visibility: .model,
            whenToUse: ["recap the conversation", "summarize the session", "what did we cover", "summarize today / past day"]
        )
    }

    func execute(arguments: [String: Any], context: LiveToolContext) async throws -> [String: Any] {
        let scope = (arguments["scope"] as? String) ?? "current_session"
        guard let summarize = context.summarize else {
            return ["ok": false, "error": "Summarization is not available in this context."]
        }
        let summary = try await summarize(scope)
        return ["ok": true, "scope": scope, "summary": summary]
    }
}

/// Stay Silent release tool. Returns the transcript/context captured while Stay
/// Silent mode was enabled so the realtime model can produce one recap after
/// silence ends. The model is forced to call this exactly once on toggle-off, so
/// the recap goes through a visible tool call (bubble) — mirrors the web LiveLab
/// summarize_silence tool.
private struct SummarizeSilenceTool: LiveTool {
    let name = "summarize_silence"

    var definition: [String: Any] {
        [
            "type": "function",
            "name": name,
            "description": "Return the transcript and context captured while Stay Silent mode was enabled so you can produce one recap after silence ends. Call this exactly once when Stay Silent is turned off, then read the recap back to the user.",
            "parameters": [
                "type": "object",
                "properties": [:] as [String: Any],
                "additionalProperties": false,
            ],
        ]
    }

    var instructions: String? {
        "When Stay Silent mode is turned off, call summarize_silence exactly once, then give one concise spoken recap of what happened while silence was on (include concrete follow-ups)."
    }

    var metadata: LiveToolMetadata {
        LiveToolMetadata(
            category: .shortcut,
            latency: .fast,
            durability: .ephemeral,
            risk: .low,
            visibility: .model,
            whenToUse: ["Stay Silent mode just ended", "recap what happened while silent"]
        )
    }

    func execute(arguments: [String: Any], context: LiveToolContext) async throws -> [String: Any] {
        guard let silenceSummary = context.silenceSummary else {
            return ["ok": false, "error": "No Stay Silent window is available to summarize."]
        }
        let captured = await silenceSummary()
        return ["ok": true, "captured": captured]
    }
}

// MARK: - Cocktail Party Mode person tools (#627)
//
// PersonService owns profiles/facts/candidates; DeepFace is only the face-match
// compatibility backend behind the gateway. Gated on cocktailPartyActive.

private enum PeopleToolSupport {
    static func bridgeAndKey(_ context: LiveToolContext) -> (LiveGatewayBridge, String)? {
        guard context.cocktailPartyActive, let bridge = context.gatewayBridge else { return nil }
        let key = context.config.gatewayBridgeSessionKey
        return key.isEmpty ? nil : (bridge, key)
    }

    static func dict(_ p: LivePerson) -> [String: Any] {
        var result: [String: Any] = [
            "id": p.id,
            "name": p.name,
            "facts": p.facts,
            "lastRecap": p.lastRecap ?? "",
        ]
        if let candidateID = p.candidateID {
            result["candidate_id"] = candidateID
            result["is_candidate"] = true
        }
        return result
    }
}

/// Identify whoever is in front of the camera RIGHT NOW. This is how the model
/// answers "who is this?" / "who is he?" — it recognizes the live face against the
/// stored people, so the model CAN tell who someone is from the camera.
private struct IdentifyPersonTool: LiveTool {
    let name = "identify_person"
    var definition: [String: Any] {
        [
            "type": "function",
            "name": name,
            "description": "Identify the person currently on camera by matching their face against people you've met. Call this when the user asks who someone is. You CAN recognize faces. When it returns a person, tell the user their NAME and then briefly relay their facts AND the last-conversation recap (e.g. \"That's Fei-Fei Li — co-founder of World Labs. Last time you discussed spatial intelligence.\"). Say it ONCE; don't repeat.",
            "parameters": ["type": "object", "properties": [:] as [String: Any], "additionalProperties": false],
        ]
    }
    var metadata: LiveToolMetadata {
        LiveToolMetadata(category: .localContext, latency: .fast, durability: .durable, risk: .low, visibility: .model)
    }
    func isAvailable(config: LiveSessionConfig) -> Bool {
        config.bridgeToolsAvailable && config.cocktailPartyEnabled
    }
    func execute(arguments: [String: Any], context: LiveToolContext) async throws -> [String: Any] {
        guard context.cocktailPartyActive, let identify = context.identifyOnCamera else {
            return ["ok": false, "error": "Cocktail Party Mode is off — face recognition isn't running."]
        }
        let result = await identify()
        guard case let .person(person) = result else {
            if case let .suppressed(candidateID, reason) = result {
                var response: [String: Any] = [
                    "ok": true,
                    "found": false,
                    "suppressed": true,
                    "no_enroll": true,
                    "reason": reason ?? "candidate_rejected",
                    "message": "This face matches an identity candidate that was rejected or suppressed. Do not ask to remember or enroll it.",
                ]
                if let candidateID, !candidateID.isEmpty {
                    response["candidate_id"] = candidateID
                }
                return response
            }
            return ["ok": true, "found": false, "message": "No one on camera matches a person you've met. They may be new — ask their name to remember them."]
        }
        let personRecord = PeopleToolSupport.dict(person)
        if let candidateID = person.candidateID {
            return [
                "ok": true,
                "found": false,
                "candidate_id": candidateID,
                "candidate": personRecord,
                "message": "This face matches an unconfirmed identity candidate. If the user verifies their name, call confirm_identity_candidate with candidate_id \(candidateID).",
            ]
        }
        // Build an explicit "say this" instruction so the model relays the profile +
        // recap, not just the name. Phrase the recap in SECOND person — "last time you
        // had a conversation about …" (you + them), not third-person "he was talking
        // about …".
        let p = person
        var sentence = "This is \(p.name)."
        if !p.facts.isEmpty { sentence += " " + p.facts.prefix(3).joined(separator: "; ") + "." }
        var instruction = "Tell the user, once, in a natural sentence: \(sentence)"
        if let recap = p.lastRecap, !recap.isEmpty {
            instruction += " Then add the last-conversation recap phrased as the user's "
                + "own shared conversation — start with \"Last time you had a conversation about…\" "
                + "or \"Last time you two talked about…\" (NOT \"he/she was talking about\"). Recap: \(recap)"
        }
        return [
            "ok": true,
            "found": true,
            "person": personRecord,
            "say_to_user": instruction,
        ]
    }
}

/// List confirmed people and reviewable candidates from the person service.
private struct ListPeopleTool: LiveTool {
    let name = "list_people"
    var definition: [String: Any] {
        [
            "type": "function",
            "name": name,
            "description": "List the people you've met via Cocktail Party Mode (names + a few facts). Use to answer 'who have I met?'.",
            "parameters": ["type": "object", "properties": [:] as [String: Any], "additionalProperties": false],
        ]
    }
    var metadata: LiveToolMetadata {
        LiveToolMetadata(category: .localContext, latency: .fast, durability: .durable, risk: .low, visibility: .model)
    }
    func isAvailable(config: LiveSessionConfig) -> Bool {
        config.bridgeToolsAvailable && config.cocktailPartyEnabled
    }
    func execute(arguments: [String: Any], context: LiveToolContext) async throws -> [String: Any] {
        guard let (bridge, key) = PeopleToolSupport.bridgeAndKey(context) else {
            return ["ok": false, "error": "Cocktail Party Mode is off."]
        }
        let people = await bridge.listPeople(sessionKey: key)
        let records = people.map(PeopleToolSupport.dict)
        let candidates = records.filter { $0["candidate_id"] != nil }
        var result: [String: Any] = ["ok": true, "count": people.count, "people": records]
        if !candidates.isEmpty { result["candidates"] = candidates }
        return result
    }
}

/// Recall a specific person by name: their facts + last conversation recap.
private struct RecallPersonTool: LiveTool {
    let name = "recall_person"
    var definition: [String: Any] {
        [
            "type": "function",
            "name": name,
            "description": "Recall what you know about a person BY NAME (facts + last conversation). To identify who is on the camera, use identify_person instead.",
            "parameters": [
                "type": "object",
                "properties": ["name": ["type": "string", "description": "The person's name."]],
                "required": ["name"],
                "additionalProperties": false,
            ],
        ]
    }
    var metadata: LiveToolMetadata {
        LiveToolMetadata(category: .localContext, latency: .fast, durability: .durable, risk: .low, visibility: .model)
    }
    func isAvailable(config: LiveSessionConfig) -> Bool {
        config.bridgeToolsAvailable && config.cocktailPartyEnabled
    }
    func execute(arguments: [String: Any], context: LiveToolContext) async throws -> [String: Any] {
        let query = (arguments["name"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !query.isEmpty else { return ["ok": false, "error": "Missing name."] }
        guard let (bridge, key) = PeopleToolSupport.bridgeAndKey(context) else {
            return ["ok": false, "error": "Cocktail Party Mode is off."]
        }
        let people = await bridge.listPeople(sessionKey: key)
        let match = people.first { $0.name.lowercased() == query } ?? people.first { $0.name.lowercased().contains(query) }
        guard let match else { return ["ok": true, "found": false] }
        return ["ok": true, "found": true, "person": PeopleToolSupport.dict(match)]
    }
}

/// Update a person's profile: set their name, add facts, or append a conversation
/// recap. Used by the model after learning who a new face is.
private struct UpdatePersonProfileTool: LiveTool {
    let name = "update_person_profile"
    var definition: [String: Any] {
        [
            "type": "function",
            "name": name,
            "description": "Save or update info about a PERSON on camera: set their name, add facts about them, or save a one-line recap. ALWAYS use this (not memory_append) when the user introduces or names someone — e.g. 'this is Jay', 'he's a CS student', 'her name is Sarah'. Pass the id from a 'new person' notice or identify_person; if you don't have an id, call identify_person first.",
            "parameters": [
                "type": "object",
                "properties": [
                    "id": ["type": "string", "description": "The person id (from a new-person notice or identify)."],
                    "name": ["type": "string", "description": "The person's name (sets/updates it)."],
                    "facts": ["type": "array", "items": ["type": "string", "description": "A fact."], "description": "Facts to add."],
                    "recap": ["type": "string", "description": "One-line recap of what was discussed, to recall next time."],
                ],
                "additionalProperties": false,
            ],
        ]
    }
    var metadata: LiveToolMetadata {
        LiveToolMetadata(category: .localContext, latency: .fast, durability: .durable, risk: .low, visibility: .model)
    }
    func isAvailable(config: LiveSessionConfig) -> Bool {
        config.bridgeToolsAvailable && config.cocktailPartyEnabled
    }
    func execute(arguments: [String: Any], context: LiveToolContext) async throws -> [String: Any] {
        let suppliedID = (arguments["id"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let name = (arguments["name"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let facts = (arguments["facts"] as? [String]) ?? []
        let recap = (arguments["recap"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let (bridge, key) = PeopleToolSupport.bridgeAndKey(context) else {
            return ["ok": false, "error": "Cocktail Party Mode is off."]
        }

        // ALWAYS bind the write to whoever is on camera RIGHT NOW — never trust a
        // model-supplied id. The model was reusing a stale id, so "this is Daniel"
        // overwrote the earlier "Jay" on the same id instead of saving a new person.
        // resolveCameraPerson identifies the live face (or enrolls it if new), so a
        // second, different person becomes a SEPARATE profile.
        var id = suppliedID
        if let resolve = context.resolveCameraPerson {
            switch await resolve(name?.isEmpty == false ? name : nil) {
            case let .person(person):
                if let candidateID = person.candidateID {
                    return [
                        "ok": false,
                        "candidate_id": candidateID,
                        "error": "This face matches an unconfirmed identity candidate. Use confirm_identity_candidate after the user verifies the name.",
                    ]
                }
                id = person.id
            case let .suppressed(candidateID, reason):
                var response: [String: Any] = [
                    "ok": false,
                    "suppressed": true,
                    "no_enroll": true,
                    "reason": reason ?? "candidate_rejected",
                    "error": "This face matches a rejected or suppressed identity candidate and cannot be updated or enrolled.",
                ]
                if let candidateID, !candidateID.isEmpty {
                    response["candidate_id"] = candidateID
                }
                return response
            case .noMatch:
                if !id.isEmpty { break }
                return ["ok": false, "error": "No face on camera to attach this to. Point the camera at the person and try again."]
            }
            // With no live match, a model-supplied id can still target an existing profile.
        } else if id.isEmpty {
            return ["ok": false, "error": "Missing person id and no camera available."]
        }

        let updated = await bridge.updatePerson(personId: id, name: name, facts: facts, recap: recap, sessionKey: key)
        guard let updated else { return ["ok": false, "error": "Could not update (unknown id or service unavailable)."] }
        return ["ok": true, "person": PeopleToolSupport.dict(updated)]
    }
}

/// Confirm an unreviewed identity candidate after the user has explicitly said
/// who it is. This moves a legacy Unknown face into a named person profile.
private struct ConfirmIdentityCandidateTool: LiveTool {
    let name = "confirm_identity_candidate"
    var definition: [String: Any] {
        [
            "type": "function",
            "name": name,
            "description": "Confirm an unconfirmed identity candidate only after the user explicitly verifies who it is. Use the candidate_id returned by identify_person/list_people and the verified name. This promotes a legacy Unknown face into a named person profile.",
            "parameters": [
                "type": "object",
                "properties": [
                    "candidate_id": ["type": "string", "description": "The identity candidate id to confirm."],
                    "name": ["type": "string", "description": "The verified person's name."],
                    "person_id": ["type": "string", "description": "Optional existing person id. Current backend cannot merge into a different existing profile yet."],
                    "reason": ["type": "string", "description": "Optional short reason for audit/debugging."],
                ],
                "required": ["candidate_id", "name"],
                "additionalProperties": false,
            ],
        ]
    }
    var metadata: LiveToolMetadata {
        LiveToolMetadata(category: .localContext, latency: .fast, durability: .durable, risk: .medium, visibility: .model)
    }
    func isAvailable(config: LiveSessionConfig) -> Bool {
        config.bridgeToolsAvailable && config.cocktailPartyEnabled
    }
    func execute(arguments: [String: Any], context: LiveToolContext) async throws -> [String: Any] {
        let candidateID = (arguments["candidate_id"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let name = (arguments["name"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let personID = (arguments["person_id"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let reason = (arguments["reason"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !candidateID.isEmpty else { return ["ok": false, "error": "Missing candidate_id."] }
        guard !name.isEmpty else { return ["ok": false, "error": "Missing name."] }
        guard let (bridge, key) = PeopleToolSupport.bridgeAndKey(context) else {
            return ["ok": false, "error": "Cocktail Party Mode is off."]
        }

        let person = await bridge.confirmIdentityCandidate(
            candidateId: candidateID,
            name: name,
            personId: personID?.isEmpty == false ? personID : nil,
            reason: reason?.isEmpty == false ? reason : nil,
            sessionKey: key
        )
        guard let person else { return ["ok": false, "error": "Could not confirm candidate."] }
        return ["ok": true, "candidate_id": candidateID, "person": PeopleToolSupport.dict(person)]
    }
}

/// Reject an unreviewed identity candidate so it does not keep surfacing as a
/// new person to learn.
private struct RejectIdentityCandidateTool: LiveTool {
    let name = "reject_identity_candidate"
    var definition: [String: Any] {
        [
            "type": "function",
            "name": name,
            "description": "Reject an unconfirmed identity candidate when the user says it is wrong or should not be remembered as a person.",
            "parameters": [
                "type": "object",
                "properties": [
                    "candidate_id": ["type": "string", "description": "The identity candidate id to reject."],
                    "reason": ["type": "string", "description": "Optional short reason for audit/debugging."],
                ],
                "required": ["candidate_id"],
                "additionalProperties": false,
            ],
        ]
    }
    var metadata: LiveToolMetadata {
        LiveToolMetadata(category: .localContext, latency: .fast, durability: .durable, risk: .medium, visibility: .model)
    }
    func isAvailable(config: LiveSessionConfig) -> Bool {
        config.bridgeToolsAvailable && config.cocktailPartyEnabled
    }
    func execute(arguments: [String: Any], context: LiveToolContext) async throws -> [String: Any] {
        let candidateID = (arguments["candidate_id"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let reason = (arguments["reason"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !candidateID.isEmpty else { return ["ok": false, "error": "Missing candidate_id."] }
        guard let (bridge, key) = PeopleToolSupport.bridgeAndKey(context) else {
            return ["ok": false, "error": "Cocktail Party Mode is off."]
        }

        let ok = await bridge.rejectIdentityCandidate(
            candidateId: candidateID,
            reason: reason?.isEmpty == false ? reason : nil,
            sessionKey: key
        )
        guard ok else { return ["ok": false, "error": "Could not reject candidate."] }
        return ["ok": true, "candidate_id": candidateID]
    }
}

private struct NodeCommandLiveTool: LiveTool {
    let name: String
    let description: String
    let command: any NodeCommand

    var definition: [String: Any] {
        [
            "type": "function",
            "name": name,
            "description": description,
            "parameters": [
                "type": "object",
                "properties": [:],
                "additionalProperties": false,
            ],
        ]
    }

    var executor: LiveToolExecutor {
        LiveToolExecutor(runtime: .iosNode, binding: String(describing: type(of: command).name), hotLoadable: false)
    }

    var metadata: LiveToolMetadata {
        LiveToolMetadata(
            category: .deviceDiagnostics,
            latency: .instant,
            durability: .ephemeral,
            risk: .low,
            visibility: .model,
            whenToUse: ["when the user asks about this iPhone or local device state"]
        )
    }

    func execute(arguments: [String: Any], context: LiveToolContext) async throws -> [String: Any] {
        let result = try await command.invoke(args: .object([:]))
        return [
            "node_command": String(describing: type(of: command).name),
            "payload": Self.anyValue(from: result),
        ]
    }

    private static func anyValue(from value: JSONValue) -> Any {
        switch value {
        case .object(let object):
            return object.mapValues(anyValue)
        case .array(let array):
            return array.map(anyValue)
        case .string(let string):
            return string
        case .number(let number):
            return number
        case .bool(let bool):
            return bool
        case .null:
            return NSNull()
        }
    }
}

private struct LiveSkillManifestItem: LiveTool {
    let name: String
    let description: String
    let instructions: String?
    let metadata: LiveToolMetadata

    var kind: LiveToolKind { .skill }

    var definition: [String: Any] {
        [
            "kind": kind.rawValue,
            "name": name,
            "description": description,
            "instructions": instructions ?? "",
        ]
    }

    var executor: LiveToolExecutor {
        LiveToolExecutor(runtime: .instructionOnly, binding: name, hotLoadable: true)
    }

    func isAvailable(config: LiveSessionConfig) -> Bool {
        switch metadata.category {
        case .memory, .sessionBridge:
            return config.bridgeToolsAvailable
        default:
            return true
        }
    }

    func execute(arguments: [String: Any], context: LiveToolContext) async throws -> [String: Any] {
        [
            "name": name,
            "instructions": instructions ?? "",
        ]
    }
}

private struct DeviceLocationLiveTool: LiveTool {
    let name = "device_location"

    var definition: [String: Any] {
        [
            "type": "function",
            "name": name,
            "description": "Return the phone's current CoreLocation authorization state and, when authorized, a one-shot current location.",
            "parameters": [
                "type": "object",
                "properties": [
                    "request_permission": [
                        "type": "boolean",
                        "description": "If true and location permission is not determined, ask for When In Use authorization. Default true.",
                    ],
                    "include_coordinate": [
                        "type": "boolean",
                        "description": "If true, try to include the current coordinate when authorized. Default true.",
                    ],
                ],
                "additionalProperties": false,
            ],
        ]
    }

    var metadata: LiveToolMetadata {
        LiveToolMetadata(
            category: .deviceDiagnostics,
            latency: .fast,
            durability: .ephemeral,
            risk: .medium,
            visibility: .model,
            whenToUse: ["when the user asks where they are", "location-aware reminders or context"],
            whenNotToUse: ["unless location is relevant to the user's request"]
        )
    }

    func execute(arguments: [String: Any], context: LiveToolContext) async throws -> [String: Any] {
        let requestPermission = arguments["request_permission"] as? Bool ?? true
        let includeCoordinate = arguments["include_coordinate"] as? Bool ?? true
        return await LiveLocationProbe.snapshot(
            requestPermission: requestPermission,
            includeCoordinate: includeCoordinate
        )
    }
}

private struct DevicePermissionsLiveTool: LiveTool {
    let name = "device_permissions"

    var definition: [String: Any] {
        [
            "type": "function",
            "name": name,
            "description": "Return local permission status for microphone, camera, location, and notifications.",
            "parameters": [
                "type": "object",
                "properties": [:],
                "additionalProperties": false,
            ],
        ]
    }

    var metadata: LiveToolMetadata {
        LiveToolMetadata(
            category: .deviceDiagnostics,
            latency: .instant,
            durability: .ephemeral,
            risk: .low,
            visibility: .model,
            whenToUse: ["when a capture, live, notification, or location feature is not working"]
        )
    }

    func execute(arguments: [String: Any], context: LiveToolContext) async throws -> [String: Any] {
        let locationStatus = await MainActor.run { CLLocationManager().authorizationStatus }
        var output: [String: Any] = [
            "microphone": Self.avStatusString(AVCaptureDevice.authorizationStatus(for: .audio)),
            "camera": Self.avStatusString(AVCaptureDevice.authorizationStatus(for: .video)),
            "location": LiveLocationProbe.authorizationStatusString(locationStatus),
        ]
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        output["notifications"] = Self.notificationStatusString(settings.authorizationStatus)
        return output
    }

    private static func avStatusString(_ status: AVAuthorizationStatus) -> String {
        switch status {
        case .authorized: return "authorized"
        case .denied: return "denied"
        case .restricted: return "restricted"
        case .notDetermined: return "not_determined"
        @unknown default: return "unknown"
        }
    }

    private static func notificationStatusString(_ status: UNAuthorizationStatus) -> String {
        switch status {
        case .authorized: return "authorized"
        case .denied: return "denied"
        case .notDetermined: return "not_determined"
        case .provisional: return "provisional"
        case .ephemeral: return "ephemeral"
        @unknown default: return "unknown"
        }
    }
}

private struct SessionGetInfoTool: LiveTool {
    let name = "session_get_info"

    var definition: [String: Any] {
        [
            "type": "function",
            "name": name,
            "description": "Return the bound Hawky background-agent session for this realtime conversation.",
            "parameters": [
                "type": "object",
                "properties": [:],
                "additionalProperties": false,
            ],
        ]
    }

    var metadata: LiveToolMetadata {
        LiveToolMetadata(
            category: .sessionBridge,
            latency: .instant,
            durability: .session,
            risk: .low,
            visibility: .model,
            whenToUse: ["when the model needs to know which backend session is bound"]
        )
    }

    func isAvailable(config: LiveSessionConfig) -> Bool {
        config.bridgeToolsAvailable
    }

    func execute(arguments: [String: Any], context: LiveToolContext) async throws -> [String: Any] {
        [
            "enabled": context.config.gatewayBridgeEnabled,
            "availability": context.config.bridgeAvailability.diagnosticsLabel,
            "session_key": context.config.gatewayBridgeSessionKey,
            "session_mode": context.config.gatewayBridgeSessionMode.rawValue,
            "feed_mode": context.config.gatewayBridgeFeedMode.rawValue,
            "purpose": "Use this session to ask the background Hawky agent for longer-running help.",
        ]
    }
}

private struct SessionSendMessageTool: LiveTool {
    let name = "session_send_message"

    var definition: [String: Any] {
        [
            "type": "function",
            "name": name,
            "description": "Send a structured request to the Hawky background agent for longer-running help (research, tools, files, durable work). Do NOT use this for timed intentions or anything the user wants to happen at a specific time — use create_intention for those.",
            "parameters": [
                "type": "object",
                "properties": [
                    "message": [
                        "type": "string",
                        "description": "The request or context to send to the background agent.",
                    ],
                    "priority": [
                        "type": "string",
                        "description": "How urgently the background response should affect the frontend conversation.",
                        "enum": ["normal", "non_priority", "urgent", "absolute_urgent"],
                    ],
                    "frontend_delivery": [
                        "type": "string",
                        "description": "How the realtime model expects to use the background response.",
                        "enum": ["context_only", "stream_to_frontend", "urgent_frontend"],
                    ],
                ],
                "required": ["message"],
                "additionalProperties": false,
            ],
        ]
    }

    var metadata: LiveToolMetadata {
        LiveToolMetadata(
            category: .sessionBridge,
            latency: .background,
            durability: .durable,
            risk: .medium,
            visibility: .model,
            whenToUse: ["longer reasoning", "files", "nodes", "memory", "durable backend work"],
            whenNotToUse: ["simple local facts", "explicit timed reminders"]
        )
    }

    func isAvailable(config: LiveSessionConfig) -> Bool {
        config.bridgeToolsAvailable
    }

    var executor: LiveToolExecutor {
        LiveToolExecutor(runtime: .gatewayBackend, binding: "chat.send", hotLoadable: true)
    }

    func execute(arguments: [String: Any], context: LiveToolContext) async throws -> [String: Any] {
        guard let bridge = context.gatewayBridge else {
            throw LiveGatewayBridgeError.notConfigured
        }
        let message = (arguments["message"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !message.isEmpty else {
            throw LiveGatewayBridgeError.gateway("message is required")
        }
        let priority = (arguments["priority"] as? String) ?? "normal"
        let frontendDelivery = (arguments["frontend_delivery"] as? String) ?? "context_only"
        let wrappedMessage = """
        Realtime frontend agent request.

        priority: \(priority)
        frontend_delivery: \(frontendDelivery)
        timezone: \(TimeZone.current.identifier)

        Use the collaboration contract for this realtime session. Return concise content that the realtime frontend agent can decide whether to speak, display, or keep as context.

        Request:
        \(message)
        """
        let response = try await bridge.send(message: wrappedMessage, sessionKey: context.config.gatewayBridgeSessionKey)
        return [
            "session_key": response.sessionKey,
            "priority": priority,
            "frontend_delivery": frontendDelivery,
            "background_text": response.text,
            "system_messages": response.systemMessages,
            "tool_events": response.toolEvents,
        ]
    }
}

private struct MemorySearchTool: LiveTool {
    let name = "memory_search"

    var definition: [String: Any] {
        [
            "type": "function",
            "name": name,
            "description": "Ask the Hawky backend agent to search durable memory and recent logs for relevant context.",
            "parameters": [
                "type": "object",
                "properties": [
                    "query": [
                        "type": "string",
                        "description": "The memory question or search query.",
                    ],
                    "reason": [
                        "type": "string",
                        "description": "Why this context is needed for the live conversation.",
                    ],
                ],
                "required": ["query"],
                "additionalProperties": false,
            ],
        ]
    }

    var metadata: LiveToolMetadata {
        LiveToolMetadata(
            category: .memory,
            latency: .background,
            durability: .durable,
            risk: .medium,
            visibility: .model,
            whenToUse: ["the user asks what is remembered", "identity or project memory is needed"],
            whenNotToUse: ["simple current device facts"]
        )
    }

    var executor: LiveToolExecutor {
        LiveToolExecutor(runtime: .gatewayBackend, binding: "chat.send:memory_search", hotLoadable: true)
    }

    func isAvailable(config: LiveSessionConfig) -> Bool {
        config.bridgeToolsAvailable
    }

    func execute(arguments: [String: Any], context: LiveToolContext) async throws -> [String: Any] {
        guard let bridge = context.gatewayBridge else {
            throw LiveGatewayBridgeError.notConfigured
        }
        let query = (arguments["query"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !query.isEmpty else {
            throw LiveGatewayBridgeError.gateway("query is required")
        }
        let reason = (arguments["reason"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let message = """
        Realtime frontend memory_search request.

        Search durable memory, bootstrap context, recent daily logs, and relevant session notes for the query below.
        Return concise findings only. If nothing relevant is known, say that clearly. Do not invent memory.

        query: \(query)
        reason: \(reason?.isEmpty == false ? reason! : "unspecified")
        """
        let response = try await bridge.send(message: message, sessionKey: context.config.gatewayBridgeSessionKey)
        return [
            "session_key": response.sessionKey,
            "query": query,
            "background_text": response.text,
            "system_messages": response.systemMessages,
            "tool_events": response.toolEvents,
        ]
    }
}

private struct MemoryAppendTool: LiveTool {
    let name = "memory_append"

    var definition: [String: Any] {
        [
            "type": "function",
            "name": name,
            "description": "Save a durable fact about the USER or their projects/preferences (not about other people). Do NOT use this to remember someone shown on camera or whom the user introduces — for that use update_person_profile. Examples: the user's own preferences, project context, tasks.",
            "parameters": [
                "type": "object",
                "properties": [
                    "memory": [
                        "type": "string",
                        "description": "The smallest durable fact or preference to remember.",
                    ],
                    "category": [
                        "type": "string",
                        "description": "The memory category.",
                        "enum": ["identity", "preference", "project", "task", "other"],
                    ],
                    "evidence": [
                        "type": "string",
                        "description": "Short evidence from the live conversation.",
                    ],
                ],
                "required": ["memory"],
                "additionalProperties": false,
            ],
        ]
    }

    var metadata: LiveToolMetadata {
        LiveToolMetadata(
            category: .memory,
            latency: .background,
            durability: .durable,
            risk: .medium,
            visibility: .model,
            whenToUse: ["durable user preference", "identity update", "important project context"],
            whenNotToUse: ["temporary one-off facts", "uncertain inferences"]
        )
    }

    var executor: LiveToolExecutor {
        LiveToolExecutor(runtime: .gatewayBackend, binding: "chat.send:memory_append", hotLoadable: true)
    }

    func isAvailable(config: LiveSessionConfig) -> Bool {
        config.bridgeToolsAvailable
    }

    func execute(arguments: [String: Any], context: LiveToolContext) async throws -> [String: Any] {
        guard let bridge = context.gatewayBridge else {
            throw LiveGatewayBridgeError.notConfigured
        }
        let memory = (arguments["memory"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !memory.isEmpty else {
            throw LiveGatewayBridgeError.gateway("memory is required")
        }
        let category = (arguments["category"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "other"
        let evidence = (arguments["evidence"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let message = """
        Realtime frontend memory_append request.

        Save this only if it is genuinely durable and useful. If it is too vague or unsafe to save, explain why instead of saving.

        category: \(category)
        memory: \(memory)
        evidence: \(evidence?.isEmpty == false ? evidence! : "unspecified")
        """
        let response = try await bridge.send(message: message, sessionKey: context.config.gatewayBridgeSessionKey)
        return [
            "session_key": response.sessionKey,
            "category": category,
            "memory": memory,
            "background_text": response.text,
            "system_messages": response.systemMessages,
            "tool_events": response.toolEvents,
        ]
    }
}

private struct ToolboxListToolsTool: LiveTool {
    let name = "toolbox_list_tools"

    var definition: [String: Any] {
        [
            "type": "function",
            "name": name,
            "description": "List the active Live toolbox manifest, including tools, instruction skills, executor runtime, availability, and risk metadata.",
            "parameters": [
                "type": "object",
                "properties": [:],
                "additionalProperties": false,
            ],
        ]
    }

    var metadata: LiveToolMetadata {
        LiveToolMetadata(
            category: .localContext,
            latency: .instant,
            durability: .session,
            risk: .low,
            visibility: .model,
            whenToUse: ["when the user asks what tools or skills are available"]
        )
    }

    func execute(arguments: [String: Any], context: LiveToolContext) async throws -> [String: Any] {
        let manifest = LiveToolRegistry.default.manifest(config: context.config)
        return [
            "version": 1,
            "items": manifest.map(LiveToolRegistry.manifestDictionary),
            "note": "Manifest entries with kind=skill are instructions and are not directly executable. Dynamic backend tools can be added by manifest, but iOS Swift executors must already exist in the signed app.",
        ]
    }
}

private struct CreateIntentionTool: LiveTool {
    let name = "create_intention"

    var definition: [String: Any] {
        [
            "type": "function",
            "name": name,
            "description": """
            Record an intention the user wants triggered at a time OR a named place. \
            Use for "remind me to … at/in <time>", "remind me when I get to <place>", \
            and direct timed/location statements ("take my pills at 8pm", "remind me at home"). \
            It fires when the trigger condition is met and is delivered back to you. \
            PRECISION RULE — for time: only call once you have an ACTIONABLE time ("8pm", "in 10 minutes", "tomorrow at 8am"). \
            PRECISION RULE — for place: only call with a SPECIFIC NAMED PLACE ("home", "Whole Foods", "the office"). \
            Do NOT call with a bare category ("a store", "a grocery") — ask for the place name first. \
            If both time and place are vague, ask ONE short question. After it succeeds, confirm to the user.
            """,
            "parameters": [
                "type": "object",
                "properties": [
                    "content": [
                        "type": "string",
                        "description": "What to do, as a short imperative (e.g. \"Take your pills\", \"Call mom\").",
                    ],
                    "when": [
                        "type": "string",
                        "description": "The trigger time as the user gave it: a clock time (\"8pm\", \"17:30\"), a relative offset (\"in 10 minutes\"), or a day-qualified time (\"tomorrow at 8am\", \"Monday at 9am\"). Omit when triggering by place only.",
                    ],
                    "where": [
                        "type": "string",
                        "description": "A specific named place to trigger on arrival (e.g. \"home\", \"Whole Foods\", \"the office\"). Omit when triggering by time only. Do NOT use bare categories like \"a store\".",
                    ],
                ],
                "required": ["content"],
                "additionalProperties": false,
            ],
        ]
    }

    var metadata: LiveToolMetadata {
        LiveToolMetadata(
            category: .memory,
            latency: .fast,
            durability: .durable,
            risk: .medium,
            visibility: .model,
            whenToUse: ["explicit timed reminders", "explicit place-triggered reminders"],
            whenNotToUse: ["vague future intent without a concrete time or place"]
        )
    }

    func isAvailable(config: LiveSessionConfig) -> Bool {
        config.bridgeToolsAvailable
    }

    func execute(arguments: [String: Any], context: LiveToolContext) async throws -> [String: Any] {
        guard let bridge = context.gatewayBridge else {
            throw LiveGatewayBridgeError.notConfigured
        }
        let content = (arguments["content"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !content.isEmpty else {
            throw LiveGatewayBridgeError.gateway("content is required")
        }
        let when = (arguments["when"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let where_ = (arguments["where"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let result = try await bridge.createIntention(
            content: content,
            when: when?.isEmpty == false ? when : nil,
            where_: where_?.isEmpty == false ? where_ : nil,
            sessionKey: context.config.gatewayBridgeSessionKey
        )
        if result.needsClarification {
            return [
                "ok": false,
                "needs_clarification": true,
                "ask": result.ask ?? "What time or place should I set this for?",
                "content": content,
            ]
        }
        return [
            "ok": result.ok,
            "intention_id": result.intentionId ?? NSNull(),
            "state": result.state ?? NSNull(),
            "content": content,
        ]
    }
}

private struct ScanIntentionTool: LiveTool {
    let name = "scan_intention"

    var definition: [String: Any] {
        [
            "type": "function",
            "name": name,
            "description": """
            Scan for latent (background-detected) intentions that are now relevant to the current conversation context. \
            Call this at conversational inflection points — when the topic shifts, when the user is winding down or leaving, \
            or when they mention a place. If matches are returned, surface the highest-confidence one conversationally, \
            one at a time (e.g. "By the way, you wanted to…"). Do not surface if the conversation context is unrelated.
            """,
            "parameters": [
                "type": "object",
                "properties": [:],
                "additionalProperties": false,
            ],
        ]
    }

    var metadata: LiveToolMetadata {
        LiveToolMetadata(
            category: .memory,
            latency: .fast,
            durability: .session,
            risk: .medium,
            visibility: .model,
            whenToUse: ["conversation topic shifts", "the user mentions a place", "the user is winding down"]
        )
    }

    func isAvailable(config: LiveSessionConfig) -> Bool {
        config.bridgeToolsAvailable
    }

    func execute(arguments: [String: Any], context: LiveToolContext) async throws -> [String: Any] {
        guard let bridge = context.gatewayBridge else {
            throw LiveGatewayBridgeError.notConfigured
        }
        // Await any in-flight transcript append before scanning so the gateway
        // sees the finalized turn in its session window (Fix: race M10 §3.1).
        await context.awaitPendingTranscriptAppend?()
        let result = try await bridge.scanIntentions(
            sessionKey: context.config.gatewayBridgeSessionKey,
            mode: context.config.mode.rawValue
        )
        return ["matches": result]
    }
}

private struct CurrentTimeLiveTool: LiveTool {
    let name = "get_current_time"

    var definition: [String: Any] {
        [
            "type": "function",
            "name": name,
            "description": "Return the phone's current local time, date, time zone, locale, and low power mode.",
            "parameters": [
                "type": "object",
                "properties": [:],
                "additionalProperties": false,
            ],
        ]
    }

    var metadata: LiveToolMetadata {
        LiveToolMetadata(
            category: .localContext,
            latency: .instant,
            durability: .ephemeral,
            risk: .low,
            visibility: .model,
            whenToUse: ["current date", "current time", "timezone", "low power mode"]
        )
    }

    func execute(arguments: [String: Any], context: LiveToolContext) async throws -> [String: Any] {
        let now = Date()
        return [
            "iso8601": ISO8601DateFormatter().string(from: now),
            "localized": DateFormatter.localizedString(from: now, dateStyle: .full, timeStyle: .long),
            "time_zone": TimeZone.current.identifier,
            "locale": Locale.current.identifier,
            "low_power_mode": ProcessInfo.processInfo.isLowPowerModeEnabled,
        ]
    }
}

private struct IntentionRespondTool: LiveTool {
    let name = "intention_respond"

    var definition: [String: Any] {
        [
            "type": "function",
            "name": name,
            "description": """
            Accept or decline a surfaced ambient suggestion. Call this when the user explicitly \
            accepts ("yes", "do it", "set it up", "sounds good") or declines ("no", "not now", \
            "ignore it", "cancel") a suggestion that was injected with a [intention_id:…] tag. \
            Pass the intention_id from the tag and action "confirm" or "decline".
            """,
            "parameters": [
                "type": "object",
                "properties": [
                    "intention_id": [
                        "type": "string",
                        "description": "The intention_id from the [intention_id:…] tag in the surfaced suggestion.",
                    ],
                    "action": [
                        "type": "string",
                        "enum": ["confirm", "decline"],
                        "description": "confirm = user accepted; decline = user rejected.",
                    ],
                ],
                "required": ["intention_id", "action"],
                "additionalProperties": false,
            ],
        ]
    }

    var metadata: LiveToolMetadata {
        LiveToolMetadata(
            category: .memory,
            latency: .fast,
            durability: .durable,
            risk: .medium,
            visibility: .model,
            whenToUse: ["the user accepts or declines a surfaced ambient suggestion"]
        )
    }

    func isAvailable(config: LiveSessionConfig) -> Bool {
        config.bridgeToolsAvailable
    }

    func execute(arguments: [String: Any], context: LiveToolContext) async throws -> [String: Any] {
        guard let bridge = context.gatewayBridge else {
            throw LiveGatewayBridgeError.notConfigured
        }
        let intentionId = (arguments["intention_id"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !intentionId.isEmpty else {
            throw LiveGatewayBridgeError.gateway("intention_id is required")
        }
        let action = (arguments["action"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard action == "confirm" || action == "decline" else {
            throw LiveGatewayBridgeError.gateway("action must be confirm or decline")
        }
        let sessionKey = context.config.gatewayBridgeSessionKey
        try await bridge.reportIntentionResponse(
            intentionId: intentionId,
            action: action,
            sessionKey: sessionKey
        )
        return [
            "intention_id": intentionId,
            "action": action,
        ]
    }
}

private struct LiveSessionSettingsTool: LiveTool {
    let name = "get_live_session_settings"

    var definition: [String: Any] {
        [
            "type": "function",
            "name": name,
            "description": "Return the current Live session settings visible to the phone app.",
            "parameters": [
                "type": "object",
                "properties": [:],
                "additionalProperties": false,
            ],
        ]
    }

    var metadata: LiveToolMetadata {
        LiveToolMetadata(
            category: .localContext,
            latency: .instant,
            durability: .ephemeral,
            risk: .low,
            visibility: .model,
            whenToUse: ["when the model needs current Live settings before deciding how to respond"]
        )
    }

    func execute(arguments: [String: Any], context: LiveToolContext) async throws -> [String: Any] {
        [
            "provider": context.config.provider.label,
            "model": context.config.model,
            "response_modality": context.config.responseModality.rawValue,
            "reasoning_effort": context.config.reasoningEffort.rawValue,
            "voice": context.config.realtimeVoice.rawValue,
            "turn_detection": context.config.turnDetectionMode.rawValue,
            "input_transcription_enabled": context.config.inputTranscriptionEnabled,
            "visual_source": context.config.visualSource.rawValue,
            "visual_fps": context.config.effectiveVisualFPS,
            "media_persistence_mode": context.config.mediaPersistenceMode.rawValue,
            "gateway_bridge_enabled": context.config.gatewayBridgeEnabled,
            "gateway_bridge_availability": context.config.bridgeAvailability.diagnosticsLabel,
            "gateway_session_key": context.config.gatewayBridgeSessionKey,
            "gateway_feed_mode": context.config.gatewayBridgeFeedMode.rawValue,
        ]
    }
}

@MainActor
private final class LiveLocationProbe: NSObject, CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private var continuation: CheckedContinuation<[String: Any], Never>?
    private var timeoutTask: Task<Void, Never>?
    private var requestPermission = false
    private var includeCoordinate = true

    override init() {
        super.init()
        manager.delegate = self
    }

    static func snapshot(requestPermission: Bool, includeCoordinate: Bool) async -> [String: Any] {
        let probe = LiveLocationProbe()
        return await probe.run(requestPermission: requestPermission, includeCoordinate: includeCoordinate)
    }

    nonisolated static func authorizationStatusString(_ status: CLAuthorizationStatus) -> String {
        switch status {
        case .notDetermined: return "not_determined"
        case .restricted: return "restricted"
        case .denied: return "denied"
        case .authorizedAlways: return "authorized_always"
        case .authorizedWhenInUse: return "authorized_when_in_use"
        @unknown default: return "unknown"
        }
    }

    private func run(requestPermission: Bool, includeCoordinate: Bool) async -> [String: Any] {
        self.requestPermission = requestPermission
        self.includeCoordinate = includeCoordinate

        let status = manager.authorizationStatus
        if status == .notDetermined, requestPermission {
            manager.requestWhenInUseAuthorization()
        }

        guard includeCoordinate else {
            return baseOutput(status: manager.authorizationStatus)
        }

        guard manager.authorizationStatus == .authorizedWhenInUse || manager.authorizationStatus == .authorizedAlways else {
            var output = baseOutput(status: manager.authorizationStatus)
            output["coordinate_available"] = false
            output["reason"] = "location_not_authorized"
            return output
        }

        return await withCheckedContinuation { continuation in
            self.continuation = continuation
            self.timeoutTask = Task { [weak self] in
                try? await Task.sleep(nanoseconds: 5_000_000_000)
                await self?.finish([
                    "authorization": Self.authorizationStatusString(self?.manager.authorizationStatus ?? .notDetermined),
                    "coordinate_available": false,
                    "reason": "location_timeout",
                ])
            }
            manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
            manager.requestLocation()
        }
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        Task { @MainActor in
            guard self.requestPermission, self.includeCoordinate else { return }
            let status = manager.authorizationStatus
            if status == .authorizedWhenInUse || status == .authorizedAlways {
                manager.requestLocation()
            } else if status == .denied || status == .restricted {
                await self.finish([
                    "authorization": Self.authorizationStatusString(status),
                    "coordinate_available": false,
                    "reason": "location_not_authorized",
                ])
            }
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        let location = locations.last
        Task { @MainActor in
            guard let location else {
                await self.finish([
                    "authorization": Self.authorizationStatusString(manager.authorizationStatus),
                    "coordinate_available": false,
                    "reason": "no_location",
                ])
                return
            }
            await self.finish([
                "authorization": Self.authorizationStatusString(manager.authorizationStatus),
                "coordinate_available": true,
                "latitude": location.coordinate.latitude,
                "longitude": location.coordinate.longitude,
                "horizontal_accuracy_m": location.horizontalAccuracy,
                "timestamp": ISO8601DateFormatter().string(from: location.timestamp),
            ])
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        Task { @MainActor in
            await self.finish([
                "authorization": Self.authorizationStatusString(manager.authorizationStatus),
                "coordinate_available": false,
                "reason": error.localizedDescription,
            ])
        }
    }

    private func baseOutput(status: CLAuthorizationStatus) -> [String: Any] {
        [
            "authorization": Self.authorizationStatusString(status),
            "coordinate_available": false,
        ]
    }

    private func finish(_ output: [String: Any]) async {
        guard let continuation else { return }
        self.continuation = nil
        timeoutTask?.cancel()
        timeoutTask = nil
        continuation.resume(returning: output)
    }
}