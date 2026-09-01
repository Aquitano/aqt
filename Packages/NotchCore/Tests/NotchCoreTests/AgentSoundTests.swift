import XCTest
@testable import NotchCore

final class AgentSoundTests: XCTestCase {
    func testLegacySystemSoundsMigrateToRetroPalette() {
        XCTAssertEqual(AgentSound.normalizedName("Ping", fallback: nil), "Alert")
        XCTAssertEqual(AgentSound.normalizedName("Glass", fallback: nil), "Complete")
        XCTAssertEqual(AgentSound.normalizedName("Pop", fallback: nil), "Coin")
        XCTAssertEqual(AgentSound.normalizedName("", fallback: .boot), "")
    }

    func testEveryCueProducesAValidEightBitMonoWave() {
        for cue in AgentSound.allCases {
            let data = RetroSoundSynthesizer.waveData(for: cue)
            XCTAssertGreaterThan(data.count, 44, cue.rawValue)
            XCTAssertEqual(String(decoding: data.prefix(4), as: UTF8.self), "RIFF")
            XCTAssertEqual(String(decoding: data[8..<12], as: UTF8.self), "WAVE")
            XCTAssertEqual(data[22], 1, "mono channel count, low byte")
            XCTAssertEqual(data[34], 8, "bits per sample")
        }
    }
}
