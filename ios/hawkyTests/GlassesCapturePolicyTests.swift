import Testing
@testable import hawky

@Suite struct GlassesCapturePolicyTests {
    @Test func iPhoneFrameRatePickerUsesSupportedChoices() {
        #expect(IPhoneVideoFrameRate.allCases.map(\.rawValue) == [1, 2, 5, 10, 15, 24, 30, 60])
        #expect(IPhoneVideoFrameRate.defaultFrameRate == .fps30)
        #expect(IPhoneVideoFrameRate.storedValue(1) == .fps1)
        #expect(IPhoneVideoFrameRate.storedValue(60) == .fps60)
        #expect(IPhoneVideoFrameRate.storedValue(13) == .fps30)
    }

    @Test func defaultPolicyIsBatterySaferThanRawVideo() {
        let config = GlassesCapturePolicy.defaultPolicy.configuration()

        #expect(config.policy == .ambient)
        #expect(config.sourceFrameRate < 24)
        #expect(config.uploadCadenceHz == 1)
    }

    @Test func policiesUseIntentionalCaptureSettings() {
        #expect(GlassesCapturePolicy.batterySaver.configuration().resolution == .low)
        #expect(GlassesCapturePolicy.batterySaver.configuration().sourceFrameRate == 2)
        #expect(GlassesCapturePolicy.ambient.configuration().resolution == .medium)
        #expect(GlassesCapturePolicy.ambient.configuration().sourceFrameRate == 7)
        #expect(GlassesCapturePolicy.preview.configuration().resolution == .high)
        #expect(GlassesCapturePolicy.preview.configuration().sourceFrameRate == 15)
    }

    @Test func developerPolicyAllowsOnlyKnownDatFrameRates() {
        #expect(GlassesCapturePolicy.developer.configuration(developerFrameRate: 15).sourceFrameRate == 15)
        #expect(GlassesCapturePolicy.developer.configuration(developerFrameRate: 30).sourceFrameRate == 30)
        #expect(GlassesCapturePolicy.developer.configuration(developerFrameRate: 13).sourceFrameRate == 24)
    }

    @Test func diagnosticsSeparateSourcePreviewAndUploadCadence() {
        let diagnostics = GlassesCapturePolicy.ambient.configuration().diagnosticsDescription

        #expect(diagnostics.contains("source 7 fps"))
        #expect(diagnostics.contains("preview 3 fps"))
        #expect(diagnostics.contains("upload 1 fps"))
    }

    @Test func descriptionsExplainThreeCadencesFromOneConfiguration() {
        let config = GlassesCapturePolicy.preview.configuration()
        let rows = config.cadenceRows

        #expect(config.conciseDescription.contains("source 15 fps"))
        #expect(config.conciseDescription.contains("preview 10 fps"))
        #expect(config.policyDescription.contains("Source is the FPS requested from Meta DAT"))
        #expect(rows.map(\.label) == ["Source request", "Preview", "Upload"])
        #expect(rows[0].value.contains("15 fps"))
        #expect(rows[1].value == "10 fps")
        #expect(rows[2].value == "1 fps")
    }
}
