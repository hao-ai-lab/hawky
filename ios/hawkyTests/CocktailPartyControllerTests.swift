import Foundation
import Testing
@testable import hawky

// =============================================================================
// Tests for the server-matching Cocktail Party recognizer + controller (#627).
// DeepFace owns matching; here FakeFaceCropper + FakeRecognitionClient stand in
// so the present-face→identify→(recall|enroll) flow runs without Vision/gateway.
// The recognizer now sends the FULL FRAME to the client, so test frames carry the
// identity tag (via FakeCropFactory.crop); the cropper only signals "face present".
// =============================================================================

/// A test frame whose bytes encode an identity tag the FakeRecognitionClient reads.
@MainActor private func frame(_ identity: String) -> Data {
    FakeCropFactory.crop(identity: identity).jpeg
}

@MainActor
@Suite struct CocktailPartyRecognizerTests {
    private func makeRecognizer(
        crops: @escaping @Sendable (Data) -> [FaceCrop],
        client: FakeRecognitionClient,
        config: CocktailPartyConfig,
        clock: @escaping () -> Date
    ) -> CocktailPartyRecognizer {
        CocktailPartyRecognizer(cropper: FakeFaceCropper(cropsFor: crops), client: client, config: config, clock: clock)
    }

    @Test func newFaceEnrollsOnce() async {
        let client = FakeRecognitionClient()
        var now = Date(timeIntervalSince1970: 1000)
        var cfg = CocktailPartyConfig.default; cfg.minFrameInterval = 0
        let rec = makeRecognizer(crops: { _ in [FakeCropFactory.crop(identity: "present")] }, client: client, config: cfg, clock: { now })

        let first = await rec.process(jpeg: frame("alice"))
        #expect(first.count == 1)
        if case .newPerson = first[0] {} else { Issue.record("expected newPerson") }
        #expect(client.enrollCount == 1)

        // Next frame: same person now enrolled → identify hits → known, not a 2nd enroll.
        now = now.addingTimeInterval(1)
        let second = await rec.process(jpeg: frame("alice"))
        #expect(client.enrollCount == 1) // no duplicate enroll
        // Within cooldown after the enroll announcement → no event.
        #expect(second.isEmpty)
    }

    @Test func matchedProvisionalUnknownDoesNotReEnrollAfterEnrollCooldown() async {
        let client = FakeRecognitionClient()
        var now = Date(timeIntervalSince1970: 1500)
        var cfg = CocktailPartyConfig.default
        cfg.minFrameInterval = 0
        cfg.enrollCooldown = 1
        cfg.perPersonCooldown = 0
        let rec = makeRecognizer(crops: { _ in [FakeCropFactory.crop(identity: "present")] }, client: client, config: cfg, clock: { now })

        let first = await rec.process(jpeg: frame("ghost"))
        #expect(first.count == 1)
        if case .newPerson = first[0] {} else { Issue.record("expected newPerson") }
        #expect(client.enrollCount == 1)

        now = now.addingTimeInterval(2)
        let second = await rec.process(jpeg: frame("ghost"))
        #expect(client.enrollCount == 1)
        if case let .knownPerson(person)? = second.first {
            #expect(person.name == "Unknown")
        } else {
            Issue.record("expected matched provisional Unknown to take identify path")
        }
    }

    @Test func rejectedCandidateDoesNotReEnrollOrSurfaceAfterCooldown() async {
        let client = FakeRecognitionClient()
        client.suppress(tag: "ghost", candidateID: "cand-face-ghost")
        var now = Date(timeIntervalSince1970: 1700)
        var cfg = CocktailPartyConfig.default
        cfg.minFrameInterval = 0
        cfg.enrollCooldown = 1
        cfg.perPersonCooldown = 0
        let rec = makeRecognizer(crops: { _ in [FakeCropFactory.crop(identity: "present")] }, client: client, config: cfg, clock: { now })

        #expect(await rec.process(jpeg: frame("ghost")).isEmpty)
        #expect(client.enrollCount == 0)

        now = now.addingTimeInterval(2)
        #expect(await rec.process(jpeg: frame("ghost")).isEmpty)
        #expect(client.enrollCount == 0)
    }

