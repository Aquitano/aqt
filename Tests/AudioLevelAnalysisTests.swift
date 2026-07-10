import Foundation
import XCTest

final class AudioLevelAnalysisTests: XCTestCase {
    private let sampleRate = 48_000.0

    func testSilenceSettlesAtZero() {
        var analyzer = AudioBandAnalyzer()
        let levels = analyzer.process(Array(repeating: 0, count: 4_800), sampleRate: sampleRate)
        XCTAssertEqual(levels, .zero)
    }

    func testBassToneDominatesLowBand() {
        let levels = analyzeTone(frequency: 100)
        XCTAssertGreaterThan(levels.low, levels.mid)
        XCTAssertGreaterThan(levels.low, levels.high)
    }

    func testMidToneDominatesMidBand() {
        let levels = analyzeTone(frequency: 1_000)
        XCTAssertGreaterThan(levels.mid, levels.low)
        XCTAssertGreaterThan(levels.mid, levels.high)
    }

    func testTrebleToneDominatesHighBand() {
        let levels = analyzeTone(frequency: 6_000)
        XCTAssertGreaterThan(levels.high, levels.low)
        XCTAssertGreaterThan(levels.high, levels.mid)
    }

    func testOutputIsAlwaysNormalized() {
        var analyzer = AudioBandAnalyzer()
        let malformed: [Float] = [.infinity, -.infinity, .nan, 50, -50]
        let levels = analyzer.process(malformed, sampleRate: sampleRate)
        for level in levels.values {
            XCTAssertTrue(level.isFinite)
            XCTAssertTrue((0...1).contains(level))
        }
    }

    private func analyzeTone(frequency: Double) -> AudioLevels {
        let samples = (0..<4_800).map { index in
            Float(sin(2 * Double.pi * frequency * Double(index) / sampleRate) * 0.5)
        }
        var analyzer = AudioBandAnalyzer()
        return analyzer.process(samples, sampleRate: sampleRate)
    }
}
