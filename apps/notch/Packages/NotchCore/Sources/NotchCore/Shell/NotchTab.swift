import Foundation

/// The sections of the expanded panel.
package enum NotchTab: String, CaseIterable, Identifiable, Codable {
    case home, agents, media, timer, tray
    package var id: String {
        rawValue
    }

    package var title: String {
        rawValue.capitalized
    }

    package var symbol: String {
        switch self {
        case .home: "square.grid.2x2"
        case .agents: "terminal"
        case .media: "play.circle"
        case .timer: "timer"
        case .tray: "tray.full"
        }
    }
}
