import CoreImage
import Foundation
import OSLog
import SwiftUI
import UIKit

#if canImport(MWDATCamera) && canImport(MWDATCore)
import MWDATCamera
import MWDATCore
#endif

private final class StopCompletionFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var completed = false

    func markComplete() {
        lock.lock()
        completed = true
        lock.unlock()
    }

    var isComplete: Bool {
        lock.lock()
        defer { lock.unlock() }
        return completed
    }
}

@MainActor
final class GlassesVideoStream: ObservableObject {
    @Published private(set) var registrationState: String = "Unknown"
    @Published private(set) var deviceName: String = "No device"
    @Published private(set) var deviceDiagnostics: String = "No DAT device"
    @Published private(set) var cameraPermissionState: String = "Unknown"
    @Published private(set) var sessionDiagnostics: String = "Session idle"
    @Published private(set) var streamState: String = "Stopped"
    @Published private(set) var streamConfigDescription: String = "No stream config"
    @Published private(set) var captureDiagnostics: String = GlassesCapturePolicy.defaultPolicy.configuration().diagnosticsDescription
    @Published private(set) var isStreaming: Bool = false
    @Published private(set) var isStarting: Bool = false
    @Published private(set) var isStopping: Bool = false
    @Published private(set) var hasConnectedDevice: Bool = false
    @Published private(set) var latestFrame: UIImage?
    @Published private(set) var frameCount: Int = 0
    @Published private(set) var keyframeCount: Int = 0
    @Published private(set) var skippedFrameCount: Int = 0
    @Published private(set) var diagnosticLog: [String] = []
    @Published var errorMessage: String?

    var onKeyframe: ((Data, UInt64) -> Void)?
    var onUnexpectedStop: ((String) -> Void)?

    private let logger = Logger(subsystem: "live.hawky", category: "MetaVideo")
    private let stopTimeoutNs: UInt64 = 3_000_000_000
    private var currentConfiguration = GlassesCapturePolicy.defaultPolicy.configuration()
    private var lastJpegNs: UInt64 = 0
    private var lastPreviewNs: UInt64 = 0
    private var lifecycleGeneration: UInt64 = 0

    #if canImport(MWDATCamera) && canImport(MWDATCore)
    private let wearables: any WearablesInterface
    private let deviceSelector: AutoDeviceSelector
    private var streamSession: StreamSession?
    private var listenerTokens: [any AnyListenerToken] = []
    private var registrationTask: Task<Void, Never>?
    private var devicesTask: Task<Void, Never>?
    private var activeDeviceTask: Task<Void, Never>?
    private var deviceListenerTokens: [DeviceIdentifier: [any AnyListenerToken]] = [:]

    init(wearables: any WearablesInterface = Wearables.shared) {
        self.wearables = wearables
        self.deviceSelector = AutoDeviceSelector(wearables: wearables)
        registrationState = wearables.registrationState.description
        monitorDeviceDiagnostics(wearables.devices)
        updateDeviceName(from: wearables.devices)
        log("Initialized. registration=\(registrationState), devices=\(wearables.devices.map(Self.shortDeviceId).joined(separator: ","))")
        registrationTask = Task { [weak self] in
            guard let self else { return }
            for await state in wearables.registrationStateStream() {
                self.registrationState = state.description
                self.log("Registration state changed: \(self.registrationState)")
            }
        }
        devicesTask = Task { [weak self] in
            guard let self else { return }
            for await devices in wearables.devicesStream() {
                self.log("Devices changed: \(devices.map(Self.shortDeviceId).joined(separator: ","))")
                self.monitorDeviceDiagnostics(devices)
                self.updateDeviceName(from: devices)
            }
        }
        activeDeviceTask = Task { [weak self] in
            guard let self else { return }
            for await deviceId in deviceSelector.activeDeviceStream() {
                self.log("Active device changed: \(deviceId.map(Self.shortDeviceId) ?? "none")")
                self.updateActiveDevice(deviceId)
            }
        }
    }

    deinit {
        registrationTask?.cancel()
        devicesTask?.cancel()
        activeDeviceTask?.cancel()
        for tokens in deviceListenerTokens.values {
            for token in tokens {
                Task { await token.cancel() }
            }
        }
    }