    @Test func knownFaceRecallsThenCooldown() async {
        let client = FakeRecognitionClient()
        client.seed(tag: "sarah", person: LivePerson(id: "p-sarah", name: "Sarah", facts: ["coffee startup"], lastRecap: "seed round"))
        var now = Date(timeIntervalSince1970: 2000)
        var cfg = CocktailPartyConfig.default; cfg.minFrameInterval = 0; cfg.perPersonCooldown = 100
        let rec = makeRecognizer(crops: { _ in [FakeCropFactory.crop(identity: "present")] }, client: client, config: cfg, clock: { now })

        let r1 = await rec.process(jpeg: frame("sarah"))
        #expect(r1.count == 1)
        if case let .knownPerson(p) = r1[0] {
            #expect(p.name == "Sarah")
            #expect(p.lastRecap == "seed round")
        } else { Issue.record("expected knownPerson") }
        #expect(client.enrollCount == 0) // known → never enrolls

        now = now.addingTimeInterval(10)
        #expect(await rec.process(jpeg: frame("sarah")).isEmpty) // cooldown
        now = now.addingTimeInterval(200)
        #expect(await rec.process(jpeg: frame("sarah")).count == 1) // cooldown elapsed
    }

    @Test func rateLimitSkipsFrames() async {
        let client = FakeRecognitionClient()
        client.seed(tag: "x", person: LivePerson(id: "p-x", name: "X"))
        var now = Date(timeIntervalSince1970: 3000)
        var cfg = CocktailPartyConfig.default; cfg.minFrameInterval = 5; cfg.perPersonCooldown = 0
        let rec = makeRecognizer(crops: { _ in [FakeCropFactory.crop(identity: "present")] }, client: client, config: cfg, clock: { now })
        #expect(await rec.process(jpeg: frame("x")).count == 1)
        now = now.addingTimeInterval(1)
        #expect(await rec.process(jpeg: frame("x")).isEmpty) // within interval
        now = now.addingTimeInterval(10)
        #expect(await rec.process(jpeg: frame("x")).count == 1)
    }

    @Test func noFacesNoEvents() async {
        let client = FakeRecognitionClient()
        var cfg = CocktailPartyConfig.default; cfg.minFrameInterval = 0
        let rec = makeRecognizer(crops: { _ in [] }, client: client, config: cfg, clock: { Date() })
        #expect(await rec.process(jpeg: Data("x".utf8)).isEmpty)
    }
}

@MainActor
@Suite struct CocktailPartyControllerTests {
    @Test func knownPersonInjectsSilentContextNotSpeech() async {
        // Recall is now SILENT: a recognized person injects context (so the model can
        // answer when asked) but NEVER speaks an unprompted "quick aside".
        let client = FakeRecognitionClient()
        client.seed(tag: "sarah", person: LivePerson(id: "p-sarah", name: "Sarah", facts: ["climber"], lastRecap: "her startup"))
        var cfg = CocktailPartyConfig.default; cfg.minFrameInterval = 0
        let rec = CocktailPartyRecognizer(cropper: FakeFaceCropper(cropsFor: { _ in [FakeCropFactory.crop(identity: "present")] }), client: client, config: cfg, clock: { Date() })
        let controller = CocktailPartyController(recognizer: rec)

        var injected: [String] = []
        controller.injectContext = { injected.append($0) }
        controller.start()

        await controller.handleFrame(frame("sarah"))
        #expect(injected.count == 1)              // silent context only
        #expect(injected[0].contains("Sarah"))
        #expect(injected[0].contains("her startup"))
        #expect(injected[0].lowercased().contains("unless asked") || injected[0].lowercased().contains("do not say"))
    }

