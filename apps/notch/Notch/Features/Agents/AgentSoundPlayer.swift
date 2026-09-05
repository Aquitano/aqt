import AppKit
import Foundation
import NotchCore

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