    func registerGlasses() {
        log("Starting Meta registration")
        Task {
            do {
                try await wearables.startRegistration()
                log("Meta registration request completed")
            } catch let error as RegistrationError {
                errorMessage = error.description
                log("Meta registration failed: \(error.description)")
            } catch {
                errorMessage = error.localizedDescription
                log("Meta registration failed: \(error.localizedDescription)")
            }
        }
    }

    func unregisterGlasses() {
        log("Starting Meta unregistration")
        Task {
            do {
                try await wearables.startUnregistration()
                log("Meta unregistration request completed")
            } catch let error as UnregistrationError {
                errorMessage = error.description
                log("Meta unregistration failed: \(error.description)")
            } catch {
                errorMessage = error.localizedDescription
                log("Meta unregistration failed: \(error.localizedDescription)")
            }
        }
    }

    func start(configuration: GlassesCaptureConfiguration = GlassesCapturePolicy.defaultPolicy.configuration()) async {
        guard !isStarting, !isStopping, !isStreaming, streamSession == nil else {
            log("Start ignored because stream lifecycle is busy: starting=\(isStarting), stopping=\(isStopping), streaming=\(isStreaming)")
            return
        }
        lifecycleGeneration += 1
        let generation = lifecycleGeneration
        isStarting = true
        streamState = "Starting"
        sessionDiagnostics = "Start requested"
        log("Start video requested generation=\(generation) with \(configuration.diagnosticsDescription)")
        currentConfiguration = configuration
        captureDiagnostics = configuration.diagnosticsDescription
        errorMessage = nil
        lastJpegNs = 0
        lastPreviewNs = 0
        frameCount = 0
        keyframeCount = 0
        skippedFrameCount = 0
        refreshDeviceDiagnostics()
        log("Device diagnostics: \(deviceDiagnostics)")
        defer {
            isStarting = false
        }

        do {
            guard registrationState == RegistrationState.registered.description else {
                errorMessage = "Meta app registration is \(registrationState). Register before starting video."
                sessionDiagnostics = "Start blocked: registration=\(registrationState)"
                streamState = "Stopped"
                log(sessionDiagnostics)
                return
            }

            guard validateActiveDeviceForStreaming() else {
                streamState = "Stopped"
                log("Start blocked by device preflight: \(deviceDiagnostics)")
                return
            }

            let permission = Permission.camera
            log("Checking camera permission")
            let status = try await wearables.checkPermissionStatus(permission)
            cameraPermissionState = Self.describe(status)
            log("Camera permission status: \(cameraPermissionState)")
            if status != .granted {
                log("Requesting camera permission")
                let requested = try await wearables.requestPermission(permission)
                cameraPermissionState = Self.describe(requested)
                log("Camera permission request result: \(cameraPermissionState)")
                guard requested == .granted else {
                    errorMessage = "Meta camera permission denied."
                    streamState = "Stopped"
                    log("Start aborted: camera permission denied")
                    return
                }
            }

            guard lifecycleGeneration == generation, !Task.isCancelled, !isStopping else {
                streamState = "Stopped"
                log("Start cancelled during preflight generation=\(generation)")
                return
            }

            let selected = makeVideoStream(configuration: configuration)
            streamSession = selected.stream
            streamConfigDescription = selected.description
            log("Selected stream config: \(selected.description)")
            await cancelStreamListeners()
            attachListeners(to: selected.stream)
            sessionDiagnostics = "Direct StreamSession ready; state: \(selected.stream.state)"
            log(sessionDiagnostics)
            log("Starting direct video stream session")
            await selected.stream.start()
            guard lifecycleGeneration == generation, !Task.isCancelled, !isStopping, streamSession === selected.stream else {
                log("Stream start cancelled before activation generation=\(generation)")
                if streamSession === selected.stream {
                    streamSession = nil
                }
                _ = await stopStreamSession(selected.stream, reason: "cancelled-start")
                streamState = "Stopped"
                return
            }
            isStreaming = true
            streamState = "Streaming"
            sessionDiagnostics = "Direct StreamSession streaming"
            log("Stream start requested generation=\(generation)")
        } catch {
            let message = Self.formatPermissionError(error, diagnostics: deviceDiagnostics)
            errorMessage = message
            sessionDiagnostics = "Permission check failed: \(Self.permissionErrorCase(error))"
            log(sessionDiagnostics)
            streamState = "Stopped"
        }
    }

