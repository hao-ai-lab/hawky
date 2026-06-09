import SwiftUI

// TestView — lightweight precursor to the full Testing tab (plan 08 step 11).
// Runs real probes against the live gateway and shows the result inline + logs.
// Inspired by Secretary tweaks.jsx's section/row idiom; no live-preview theming.
struct TestView: View {
    @Environment(AppContainer.self) private var container

    @State private var log: [LogEntry] = []
    @State private var results: [String: String] = [:]
    @State private var expanded: Set<String> = []
    @State private var busy: Set<String> = []
    @State private var capResults: [String: String] = [:]
    @State private var capBusy: Set<String> = []

    private let pingProbeSessionKey = "test:ios-ping"

    private let capabilities: [any NodeCommand] = [
        DeviceInfoCommand(),
        BatteryCommand(),
        StorageCommand(),
        NetworkCommand(),
        ClipboardCommand(),
        NotificationShowCommand(),
        FrontendMessageCommand(),
        FrontendOpenTabCommand(),
    ]

    struct LogEntry: Identifiable {
        let id = UUID()
        let time: Date
        let text: String
    }

    private let probes: [(id: String, label: String, sub: String)] = [
        ("health", "Ping /health", "GET <gatewayURL>/health"),
        ("token",  "Fetch new token", "deviceAuth.fetchToken()"),
        ("ws",     "Open WS handshake", "one-shot transport connect+disconnect"),
        ("send",   "Send chat.send 'ping'", "isolated session: test:ios-ping"),
        ("list",   "List sessions", "session.list RPC"),
        ("history","Reload session.history", "overlays server history onto ChatStore"),
        ("live-broker", "Mint Realtime secret", "OpenAI Realtime broker probe"),
        ("jpg",    "Send test JPG", "vision.frame.upload one-shot probe"),
        ("jpg-rtt","Measure JPG RTT", "echo vs upload gateway round-trip"),
        ("frames", "View debug frames", "dumps last N unparseable/unknown frames"),
    ]

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    Button {
                        invokeAllProbes()
                    } label: {
                        HStack {
                            if busy.isEmpty {
                                Image(systemName: "play.rectangle.on.rectangle.fill")
                            } else {
                                ProgressView().controlSize(.small)
                            }
                            Text(busy.isEmpty ? "Invoke all" : "Running \(busy.count)…")
                                .fontWeight(.semibold)
                            Spacer()
                        }
                    }
                    .primaryPanelAction()
                    .disabled(!busy.isEmpty)
                    .accessibilityIdentifier("tweak.run.all")
                    Text("Runs each gateway probe in sequence; results fill in live below.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                .padding(.vertical, 2)
                ForEach(probes, id: \.id) { p in
                    probeRow(id: p.id, label: p.label, sub: p.sub)
                }
            } header: {
                sectionHeader("Probes")
            }
            .listRowBackground(DesignTokens.Surface.paper)
            .listRowSeparatorTint(DesignTokens.Surface.paperStroke)

