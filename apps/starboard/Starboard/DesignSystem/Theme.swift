import SwiftUI

/// Design tokens — the only place colors, type, metrics, and motion may live.
/// Values and rationale: BATTLEPLAN §4. No hardcoded styling outside this file.
enum Theme {
    enum Colors {
        static let accent = Color(red: 1.00, green: 0.478, blue: 0.349) // #FF7A59
        static let surface = Color(nsColor: NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
                ? NSColor(red: 0.118, green: 0.122, blue: 0.133, alpha: 1)
                : NSColor(red: 0.96, green: 0.96, blue: 0.97, alpha: 1)
        })
        static let header = Color(nsColor: NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
                ? NSColor.white.withAlphaComponent(0.04)
                : NSColor.black.withAlphaComponent(0.03)
        })
        static let destructive = Color(red: 1.00, green: 0.373, blue: 0.341) // #FF5F57
        static let stroke = Color.primary.opacity(0.10)
        /// Raycast-style selection: a quiet raised fill, no accent wash.
        static let selection = Color.primary.opacity(0.08)
        static let hover = Color.primary.opacity(0.04)
        /// Fill for key tags, and its increased-contrast variant.
        static let tag = Color.primary.opacity(0.08)
        static let tagContrast = Color.primary.opacity(0.16)
    }

    enum Metrics {
        static let grid: CGFloat = 8
        static let panelRadius: CGFloat = 16
        static let rowRadius: CGFloat = 8
        static let rowHeight: CGFloat = 40
        static let rowIcon: CGFloat = 24
        static let tagSize: CGFloat = 28
        static let searchWidth: CGFloat = 760
        static let searchHeader: CGFloat = 64
        static let searchFooter: CGFloat = 52
        static let searchRows = 8
    }

    enum Motion {
        static let overlayIn = Animation.easeOut(duration: 0.16)
        // Keyboard-driven surfaces animate nothing: the search overlay
        // appears and disappears instantly, and selection never animates — a
        // fade trailing a keystroke reads as lag. `overlayIn` is for surfaces
        // the user waited for (toasts); toasts fade out over 0.10s.
    }
}

private struct ThemeContrastBoostKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    var themeContrastBoost: Bool {
        get { self[ThemeContrastBoostKey.self] }
        set { self[ThemeContrastBoostKey.self] = newValue }
    }
}

private struct ThemeAccessibilityModifier: ViewModifier {
    @Environment(\.colorSchemeContrast) private var contrast

    func body(content: Content) -> some View {
        content.environment(\.themeContrastBoost, contrast == .increased)
    }
}

extension View {
    func themeAccessibility() -> some View {
        modifier(ThemeAccessibilityModifier())
    }
}
