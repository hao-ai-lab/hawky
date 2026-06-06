import Foundation

enum GlassesCaptureResolution: String, CaseIterable, Identifiable {
    case low
    case medium
    case high

    var id: String { rawValue }

    var label: String {
        switch self {
        case .low: return "Low"
        case .medium: return "Medium"
        case .high: return "High"
        }
    }

    var diagnosticsLabel: String {
        switch self {
        case .low: return "low 360x640"
        case .medium: return "medium 504x896"
        case .high: return "high 720x1280"
        }
    }
}

struct GlassesCaptureConfiguration: Equatable {
    static let uploadCadenceHz: Double = 1
    static let developerFrameRates = [15, 24, 30]
    static let defaultDeveloperFrameRate = 24

    let policy: GlassesCapturePolicy
    let resolution: GlassesCaptureResolution
    let sourceFrameRate: Int
    let previewCadenceHz: Double
    let uploadCadenceHz: Double

    init(
        policy: GlassesCapturePolicy,
        resolution: GlassesCaptureResolution,
        sourceFrameRate: Int,
        previewCadenceHz: Double,
        uploadCadenceHz: Double = Self.uploadCadenceHz
    ) {
        self.policy = policy
        self.resolution = resolution
        self.sourceFrameRate = sourceFrameRate
        self.previewCadenceHz = previewCadenceHz
        self.uploadCadenceHz = uploadCadenceHz
    }

    var previewIntervalNanoseconds: UInt64 {
        UInt64((1_000_000_000 / previewCadenceHz).rounded())
    }

    var uploadIntervalNanoseconds: UInt64 {
        UInt64((1_000_000_000 / uploadCadenceHz).rounded())
    }

    var sourceFrameRateDescription: String {
        "\(sourceFrameRate) fps"
    }

    var uploadCadenceDescription: String {
        Self.formatCadence(uploadCadenceHz)
    }

    var previewCadenceDescription: String {
        Self.formatCadence(previewCadenceHz)
    }

    var diagnosticsDescription: String {
        "\(policy.diagnosticsLabel), resolution \(resolution.diagnosticsLabel), source \(sourceFrameRateDescription), preview \(previewCadenceDescription), upload \(uploadCadenceDescription)"
    }

    var conciseDescription: String {
        "\(resolution.diagnosticsLabel), source \(sourceFrameRateDescription), preview \(previewCadenceDescription), upload \(uploadCadenceDescription)"
    }

    var policyDescription: String {
        "\(policy.intentDescription) \(cadenceExplanation)"
    }

    var cadenceExplanation: String {
        "Source is the FPS requested from Meta DAT; preview is how often this app refreshes the on-screen image; upload is how often keyframes are sent/stored."
    }

    var cadenceRows: [GlassesCaptureCadenceRow] {
        [
            GlassesCaptureCadenceRow(
                label: "Source request",
                value: "\(sourceFrameRateDescription), \(resolution.diagnosticsLabel)",
                explanation: "Requested from Meta DAT. The glasses/SDK may still adapt downward when Bluetooth bandwidth is limited."
            ),
            GlassesCaptureCadenceRow(
                label: "Preview",
                value: previewCadenceDescription,
                explanation: "How often Hawky updates the live image on screen."
            ),
            GlassesCaptureCadenceRow(
                label: "Upload",
                value: uploadCadenceDescription,
                explanation: "How often Hawky emits keyframes for upload and recording playback."
            ),
        ]
    }

    static func sanitizedDeveloperFrameRate(_ rawValue: Int) -> Int {
        developerFrameRates.contains(rawValue) ? rawValue : defaultDeveloperFrameRate
    }

    private static func formatCadence(_ cadence: Double) -> String {
        if cadence.rounded() == cadence {
            return "\(Int(cadence)) fps"
        }
        return String(format: "%.1f fps", cadence)
    }
}

struct GlassesCaptureCadenceRow: Identifiable, Equatable {
    let label: String
    let value: String
    let explanation: String

    var id: String { label }
}

enum GlassesCapturePolicy: String, CaseIterable, Identifiable {
    case batterySaver = "battery_saver"
    case ambient
    case preview
    case developer

    static let defaultPolicy: GlassesCapturePolicy = .ambient

    var id: String { rawValue }

    var label: String {
        switch self {
        case .batterySaver: return "Battery saver"
        case .ambient: return "Ambient"
        case .preview: return "Preview"
        case .developer: return "Developer"
        }
    }

    var diagnosticsLabel: String {
        switch self {
        case .batterySaver: return "policy battery_saver"
        case .ambient: return "policy ambient"
        case .preview: return "policy preview"
        case .developer: return "policy developer"
        }
    }

    var intentDescription: String {
        switch self {
        case .batterySaver:
            return "Conserves battery and bandwidth for long ambient capture."
        case .ambient:
            return "Balanced default for ambient visual context."
        case .preview:
            return "Prioritizes a smoother local preview while keeping upload sparse."
        case .developer:
            return "Uses high resolution with a selectable Meta DAT source FPS."
        }
    }

    func configuration(developerFrameRate: Int = GlassesCaptureConfiguration.defaultDeveloperFrameRate) -> GlassesCaptureConfiguration {
        switch self {
        case .batterySaver:
            return GlassesCaptureConfiguration(policy: self, resolution: .low, sourceFrameRate: 2, previewCadenceHz: 1)
        case .ambient:
            return GlassesCaptureConfiguration(policy: self, resolution: .medium, sourceFrameRate: 7, previewCadenceHz: 3)
        case .preview:
            return GlassesCaptureConfiguration(policy: self, resolution: .high, sourceFrameRate: 15, previewCadenceHz: 10)
        case .developer:
            return GlassesCaptureConfiguration(
                policy: self,
                resolution: .high,
                sourceFrameRate: GlassesCaptureConfiguration.sanitizedDeveloperFrameRate(developerFrameRate),
                previewCadenceHz: 10
            )
        }
    }

    static func storedValue(_ rawValue: String) -> GlassesCapturePolicy {
        GlassesCapturePolicy(rawValue: rawValue) ?? defaultPolicy
    }
}