            Section {
                VStack(alignment: .leading, spacing: 6) {
                    Button {
                        invokeAllCapabilities()
                    } label: {
                        HStack {
                            if capBusy.isEmpty {
                                Image(systemName: "play.rectangle.on.rectangle.fill")
                            } else {
                                ProgressView().controlSize(.small)
                            }
                            Text(capBusy.isEmpty ? "Invoke all" : "Running \(capBusy.count)…")
                                .fontWeight(.semibold)
                            Spacer()
                        }
                    }
                    .primaryPanelAction()
                    .disabled(!capBusy.isEmpty)
                    .accessibilityIdentifier("cap.invoke.all")
                    Text("Runs every probe in sequence; results fill in live below.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                .padding(.vertical, 2)
                ForEach(Array(capabilities.enumerated()), id: \.offset) { _, cmd in
                    capabilityRow(cmd)
                }
            } header: {
                sectionHeader("Node capabilities")
            }
            .listRowBackground(DesignTokens.Surface.paper)
            .listRowSeparatorTint(DesignTokens.Surface.paperStroke)

            Section {
                if log.isEmpty {
                    Text("No runs yet")
                        .font(DesignTokens.Font.mono)
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(log) { entry in
                        HStack(alignment: .top, spacing: 8) {
                            Text(timeFmt.string(from: entry.time))
                                .font(DesignTokens.Font.mono)
                                .foregroundStyle(DesignTokens.tertiaryText)
                            Text(entry.text)
                                .font(DesignTokens.Font.mono)
                                .textSelection(.enabled)
                        }
                    }
                }
                if !log.isEmpty {
                    Button("Clear log") { log.removeAll() }
                        .secondaryPanelAction()
                }
            } header: {
                sectionHeader("Log")
            }
            .listRowBackground(DesignTokens.Surface.paperInset)
            .listRowSeparatorTint(DesignTokens.Surface.paperStroke)
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(DesignTokens.groupedBackground)
        .tint(DesignTokens.accent)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                ConnectionStatusDot(
                    status: container.connectionStore.status,
                    lastError: container.connectionStore.lastError
                )
            }
        }
    }

    private func sectionHeader(_ title: String) -> some View {
        Text(title)
            .font(DesignTokens.Font.eyebrow)
            .foregroundStyle(DesignTokens.tertiaryText)
            .textCase(.uppercase)
            .padding(.top, 4)
    }

    @ViewBuilder
    private func probeRow(id: String, label: String, sub: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(label).font(.body)
                    Text(sub).font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Button("Run") { run(id) }
                    .secondaryPanelAction()
                    .disabled(busy.contains(id))
                    .accessibilityIdentifier("tweak.run.\(id)")
            }
            if let out = results[id] {
                DisclosureGroup(
                    isExpanded: Binding(
                        get: { expanded.contains(id) },
                        set: { on in if on { expanded.insert(id) } else { expanded.remove(id) } }
                    )
                ) {
                    Text(out)
                        .font(DesignTokens.Font.mono)
                        .textSelection(.enabled)
                        .padding(10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .paperSurface(in: RoundedRectangle(cornerRadius: 12, style: .continuous), inset: true)
                } label: {
                    Text(out.prefix(60) + (out.count > 60 ? "…" : ""))
                        .font(DesignTokens.Font.mono)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
        }
        .padding(.vertical, 2)
    }

    private func run(_ id: String) {
        busy.insert(id)
        Task {
            let result = await runProbe(id)
            await MainActor.run {
                results[id] = result
                expanded.insert(id)
                log.append(LogEntry(time: Date(), text: "[\(id)] \(result)"))
                busy.remove(id)
            }
        }
    }

    private func invokeAllProbes() {
        for probe in probes { busy.insert(probe.id) }
        Task {
            for probe in probes {
                let result = await runProbe(probe.id)
                await MainActor.run {
                    results[probe.id] = result
                    expanded.insert(probe.id)
                    log.append(LogEntry(time: Date(), text: "[\(probe.id)] \(result)"))
                    busy.remove(probe.id)
                }
            }
        }
    }

    private func runProbe(_ id: String) async -> String {
        switch id {
        case "health": return await probeHealth()
        case "token":  return await probeToken()
        case "ws":     return await probeWS()
        case "send":   return await probeSend()
        case "list":   return await probeListSessions()
        case "history": return await probeReloadHistory()
        case "live-broker": return await probeLiveBroker()
        case "jpg": return await probeVisionFrameUpload()
        case "jpg-rtt": return await probeVisionFrameRoundTrip()
        case "frames": return await probeDebugFrames()
        default: return "unknown probe"
        }
    }

    // MARK: - Probes

    private func probeHealth() async -> String {
        let url = container.gatewayURL.appendingPathComponent("health")
        let t0 = Date()
        do {
            var req = URLRequest(url: url)
            CloudflareAccessStore.applyHeaders(to: &req, gatewayURL: container.gatewayURL)
            let (_, resp) = try await URLSession.shared.data(for: req)
            let ms = Int(Date().timeIntervalSince(t0) * 1000)
            let code = (resp as? HTTPURLResponse)?.statusCode ?? -1
            return "HTTP \(code) in \(ms)ms"
        } catch {
            return "failed: \(error.localizedDescription)"
        }
    }

    private func probeToken() async -> String {
        do {
            let token = try await container.deviceAuth.fetchToken()
            let tail = token.suffix(8)
            if let exp = decodeJWTExpiry(token) {
                let fmt = DateFormatter(); fmt.dateStyle = .short; fmt.timeStyle = .short
                return "…\(tail) exp=\(fmt.string(from: exp))"
            }
            return "…\(tail) (opaque)"
        } catch {
            return "failed: \(error)"
        }
    }

    private func probeWS() async -> String {
        let transport = URLSessionGatewayTransport()
        defer { Task { await transport.disconnect() } }
        do {
            let token: String
            if let cached = try? KeychainStore.load(for: container.gatewayURL), !cached.isEmpty {
                token = cached
            } else {
                token = try await container.deviceAuth.fetchToken()
            }
            var comps = URLComponents(url: container.gatewayURL, resolvingAgainstBaseURL: false)!
            if comps.scheme == "http" { comps.scheme = "ws" }
            if comps.scheme == "https" { comps.scheme = "wss" }
            let params = ConnectParams(version: "1", platform: "tweak-probe", token: token, sessionKey: container.sessionStore.activeSessionKey, role: "client")
            let hello = try await transport.connect(url: comps.url!, connectParams: params)
            return "connId=\(hello.connId.prefix(8)) methods=\(hello.methods.count)"
        } catch {
            return "failed: \(error)"
        }
    }

    private func probeSend() async -> String {
        let transport = URLSessionGatewayTransport()
        defer { Task { await transport.disconnect() } }
        do {
            let token: String
            if let cached = try? KeychainStore.load(for: container.gatewayURL), !cached.isEmpty {
                token = cached
            } else {
                token = try await container.deviceAuth.fetchToken()
            }
            var comps = URLComponents(url: container.gatewayURL, resolvingAgainstBaseURL: false)!
            if comps.scheme == "http" { comps.scheme = "ws" }
            if comps.scheme == "https" { comps.scheme = "wss" }
            let params = ConnectParams(
                version: "1",
                platform: "tweak-probe",
                token: token,
                sessionKey: pingProbeSessionKey,
                role: "client"
            )
            _ = try await transport.connect(url: comps.url!, connectParams: params)
            let client = ChatClient(transport: transport, sessionKey: pingProbeSessionKey)
            let stream = try await client.send("ping")
            var text = ""
            var count = 0
            for await ev in stream {
                switch ev {
                case .text(content: let s, replace: let replace):
                    text = replace ? s : text + s
                    count += 1
                case .done: return "\(pingProbeSessionKey) \(count) deltas: \(text.prefix(80))"
                case .error(let c, let m): return "error [\(c)] \(m)"
                default: continue
                }
            }
            return "\(pingProbeSessionKey) stream ended (\(count) deltas): \(text.prefix(80))"
        } catch {
            return "failed: \(error)"
        }
    }

    private func probeListSessions() async -> String {
        guard let transport = container.transport else { return "no transport — connect first" }
        let frame = RequestFrame(id: UUID().uuidString, method: "session.list", params: [:])
        do {
            let resp = try await transport.send(frame)
            if !resp.ok { return "error: \(resp.error?.message ?? "unknown")" }
            if case .some(.array(let arr)) = resp.payload {
                return "\(arr.count) sessions"
            }
            if case .some(.object(let obj)) = resp.payload,
               case .some(.array(let arr)) = obj["sessions"] {
                return "\(arr.count) sessions"
            }
            return "ok (payload shape unknown)"
        } catch {
            return "failed: \(error)"
        }
    }

    private func probeReloadHistory() async -> String {
        do {
            let count = try await container.reloadHistory()
            return "Reloaded \(count) messages"
        } catch GatewayTransportError.notConnected {
            return "failed: not connected"
        } catch let GatewayTransportError.decodeError(message) {
            return "failed: \(message)"
        } catch {
            return "failed: \(error)"
        }
    }

    private func probeLiveBroker() async -> String {
        let url = container.gatewayURL.appendingPathComponent("api/live/openai/client-secret")
        let started = Date()
        do {
            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            CloudflareAccessStore.applyHeaders(to: &request, gatewayURL: container.gatewayURL)
            // #526: the broker now requires the device token when the gateway has
            // DeviceAuth configured; attach it so this probe doesn't 401.
            if let token = try? KeychainStore.load(for: container.gatewayURL), !token.isEmpty {
                request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            }
            request.httpBody = try JSONSerialization.data(withJSONObject: [
                "model": LiveProviderKind.openAIRealtime.defaultModel,
                "expires_after_seconds": 60,
            ])

            let (data, response) = try await URLSession.shared.data(for: request)
            let ms = Int(Date().timeIntervalSince(started) * 1000)
            let code = (response as? HTTPURLResponse)?.statusCode ?? -1
            let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            let ok = object?["ok"] as? Bool ?? false
            let model = object?["model"] as? String ?? "unknown"
            let hasSecret = object?["client_secret"] != nil
            let error = object?["error"] as? String

            if ok {
                return "HTTP \(code) in \(ms)ms\nmodel=\(model)\nclient_secret=\(hasSecret ? "present" : "missing")"
            }
            return "HTTP \(code) in \(ms)ms\nerror: \(error ?? "broker failed")"
        } catch {
            return "failed: \(error.localizedDescription)"
        }
    }

    private func probeVisionFrameUpload() async -> String {
        let transport = URLSessionGatewayTransport()
        defer { Task { await transport.disconnect() } }
        do {
            let token: String
            if let cached = try? KeychainStore.load(for: container.gatewayURL), !cached.isEmpty {
                token = cached
            } else {
                token = try await container.deviceAuth.fetchToken()
            }

            var comps = URLComponents(url: container.gatewayURL, resolvingAgainstBaseURL: false)!
            if comps.scheme == "http" { comps.scheme = "ws" }
            if comps.scheme == "https" { comps.scheme = "wss" }

            let params = ConnectParams(
                version: "1",
                platform: "jpg-probe",
                token: token,
                sessionKey: container.sessionStore.activeSessionKey,
                role: "client"
            )
            _ = try await transport.connect(url: comps.url!, connectParams: params)

            let jpeg = try makeProbeJPEG()
            let captureId = "probe-\(Int(Date().timeIntervalSince1970))"
            let request = RequestFrame(
                id: UUID().uuidString,
                method: "vision.frame.upload",
                params: [
                    "capture_id": .string(captureId),
                    "seq": .number(0),
                    "bytes": .string(jpeg.base64EncodedString()),
                    "mime": .string("image/jpeg"),
                    "captured_at_ns": .number(0),
                ]
            )
            let response = try await transport.send(request)
            guard response.ok else {
                return "error: \(response.error?.message ?? "vision.frame.upload failed")"
            }
            if case .some(.object(let obj)) = response.payload,
               case .some(.string(let frameId)) = obj["frame_id"],
               case .some(.number(let bytes)) = obj["bytes"] {
                return "uploaded \(frameId) (\(Int(bytes)) bytes)"
            }
            return "uploaded (payload shape unknown)"
        } catch {
            return "failed: \(error)"
        }
    }

    private func probeVisionFrameRoundTrip() async -> String {
        let transport = URLSessionGatewayTransport()
        defer { Task { await transport.disconnect() } }
        do {
            let token: String
            if let cached = try? KeychainStore.load(for: container.gatewayURL), !cached.isEmpty {
                token = cached
            } else {
                token = try await container.deviceAuth.fetchToken()
            }

            var comps = URLComponents(url: container.gatewayURL, resolvingAgainstBaseURL: false)!
            if comps.scheme == "http" { comps.scheme = "ws" }
            if comps.scheme == "https" { comps.scheme = "wss" }

            let params = ConnectParams(
                version: "1",
                platform: "jpg-rtt-probe",
                token: token,
                sessionKey: container.sessionStore.activeSessionKey,
                role: "client"
            )
            _ = try await transport.connect(url: comps.url!, connectParams: params)

            let jpeg = try makeProbeJPEG()
            let encoded = jpeg.base64EncodedString()
            let captureId = "latency-\(Int(Date().timeIntervalSince1970))"
            let iterations = 5
            var echoRTT: [Double] = []
            var uploadRTT: [Double] = []
            var serverEchoMs: [Double] = []

            for seq in 0..<iterations {
                let result = try await sendVisionProbe(
                    transport: transport,
                    method: "vision.frame.echo",
                    captureId: captureId,
                    seq: seq,
                    encodedJPEG: encoded
                )
                echoRTT.append(result.rttMs)
                if let processing = result.serverProcessingMs {
                    serverEchoMs.append(processing)
                }
            }

            for seq in 0..<iterations {
                let result = try await sendVisionProbe(
                    transport: transport,
                    method: "vision.frame.upload",
                    captureId: captureId,
                    seq: seq,
                    encodedJPEG: encoded
                )
                uploadRTT.append(result.rttMs)
            }

            let diskDelta = average(uploadRTT) - average(echoRTT)
            return """
            jpg \(jpeg.count) bytes, \(iterations)x
            echo RTT: \(summarize(echoRTT))
            upload RTT: \(summarize(uploadRTT))
            upload - echo avg: \(formatMs(diskDelta))
            server echo processing: \(serverEchoMs.isEmpty ? "n/a" : summarize(serverEchoMs))
            """
        } catch {
            return "failed: \(error)"
        }
    }

    private func sendVisionProbe(
        transport: GatewayTransport,
        method: String,
        captureId: String,
        seq: Int,
        encodedJPEG: String
    ) async throws -> VisionProbeTiming {
        let request = RequestFrame(
            id: UUID().uuidString,
            method: method,
            params: [
                "capture_id": .string(captureId),
                "seq": .number(Double(seq)),
                "bytes": .string(encodedJPEG),
                "mime": .string("image/jpeg"),
                "captured_at_ns": .number(Date().timeIntervalSince1970 * 1_000_000_000),
            ]
        )
        let started = Date()
        let response = try await transport.send(request)
        let rttMs = Date().timeIntervalSince(started) * 1000
        guard response.ok else {
            throw GatewayTransportError.decodeError(message: response.error?.message ?? "\(method) failed")
        }

        var serverProcessingMs: Double?
        if case .some(.object(let obj)) = response.payload,
           case .some(.number(let receivedAtMs)) = obj["received_at_ms"],
           case .some(.number(let processedAtMs)) = obj["processed_at_ms"] {
            serverProcessingMs = processedAtMs - receivedAtMs
        }

        return VisionProbeTiming(rttMs: rttMs, serverProcessingMs: serverProcessingMs)
    }

    private func makeProbeJPEG() throws -> Data {
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 320, height: 180))
        let image = renderer.image { ctx in
            UIColor.systemIndigo.setFill()
            ctx.fill(CGRect(x: 0, y: 0, width: 320, height: 180))

            UIColor.systemTeal.setFill()
            ctx.cgContext.fillEllipse(in: CGRect(x: 218, y: 34, width: 68, height: 68))

            UIColor.white.setFill()
            let title = "Hawky JPG probe"
            title.draw(
                at: CGPoint(x: 24, y: 34),
                withAttributes: [
                    .font: UIFont.boldSystemFont(ofSize: 24),
                    .foregroundColor: UIColor.white,
                ]
            )

            let stamp = ISO8601DateFormatter().string(from: Date())
            stamp.draw(
                at: CGPoint(x: 24, y: 78),
                withAttributes: [
                    .font: UIFont.monospacedSystemFont(ofSize: 14, weight: .medium),
                    .foregroundColor: UIColor.white.withAlphaComponent(0.9),
                ]
            )

            UIColor.white.withAlphaComponent(0.85).setStroke()
            let path = UIBezierPath(roundedRect: CGRect(x: 18, y: 24, width: 284, height: 132), cornerRadius: 18)
            path.lineWidth = 3
            path.stroke()
        }
        guard let jpeg = image.jpegData(compressionQuality: 0.82) else {
            throw GatewayTransportError.decodeError(message: "failed to render probe JPEG")
        }
        return jpeg
    }

    private func probeDebugFrames() async -> String {
        let entries = DebugFrameLog.shared.recent(limit: 20)
        if entries.isEmpty { return "buffer empty — no unparseable frames captured" }
        let fmt = DateFormatter(); fmt.dateFormat = "HH:mm:ss.SSS"
        let rendered = entries.map { e -> String in
            let rawPreview = e.raw.count > 120 ? String(e.raw.prefix(120)) + "…" : e.raw
            return "[\(fmt.string(from: e.timestamp))] \(e.reason) — \(rawPreview)"
        }.joined(separator: "\n")
        return "\(entries.count) entries (of \(DebugFrameLog.shared.count)):\n\(rendered)"
    }

    private struct VisionProbeTiming {
        let rttMs: Double
        let serverProcessingMs: Double?
    }

    private func summarize(_ samples: [Double]) -> String {
        guard !samples.isEmpty else { return "n/a" }
        let sorted = samples.sorted()
        let minValue = sorted.first ?? 0
        let maxValue = sorted.last ?? 0
        let avgValue = average(samples)
        return "min \(formatMs(minValue)), avg \(formatMs(avgValue)), max \(formatMs(maxValue))"
    }

    private func average(_ samples: [Double]) -> Double {
        guard !samples.isEmpty else { return 0 }
        return samples.reduce(0, +) / Double(samples.count)
    }

    private func formatMs(_ value: Double) -> String {
        String(format: "%.1fms", value)
    }

    // MARK: - Node capability probes

    @ViewBuilder
    private func capabilityRow(_ cmd: any NodeCommand) -> some View {
        let name = type(of: cmd).name
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(name).font(.body).monospaced()
                Spacer()
                Button("Invoke") { invokeCapability(cmd) }
                    .secondaryPanelAction()
                    .disabled(capBusy.contains(name))
                    .accessibilityIdentifier("cap.invoke.\(name)")
            }
            if let out = capResults[name] {
                Text(out)
                    .font(DesignTokens.Font.mono)
                    .textSelection(.enabled)
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .paperSurface(in: RoundedRectangle(cornerRadius: 12, style: .continuous), inset: true)
            }
        }
        .padding(.vertical, 2)
    }

    private func invokeCapability(_ cmd: any NodeCommand) {
        let name = type(of: cmd).name
        capBusy.insert(name)
        Task {
            let text = await runOne(cmd)
            await MainActor.run {
                capResults[name] = text
                capBusy.remove(name)
                log.append(LogEntry(time: Date(), text: "[cap:\(name)] \(text.prefix(80))"))
            }
        }
    }

    private func invokeAllCapabilities() {
        for cmd in capabilities { capBusy.insert(type(of: cmd).name) }
        Task {
            for cmd in capabilities {
                let name = type(of: cmd).name
                let text = await runOne(cmd)
                await MainActor.run {
                    capResults[name] = text
                    capBusy.remove(name)
                    log.append(LogEntry(time: Date(), text: "[cap:\(name)] \(text.prefix(80))"))
                }
            }
        }
    }

    private func runOne(_ cmd: any NodeCommand) async -> String {
        let args: JSONValue
        if type(of: cmd).name == NotificationShowCommand.name {
            let fmt = DateFormatter(); fmt.dateFormat = "HH:mm:ss"
            args = .object([
                "title": .string("Test"),
                "body": .string("Probe fired at \(fmt.string(from: Date()))"),
            ])
        } else if type(of: cmd).name == FrontendMessageCommand.name {
            let fmt = DateFormatter(); fmt.dateFormat = "HH:mm:ss"
            args = .object([
                "kind": .string("message"),
                "title": .string("Backend probe"),
                "body": .string("Frontend message probe at \(fmt.string(from: Date()))"),
                "action_id": .string("test-probe"),
            ])
        } else if type(of: cmd).name == FrontendOpenTabCommand.name {
            args = .object([
                "tab": .string("test"),
                "source": .string("test-probe"),
            ])
        } else {
            args = .null
        }
        do {
            let result = try await cmd.invoke(args: args)
            return prettyJSON(result)
        } catch {
            return "error: \(error)"
        }
    }

    private func prettyJSON(_ value: JSONValue) -> String {
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        if let data = try? enc.encode(value), let s = String(data: data, encoding: .utf8) {
            return s
        }
        return "\(value)"
    }

    private var timeFmt: DateFormatter {
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss"
        return f
    }
}