    @Test func unknownPersonRecallIsSuppressed() async {
        // A recognized-but-nameless ("Unknown") person must NOT trigger any recall.
        let client = FakeRecognitionClient()
        client.seed(tag: "ghost", person: LivePerson(id: "p-ghost", name: "Unknown"))
        var cfg = CocktailPartyConfig.default; cfg.minFrameInterval = 0
        let rec = CocktailPartyRecognizer(cropper: FakeFaceCropper(cropsFor: { _ in [FakeCropFactory.crop(identity: "present")] }), client: client, config: cfg, clock: { Date() })
        let controller = CocktailPartyController(recognizer: rec)
        var injected: [String] = []
        controller.injectContext = { injected.append($0) }
        controller.start()
        await controller.handleFrame(frame("ghost"))
        #expect(injected.isEmpty)                 // no announce for Unknown
    }

    @Test func newPersonInjectsLearnContextNotSpeech() async {
        let client = FakeRecognitionClient()
        var cfg = CocktailPartyConfig.default; cfg.minFrameInterval = 0
        let rec = CocktailPartyRecognizer(cropper: FakeFaceCropper(cropsFor: { _ in [FakeCropFactory.crop(identity: "present")] }), client: client, config: cfg, clock: { Date() })
        let controller = CocktailPartyController(recognizer: rec)

        var injected: [String] = []
        controller.injectContext = { injected.append($0) }
        controller.start()

        await controller.handleFrame(frame("newp"))
        #expect(injected.count == 1)            // model is told to learn them
        #expect(injected[0].contains("update_person_profile"))
        #expect(!injected[0].contains("face_update"))
        #expect(injected[0].contains("person-newp"))
    }

    @Test func inactiveControllerIgnoresFrames() async {
        let client = FakeRecognitionClient()
        var cfg = CocktailPartyConfig.default; cfg.minFrameInterval = 0
        let rec = CocktailPartyRecognizer(cropper: FakeFaceCropper(cropsFor: { _ in [FakeCropFactory.crop(identity: "present")] }), client: client, config: cfg, clock: { Date() })
        let controller = CocktailPartyController(recognizer: rec)
        var injected = 0
        controller.injectContext = { _ in injected += 1 }
        // not started
        await controller.handleFrame(Data("x".utf8))
        #expect(injected == 0)
        #expect(client.enrollCount == 0)
    }

    @Test func learnNameThenRecallArc() async {
        // New face → enroll → model names them → reappears → recalled as SILENT
        // context (never spoken unprompted).
        let client = FakeRecognitionClient()
        var cfg = CocktailPartyConfig.default; cfg.minFrameInterval = 0; cfg.perPersonCooldown = 0
        var now = Date(timeIntervalSince1970: 5000)
        let rec = CocktailPartyRecognizer(cropper: FakeFaceCropper(cropsFor: { _ in [FakeCropFactory.crop(identity: "present")] }), client: client, config: cfg, clock: { now })
        let controller = CocktailPartyController(recognizer: rec)
        var injected: [String] = []
        controller.injectContext = { injected.append($0) }
        controller.start()

        await controller.handleFrame(frame("marcus")) // enroll (tag from frame)
        // Model learns the name + recap (what update_person_profile does, simulated here).
        client.seed(tag: "marcus", person: LivePerson(id: "person-marcus", name: "Marcus", facts: [], lastRecap: "Yosemite climbing"))
        now = now.addingTimeInterval(1)
        await controller.handleFrame(frame("marcus")) // recall
        #expect(injected.contains { $0.contains("Marcus") && $0.contains("Yosemite") })
    }
}

@Suite struct LiveGatewayBridgePersonContractTests {
    private func uniqueURL() -> URL {
        URL(string: "http://person-contract-\(UUID().uuidString).local")!
    }

