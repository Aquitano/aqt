import Foundation
import NotchCore

enum HUDKind: Equatable {
    case volume
    case brightness
    case mute

    var symbol: String {
        switch self {
        case .volume: return "speaker.wave.2.fill"
        case .brightness: return "sun.max.fill"
        case .mute: return "speaker.slash.fill"
        }
    }

    /// Short name shown beside the glyph in the HUD capsule.
    var title: String {
        switch self {
        case .volume: return "Volume"
        case .brightness: return "Display"
        case .mute: return "Muted"
        }
    }
}
