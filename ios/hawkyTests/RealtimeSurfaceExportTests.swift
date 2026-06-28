import XCTest
@testable import hawky

/// Exports the production iOS realtime "surface" — the bits of the Live realtime
/// prompt that are owned by Swift (the bridge-instructions block) plus the full
/// LiveToolRegistry tool schemas the model is given — as JSON, so the prompt-test
/// harness (prompt_test/, TS) can assemble a production-faithful realtime prompt
/// without re-deriving any of this by hand.
///
/// This is the single source of truth + drift guard: run it via
/// `prompt_test/scripts/export-ios-surface.sh`, which captures the JSON printed
/// between the markers below and writes prompt_test/fixtures/realtime_surface.json.
/// If the committed fixture and a fresh export diverge, the iOS Live surface
/// changed and the prompt-test fixture must be regenerated.
///
/// base persona and memory are NOT exported here: the base persona comes from the
/// gateway prompt registry (TS getPrompt, mirrored by concise.defaultInstructions,
/// included below for reference only) and memory comes from TS
/// buildFrontendBootContext — both reused directly by the harness.
final class RealtimeSurfaceExportTests: XCTestCase {
    /// Config that exposes the FULL tool surface, so the prompt-test harness sees
    /// every tool the model can be given (its cases exercise the people tools too):
    ///  - gatewayBridgeEnabled + bridgeAvailability=.available → bridgeToolsAvailable,
    ///    which gates the session/memory/intention bridge tools.
    ///  - cocktailPartyEnabled → the person tools (identify_person, list_people,
    ///    recall_person, update_person_profile, confirm_identity_candidate,
    ///    reject_identity_candidate) additionally gate on this.
    /// The session key is pinned: realtimeBridgeInstructions interpolates it, and a
    /// random UUID would make the fixture non-deterministic (drift-guard false-positive).
    private func fullSurfaceConfig() -> LiveSessionConfig {
        var config = LiveProfileDefaults.load()
        config.gatewayBridgeEnabled = true
        config.bridgeAvailability = .available
        config.cocktailPartyEnabled = true
        config.gatewayBridgeSessionKey = "prompt-test-fixed-session"
        return config
    }

    func testDumpRealtimeSurface() throws {
        let config = fullSurfaceConfig()

        let tools = LiveToolRegistry.default.definitions(config: config)
        let manifest = LiveToolRegistry.default.manifest(config: config).map(LiveToolRegistry.manifestDictionary)

        let surface: [String: Any] = [
            "schema_version": 1,
            "model": LiveOpenAIModelPreset.realtime2.rawValue,
            // The model-facing tool array, exactly as LiveToolRegistry feeds the
            // realtime session.update.
            "tools": tools,
            // Full manifest (incl. instruction-only skills + metadata) for reference.
            "tool_manifest": manifest,
            // The big bridge/intentions/Slack behavioral block appended to the base
            // persona when the Hawky bridge is on (LiveSessionConfig.realtimeBridgeInstructions).
            "bridge_instructions": config.realtimeBridgeInstructions,
            // Offline mirror of the gateway concise persona, for reference / fallback.
            "base_persona_offline_mirror": LivePromptPreset.concise.defaultInstructions,
            "note": "Generated from ios LiveToolRegistry + LiveSessionConfig.realtimeBridgeInstructions. Do not hand-edit; regenerate via prompt_test/scripts/export-ios-surface.sh.",
        ]

        let data = try JSONSerialization.data(
            withJSONObject: surface,
            options: [.prettyPrinted, .sortedKeys]
        )
        let json = String(data: data, encoding: .utf8) ?? "{}"

        print("<<<REALTIME_SURFACE_BEGIN>>>")
        print(json)
        print("<<<REALTIME_SURFACE_END>>>")

        XCTAssertFalse(tools.isEmpty, "Expected a non-empty realtime tool surface")
    }

    // #694 de-productization: the backend-executor runtime discriminator carries
    // a neutral name (gateway_backend), not the product name. It's iOS-internal
    // (built fresh from the static registry, not persisted), so a plain rename is
    // safe; the realtime_surface.json fixture's runtime values are updated to match.

    /// Full contract over every runtime rawValue — none should embed a product name.
    func testExecutorRuntimeRawValuesAreNeutral() throws {
        XCTAssertEqual(LiveToolExecutorRuntime.iosSwift.rawValue, "ios_swift")
        XCTAssertEqual(LiveToolExecutorRuntime.iosNode.rawValue, "ios_node")
        XCTAssertEqual(LiveToolExecutorRuntime.gatewayBackend.rawValue, "gateway_backend")
        XCTAssertEqual(LiveToolExecutorRuntime.instructionOnly.rawValue, "instruction_only")
        for runtime in [LiveToolExecutorRuntime.iosSwift, .iosNode, .gatewayBackend, .instructionOnly] {
            XCTAssertFalse(runtime.rawValue.contains("hawky"), "runtime \(runtime) still embeds product name")
        }
    }

    /// The exported manifest (what the toolbox-list tool returns to the model)
    /// exposes the renamed runtime, never the legacy one.
    func testManifestExposesGatewayBackendRuntime() throws {
        var config = LiveProfileDefaults.load()
        config.gatewayBridgeEnabled = true
        let manifest = LiveToolRegistry.default.manifest(config: config).map(LiveToolRegistry.manifestDictionary)
        let runtimes = manifest.compactMap { ($0["executor"] as? [String: Any])?["runtime"] as? String }
        XCTAssertTrue(runtimes.contains("gateway_backend"), "expected at least one gateway_backend executor")
        XCTAssertFalse(runtimes.contains("hawky_backend"), "manifest still exposes legacy hawky_backend runtime")
    }

    /// Regression guard for the export config: the full surface must include both
    /// the bridge-gated tools and the cocktail-party-gated person tools, because
    /// the prompt-test harness has cases that call them. If someone narrows the
    /// export config again, the fixture would silently drop these tools — fail here.
    func testFullSurfaceIncludesGatedTools() throws {
        let names = Set(LiveToolRegistry.default.definitions(config: fullSurfaceConfig())
            .compactMap { $0["name"] as? String })
        for tool in ["session_send_message", "memory_search", "create_intention"] {
            XCTAssertTrue(names.contains(tool), "full surface should include bridge tool \(tool)")
        }
        for tool in [
            "identify_person",
            "list_people",
            "recall_person",
            "update_person_profile",
            "confirm_identity_candidate",
            "reject_identity_candidate",
        ] {
            XCTAssertTrue(names.contains(tool), "full surface should include person tool \(tool)")
        }
    }
}
