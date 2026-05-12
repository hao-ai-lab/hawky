import Foundation
import PipecatClientIOS
import OSLog
import WebRTC

/// An RTVI transport to connect with the OpenAI Realtime  backend.
public class OpenAIRealtimeTransport: Transport {
    
    private let BASE_URL = "https://api.openai.com/v1/realtime/calls";
    private let MODEL = "gpt-4o-realtime-preview";
    
    private var iceServers: [String] = []
    private let options: RTVIClientOptions
    private var _state: TransportState = .disconnected
    private var openAIWebRTCConnection: OpenAIRealtimeWebRTCConnection?  = nil
    private let audioManager = AudioManager()
    private var connectedBotParticipant = Participant(
        id: ParticipantId(id: UUID().uuidString),
        name: "OpenAI Realtime",
        local: false
    )
    private var devicesInitialized: Bool = false
    private var _selectedMic: MediaDeviceInfo?
    
    // MARK: - Public
    
    /// Voice client delegate (used directly by user's code)
    public weak var delegate: PipecatClientIOS.RTVIClientDelegate?
    
    /// RTVI inbound message handler (for sending RTVI-style messages to voice client code to handle)
    public var onMessage: ((PipecatClientIOS.RTVIMessageInbound) -> Void)?
    
    public required convenience init(options: PipecatClientIOS.RTVIClientOptions) {
        self.init(options: options, iceServers: nil)
    }
    
    public init(options: PipecatClientIOS.RTVIClientOptions, iceServers: [String]?) {
        self.options = options
        self.audioManager.delegate = self
        if iceServers != nil {
            self.iceServers = iceServers!
        }
        logUnsupportedOptions()
    }
    
    public func initDevices() async throws {
        if (self.devicesInitialized) {
            // There is nothing to do in this case
            return
        }
        
        self.setState(state: .initializing)
        
        // start managing audio device configuration
        self.audioManager.startManagingIfNecessary()
        
        // initialize devices state and report initial available & selected devices
        self._selectedMic = self.getSelectedMic()
        self.delegate?.onAvailableMicsUpdated(mics: self.getAllMics());
        self.delegate?.onMicUpdated(mic: self._selectedMic)
        
        self.setState(state: .initialized)
        self.devicesInitialized = true
    }
    
    public func release() {
        // stop managing audio device configuration
        self.audioManager.stopManaging()
        self._selectedMic = nil
    }
    
    private func sendOffer(connectUrl: String, sdp: RTCSessionDescription, apiKey: String, model: String) async throws -> RTCSessionDescription {
        guard let url = URL(string: connectUrl) else {
            throw InvalidAuthBundleError()
        }
        
        Logger.shared.debug("connectUrl, \(connectUrl)")
        
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        
        let boundary = "Boundary-\(UUID().uuidString)"
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        // configuring the OpenAI api KEY
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        
        do {
            // Minimal connect handshake (the known-good original). The OpenAI Realtime
            // SDP endpoint rejects a richer session object (turn_detection / instructions
            // / tools) here → PipecatClientIOS.StartBotError. So we send only the required
            // connect fields; the FULL quiet config (create_response:false, persona,
            // tools) is applied immediately after via the data-channel session.update in
            // updateSession(), and Safety Check's hardQuiet cancels any stray greeting.
            let sessionConfig: [String: Any] = [
                "type": "realtime",
                "model": model,
                "audio": [
                    "output": [
                        "voice": "marin"
                    ]
                ]
            ]
            let sessionData = try JSONSerialization.data(withJSONObject: sessionConfig, options: [])
            guard let sessionJSON = String(data: sessionData, encoding: .utf8) else {
                throw HttpError(message: "Failed to encode session config.")
            }

            var body = Data()
            body.appendFormField(name: "sdp", value: sdp.sdp, boundary: boundary)
            body.appendFormField(name: "session", value: sessionJSON, boundary: boundary)
            body.appendString("--\(boundary)--\r\n")
            request.httpBody = body
            
            Logger.shared.debug("Will send offer")
            
            let (data, response) = try await URLSession.shared.data(for: request)
            
            guard let httpResponse = response as? HTTPURLResponse, ( httpResponse.statusCode >= 200 && httpResponse.statusCode <= 299 ) else {
                let errorMessage = String(data: data, encoding: .utf8) ?? "Unknown error"
                let message = "Failed while authenticating: \(errorMessage)"
                throw HttpError(message: message)
            }
            
            guard let sdpString = String(data: data, encoding: .utf8) else {
                let message = "Failed to retrieve SDP answer."
                throw HttpError(message: message)
            }
            
            //let answer = try JSONDecoder().decode(SessionDescription.self, from: data)
            let answer = RTCSessionDescription(type: .answer, sdp: sdpString)
            
            Logger.shared.debug("Received answer")
            
            return answer
        } catch {
            throw HttpError(message: "Failed while trying to receive answer.", underlyingError: error)
        }
    }
    