    @Test func personOperationsUseSharedPersonRPCs() async throws {
        let url = uniqueURL()
        try KeychainStore.save(token: "test-token", for: url)
        defer { try? KeychainStore.delete(for: url) }

        let recorder = RecordingGatewayTransportStore()
        let bridge = LiveGatewayBridge(
            gatewayURL: url,
            transportFactory: { RecordingGatewayTransport(recorder: recorder) }
        )

        let identified = await bridge.identifyFace(imageBase64: "frame-a", sessionKey: "session-a")
        let enrolled = await bridge.enrollFace(imageBase64: "frame-b", name: "Alice", personId: nil, sessionKey: "session-a")
        let updated = await bridge.updatePerson(personId: "p-alice", name: "Alice", facts: ["met at demo"], recap: "likes espresso", sessionKey: "session-a")
        let people = await bridge.listPeople(sessionKey: "session-a")
        let confirmed = await bridge.confirmIdentityCandidate(candidateId: "cand-alice", name: "Alice", personId: nil, reason: "user verified", sessionKey: "session-a")
        let rejected = await bridge.rejectIdentityCandidate(candidateId: "cand-bob", reason: "not them", sessionKey: "session-a")

        #expect(identified?.id == "p-alice")
        #expect(enrolled?.name == "Alice")
        #expect(updated?.facts == ["met at demo"])
        #expect(people.map(\.id) == ["p-alice"])
        #expect(confirmed?.id == "p-alice")
        #expect(rejected == true)

        let frames = recorder.sentFrames()
        #expect(frames.map(\.method) == [
            "person.identify_current_frame",
            "person.update_profile",
            "person.update_profile",
            "person.list",
            "person.confirm_candidate",
            "person.reject_candidate",
        ])
        #expect(recorder.connectPlatforms() == Array(repeating: "ios-live-rpc", count: 6))

        #expect(stringParam(frames[0], "image_base64") == "frame-a")
        #expect(stringParam(frames[0], "session_key") == "session-a")

        #expect(stringParam(frames[1], "image_base64") == "frame-b")
        #expect(stringParam(frames[1], "name") == "Alice")
        #expect(stringParam(frames[1], "session_key") == "session-a")

        #expect(stringParam(frames[2], "id") == "p-alice")
        #expect(stringArrayParam(frames[2], "facts") == ["met at demo"])
        #expect(stringParam(frames[2], "recap") == "likes espresso")
        #expect(stringParam(frames[3], "session_key") == "session-a")
        #expect(boolParam(frames[3], "include_candidates") == true)
        #expect(stringParam(frames[4], "candidate_id") == "cand-alice")
        #expect(stringParam(frames[4], "name") == "Alice")
        #expect(stringParam(frames[4], "reason") == "user verified")
        #expect(stringParam(frames[5], "candidate_id") == "cand-bob")
        #expect(stringParam(frames[5], "reason") == "not them")
    }

    @Test func provisionalUnknownIdentifyCandidateSuppressesNilMiss() async throws {
        let url = uniqueURL()
        try KeychainStore.save(token: "test-token", for: url)
        defer { try? KeychainStore.delete(for: url) }

        let recorder = RecordingGatewayTransportStore(
            identifyPayload: .object([
                "found": .bool(false),
                "candidate_id": .string("cand-face-ghost"),
                "candidate": .object([
                    "id": .string("cand-face-ghost"),
                    "candidateType": .string("unknown_face"),
                    "modalities": .array([.string("face")]),
                    "metadata": .object(["deepfaceProfileId": .string("p-ghost")]),
                    "legacyRefs": .array([
                        .object(["system": .string("deepface"), "profileId": .string("p-ghost")]),
                    ]),
                ]),
                "reason": .string("candidate_like_legacy_unknown"),
            ])
        )
        let bridge = LiveGatewayBridge(
            gatewayURL: url,
            transportFactory: { RecordingGatewayTransport(recorder: recorder) }
        )

        let identified = await bridge.identifyFace(imageBase64: "unknown-match", sessionKey: "session-c")

        #expect(identified?.id == "p-ghost")
        #expect(identified?.candidateID == "cand-face-ghost")
        #expect(identified?.name == "Unknown")
        #expect(recorder.sentFrames().map(\.method) == ["person.identify_current_frame"])
    }

    @Test func rejectedCandidateIdentifyReturnsSuppressedNoEnrollSignal() async throws {
        let url = uniqueURL()
        try KeychainStore.save(token: "test-token", for: url)
        defer { try? KeychainStore.delete(for: url) }

        let recorder = RecordingGatewayTransportStore(
            identifyPayload: .object([
                "found": .bool(false),
                "candidate_id": .string("cand-face-ghost"),
                "reason": .string("candidate_rejected"),
                "suppressed": .bool(true),
                "no_enroll": .bool(true),
                "message": .string("This face matches an identity candidate that was rejected or suppressed."),
            ])
        )
        let bridge = LiveGatewayBridge(
            gatewayURL: url,
            transportFactory: { RecordingGatewayTransport(recorder: recorder) }
        )

        let result = await bridge.identifyFaceResult(imageBase64: "unknown-match", sessionKey: "session-c")

        if case let .suppressed(candidateID, reason) = result {
            #expect(candidateID == "cand-face-ghost")
            #expect(reason == "candidate_rejected")
        } else {
            Issue.record("expected rejected candidate to return suppressed no-enroll signal")
        }
        #expect(await bridge.identifyFace(imageBase64: "unknown-match", sessionKey: "session-c") == nil)
    }

    @Test func identifyPersonToolSurfacesCandidateIdForProvisionalUnknown() async throws {
        var config = LiveSessionConfig()
        config.gatewayBridgeEnabled = true
        config.bridgeAvailability = .available
        config.cocktailPartyEnabled = true
        config.gatewayBridgeSessionKey = "session-tool"
        let context = LiveToolContext(
            config: config,
            gatewayBridge: nil,
            awaitPendingTranscriptAppend: nil,
            cocktailPartyActive: true,
            identifyOnCamera: {
                .person(LivePerson(id: "p-ghost", name: "Unknown", candidateID: "cand-face-ghost"))
            }
        )

        let json = await LiveToolRegistry.default.execute(
            name: "identify_person",
            argumentsJSON: "{}",
            context: context
        )
        let output = try jsonObject(json)
        let candidate = try #require(output["candidate"] as? [String: Any])

        #expect(output["ok"] as? Bool == true)
        #expect(output["found"] as? Bool == false)
        #expect(output["candidate_id"] as? String == "cand-face-ghost")
        #expect(candidate["id"] as? String == "p-ghost")
        #expect(candidate["candidate_id"] as? String == "cand-face-ghost")
        #expect(candidate["is_candidate"] as? Bool == true)
        #expect(output["person"] == nil)
    }

    @Test func identifyPersonToolSurfacesSuppressedCandidateSignal() async throws {
        var config = LiveSessionConfig()
        config.gatewayBridgeEnabled = true
        config.bridgeAvailability = .available
        config.cocktailPartyEnabled = true
        config.gatewayBridgeSessionKey = "session-tool"
        let context = LiveToolContext(
            config: config,
            gatewayBridge: nil,
            awaitPendingTranscriptAppend: nil,
            cocktailPartyActive: true,
            identifyOnCamera: {
                .suppressed(candidateID: "cand-face-ghost", reason: "candidate_rejected")
            }
        )

        let json = await LiveToolRegistry.default.execute(
            name: "identify_person",
            argumentsJSON: "{}",
            context: context
        )
        let output = try jsonObject(json)
        let message = try #require(output["message"] as? String)

        #expect(output["ok"] as? Bool == true)
        #expect(output["found"] as? Bool == false)
        #expect(output["suppressed"] as? Bool == true)
        #expect(output["no_enroll"] as? Bool == true)
        #expect(output["reason"] as? String == "candidate_rejected")
        #expect(output["candidate_id"] as? String == "cand-face-ghost")
        #expect(message.contains("rejected or suppressed"))
        #expect(!message.contains("They may be new"))
        #expect(output["candidate"] == nil)
        #expect(output["person"] == nil)
    }

    @Test func updatePersonToolRefusesUnconfirmedResolvedCandidate() async throws {
        let url = uniqueURL()
        try KeychainStore.save(token: "test-token", for: url)
        defer { try? KeychainStore.delete(for: url) }

        let recorder = RecordingGatewayTransportStore()
        let bridge = LiveGatewayBridge(
            gatewayURL: url,
            transportFactory: { RecordingGatewayTransport(recorder: recorder) }
        )
        var config = LiveSessionConfig()
        config.gatewayBridgeEnabled = true
        config.bridgeAvailability = .available
        config.cocktailPartyEnabled = true
        config.gatewayBridgeSessionKey = "session-tool-update"
        let context = LiveToolContext(
            config: config,
            gatewayBridge: bridge,
            awaitPendingTranscriptAppend: nil,
            cocktailPartyActive: true,
            resolveCameraPerson: { _ in
                .person(LivePerson(id: "p-ghost", name: "Unknown", candidateID: "cand-face-ghost"))
            }
        )

        let json = await LiveToolRegistry.default.execute(
            name: "update_person_profile",
            argumentsJSON: #"{"name":"Morgan"}"#,
            context: context
        )
        let output = try jsonObject(json)
        let error = try #require(output["error"] as? String)

        #expect(output["ok"] as? Bool == false)
        #expect(output["candidate_id"] as? String == "cand-face-ghost")
        #expect(error.contains("confirm_identity_candidate"))
        #expect(recorder.sentFrames().isEmpty)
    }

    @Test func updatePersonToolRefusesSuppressedResolvedFaceEvenWithStaleId() async throws {
        let url = uniqueURL()
        try KeychainStore.save(token: "test-token", for: url)
        defer { try? KeychainStore.delete(for: url) }

        let recorder = RecordingGatewayTransportStore()
        let bridge = LiveGatewayBridge(
            gatewayURL: url,
            transportFactory: { RecordingGatewayTransport(recorder: recorder) }
        )
        var config = LiveSessionConfig()
        config.gatewayBridgeEnabled = true
        config.bridgeAvailability = .available
        config.cocktailPartyEnabled = true
        config.gatewayBridgeSessionKey = "session-tool-update-suppressed"
        let context = LiveToolContext(
            config: config,
            gatewayBridge: bridge,
            awaitPendingTranscriptAppend: nil,
            cocktailPartyActive: true,
            resolveCameraPerson: { _ in
                .suppressed(candidateID: "cand-face-ghost", reason: "candidate_rejected")
            }
        )

        let json = await LiveToolRegistry.default.execute(
            name: "update_person_profile",
            argumentsJSON: #"{"id":"p-stale","name":"Morgan"}"#,
            context: context
        )
        let output = try jsonObject(json)
        let error = try #require(output["error"] as? String)

        #expect(output["ok"] as? Bool == false)
        #expect(output["suppressed"] as? Bool == true)
        #expect(output["no_enroll"] as? Bool == true)
        #expect(output["reason"] as? String == "candidate_rejected")
        #expect(output["candidate_id"] as? String == "cand-face-ghost")
        #expect(error.contains("cannot be updated or enrolled"))
        #expect(recorder.sentFrames().isEmpty)
    }

    @Test func listPeopleIncludesProvisionalUnknownCandidatesForClearPath() async throws {
        let url = uniqueURL()
        try KeychainStore.save(token: "test-token", for: url)
        defer { try? KeychainStore.delete(for: url) }

        let recorder = RecordingGatewayTransportStore(
            listPayload: .object([
                "people": .array([]),
                "candidates": .array([
                    .object([
                        "id": .string("cand-face-unknown"),
                        "candidateType": .string("unknown_face"),
                        "modalities": .array([.string("face")]),
                        "metadata": .object(["deepfaceProfileId": .string("p-unknown")]),
                        "legacyRefs": .array([
                            .object(["system": .string("deepface"), "profileId": .string("p-unknown")]),
                        ]),
                    ]),
                ]),
            ])
        )
        let bridge = LiveGatewayBridge(
            gatewayURL: url,
            transportFactory: { RecordingGatewayTransport(recorder: recorder) }
        )

        let people = await bridge.listPeople(sessionKey: "session-d")

        #expect(people.map(\.id) == ["p-unknown"])
        #expect(people.map(\.candidateID) == ["cand-face-unknown"])
        #expect(people.map(\.name) == ["Unknown"])
        let frames = recorder.sentFrames()
        #expect(frames.map(\.method) == ["person.list"])
        #expect(stringParam(frames[0], "session_key") == "session-d")
        #expect(boolParam(frames[0], "include_candidates") == true)
    }

    @Test func listPeopleToolSurfacesCandidateIdForProvisionalUnknowns() async throws {
        let url = uniqueURL()
        try KeychainStore.save(token: "test-token", for: url)
        defer { try? KeychainStore.delete(for: url) }

        let recorder = RecordingGatewayTransportStore(
            listPayload: .object([
                "people": .array([]),
                "candidates": .array([
                    .object([
                        "id": .string("cand-face-unknown"),
                        "candidateType": .string("unknown_face"),
                        "modalities": .array([.string("face")]),
                        "metadata": .object(["deepfaceProfileId": .string("p-unknown")]),
                        "legacyRefs": .array([
                            .object(["system": .string("deepface"), "profileId": .string("p-unknown")]),
                        ]),
                    ]),
                ]),
            ])
        )
        let bridge = LiveGatewayBridge(
            gatewayURL: url,
            transportFactory: { RecordingGatewayTransport(recorder: recorder) }
        )
        var config = LiveSessionConfig()
        config.gatewayBridgeEnabled = true
        config.bridgeAvailability = .available
        config.cocktailPartyEnabled = true
        config.gatewayBridgeSessionKey = "session-tool-list"
        let context = LiveToolContext(
            config: config,
            gatewayBridge: bridge,
            awaitPendingTranscriptAppend: nil,
            cocktailPartyActive: true
        )

        let json = await LiveToolRegistry.default.execute(
            name: "list_people",
            argumentsJSON: "{}",
            context: context
        )
        let output = try jsonObject(json)
        let people = try #require(output["people"] as? [[String: Any]])
        let candidates = try #require(output["candidates"] as? [[String: Any]])
        let person = try #require(people.first)
        let candidate = try #require(candidates.first)

        #expect(output["ok"] as? Bool == true)
        #expect(output["count"] as? Int == 1)
        #expect(person["id"] as? String == "p-unknown")
        #expect(person["candidate_id"] as? String == "cand-face-unknown")
        #expect(person["is_candidate"] as? Bool == true)
        #expect(candidate["id"] as? String == "p-unknown")
        #expect(candidate["candidate_id"] as? String == "cand-face-unknown")
    }

    @Test func provisionalUnknownAndAddCropEnrollsStayOnLegacyFaceTool() async throws {
        let url = uniqueURL()
        try KeychainStore.save(token: "test-token", for: url)
        defer { try? KeychainStore.delete(for: url) }

        let recorder = RecordingGatewayTransportStore()
        let bridge = LiveGatewayBridge(
            gatewayURL: url,
            transportFactory: { RecordingGatewayTransport(recorder: recorder) }
        )

        _ = await bridge.enrollFace(imageBase64: "unknown-frame", name: "Unknown", personId: nil, sessionKey: "session-b")
        _ = await bridge.enrollFace(imageBase64: "extra-crop", name: "Alice", personId: "p-alice", sessionKey: "session-b")

        let frames = recorder.sentFrames()
        #expect(frames.map(\.method) == ["tool.invoke", "tool.invoke"])
        #expect(recorder.connectPlatforms() == Array(repeating: "ios-live-face", count: 2))

        #expect(stringParam(frames[0], "tool_name") == "face_enroll")
        #expect(stringParam(frames[0], "session_key") == "session-b")
        #expect(stringParam(frames[0], "args", "image_base64") == "unknown-frame")
        #expect(stringParam(frames[0], "args", "name") == "Unknown")

        #expect(stringParam(frames[1], "tool_name") == "face_enroll")
        #expect(stringParam(frames[1], "args", "image_base64") == "extra-crop")
        #expect(stringParam(frames[1], "args", "person_id") == "p-alice")
    }
}