    private func validateActiveDeviceForStreaming() -> Bool {
        guard let deviceId = deviceSelector.activeDevice ?? wearables.devices.first else {
            errorMessage = "No DAT device is available. Open the glasses hinges, make sure Bluetooth is connected, and wait for the device to appear."
            sessionDiagnostics = "Start blocked: no active DAT device"
            hasConnectedDevice = false
            return false
        }

        guard let device = wearables.deviceForIdentifier(deviceId) else {
            errorMessage = "DAT reported device \(Self.shortDeviceId(deviceId)), but the SDK could not resolve it. Reopen Meta AI or re-register the glasses."
            sessionDiagnostics = "Start blocked: unresolved device \(Self.shortDeviceId(deviceId))"
            hasConnectedDevice = false
            return false
        }

        refreshDeviceDiagnostics()

        guard device.compatibility() == .compatible else {
            errorMessage = "Glasses are not compatible with this SDK build: \(device.compatibility().displayString). \(deviceDiagnostics)"
            sessionDiagnostics = "Start blocked: compatibility=\(device.compatibility().displayString)"
            hasConnectedDevice = device.linkState == .connected
            return false
        }

        guard device.linkState == .connected else {
            errorMessage = "Glasses are registered, but not connected for DAT streaming yet. Current link: \(Self.describe(device.linkState)). Open the hinges, wear the glasses, keep Meta AI nearby, and try again after the device shows connected."
            sessionDiagnostics = "Start blocked: link=\(Self.describe(device.linkState)), device=\(Self.shortDeviceId(device.identifier))"
            hasConnectedDevice = false
            return false
        }

        hasConnectedDevice = true
        return true
    }

    private func monitorDeviceDiagnostics(_ devices: [DeviceIdentifier]) {
        let live = Set(devices)
        for (deviceId, tokens) in deviceListenerTokens where !live.contains(deviceId) {
            for token in tokens {
                Task { await token.cancel() }
            }
            deviceListenerTokens[deviceId] = nil
        }

        for deviceId in devices where deviceListenerTokens[deviceId] == nil {
            guard let device = wearables.deviceForIdentifier(deviceId) else { continue }
            let linkToken = device.addLinkStateListener { [weak self] state in
                Task { @MainActor [weak self] in
                    self?.log("Device \(Self.shortDeviceId(deviceId)) link changed: \(Self.describe(state))")
                    self?.refreshDeviceDiagnostics()
                }
            }
            let compatibilityToken = device.addCompatibilityListener { [weak self] compatibility in
                Task { @MainActor [weak self] in
                    self?.log("Device \(Self.shortDeviceId(deviceId)) compatibility changed: \(compatibility.displayString)")
                    self?.refreshDeviceDiagnostics()
                }
            }
            deviceListenerTokens[deviceId] = [linkToken, compatibilityToken]
        }
    }

    private static func formatPermissionError(_ error: PermissionError, diagnostics: String) -> String {
        let detail: String
        switch error {
        case .noDevice:
            detail = "Meta AI has no registered glasses available for camera permission."
        case .noDeviceWithConnection:
            detail = "Meta AI sees glasses, but none are connected for permission negotiation."
        case .connectionError:
            detail = "Meta AI could not reach the glasses while checking camera permission."
        case .metaAINotInstalled:
            detail = "The Meta AI companion app is not installed or cannot be opened."
        case .requestInProgress:
            detail = "A Meta permission request is already in progress."
        case .requestTimeout:
            detail = "The Meta camera permission request timed out."
        case .internalError:
            detail = "The Meta SDK returned an internal permission error."
        @unknown default:
            detail = "The Meta SDK returned an unknown permission error."
        }
        return "\(detail) (\(error.description)) Diagnostics: \(diagnostics)"
    }

    private static func formatStreamError(_ error: StreamSessionError, diagnostics: String) -> String {
        "\(format(error)) Diagnostics: \(diagnostics)"
    }

    private static func streamErrorCase(_ error: StreamSessionError) -> String {
        switch error {
        case .internalError:
            return "internalError"
        case .deviceNotFound(let id):
            return "deviceNotFound(\(shortDeviceId(id)))"
        case .deviceNotConnected(let id):
            return "deviceNotConnected(\(shortDeviceId(id)))"
        case .timeout:
            return "timeout"
        case .videoStreamingError:
            return "videoStreamingError"
        case .audioStreamingError:
            return "audioStreamingError"
        case .permissionDenied:
            return "permissionDenied"
        case .hingesClosed:
            return "hingesClosed"
        @unknown default:
            return "unknown"
        }
    }

