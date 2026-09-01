import Foundation

/// Short, synthesized 8-bit cues used by agent notifications. Keeping the sound
/// definitions in code avoids shipping opaque audio assets and gives every cue the
/// same square-wave character as the app's pixel visuals.
package enum AgentSound: String, CaseIterable {
    case boot = "Boot"
    case alert = "Alert"
    case complete = "Complete"
    case coin = "Coin"
    case blip = "Blip"

    package static var availableNames: [String] { allCases.map(\.rawValue) }

    /// Convert settings from the previous macOS-system-sound picker into the new
    /// palette. Unknown non-empty values still produce a useful retro blip.
    package static func resolve(_ name: String) -> AgentSound? {
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

    package static func normalizedName(_ name: String?, fallback: AgentSound?) -> String {
        guard let name else { return fallback?.rawValue ?? "" }
        return resolve(name)?.rawValue ?? ""
    }
}
