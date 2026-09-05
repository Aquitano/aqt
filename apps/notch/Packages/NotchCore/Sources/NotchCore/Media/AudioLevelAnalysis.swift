import Foundation

/// Normalized energy in the three bands drawn beside the physical notch.
package struct AudioLevels: Equatable, Sendable {
    package var low: Float
    package var mid: Float
    package var high: Float

    package static let zero = AudioLevels(low: 0, mid: 0, high: 0)

    package var values: [Float] {
        [low, mid, high]
    }

    /// The compact meter draws six discrete heights (zero through five). Keep
    /// published state at that same resolution so invisible floating-point
    /// changes do not trigger main-actor work and SwiftUI renders.
    package func quantizedForMeter(stepCount: Int = 5) -> AudioLevels {
        guard stepCount > 0 else { return .zero }
        let steps = Float(stepCount)
        func quantize(_ value: Float) -> Float {
            round(min(1, max(0, value)) * steps) / steps
        }
        return AudioLevels(
            low: quantize(low),
            mid: quantize(mid),
            high: quantize(high)
        )
    }
}

/// Tiny streaming three-band analyzer. Two one-pole low-pass filters split the
/// mono signal into bass (<250 Hz), mids (250 Hz–2 kHz), and treble (>2 kHz).
/// This is intentionally O(n), allocation-free for capture buffers, and much
/// cheaper than running an FFT for three twelve-point bars.
package struct AudioBandAnalyzer: Sendable {
    package init() {}
    private var lowState: Float = 0
    private var midState: Float = 0
    private var smoothed = AudioLevels.zero

    package mutating func process(_ samples: [Float], sampleRate: Double) -> AudioLevels {
        samples.withUnsafeBufferPointer {
            process($0, sampleRate: sampleRate)
        }
    }

    package mutating func process(
        _ samples: UnsafeBufferPointer<Float>,
        sampleRate: Double
    ) -> AudioLevels {
        guard !samples.isEmpty, sampleRate > 0 else { return smoothed }

        let lowCoefficient = Self.lowPassCoefficient(cutoff: 250, sampleRate: sampleRate)
        let midCoefficient = Self.lowPassCoefficient(cutoff: 2000, sampleRate: sampleRate)
        var lowEnergy: Float = 0
        var midEnergy: Float = 0
        var highEnergy: Float = 0

        for sample in samples {
            // Defensive clipping keeps a malformed capture buffer from turning the
            // published meter into NaN/Inf and poisoning subsequent smoothing.
            let input = min(1, max(-1, sample.isFinite ? sample : 0))
            lowState += lowCoefficient * (input - lowState)
            midState += midCoefficient * (input - midState)

            let low = lowState
            let mid = midState - lowState
            let high = input - midState
            lowEnergy += low * low
            midEnergy += mid * mid
            highEnergy += high * high
        }

        let count = Float(samples.count)
        let target = AudioLevels(
            low: Self.meterLevel(rms: sqrt(lowEnergy / count), gain: 1.0),
            mid: Self.meterLevel(rms: sqrt(midEnergy / count), gain: 1.35),
            high: Self.meterLevel(rms: sqrt(highEnergy / count), gain: 2.0)
        )

        let duration = Double(samples.count) / sampleRate
        smoothed.low = Self.smooth(from: smoothed.low, to: target.low, duration: duration)
        smoothed.mid = Self.smooth(from: smoothed.mid, to: target.mid, duration: duration)
        smoothed.high = Self.smooth(from: smoothed.high, to: target.high, duration: duration)
        return smoothed
    }

    package mutating func reset() {
        lowState = 0
        midState = 0
        smoothed = .zero
    }

    private static func lowPassCoefficient(cutoff: Double, sampleRate: Double) -> Float {
        Float(1 - exp(-2 * Double.pi * cutoff / sampleRate))
    }

    /// Log mapping gives quiet passages useful travel while leaving headroom for
    /// transients. Values below -55 dB settle to the two-pixel silence baseline.
    private static func meterLevel(rms: Float, gain: Float) -> Float {
        let decibels = 20 * log10(max(rms * gain, 0.000_001))
        let normalized = min(1, max(0, (decibels + 55) / 49))
        return pow(normalized, 0.72)
    }

    private static func smooth(from current: Float, to target: Float, duration: Double) -> Float {
        let timeConstant = target > current ? 0.035 : 0.16
        let amount = Float(1 - exp(-duration / timeConstant))
        return current + (target - current) * amount
    }
}
