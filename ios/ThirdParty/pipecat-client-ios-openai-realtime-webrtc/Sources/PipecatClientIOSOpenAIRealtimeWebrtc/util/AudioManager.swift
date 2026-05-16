import AVFAudio

protocol AudioManagerDelegate: AnyObject {
    func audioManagerDidChangeAvailableDevices(_ audioManager: AudioManager)
    func audioManagerDidChangeAudioDevice(_ audioManager: AudioManager)
}

final class AudioManager {
    internal weak var delegate: AudioManagerDelegate? = nil
    
    /// user's explicitly preferred device.
    /// nil means "current system default".
    internal var preferredAudioDevice: AudioDeviceType? = nil {
        didSet {
            if self.preferredAudioDevice != oldValue {
                self.configureAudioSessionIfNeeded()
            }
        }
    }
    
    /// the actual audio device in use.
    internal var audioDevice: AudioDeviceType?
    
    /// the user's preferred device, if it's available, or nil—signifying "current system default"—otherwise.
    /// this is the basis of the selectedMic() exposed to the user, matching the Daily transport's behavior.
    internal var preferredAudioDeviceIfAvailable: AudioDeviceType? {
        self.preferredAudioDeviceIsAvailable(preferredAudioDevice) ? self.preferredAudioDevice : nil
    }
    
    /// the set of available devices on the system.
    internal var availableDevices: [Device] = []
    
    private var isManaging: Bool = false
    private let notificationCenter: NotificationCenter
    
    // The AVAudioSession class is only available as a singleton:
    // https://developer.apple.com/documentation/avfaudio/avaudiosession/1648777-init
    private let audioSession: AVAudioSession = .sharedInstance()
    
    private var availableDevicesPollTimer: Timer?
    
    private static var defaultDevice: AudioDeviceType {
        .speakerphone
    }
    
    internal convenience init() {
        self.init(
            notificationCenter: .default
        )
    }
    
    internal init(
        notificationCenter: NotificationCenter
    ) {
        self.notificationCenter = notificationCenter
        self.addNotificationObservers()
    }
    
    // MARK: - API
    
    func startManagingIfNecessary() {
        guard !self.isManaging else {
            return
        }
        self.startManaging()
    }
    
    func startManaging() {
        if self.isManaging {
            // nothing to do here
            return
        }
        
        self.isManaging = true
        
        // Set initial device state (audioDevice and availableDevices) and configure the audio
        // session if needed.
        // Note: initial state after startManaging() does not represent a "change", so don't fire
        // callbacks
        self.refreshAvailableDevices(suppressDelegateCallbacks: true)
        self.configureAudioSessionIfNeeded(suppressDelegateCallbacks: true)
        
        // Start polling for changes to available devices
        self.availableDevicesPollTimer = Timer.scheduledTimer(
            withTimeInterval: 1,
            repeats: true
        ) { [weak self] _ in
            self?.refreshAvailableDevices()
            // Note: Polling is only for detecting changes to available devices that *don't* affect
            // the audio route, so we don't need to call configureAudioSessionIfNeeded() here. In
            // fact, avoiding calling it avoids unnecessary repeated attempts at reconfiguration.
        }
    }
    
    func stopManaging() {
        if !self.isManaging {
            // nothing to do here
            return
        }
        
        self.isManaging = false
        
        // Stop polling for changes to available devices
        self.availableDevicesPollTimer?.invalidate()
        
        // Reset device state
        self.availableDevices = []
        self.audioDevice = nil
    }
    
    // MARK: - Notifications
    
    private func addNotificationObservers() {
        self.notificationCenter.addObserver(
            self,
            selector: #selector(routeDidChange(_:)),
            name: AVAudioSession.routeChangeNotification,
            object: self.audioSession
        )
        
        self.notificationCenter.addObserver(
            self,
            selector: #selector(mediaServicesWereReset(_:)),
            name: AVAudioSession.mediaServicesWereResetNotification,
            object: self.audioSession
        )
    }
    
    @objc private func routeDidChange(_ notification: Notification) {
        refreshAvailableDevices()
        configureAudioSessionIfNeeded()
    }
    
    @objc private func mediaServicesWereReset(_ notification: Notification) {
        self.configureAudioSessionIfNeeded()
    }
    
