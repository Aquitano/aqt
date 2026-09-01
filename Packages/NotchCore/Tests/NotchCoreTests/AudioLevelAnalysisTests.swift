import Foundation
@testable import NotchCore
import Testing

struct AudioLevelAnalysisTests {
    private let sampleRate = 48_000.0

    @Test func silenceSettlesAtZero() {
        var analyzer = AudioBandAnalyzer()
        let levels = analyzer.process(Array(repeating: 0, count: 4_800), sampleRate: sampleRate)
        #expect(levels == .zero)
    }

    @Test func bassToneDominatesLowBand() {
        let levels = analyzeTone(frequency: 100)
        #expect(levels.low > levels.mid)
        #expect(levels.low > levels.high)
    }

    @Test func midToneDominatesMidBand() {
        let levels = analyzeTone(frequency: 1_000)
        #expect(levels.mid > levels.low)
        #expect(levels.mid > levels.high)
    }

    @Test func trebleToneDominatesHighBand() {
        let levels = analyzeTone(frequency: 6_000)
        #expect(levels.high > levels.low)
        #expect(levels.high > levels.mid)
    }

    @Test func outputIsAlwaysNormalized() {
        var analyzer = AudioBandAnalyzer()
        let malformed: [Float] = [.infinity, -.infinity, .nan, 50, -50]
        let levels = analyzer.process(malformed, sampleRate: sampleRate)
        for level in levels.values {
            #expect(level.isFinite)
            #expect((0...1).contains(level))
        }
    }

    @Test func meterQuantizationSuppressesInvisibleChanges() {
        let first = AudioLevels(low: 0.22, mid: 0.57, high: 0.94).quantizedForMeter()
        let second = AudioLevels(low: 0.27, mid: 0.62, high: 0.99).quantizedForMeter()

        #expect(first == second)
        #expect(first == AudioLevels(low: 0.2, mid: 0.6, high: 1.0))
    }

    @Test func meterQuantizationClampsMalformedRange() {
        let levels = AudioLevels(low: -1, mid: 0.5, high: 2).quantizedForMeter()

        #expect(levels == AudioLevels(low: 0, mid: 0.6, high: 1))
    }

    private func analyzeTone(frequency: Double) -> AudioLevels {
        let samples = (0..<4_800).map { index in
            Float(sin(2 * Double.pi * frequency * Double(index) / sampleRate) * 0.5)
        }
        var analyzer = AudioBandAnalyzer()
        return analyzer.process(samples, sampleRate: sampleRate)
    }
}