    private static func permissionErrorCase(_ error: PermissionError) -> String {
        switch error {
        case .noDevice:
            return "noDevice"
        case .noDeviceWithConnection:
            return "noDeviceWithConnection"
        case .connectionError:
            return "connectionError"
        case .metaAINotInstalled:
            return "metaAINotInstalled"
        case .requestInProgress:
            return "requestInProgress"
        case .requestTimeout:
            return "requestTimeout"
        case .internalError:
            return "internalError"
        @unknown default:
            return "unknown"
        }
    }

    private static func describe(_ state: RegistrationState) -> String {
        state.description
    }

    private static func describe(_ status: PermissionStatus) -> String {
        switch status {
        case .granted:
            return "granted"
        case .denied:
            return "denied"
        @unknown default:
            return "unknown"
        }
    }

    private static func describe(_ state: LinkState) -> String {
        switch state {
        case .disconnected:
            return "disconnected"
        case .connecting:
            return "connecting"
        case .connected:
            return "connected"
        }
    }

    func stop() async {
        if isStopping {
            log("Stop ignored because stream is already stopping")
            return
        }
        guard isStarting || isStreaming || streamSession != nil else {
            log("Stop ignored because stream is not active")
            return
        }
        lifecycleGeneration += 1
        let generation = lifecycleGeneration
        log("Stop video requested generation=\(generation)")
        isStopping = true
        isStarting = false
        onKeyframe = nil
        onUnexpectedStop = nil
        let session = streamSession
        isStreaming = false
        streamSession = nil
        latestFrame = nil
        streamState = "Stopping"
        sessionDiagnostics = "DAT stop requested; callbacks released"
        await cancelStreamListeners()

        if let session {
            let completed = await stopStreamSession(session, reason: "user-stop")
            if completed {
                sessionDiagnostics = "Direct StreamSession idle"
            } else {
                let timeout = Double(stopTimeoutNs) / 1_000_000_000
                sessionDiagnostics = "DAT stop timed out after \(String(format: "%.0f", timeout))s; local callbacks released"
                errorMessage = sessionDiagnostics
            }
        } else {
            sessionDiagnostics = "Direct StreamSession idle"
        }

        streamState = "Stopped"
        streamConfigDescription = "No stream config"
        captureDiagnostics = "No active capture policy"
        isStopping = false
        log("Video stream stopped generation=\(generation), diagnostics=\(sessionDiagnostics)")
    }

    private func stopStreamSession(_ session: StreamSession, reason: String) async -> Bool {
        log("DAT stop started reason=\(reason)")
        let completion = StopCompletionFlag()
        let task = Task {
            await session.stop()
            completion.markComplete()
        }

        let pollNs: UInt64 = 50_000_000
        var waitedNs: UInt64 = 0
        while waitedNs < stopTimeoutNs {
            if completion.isComplete {
                _ = await task.result
                log("DAT stop completed reason=\(reason)")
                return true
            }
            try? await Task.sleep(nanoseconds: pollNs)
            waitedNs += pollNs
        }

        task.cancel()
        log("DAT stop timed out reason=\(reason), timeoutNs=\(stopTimeoutNs)")
        return false
    }

    private func makeVideoStream(configuration: GlassesCaptureConfiguration) -> (stream: StreamSession, description: String) {
        let config = StreamSessionConfig(
            videoCodec: .raw,
            resolution: Self.datResolution(for: configuration.resolution),
            frameRate: UInt(configuration.sourceFrameRate)
        )
        let stream = StreamSession(
            streamSessionConfig: config,
            deviceSelector: deviceSelector
        )
        return (stream, "Raw \(configuration.diagnosticsDescription) (DAT SDK 0.4 path)")
    }

    private static func datResolution(for resolution: GlassesCaptureResolution) -> StreamingResolution {
        switch resolution {
        case .low:
            return .low
        case .medium:
            return .medium
        case .high:
            return .high
        }
    }