private final class RecordingGatewayTransportStore: @unchecked Sendable {
    private let lock = NSLock()
    private let identifyPayload: JSONValue
    private let listPayload: JSONValue
    private var frames: [RequestFrame] = []
    private var platforms: [String] = []

    init(identifyPayload: JSONValue? = nil, listPayload: JSONValue? = nil) {
        self.identifyPayload = identifyPayload ?? .object(["found": .bool(true), "person": Self.person()])
        self.listPayload = listPayload ?? .object(["people": .array([Self.person()])])
    }

    func recordConnect(_ params: ConnectParams) {
        lock.lock()
        platforms.append(params.platform)
        lock.unlock()
    }

    func recordSend(_ frame: RequestFrame) {
        lock.lock()
        frames.append(frame)
        lock.unlock()
    }

    func sentFrames() -> [RequestFrame] {
        lock.lock()
        defer { lock.unlock() }
        return frames
    }

    func connectPlatforms() -> [String] {
        lock.lock()
        defer { lock.unlock() }
        return platforms
    }

    func responsePayload(for frame: RequestFrame) -> JSONValue {
        switch frame.method {
        case "person.identify_current_frame":
            return identifyPayload
        case "person.update_profile":
            return .object(["person": Self.person(facts: stringArrayParam(frame, "facts"))])
        case "person.list":
            return listPayload
        case "person.confirm_candidate":
            return .object(["ok": .bool(true), "candidate": Self.candidate(), "person": Self.person()])
        case "person.reject_candidate":
            return .object(["ok": .bool(true), "candidate": Self.candidate(reviewState: "rejected")])
        case "tool.invoke":
            return .object(["result": .object(["metadata": .object(["person": Self.person()])])])
        default:
            return .object([:])
        }
    }

