import Foundation

enum ShareMethod: String, CaseIterable, Identifiable, Codable {
    case airdrop
    case blip

    var id: String { rawValue }

    /// Name shown in Settings.
    var title: String {
        switch self {
        case .airdrop: return "AirDrop"
        case .blip: return "Blip"
        }
    }

    /// Label on the drop zone.
    var actionTitle: String {
        switch self {
        case .airdrop: return "AirDrop"
        case .blip: return "Send with Blip"
        }
    }

    var symbol: String {
        switch self {
        case .airdrop: return "airdrop"
        case .blip: return "paperplane.fill"
        }
    }

    /// Substring used to locate the service in `NSSharingService.sharingServices`.
    /// AirDrop has a named constant and skips this.
    var serviceMatch: String { "blip" }
}

/// Where the expanded panel's section switcher renders. Only `.inside` spends a
/// row of the body on itself; the other two draw outside it, so the blob gives