    // MARK: - Configuration
    
    private func configureAudioSessionIfNeeded(suppressDelegateCallbacks: Bool = false) {
        // Do nothing if we still not in a call
        if !self.isManaging {
            return
        }
        
        do {
            // If the current audio device is not the one we want...
            //
            // Note: here we use self.getCurrentAudioDevice() and not self.audioDevice because
            // we'll only update self.audioDevice (and fire the corresponding delegate callback)
            // *after* applying our configuration. We don't want to broadcast brief transient
            // periods of routing through a non-preferred device.
            if self.getCurrentAudioDevice() != self.preferredAudioDevice {
                // Apply desired configuration
                try self.applyConfiguration()
                
                // Check whether we've switched to a new audio device
                let newAudioDevice = getCurrentAudioDevice()
                if audioDevice != newAudioDevice {
                    audioDevice = newAudioDevice
                    if !suppressDelegateCallbacks {
                        delegate?.audioManagerDidChangeAudioDevice(self)
                    }
                }
            }
        } catch {
            Logger.shared.error("Error configuring audio session")
        }
    }
    
    private func preferredAudioDeviceIsAvailable(_ preferredAudioDevice: AudioDeviceType?) -> Bool {
        var targetPortTypes: [AVAudioSession.Port]
        var invert = false // whether to check whether targetPortTypes are *not* available
        
        switch preferredAudioDevice {
        case .wired?, .earpiece?:
            targetPortTypes = [.headphones, .headsetMic]
            if case .earpiece = preferredAudioDevice {
                // We treat earpiece as available whenever wired is *not* available
                invert = true
            }
        case .bluetooth?:
            targetPortTypes = [.bluetoothA2DP, .bluetoothHFP, .bluetoothLE]
        case .speakerphone?:
            return true
        case nil:
            return false
        }
        
        var hasTargetPortType = false
        if let availableInputs = self.audioSession.availableInputs {
            hasTargetPortType = availableInputs.contains { targetPortTypes.contains($0.portType) }
        }
        hasTargetPortType = hasTargetPortType || self.audioSession.currentRoute.outputs.contains { targetPortTypes.contains($0.portType) }
        return invert ? !hasTargetPortType : hasTargetPortType
    }
    
    // swiftlint:disable:next function_body_length cyclomatic_complexity
    internal func applyConfiguration() throws {
        let session = self.audioSession
        
        var sessionMode: AVAudioSession.Mode = .voiceChat
        let sessionCategory: AVAudioSession.Category = .playAndRecord
        
        // Mixing audio with other apps allows this app to stay alive in the background during
        // a call (assuming it has the voip background mode set).
        // After iOS 16, we must also always keep the bluetooth option here, otherwise
        // we are not able to see the bluetooth devices on the list
        var sessionCategoryOptions: AVAudioSession.CategoryOptions = [
            .allowBluetooth,
            .mixWithOthers,
        ]
        
        let preferredDeviceToUse = preferredAudioDeviceIfAvailable
        
        switch preferredDeviceToUse {
        case .speakerphone?:
            sessionCategoryOptions.insert(.defaultToSpeaker)
            sessionMode = AVAudioSession.Mode.videoChat
        case .earpiece?, .bluetooth?, .wired?:
            break
        case nil:
            sessionMode = AVAudioSession.Mode.videoChat
        }
        
        do {
            try session.setCategory(
                sessionCategory,
                mode: sessionMode,
                options: sessionCategoryOptions
            )
        } catch {
            Logger.shared.error("Error configuring audio session")
        }
        
        let preferredInput: AVAudioSessionPortDescription?
        let overriddenOutputAudioPort: AVAudioSession.PortOverride
        switch preferredDeviceToUse {
        case .bluetooth?:
            preferredInput = nil
            overriddenOutputAudioPort = .none
        case .speakerphone?:
            preferredInput = nil
            // Force to speaker. We only need to do that the cases a wired
            // headset is connected, but we still want to force to speaker
            overriddenOutputAudioPort = .speaker
        case .wired?:
            preferredInput = nil
            overriddenOutputAudioPort = .none
        case .earpiece?:
            // We just try to force the preferred input to earpiece
            // if we don't already have a wired headset plugged
            // Because otherwise it will always use the wired headset.
            // It is not possible to choose the earpiece in this case.
            preferredInput = session.availableInputs?
                .first {
                    $0.portType == .builtInMic
                }
            overriddenOutputAudioPort = .none
        case nil:
            preferredInput = nil
            overriddenOutputAudioPort = .none
        }
        
        do {
            try session.overrideOutputAudioPort(overriddenOutputAudioPort)
        } catch let error {
            Logger.shared.error("Error overriding output audio port: \(error)")
        }
        if preferredInput != nil {
            do {
                try session.setPreferredInput(preferredInput)
            } catch let error {
                Logger.shared.error("Error configuring preferred input audio port: \(error)")
            }
        }
    }
    
