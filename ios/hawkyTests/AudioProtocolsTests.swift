import Testing
import Foundation
@testable import hawky

@Suite struct AudioFormatTests {

    @Test func fileExtensionIsWav() {
        #expect(AudioFormat.wavMono(sampleRate: 16_000).fileExtension == "wav")
        #expect(AudioFormat.wavMono(sampleRate: 44_100).fileExtension == "wav")
    }

    @Test func sampleRateReflectsAssociatedValue() {
        #expect(AudioFormat.wavMono(sampleRate: 16_000).sampleRate == 16_000)
        #expect(AudioFormat.wavMono(sampleRate: 44_100).sampleRate == 44_100)
    }

    @Test func formatIsMono() {
        #expect(AudioFormat.wavMono(sampleRate: 16_000).channelCount == 1)
        #expect(AudioFormat.wavMono(sampleRate: 48_000).channelCount == 1)
    }
}

@Suite struct AudioChunkTests {

    @Test func initializerStoresAllFields() {
        let pcm = Data([0x00, 0x01, 0x02, 0x03])
        let chunk = AudioChunk(pcm: pcm, timestamp: 12.5, sampleRate: 16_000)
        #expect(chunk.pcm == pcm)
        #expect(chunk.timestamp == 12.5)
        #expect(chunk.sampleRate == 16_000)
    }

    @Test func emptyChunkIsValid() {
        let chunk = AudioChunk(pcm: Data(), timestamp: 0, sampleRate: 44_100)
        #expect(chunk.pcm.isEmpty)
        #expect(chunk.sampleRate == 44_100)
    }
}

@Suite struct AudioErrorTests {

    @Test func conformsToError() {
        let err: Error = AudioError.notAuthorized
        #expect(err is AudioError)
    }

    @Test func formatUnsupportedCarriesFormat() {
        let err = AudioError.formatUnsupported(.wavMono(sampleRate: 16_000))
        if case .formatUnsupported(let f) = err {
            #expect(f.sampleRate == 16_000)
            #expect(f.fileExtension == "wav")
        } else {
            Issue.record("wrong case")
        }
    }

    @Test func engineFailedCarriesMessage() {
        let err = AudioError.engineFailed("boom")
        if case .engineFailed(let msg) = err {
            #expect(msg == "boom")
        } else {
            Issue.record("wrong case")
        }
    }
}