    private static func person(facts: [String] = []) -> JSONValue {
        .object([
            "id": .string("p-alice"),
            "name": .string("Alice"),
            "facts": .array(facts.map { .string($0) }),
            "last_recap": .string("likes espresso"),
        ])
    }

    private static func candidate(reviewState: String = "confirmed") -> JSONValue {
        .object([
            "id": .string("cand-alice"),
            "candidateType": .string("unknown_face"),
            "modalities": .array([.string("face")]),
            "review": .object(["state": .string(reviewState)]),
            "metadata": .object(["deepfaceProfileId": .string("p-alice")]),
            "legacyRefs": .array([
                .object(["system": .string("deepface"), "profileId": .string("p-alice")]),
            ]),
        ])
    }
}

private final class RecordingGatewayTransport: GatewayTransport, @unchecked Sendable {
    private let recorder: RecordingGatewayTransportStore

    var isConnected: Bool { true }

    init(recorder: RecordingGatewayTransportStore) {
        self.recorder = recorder
    }

    func connect(url: URL, connectParams: ConnectParams) async throws -> HelloPayload {
        recorder.recordConnect(connectParams)
        return HelloPayload(connId: "test-conn", serverVersion: "test", methods: [])
    }

    func send(_ frame: RequestFrame) async throws -> ResponseFrame {
        try await send(frame, timeout: nil)
    }