    public func connect(authBundle: PipecatClientIOS.AuthBundle?) async throws {
        self.setState(state: .connecting)
        
        self.openAIWebRTCConnection = OpenAIRealtimeWebRTCConnection(
            iceServers: self.iceServers,
            audioEnabled: self.options.enableMic
        )
        
        guard let webrtcClient = self.openAIWebRTCConnection else {
            return
        }
        webrtcClient.delegate = self
        
        // start connecting
        do {
            let offer = try await webrtcClient.offer()
            
            guard let apiKey = self.options.params.config.apiKey else {
                Logger.shared.error("Missing API KEY")
                return
            }
            
            let model = self.options.params.config.model ?? self.MODEL
            let connectUrl = self.BASE_URL

            let answer = try await self.sendOffer(connectUrl: connectUrl, sdp: offer, apiKey: apiKey, model: model)
            webrtcClient.set(remoteSdp: answer, completion: { error in
                if let error = error {
                    Logger.shared.error("Failed to set remote SDP: \(error.localizedDescription)")
                }
            })
        } catch {
            Logger.shared.error("Received error while trying to connect \(error)")
            self.openAIWebRTCConnection = nil
            self.setState(state: .error)
            throw error
        }
        
        // go to connected state
        // (unless we've already leaped ahead to the ready state - see connectionDidFinishModelSetup())
        if _state == .connecting {
            self.setState(state: .connected)
        }
    }
    
    public func disconnect() async throws {
        // stop websocket connection
        self.openAIWebRTCConnection?.disconnect()
        self.openAIWebRTCConnection = nil
        
        self.delegate?.onTracksUpdated(tracks: self.tracks()!)
        
        self.setState(state: .disconnected)
    }
    
    public func getAllMics() -> [PipecatClientIOS.MediaDeviceInfo] {
        audioManager.availableDevices.map { $0.toRtvi() }
    }
    
