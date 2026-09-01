import Foundation

package enum TabBarStyle: String, CaseIterable, Identifiable, Codable {
    /// Detached capsule below the blob, Dynamic-Island style.
    case floating
    /// Glass strip inside the blob, above the body.
    case inside
    /// Icons straight on the black band flanking the physical cutout.
    case shoulders

    package var id: String { rawValue }

    /// Name shown in Settings.
    package var title: String {
        switch self {
        case .floating: return "Floating below the notch"
        case .inside: return "Inside the panel"
        case .shoulders: return "On the notch shoulders"
        }
    }
}