    // MARK: - Available Devices
    
    private func refreshAvailableDevices(suppressDelegateCallbacks: Bool = false) {
        if !isManaging {
            return
        }
        
        // Check for change in available devices
        let newAvailableDevices = getAvailableDevices()
        if availableDevices != newAvailableDevices {
            availableDevices = newAvailableDevices
            if !suppressDelegateCallbacks {
                delegate?.audioManagerDidChangeAvailableDevices(self)
            }
        }
    }
    
    private func getCurrentAudioDevice() -> AudioDeviceType {
        let defaultDevice: AudioDeviceType = Self.defaultDevice
        
        guard let firstOutput = self.audioSession.currentRoute.outputs.first else {
            return defaultDevice
        }
        
        guard let audioDevice = AudioDeviceType(sessionPort: firstOutput.portType) else {
            return defaultDevice
        }
        
        return audioDevice
    }
    
    // Adapted from WebrtcDevicesManager in Daily
    private func getAvailableDevices() -> [Device] {
        let audioSession = self.audioSession
        let availableInputs = audioSession.availableInputs ?? []
        let availableOutputs = audioSession.currentRoute.outputs
        
        var deviceTypes = availableInputs.compactMap { input in
            AudioDeviceType(sessionPort: input.portType)
        }
        // It always returns or earpiece or speakerphone on available inputs, depending on th category that
        // we are using. So we need to add the one that is missing.
        if deviceTypes.contains(AudioDeviceType.speakerphone) {
            deviceTypes.append(AudioDeviceType.earpiece)
        } else {
            deviceTypes.append(AudioDeviceType.speakerphone)
        }
        
        // When we are using bluetooth as the default route,
        // iOS does not list the bluetooth device on the list of availableInputs
        let outputDevice = availableOutputs.first.flatMap { AudioDeviceType(sessionPort: $0.portType) }
        if let outputDevice {
            if !deviceTypes.contains(outputDevice) {
                deviceTypes.append(outputDevice)
            }
        }
        
        // bluetooth and earpiece should only be available in case we don't have a wired headset plugged
        // otherwise we can never change the route to bluetooth or earpiece, iOS does not respect that
        if deviceTypes.contains(AudioDeviceType.wired) {
            deviceTypes = deviceTypes.filter { device in
                device != AudioDeviceType.bluetooth && device != AudioDeviceType.earpiece
            }
        }
        
        // NOTE: we use .input for the kind of all of these, since we only care about reporting mics
        return deviceTypes.map { deviceType in
            switch deviceType {
            case .bluetooth:
                return .init(
                    deviceID: deviceType.deviceID,
                    groupID: "",
                    kind: .audio(.input),
                    label: "Bluetooth Speaker & Mic"
                )
            case .speakerphone:
                return .init(
                    deviceID: deviceType.deviceID,
                    groupID: "",
                    kind: .audio(.input),
                    label: "Built-in Speaker & Mic"
                )
            case .wired:
                return .init(
                    deviceID: deviceType.deviceID,
                    groupID: "",
                    kind: .audio(.input),
                    label: "Wired Speaker & Mic"
                )
            case .earpiece:
                return .init(
                    deviceID: deviceType.deviceID,
                    groupID: "",
                    kind: .audio(.input),
                    label: "Built-in Earpiece & Mic"
                )
            }
        }
        // A stable order helps us detect when available devices have changed
        .sorted(by: { $0.deviceID < $1.deviceID })
    }
}