    private func attachListeners(to stream: StreamSession) {
        listenerTokens = [
            stream.statePublisher.listen { [weak self] state in
                Task { @MainActor [weak self] in
                    self?.updateStreamState(state)
                }
            },
            stream.videoFramePublisher.listen { [weak self] frame in
                Task { @MainActor [weak self] in
                    self?.handleFrame(frame)
                }
            },
            stream.errorPublisher.listen { [weak self] error in
                Task { @MainActor [weak self] in
                    self?.refreshDeviceDiagnostics()
                    let diagnostics = self?.deviceDiagnostics ?? "No diagnostics"
                    let message = Self.formatStreamError(error, diagnostics: diagnostics)
                    self?.errorMessage = message
                    self?.sessionDiagnostics = "Stream error: \(Self.streamErrorCase(error))"
                    self?.log("Stream error publisher: \(Self.streamErrorCase(error)) \(message)")
                    self?.scheduleUnexpectedStop(reason: "stream-error-\(Self.streamErrorCase(error))")
                }
            },
        ]
        updateStreamState(stream.state)
    }

    private func cancelStreamListeners() async {
        let tokens = listenerTokens
        listenerTokens.removeAll()
        for token in tokens {
            await token.cancel()
        }
    }

    private func updateDeviceName(from devices: [DeviceIdentifier]) {
        guard let first = devices.first else {
            deviceName = "No device"
            deviceDiagnostics = "No DAT device"
            hasConnectedDevice = false
            log("No DAT devices available")
            return
        }
        updateActiveDevice(first)
    }

    private func updateActiveDevice(_ deviceId: DeviceIdentifier?) {
        guard let deviceId else {
            deviceName = "No active device"
            deviceDiagnostics = "No active device"
            hasConnectedDevice = false
            return
        }
        if let device = wearables.deviceForIdentifier(deviceId) {
            deviceName = device.nameOrId()
        } else {
            deviceName = deviceId
        }
        refreshDeviceDiagnostics()
    }

    private func refreshDeviceDiagnostics() {
        guard let deviceId = deviceSelector.activeDevice ?? wearables.devices.first else {
            deviceDiagnostics = "No DAT device"
            hasConnectedDevice = false
            return
        }
        guard let device = wearables.deviceForIdentifier(deviceId) else {
            deviceDiagnostics = "Device \(Self.shortDeviceId(deviceId)) not resolved"
            hasConnectedDevice = false
            return
        }
        hasConnectedDevice = device.linkState == .connected
        deviceDiagnostics = [
            "id: \(Self.shortDeviceId(device.identifier))",
            "type: \(device.deviceType().rawValue)",
            "link: \(Self.describe(device.linkState))",
            "compat: \(device.compatibility().displayString)",
        ].joined(separator: ", ")
        log("Refreshed device diagnostics: \(deviceDiagnostics)")
    }

    private func updateStreamState(_ state: StreamSessionState) {
        let previousState = streamState
        switch state {
        case .stopped:
            streamState = "Stopped"
            let wasUnexpected = streamSession != nil && !isStopping && !isStarting
            isStreaming = false
            isStopping = false
            if wasUnexpected {
                scheduleUnexpectedStop(reason: "stream-state-stopped")
            }
        case .waitingForDevice:
            streamState = "Waiting for device"
        case .starting:
            streamState = "Starting"
            isStarting = true
        case .streaming:
            streamState = "Streaming"
            isStreaming = true
            isStarting = false
            isStopping = false
        case .paused:
            streamState = "Paused"
        case .stopping:
            streamState = "Stopping"
            isStopping = true
        }
        if previousState != streamState {
            log("Stream state changed: \(streamState)")
        }
    }

    private func scheduleUnexpectedStop(reason: String) {
        guard streamSession != nil, !isStopping else { return }
        Task { @MainActor [weak self] in
            await self?.handleUnexpectedStop(reason: reason)
        }
    }

    private func handleUnexpectedStop(reason: String) async {
        guard streamSession != nil, !isStopping else { return }
        log("Unexpected DAT stream stop detected: \(reason)")
        lifecycleGeneration += 1
        let session = streamSession
        streamSession = nil
        isStreaming = false
        isStarting = false
        latestFrame = nil
        onKeyframe = nil
        streamState = "Stopped"
        streamConfigDescription = "No stream config"
        captureDiagnostics = "No active capture policy"
        sessionDiagnostics = "DAT stream stopped unexpectedly: \(reason)"
        errorMessage = sessionDiagnostics
        await cancelStreamListeners()
        if let session {
            _ = await stopStreamSession(session, reason: "unexpected-\(reason)")
        }
        onUnexpectedStop?(sessionDiagnostics)
    }