    func send(_ frame: RequestFrame, timeout: TimeInterval?) async throws -> ResponseFrame {
        recorder.recordSend(frame)
        return ResponseFrame(
            type: "res",
            id: frame.id,
            ok: true,
            payload: recorder.responsePayload(for: frame),
            error: nil
        )
    }

    func events() -> AsyncStream<EventFrame> {
        AsyncStream { continuation in continuation.finish() }
    }

    func disconnect() async {}
}

private func stringParam(_ frame: RequestFrame, _ key: String) -> String? {
    guard case let .string(value)? = frame.params?[key] else { return nil }
    return value
}

private func stringParam(_ frame: RequestFrame, _ objectKey: String, _ key: String) -> String? {
    guard case let .object(object)? = frame.params?[objectKey],
          case let .string(value)? = object[key]
    else { return nil }
    return value
}

private func boolParam(_ frame: RequestFrame, _ key: String) -> Bool? {
    guard case let .bool(value)? = frame.params?[key] else { return nil }
    return value
}

private func stringArrayParam(_ frame: RequestFrame, _ key: String) -> [String] {
    guard case let .array(values)? = frame.params?[key] else { return [] }
    return values.compactMap { value in
        guard case let .string(text) = value else { return nil }
        return text
    }
}

private enum TestJSONError: Error {
    case invalidJSON
}

private func jsonObject(_ text: String) throws -> [String: Any] {
    guard let data = text.data(using: .utf8),
          let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
    else {
        throw TestJSONError.invalidJSON
    }
    return object
}
