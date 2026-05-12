import Foundation
import WebRTC
import PipecatClientIOS

protocol OpenAIRealtimeWebRTCConnectionDelegate: AnyObject {
    func onConnectionStateChanged(state: RTCIceConnectionState)
    func onMsgReceived(msg: Value)
    func onTracksUpdated()
}

final class OpenAIRealtimeWebRTCConnection: NSObject {
    
    private static let factory: RTCPeerConnectionFactory = {
        RTCInitializeSSL()
        let videoEncoderFactory = RTCDefaultVideoEncoderFactory()
        let videoDecoderFactory = RTCDefaultVideoDecoderFactory()
        return RTCPeerConnectionFactory(encoderFactory: videoEncoderFactory, decoderFactory: videoDecoderFactory)
    }()
    
    weak var delegate: OpenAIRealtimeWebRTCConnectionDelegate?
    
    private let peerConnection: RTCPeerConnection
    private let mediaConstraints = [kRTCMediaConstraintsOfferToReceiveAudio: kRTCMediaConstraintsValueTrue]
    
    private var openAIDataChannel: RTCDataChannel?
    
    private var localAudioTrack: RTCAudioTrack?
    private var remoteAudioTrack: RTCAudioTrack?
    
    private var iceGatheringCompleted = false
    
    @available(*, unavailable)
    override init() {
        fatalError("WebRTCClient:init is unavailable")
    }
    
    required convenience init(iceServers: [String]) {
        self.init(iceServers: iceServers, audioEnabled: true)
    }

    init(iceServers: [String], audioEnabled: Bool) {
        let config = RTCConfiguration()
        if !iceServers.isEmpty {
            config.iceServers = [RTCIceServer(urlStrings: iceServers)]
        }
        
        // Unified plan is more superior than planB
        config.sdpSemantics = .unifiedPlan
        
        // gatherContinually will let WebRTC to listen to any network changes and send any new candidates to the other client
        config.continualGatheringPolicy = .gatherOnce
        
        // Define media constraints. DtlsSrtpKeyAgreement is required to be true to be able to connect with web browsers.
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil,
                                              optionalConstraints: ["DtlsSrtpKeyAgreement":kRTCMediaConstraintsValueTrue])
        
        guard let peerConnection = OpenAIRealtimeWebRTCConnection.factory.peerConnection(with: config, constraints: constraints, delegate: nil) else {
            fatalError("Could not create new RTCPeerConnection")
        }
        
        self.peerConnection = peerConnection
        
        super.init()
        self.createMediaSenders(audioEnabled: audioEnabled)
        self.peerConnection.delegate = self
    }
    
    // MARK: Signaling
    func offer(completion: @escaping (_ sdp: RTCSessionDescription) -> Void) {
        // 1. Create the offer
        let constrains = RTCMediaConstraints(mandatoryConstraints: self.mediaConstraints, optionalConstraints: nil)
        
        self.peerConnection.offer(for: constrains) { (sdp, error) in
            guard let sdp = sdp else {
                Logger.shared.debug("Error creating offer: \(String(describing: error))")
                return
            }
            
            // 2. Set the local description to trigger ICE gathering
            self.peerConnection.setLocalDescription(sdp) { (error) in
                if let error = error {
                    Logger.shared.debug("Error setting local description: \(error)")
                    return
                }
                
                // Now ICE gathering will start, we need to wait for it to complete
                self.waitForIceGathering(completion: {
                    completion(self.peerConnection.localDescription!)
                })
            }
        }
    }
    
    private func waitForIceGathering(completion: @escaping () -> Void) {
        // Wait until ICE gathering is complete
        DispatchQueue.global().async {
            while self.peerConnection.iceGatheringState != .complete {
                // Sleep to avoid blocking the main thread
                Thread.sleep(forTimeInterval: 0.1)
            }
            
            // Once gathering is complete, proceed with the callback
            DispatchQueue.main.async {
                completion()
            }
        }
    }
    
    func offer() async throws -> RTCSessionDescription {
        return try await withCheckedThrowingContinuation { continuation in
            self.offer { sdp in
                continuation.resume(returning: sdp)
            }
        }
    }
    
    func answer(completion: @escaping (_ sdp: RTCSessionDescription) -> Void)  {
        let constrains = RTCMediaConstraints(mandatoryConstraints: self.mediaConstraints,
                                             optionalConstraints: nil)
        self.peerConnection.answer(for: constrains) { (sdp, error) in
            guard let sdp = sdp else {
                return
            }
            
            self.peerConnection.setLocalDescription(sdp, completionHandler: { (error) in
                completion(sdp)
            })
        }
    }
    
    func answer() async throws -> RTCSessionDescription {
        return try await withCheckedThrowingContinuation { continuation in
            self.answer { sdp in
                continuation.resume(returning: sdp)
            }
        }
    }
    
    func set(remoteSdp: RTCSessionDescription, completion: @escaping (Error?) -> ()) {
        self.peerConnection.setRemoteDescription(remoteSdp, completionHandler: completion)
    }
    
    func set(remoteCandidate: RTCIceCandidate, completion: @escaping (Error?) -> ()) {
        self.peerConnection.add(remoteCandidate, completionHandler: completion)
    }
    
    func getLocalAudioTrack() -> RTCAudioTrack? {
        return self.localAudioTrack
    }
    
    func getRemoteAudioTrack() -> RTCAudioTrack? {
        return self.remoteAudioTrack
    }
    
    // MARK: Media
    private func createMediaSenders(audioEnabled: Bool) {
        let streamId = "stream"
        
        // Audio
        let audioTrack = self.createAudioTrack()
        audioTrack.isEnabled = audioEnabled
        self.localAudioTrack = audioTrack
        self.peerConnection.add(audioTrack, streamIds: [streamId])
        
        // Data
        if let dataChannel = self.createDataChannel(label: "oai-events") {
            dataChannel.delegate = self
            self.openAIDataChannel = dataChannel
        }
    }
    
    private func createAudioTrack() -> RTCAudioTrack {
        let audioConstrains = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        let audioSource = OpenAIRealtimeWebRTCConnection.factory.audioSource(with: audioConstrains)
        let audioTrack = OpenAIRealtimeWebRTCConnection.factory.audioTrack(with: audioSource, trackId: "audio0")
        return audioTrack
    }
    
    // MARK: Data Channels
    private func createDataChannel(label:String) -> RTCDataChannel? {
        let config = RTCDataChannelConfiguration()
        guard let dataChannel = self.peerConnection.dataChannel(forLabel: label, configuration: config) else {
            Logger.shared.debug("Warning: Couldn't create data channel.")
            return nil
        }
        return dataChannel
    }
    
    func sendMessage( message: Encodable) throws{
        let jsonData = try JSONEncoder().encode(message);
        Logger.shared.debug("Sending message: \(String(data: jsonData, encoding: .utf8))")
        let buffer = RTCDataBuffer(data: jsonData, isBinary: true)
        self.openAIDataChannel?.sendData(buffer)
    }
    
    func disconnect() {
        self.openAIDataChannel?.close()
        self.peerConnection.close()
        
        self.openAIDataChannel = nil
        self.localAudioTrack = nil
        self.remoteAudioTrack = nil
    }
}

