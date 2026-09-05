import Foundation
import NotchCore

enum HUDKind: Equatable {
    case volume
    case brightness
    case mute

    var symbol: String {
        switch self {
        case .volume: "speaker.wave.2.fill"
        case .brightness: "sun.max.fill"
        case .mute: "speaker.slash.fill"
        }
    }

    /// Short name shown beside the glyph in the HUD capsule.
    var title: String {
        switch self {
        case .volume: "Volume"
        case .brightness: "Display"
        case .mute: "Muted"
        }
    }
}
