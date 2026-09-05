import Foundation

package enum ShareMethod: String, CaseIterable, Identifiable, Codable {
    case airdrop
    case blip

    package var id: String {
        rawValue
    }

    /// Name shown in Settings.
    package var title: String {
        switch self {
        case .airdrop: "AirDrop"
        case .blip: "Blip"
        }
    }

    /// Label on the drop zone.
    package var actionTitle: String {
        switch self {
        case .airdrop: "AirDrop"
        case .blip: "Send with Blip"
        }
    }

    package var symbol: String {
        switch self {
        case .airdrop: "airdrop"
        case .blip: "paperplane.fill"
        }
    }

    /// Substring used to locate the service in `NSSharingService.sharingServices`.
    /// AirDrop has a named constant and skips this.
    package var serviceMatch: String {
        "blip"
    }
}

// Where the expanded panel's section switcher renders. Only `.inside` spends a
// row of the body on itself; the other two draw outside it, so the blob gives
