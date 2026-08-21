import SwiftUI

/// Design tokens — the only place colors, type, metrics, and motion may live.
/// Values and rationale: BATTLEPLAN §4. No hardcoded styling outside this file.
enum Theme {
    enum Colors {
        static let accent = Color(red: 1.00, green: 0.478, blue: 0.349) // #FF7A59
        static let surface = Color(red: 0.118, green: 0.122, blue: 0.133) // #1E1F22
        static let destructive = Color(red: 1.00, green: 0.373, blue: 0.341) // #FF5F57
        static let stroke = Color.white.opacity(0.08)
        static let selection = accent.opacity(0.16)
    }

    enum Metrics {
        static let grid: CGFloat = 8
        static let panelRadius: CGFloat = 16
        static let rowRadius: CGFloat = 10
        static let rowHeight: CGFloat = 44
        static let searchWidth: CGFloat = 640
    }

    enum Motion {
        static let standard = Animation.easeOut(duration: 0.14)
        static let overlayIn = Animation.easeOut(duration: 0.16)
        // Overlay exit: 0.10s fade only. Cycling selection: no animation at all.
    }
}
