import AppKit
import Foundation

/// Short, synthesized 8-bit cues used by agent notifications. Keeping the sound
/// definitions in code avoids shipping opaque audio assets and gives every cue the
/// same square-wave character as the app's pixel visuals.
enum AgentSound: String, CaseIterable {
    case boot = "Boot"
    case alert = "Alert"
    case complete = "Complete"
    case coin = "Coin"
    case blip = "Blip"

    static var availableNames: [String] { allCases.map(\.rawValue) }

    /// Convert settings from the previous macOS-system-sound picker into the new
    /// palette. Unknown non-empty values still produce a useful retro blip.
    static func resolve(_ name: String) -> AgentSound? {
        if name.isEmpty { return nil }
        if let sound = AgentSound(rawValue: name) { return sound }
        switch name {
        case "Ping", "Basso", "Sosumi", "Submarine": return .alert
        case "Glass", "Hero", "Tink": return .complete
        case "Pop", "Bottle": return .coin
        case "Blow", "Frog", "Funk", "Morse", "Purr": return .blip
        default: return .blip
        }
    }

    static func normalizedName(_ name: String?, fallback: AgentSound?) -> String {
        guard let name else { return fallback?.rawValue ?? "" }
        return resolve(name)?.rawValue ?? ""
    }
}

@MainActor
enum AgentSoundPlayer {
    /// Retain the sound for the duration of playback. Agent events are already
    /// rate-limited; replacing an in-flight cue also prevents noisy overlaps.
    private static var currentSound: NSSound?

    static func play(_ name: String) {
        guard let cue = AgentSound.resolve(name),
              let sound = NSSound(data: RetroSoundSynthesizer.waveData(for: cue)) else { return }
        currentSound?.stop()
        currentSound = sound
        sound.volume = 0.58
        sound.play()
    }
}

/// Produces unsigned 8-bit, mono PCM WAV data. Notes use a tiny attack/release
/// envelope to avoid speaker clicks while retaining a deliberately crunchy edge.
enum RetroSoundSynthesizer {
    private static let sampleRate = 22_050

    private struct Step {
        var frequency: Double?
        var milliseconds: Int
        var duty: Double = 0.5
    }

    static func waveData(for cue: AgentSound) -> Data {
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