extension OpenAIRealtimeWebRTCConnection: RTCPeerConnectionDelegate {
    
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {
        Logger.shared.debug("peerConnection new signaling state: \(stateChanged)")
    }
    
    func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {
        Logger.shared.debug("peerConnection did add stream")
        if !stream.audioTracks.isEmpty {
            self.remoteAudioTrack = stream.audioTracks[0]
            self.delegate?.onTracksUpdated()
        }
    }
    
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {
        Logger.shared.debug("peerConnection did remove stream")
        if !stream.audioTracks.isEmpty && self.remoteAudioTrack != nil && self.remoteAudioTrack?.trackId == stream.audioTracks[0].trackId {
            self.remoteAudioTrack = nil
            self.delegate?.onTracksUpdated()
        }
    }
    
    func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {
        Logger.shared.debug("peerConnection should negotiate")
    }
    
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {
        Logger.shared.debug("peerConnection new connection state: \(newState)")
        self.delegate?.onConnectionStateChanged(state: newState)
    }
    
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {
        Logger.shared.debug("peerConnection new gathering state: \(newState)")
        if newState == .complete {
            self.iceGatheringCompleted = true
        }
    }
    
    func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
        Logger.shared.debug("peerConnection did discover new ice candidate \(candidate.sdp)")
    }
    
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {
        Logger.shared.debug("peerConnection did remove candidate(s)")
    }
    
    func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {
        Logger.shared.debug("peerConnection did receive new data channel")
    }
    
}
extension OpenAIRealtimeWebRTCConnection {
    private func setTrackEnabled<T: RTCMediaStreamTrack>(_ type: T.Type, isEnabled: Bool) {
        peerConnection.transceivers
            .compactMap { return $0.sender.track as? T }
            .forEach { $0.isEnabled = isEnabled }
    }
}

// MARK:- Audio control
extension OpenAIRealtimeWebRTCConnection {
    func muteAudio() {
        self.setAudioEnabled(false)
    }
    
    func unmuteAudio() {
        self.setAudioEnabled(true)
    }
    
    func isAudioEnabled() -> Bool {
        return self.localAudioTrack?.isEnabled ?? true
    }
    
    private func setAudioEnabled(_ isEnabled: Bool) {
        setTrackEnabled(RTCAudioTrack.self, isEnabled: isEnabled)
    }
}

extension OpenAIRealtimeWebRTCConnection: RTCDataChannelDelegate {
    
    func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {
        Logger.shared.debug("dataChannel did change state: \(dataChannel.readyState)")
    }
    
    func dataChannel(_ dataChannel: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {
        do {
            let receivedValue = try JSONDecoder().decode(Value.self, from: buffer.data)
            self.delegate?.onMsgReceived(msg: receivedValue)
        } catch {
            Logger.shared.error("Error decoding JSON into Value: \(error.localizedDescription)")
        }
    }
    
}