    public func getAllCams() -> [PipecatClientIOS.MediaDeviceInfo] {
        logOperationNotSupported(#function)
        return []
    }
    
    public func updateMic(micId: PipecatClientIOS.MediaDeviceId) async throws {
        audioManager.preferredAudioDevice = .init(deviceID: micId.id)
        
        // Refresh what we should report as the selected mic
        refreshSelectedMicIfNeeded()
    }
    
    public func updateCam(camId: PipecatClientIOS.MediaDeviceId) async throws {
        logOperationNotSupported(#function)
    }
    
    /// What we report as the selected mic.
    public func selectedMic() -> PipecatClientIOS.MediaDeviceInfo? {
        _selectedMic
    }
    
    public func selectedCam() -> PipecatClientIOS.MediaDeviceInfo? {
        logOperationNotSupported(#function)
        return nil
    }
    
    public func enableMic(enable: Bool) async throws {
        if enable {
            self.openAIWebRTCConnection?.unmuteAudio()
        } else {
            self.openAIWebRTCConnection?.muteAudio()
        }
    }
    
    public func enableCam(enable: Bool) async throws {
        logOperationNotSupported(#function)
    }
    
    public func isCamEnabled() -> Bool {
        logOperationNotSupported(#function)
        return false
    }
    
    public func isMicEnabled() -> Bool {
        return self.openAIWebRTCConnection?.isAudioEnabled() ?? true
    }
    
    public func sendMessage(message: PipecatClientIOS.RTVIMessageOutbound) throws {
        switch (message.type) {
        case RTVIMessageOutbound.MessageType.ACTION:
            if let data = message.decodeActionData(), data.service == "llm" && data.action == "append_to_messages" {
                let messagesArgument = data.arguments?.first { $0.name == "messages" }
                if let messages = messagesArgument?.value.toConversationArray() {
                    // Whether to trigger a model response after appending the item(s).
                    // Honor BOTH `create_response` and the caller's `run_immediately`
                    // flag (the iOS provider sends run_immediately:false for camera
                    // frames + background context — those must NOT create a response).
                    // Default to FALSE: appending an item is context, not a turn. The
                    // previous default of `true` made every camera frame fire an explicit
                    // response.create → the model narrated the feed + active-response storm.
                    let createResponse = (data.arguments?
                        .first { $0.name == "create_response" }?
                        .value.asBool)
                        ?? (data.arguments?
                            .first { $0.name == "run_immediately" }?
                            .value.asBool)
                        ?? false
                    try self.sendConversationMessages(conversationMessages: messages, createResponse: createResponse)
                    // Synthesize (i.e. fake) an RTVI-style action response from the server
                    onMessage?(.init(
                        type: RTVIMessageInbound.MessageType.ACTION_RESPONSE,
                        data: String(data: try JSONEncoder().encode(ActionResponse.init(result: .boolean(true))), encoding: .utf8),
                        id: message.id
                    ))
                }
            } else {
                logOperationNotSupported("\(#function) of type 'action' (except for 'append_to_messages')")
                // Tell RTVIClient that sendMessage() has failed so the user's completion handler can run
                onMessage?(.init(
                    type: RTVIMessageInbound.MessageType.ERROR_RESPONSE,
                    data: "", // passing nil causes a crash
                    id: message.id
                ))
            }
        
        case LLMMessageType.Outgoing.LLMFunctionCallResult:
            self.sendFunctionCallResult(data: message.data)
        default:
            logOperationNotSupported("\(#function) of type '\(message.type)'")
            // Tell RTVIClient that sendMessage() has failed so the user's completion handler can run
            onMessage?(.init(
                type: RTVIMessageInbound.MessageType.ERROR_RESPONSE,
                data: "", // passing nil causes a crash
                id: message.id
            ))
        }
    }

    // MARK: - Live session control (hawky: Stay Silent)
    // The RTVI action interface only exposes `append_to_messages`. These public
    // helpers let the app send a raw `session.update` (to toggle silence / change
    // turn_detection / tool_choice mid-session) and a parameterized `response.create`
    // (to force one recap turn on release) over the existing oai-events data channel.

    /// Send a `session.update` with the given `session` object to the live model.
    public func sendSessionUpdate(session: Value) throws {
        try self.openAIWebRTCConnection?.sendMessage(
            message: OpenAIMessages.Outbound.SessionUpdate(session: session)
        )
    }

    /// Send a `response.create`. Pass a `response` body to constrain the turn
    /// (output_modalities / tool_choice / instructions); pass nil for a bare trigger.
    public func sendCreateResponse(response: Value? = nil) throws {
        if let response {
            try self.openAIWebRTCConnection?.sendMessage(
                message: OpenAIMessages.Outbound.CreateResponseWithBody(response: response)
            )
        } else {
            try self.openAIWebRTCConnection?.sendMessage(
                message: OpenAIMessages.Outbound.CreateResponse()
            )
        }
    }

    /// Cancel the response currently in progress (`response.cancel`). Used by Safety
    /// Check hard-quiet to abort an unsanctioned model turn (greeting / narration).
    public func sendCancelResponse() throws {
        try self.openAIWebRTCConnection?.sendMessage(
            message: OpenAIMessages.Outbound.ResponseCancel()
        )
    }

    /// Send a `conversation.item.create` user message WITHOUT triggering a response.
    /// Used to inject the captured silence transcript before the single recap turn.
    public func sendUserContext(text: String) throws {
        let conversation = OpenAIMessages.Outbound.Conversation(
            item: OpenAIMessages.Outbound.MessageContent(text: text, role: "user")
        )
        try self.openAIWebRTCConnection?.sendMessage(message: conversation)
    }
    
    public func state() -> PipecatClientIOS.TransportState {
        self._state
    }
    
    public func setState(state: PipecatClientIOS.TransportState) {
        let previousState = self._state
        
        self._state = state
        
        // Fire delegate methods as needed
        if state != previousState {
            self.delegate?.onTransportStateChanged(state: self._state)
            
            if state == .connected {
                self.delegate?.onConnected()
                // New bot participant id each time we connect
                connectedBotParticipant = Participant(
                    id: ParticipantId(id: UUID().uuidString),
                    name: connectedBotParticipant.name,
                    local: connectedBotParticipant.local
                )
                self.delegate?.onParticipantJoined(participant: connectedBotParticipant)
                self.delegate?.onBotConnected(participant: connectedBotParticipant)
            }
            else if state == .disconnected {
                self.delegate?.onParticipantLeft(participant: connectedBotParticipant)
                self.delegate?.onBotDisconnected(participant: connectedBotParticipant)
                self.delegate?.onDisconnected()
            }
        }
    }
    
    public func isConnected() -> Bool {
        return [.connected, .ready].contains(self._state)
    }
    
    public func tracks() -> PipecatClientIOS.Tracks? {
        return .init(
            local: .init(
                audio: self.openAIWebRTCConnection?.getLocalAudioTrack()?.toRtvi(),
                video: nil
            ),
            bot: .init(
                audio: self.openAIWebRTCConnection?.getRemoteAudioTrack()?.toRtvi(),
                video: nil
            )
        )
    }
    
    public func expiry() -> Int? {
        return nil
    }
    
    public func setIceServers(iceServers: [String]) {
        self.iceServers = iceServers
    }
    
    // MARK: - Private
    
    private func logUnsupportedOptions() {
        if options.enableCam {
            logOperationNotSupported("enableCam option")
        }
        if !options.services.isEmpty {
            logOperationNotSupported("services option")
        }
        if options.params.requestData != nil {
            logOperationNotSupported("params.requestData/customBodyParams option")
        }
        if !options.params.headers.isEmpty {
            logOperationNotSupported("params.headers/customBodyParams option")
        }
        let config = options.params.config
        if options.params.config.contains(where: { $0.service != "llm" }) {
            logOperationNotSupported("config for service other than 'llm'")
        }
        if let llmConfig = config.llmConfig {
            let supportedLlmConfigOptions = ["api_key", "initial_messages", "session_config"]
            if llmConfig.options.contains(where: { !supportedLlmConfigOptions.contains($0.name) }) {
                logOperationNotSupported("'llm' service config option other than \(supportedLlmConfigOptions.joined(separator: ", "))")
            }
        }
    }
    
    private func logOperationNotSupported(_ operationName: String) {
        Logger.shared.warn("\(operationName) not supported")
    }
    
    /// Refresh what we should report as the selected mic.
    private func refreshSelectedMicIfNeeded() {
        let newSelectedMic = getSelectedMic()
        if newSelectedMic != _selectedMic {
            _selectedMic = newSelectedMic
            delegate?.onMicUpdated(mic: _selectedMic)
        }
    }
    
    /// Selected mic is a value derived from the preferredAudioDevice and the set of available devices, so it may change whenever either of those change.
    private func getSelectedMic() -> PipecatClientIOS.MediaDeviceInfo? {
        audioManager.availableDevices.first { $0.deviceID == audioManager.preferredAudioDeviceIfAvailable?.deviceID }?.toRtvi()
    }
}

// MARK: - OpenAIRealtimeConnection.Delegate

extension OpenAIRealtimeTransport: OpenAIRealtimeWebRTCConnectionDelegate {
    
    func onConnectionStateChanged(state: RTCIceConnectionState) {
        if ( state == .failed || state == .closed ) && ( self._state != .disconnected && self._state != .disconnecting ){
            Task {
                try await self.disconnect()
            }
        }
    }
    
    func onMsgReceived(msg: PipecatClientIOS.Value) {
        self.handleOpenAIMessage(msg)
    }
    
    func onTracksUpdated() {
        self.delegate?.onTracksUpdated(tracks: self.tracks()!)
    }
    
    private func updateSession() {
        do {
            let config = self.options.params.config
            let sessionConfig = config.sessionConfig ?? .object([:])
            // GA Realtime no longer accepts the beta top-level
            // `input_audio_transcription` field. WebRTC sessions still emit
            // audio lifecycle and transcript events over the data channel.
            // Enabling noise reduction
            /*if sessionConfig.asObject["input_audio_noise_reduction"] == nil {
             try sessionConfig.addProperty(key: "input_audio_noise_reduction", value: .object(
             ["type": "near_field"] // or "far_field"
             ))
             }*/
            // Enabling turn detection
            /*if sessionConfig.asObject["turn_detection"] == nil {
             try sessionConfig.addProperty(key: "turn_detection", value: .object(
             [
             "type": "semantic_vad",
             "eagerness": "low",
             "create_response": true,
             "interrupt_response": true
             ]
             ))
             }*/
            let sessionUpdate = OpenAIMessages.Outbound.SessionUpdate(session: sessionConfig)
            try self.openAIWebRTCConnection?.sendMessage(message: sessionUpdate)
            try self.sendConversationMessages(conversationMessages: config.initialMessages, createResponse: false)
        } catch {
            // #677: this send applies persona/tools/VAD/transcription + initial_messages
            // over the data channel AFTER the media leg is already "connected". A swallowed
            // failure here left the app showing Connected on a session that was never
            // configured. Forward it to the delegate (prefixed so the app can classify it)
            // instead of only logging, so the connected-but-unconfigured state is visible.
            Logger.shared.error("Error updating session: \(error.localizedDescription)")
            self.delegate?.onError(message: "session_config_failed: \(error.localizedDescription)")
        }
    }
    
    private func sendFunctionCallResult(data: Value?) {
        do {
            guard let functionCallResult = data?.asObject else {
                Logger.shared.error("Failed to parse function call, no result to send")
                return
            }
            
            let toolCallId = functionCallResult["tool_call_id"]!!.asString
            let result = functionCallResult["result"]!!.asString
            
            Logger.shared.info("Sending function call result, toolCallId: \(toolCallId), result: \(result)")
            
            let resultMessage = OpenAIMessages.Outbound.Conversation.init(
                item: OpenAIMessages.Outbound.FunctionCallOutputContent.init(call_id: toolCallId, output: result)
            )
            
            try self.openAIWebRTCConnection?.sendMessage(message: resultMessage)
            try self.run()
        } catch {
            Logger.shared.error("Failed to parse function call: \(error.localizedDescription)")
        }
    }
    
    private func run() throws{
        try self.openAIWebRTCConnection?.sendMessage(message: OpenAIMessages.Outbound.CreateResponse())
    }
    
    private func sendConversationMessages(conversationMessages: [OpenAIMessages.Outbound.Conversation], createResponse: Bool = true) throws {
        if !conversationMessages.isEmpty {
            try conversationMessages.forEach { message in
                try self.openAIWebRTCConnection?.sendMessage(message: message)
            }
            if createResponse {
                try self.run()
            }
        }
    }
    
    private func handleOpenAIMessage(_ msg: Value) {
        if let data = try? String(data: JSONEncoder().encode(msg), encoding: .utf8) {
            self.onMessage?(.init(
                type: RTVIMessageInbound.MessageType.SERVER_MESSAGE,
                data: data,
                id: String(UUID().uuidString.prefix(8))
            ))
        }

        guard case .object(let dict) = msg, let typeValue = dict["type"], case .string(let type) = typeValue else {
            Logger.shared.warn("Received message without a valid type: \(msg)")
            return
        }
        
        switch type {
        case "error":
            Logger.shared.error("OpenAI error: \(msg)")
            self.delegate?.onError(message: msg.asString)
            
        case "session.created":
            Logger.shared.debug("Session created")
            self.updateSession()
            // Synthesize (i.e. fake) an RTVI-style "bot ready" response from the server
            let botReadyData = BotReadyData(version: "n/a", config: [])
            self.onMessage?(.init(
                type: RTVIMessageInbound.MessageType.BOT_READY,
                data: String(data: try! JSONEncoder().encode(botReadyData), encoding: .utf8),
                id: String(UUID().uuidString.prefix(8))
            ))
            
        case "input_audio_buffer.speech_started":
            Logger.shared.debug("User started speaking")
            self.delegate?.onUserStartedSpeaking()
            
        case "input_audio_buffer.speech_stopped":
            Logger.shared.debug("User stopped speaking")
            self.delegate?.onUserStoppedSpeaking()
            
        case "conversation.item.input_audio_transcription.completed":
            if let transcriptValue = dict["transcript"], case .string(let transcript) = transcriptValue {
                Logger.shared.debug("Received user transcription: \(transcript)")
                self.delegate?.onUserTranscript(data: Transcript.init(text: transcript, final: true))
            }
            
        case "response.content_part.added":
            if let partValue = dict["part"], case .object(let partDict) = partValue,
               let typeValue = partDict["type"], case .string(let partType) = typeValue, partType == "audio" {
                Logger.shared.debug("Bot started speaking")
                self.delegate?.onBotStartedSpeaking()
            }
            
        case "output_audio_buffer.cleared":
            // bot interrupted
            Logger.shared.debug("Bot interrupted")
            self.delegate?.onBotStoppedSpeaking()
            
        case "output_audio_buffer.stopped":
            Logger.shared.debug("Bot stopped speaking")
            self.delegate?.onBotStoppedSpeaking()
            
        case "response.audio_transcript.delta", "response.output_audio_transcript.delta":
            if let deltaValue = dict["delta"], case .string(let delta) = deltaValue {
                Logger.shared.debug("Received onBotTtsText: \(delta)")
                self.delegate?.onBotTTSText(data: BotTTSText(text: delta))
            }
            
        case "response.audio_transcript.done", "response.output_audio_transcript.done":
            if let transcriptValue = dict["transcript"], case .string(let transcript) = transcriptValue {
                Logger.shared.debug("Received bot transcription: \(transcript)")
                self.delegate?.onBotTranscript(data: transcript)
            }
            
        case "response.function_call_arguments.done":
            do {
                let functionName = dict["name"]!!.asString
                let toolCallId = dict["call_id"]!!.asString
                let arguments = dict["arguments"]!!.asString
                
                // Decode the JSON data into a Value object
                let args = try JSONDecoder().decode(Value.self, from: arguments.data(using: .utf8)!)
                
                let functionCallData = LLMFunctionCallData.init(functionName: functionName, toolCallID: toolCallId, args: args)
                
                Logger.shared.debug("Received funcion call: \(functionCallData)")
                self.onMessage?(.init(
                    type: LLMMessageType.Incoming.LLMFunctionCall,
                    data: functionCallData.asString
                ))
            } catch {
                Logger.shared.error("Failed to parse function call: \(error.localizedDescription)")
            }
        default:
            Logger.shared.trace("Ignoring OpenAI message: \(msg)")
        }
    }
}

// MARK: - AudioManagerDelegate

extension OpenAIRealtimeTransport: AudioManagerDelegate {
    func audioManagerDidChangeAvailableDevices(_ audioManager: AudioManager) {
        // Report available mics changed
        delegate?.onAvailableMicsUpdated(mics: getAllMics())
        
        // Refresh what we should report as the selected mic
        refreshSelectedMicIfNeeded()
    }
    
    func audioManagerDidChangeAudioDevice(_ audioManager: AudioManager) {
        // nothing to do here
    }
}

private extension Data {
    mutating func appendFormField(name: String, value: String, boundary: String) {
        appendString("--\(boundary)\r\n")
        appendString("Content-Disposition: form-data; name=\"\(name)\"\r\n\r\n")
        appendString("\(value)\r\n")
    }

    mutating func appendString(_ string: String) {
        if let data = string.data(using: .utf8) {
            append(data)
        }
    }
}
