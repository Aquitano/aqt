import Foundation
import Testing
@testable import NotchCore

struct AgentSoundTests {
    @Test func legacySystemSoundsMigrateToRetroPalette() {
        #expect(AgentSound.normalizedName("Ping", fallback: nil) == "Alert")
        #expect(AgentSound.normalizedName("Glass", fallback: nil) == "Complete")
        #expect(AgentSound.normalizedName("Pop", fallback: nil) == "Coin")
        #expect(AgentSound.normalizedName("", fallback: .boot) == "")
    }

    @Test func everyCueProducesAValidEightBitMonoWave() {
        for cue in AgentSound.allCases {
            let data = RetroSoundSynthesizer.waveData(for: cue)
            #expect(data.count > 44, "\(cue.rawValue)")
            #expect(String(decoding: data.prefix(4), as: UTF8.self) == "RIFF")
            #expect(String(decoding: data[8..<12], as: UTF8.self) == "WAVE")
            #expect(data[22] == 1, "mono channel count, low byte")
            #expect(data[34] == 8, "bits per sample")
        }
    }
}
