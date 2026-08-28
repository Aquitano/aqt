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
        // Keyboard-driven surfaces animate nothing: the search overlay and the
        // key-hint grid appear and disappear instantly, and selection never
        // animates — a fade trailing a keystroke reads as lag. `overlayIn` is
        // for surfaces the user waited for (toasts, the hint grid's fade-in);
        // toasts fade out over 0.10s.
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