    private func handleFrame(_ frame: VideoFrame) {
        frameCount += 1
        let nowNs = UInt64(DispatchTime.now().uptimeNanoseconds)
        let shouldUpdatePreview = lastPreviewNs == 0 || nowNs - lastPreviewNs >= currentConfiguration.previewIntervalNanoseconds
        let shouldEmitKeyframe = lastJpegNs == 0 || nowNs - lastJpegNs >= currentConfiguration.uploadIntervalNanoseconds

        guard shouldUpdatePreview || shouldEmitKeyframe else {
            skippedFrameCount += 1
            return
        }

        guard let image = frame.makeUIImage() else { return }
        if shouldUpdatePreview {
            latestFrame = image
            lastPreviewNs = nowNs
        }
        if frameCount == 1 || frameCount % 30 == 0 {
            log("Received frame \(frameCount); skipped \(skippedFrameCount); keyframes \(keyframeCount)")
        }
        if shouldEmitKeyframe {
            emitKeyframe(image, capturedAtNs: nowNs)
        }
    }

    private func emitKeyframe(_ image: UIImage, capturedAtNs: UInt64) {
        lastJpegNs = capturedAtNs
        guard let jpeg = Self.makeJPEG(from: image) else { return }
        keyframeCount += 1
        onKeyframe?(jpeg, capturedAtNs)
        if frameCount == 1 || frameCount % 30 == 0 {
            log("Emitted keyframe \(keyframeCount) at source frame \(frameCount), bytes=\(jpeg.count), upload=\(currentConfiguration.uploadCadenceDescription)")
        }
    }

    private static func makeJPEG(from image: UIImage) -> Data? {
        let maxWidth: CGFloat = 640
        let width = max(image.size.width, 1)
        let scale = min(1, maxWidth / width)
        let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
        let renderer = UIGraphicsImageRenderer(size: size)
        let resized = renderer.image { _ in
            image.draw(in: CGRect(origin: .zero, size: size))
        }
        return resized.jpegData(compressionQuality: 0.65)
    }

    private static func format(_ error: StreamSessionError) -> String {
        switch error {
        case .internalError:
            return "Meta stream internal error. Try stopping and starting the stream again."
        case .deviceNotFound(let id):
            return "Meta device not found: \(Self.shortDeviceId(id)). Registration may be complete, but the SDK cannot resolve that glasses device."
        case .deviceNotConnected(let id):
            return "Meta device not connected: \(Self.shortDeviceId(id)). Open the hinges, wear the glasses, and wait for link=connected."
        case .timeout:
            return "Meta stream timed out. Keep Meta AI open nearby and retry after the device shows connected."
        case .videoStreamingError:
            return "Meta video streaming failed after session start. This is not the preflight permission check; inspect device/link diagnostics."
        case .audioStreamingError:
            return "Meta audio streaming failed."
        case .permissionDenied:
            return "Meta camera permission denied by the stream session. Re-request camera permission in Meta AI."
        case .hingesClosed:
            return "Glasses hinges are closed. Open the glasses and wait for link=connected before starting video."
        @unknown default:
            return "Unknown Meta stream error."
        }
    }

    private static func shortDeviceId(_ id: DeviceIdentifier) -> String {
        String(id.prefix(8))
    }

    private func log(_ message: String) {
        let timestamp = String(format: "%.3f", Date().timeIntervalSince1970)
        let line = "\(timestamp) \(message)"
        diagnosticLog.append(line)
        if diagnosticLog.count > 80 {
            diagnosticLog.removeFirst(diagnosticLog.count - 80)
        }
        logger.info("\(line, privacy: .public)")
    }
    #else
    init() {
        errorMessage = "Meta Wearables DAT SDK is not linked."
        hasConnectedDevice = false
    }

    func registerGlasses() {}
    func unregisterGlasses() {}
    func start(configuration: GlassesCaptureConfiguration = GlassesCapturePolicy.defaultPolicy.configuration()) async {}
    func stop() async {}
    #endif
}
