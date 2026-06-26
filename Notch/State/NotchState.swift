import SwiftUI
import Combine

/// Single source of truth for what the notch is showing right now.
/// Owns the presentation phase and the active-activity selection; the feature
/// managers own their own data and publish into the SwiftUI environment.
@MainActor
final class NotchState: ObservableObject {

    enum Presentation: Equatable {
        case hidden     // panel ordered out, fully click-through
        case compact    // the pill / now-playing sliver hugging the bezel
        case expanded   // full panel
    }

    enum ExpandedTab: String, CaseIterable, Identifiable {
        case home, media, tray, settings
        var id: String { rawValue }
        var symbol: String {
            switch self {
            case .home: return "square.grid.2x2"
            case .media: return "play.circle"
            case .tray: return "tray.full"
            case .settings: return "gearshape"
            }
        }
    }

    @Published var presentation: Presentation = .hidden
    @Published var isHovering: Bool = false
    @Published var expandedTab: ExpandedTab = .home

    /// Mirrors `accessibilityReduceMotion`; the root view keeps it in sync so the
    /// transition helpers (which run outside the SwiftUI environment) can react.
    @Published var reduceMotion: Bool = false

    var isExpanded: Bool { presentation == .expanded }
    var isVisible: Bool { presentation != .hidden }

    // MARK: - Transitions

    func hoverChanged(_ hovering: Bool) {
        isHovering = hovering
        if hovering {
            expand()
        } else {
            collapse()
        }
    }

    func expand() {
        guard presentation != .expanded else { return }
        withAnimation(NotchAnimation.open(reduceMotion: reduceMotion)) {
            presentation = .expanded
        }
    }

    /// Collapse to the compact pill when there is something to show, otherwise hide.
    func collapse(hasCompactContent: Bool = true) {
        let target: Presentation = hasCompactContent ? .compact : .hidden
        guard presentation != target else { return }
        withAnimation(NotchAnimation.close(reduceMotion: reduceMotion)) {
            presentation = target
            expandedTab = .home
        }
    }

    func showCompact() {
        guard presentation == .hidden else { return }
        withAnimation(NotchAnimation.morph(reduceMotion: reduceMotion)) {
            presentation = .compact
        }
    }

    func hide() {
        guard presentation != .hidden else { return }
        withAnimation(NotchAnimation.close(reduceMotion: reduceMotion)) {
            presentation = .hidden
            expandedTab = .home
        }
    }

    func select(tab: ExpandedTab) {
        withAnimation(NotchAnimation.morph(reduceMotion: reduceMotion)) {
            expandedTab = tab
        }
    }
}
