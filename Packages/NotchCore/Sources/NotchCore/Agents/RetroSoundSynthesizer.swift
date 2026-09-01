import Foundation

/// Produces unsigned 8-bit, mono PCM WAV data. Notes use a tiny attack/release
/// envelope to avoid speaker clicks while retaining a deliberately crunchy edge.
package enum RetroSoundSynthesizer {
    private static let sampleRate = 22_050

    private struct Step {
        package var frequency: Double?
        package var milliseconds: Int
        package var duty: Double = 0.5
    }

    package static func waveData(for cue: AgentSound) -> Data {
        var pcm = Data()
        for step in pattern(for: cue) {
            let sampleCount = max(1, step.milliseconds * sampleRate / 1_000)
            let edgeSamples = min(sampleCount / 2, sampleRate / 500)
            for index in 0..<sampleCount {
                guard let frequency = step.frequency else {
                    pcm.append(128)
                    continue
                }
                let phase = (Double(index) * frequency / Double(sampleRate)).truncatingRemainder(dividingBy: 1)
                let square = phase < step.duty ? 1.0 : -1.0
                let attack = edgeSamples == 0 ? 1 : min(1, Double(index) / Double(edgeSamples))
                let release = edgeSamples == 0 ? 1 : min(1, Double(sampleCount - index - 1) / Double(edgeSamples))
                let envelope = min(attack, release)
                let value = 128 + Int((square * 88 * envelope).rounded())
                pcm.append(UInt8(clamping: value))
            }
        }

        var wave = Data("RIFF".utf8)
        wave.appendUInt32LE(UInt32(36 + pcm.count))
        wave.append(contentsOf: Data("WAVEfmt ".utf8))
        wave.appendUInt32LE(16)
        wave.appendUInt16LE(1) // PCM
        wave.appendUInt16LE(1) // mono
        wave.appendUInt32LE(UInt32(sampleRate))
        wave.appendUInt32LE(UInt32(sampleRate)) // 8-bit mono byte rate
        wave.appendUInt16LE(1) // block alignment
        wave.appendUInt16LE(8)
        wave.append(contentsOf: Data("data".utf8))
        wave.appendUInt32LE(UInt32(pcm.count))
        wave.append(pcm)
        return wave
    }

    private static func pattern(for cue: AgentSound) -> [Step] {
        let rest = Step(frequency: nil, milliseconds: 14)
        switch cue {
        case .boot:
            return [Step(frequency: 523.25, milliseconds: 52), rest,
                    Step(frequency: 659.25, milliseconds: 52), rest,
                    Step(frequency: 783.99, milliseconds: 82)]
        case .alert:
            return [Step(frequency: 880, milliseconds: 68, duty: 0.25),
                    Step(frequency: nil, milliseconds: 28),
                    Step(frequency: 587.33, milliseconds: 68, duty: 0.25),
                    Step(frequency: nil, milliseconds: 28),
                    Step(frequency: 880, milliseconds: 96, duty: 0.25)]
        case .complete:
            return [Step(frequency: 523.25, milliseconds: 52), rest,
                    Step(frequency: 659.25, milliseconds: 52), rest,
                    Step(frequency: 783.99, milliseconds: 52), rest,
                    Step(frequency: 1_046.5, milliseconds: 118)]
        case .coin:
            return [Step(frequency: 987.77, milliseconds: 48, duty: 0.25),
                    Step(frequency: nil, milliseconds: 10),
                    Step(frequency: 1_318.51, milliseconds: 104, duty: 0.25)]
        case .blip:
            return [Step(frequency: 1_046.5, milliseconds: 46, duty: 0.25),
                    Step(frequency: 698.46, milliseconds: 72, duty: 0.25)]
        }
    }
}

private extension Data {
    mutating func appendUInt16LE(_ value: UInt16) {
        append(UInt8(value & 0xff))
        append(UInt8((value >> 8) & 0xff))
    }

    mutating func appendUInt32LE(_ value: UInt32) {
        append(UInt8(value & 0xff))
        append(UInt8((value >> 8) & 0xff))
        append(UInt8((value >> 16) & 0xff))
        append(UInt8((value >> 24) & 0xff))
    }
}
