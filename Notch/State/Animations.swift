import SwiftUI

/// The "Apple feel" lives here: one asymmetric spring set, ~0.4s each.
/// Open bounces, close settles, compact<->expanded snaps. Reduce Motion
/// swaps every curve for a non-bouncy `.smooth`.
enum NotchAnimation {

    static func open(reduceMotion: Bool) -> Animation {
        reduceMotion ? .smooth(duration: 0.35) : .bouncy(duration: 0.4)
    }

    static func close(reduceMotion: Bool) -> Animation {
        .smooth(duration: 0.4)
    }

    static func morph(reduceMotion: Bool) -> Animation {
        reduceMotion ? .smooth(duration: 0.35) : .snappy(duration: 0.4)
    }

    /// One-shot pop for a new track / new activity. Used as a phaseAnimator curve.
    static let pop: Animation = .spring(response: 0.32, dampingFraction: 0.55)
}

/// Layout constants for the notch geometry and morph.
enum NotchMetrics {
    /// Fallback notch size for displays where we can't read the real inset.
    static let fallbackNotchSize = CGSize(width: 210, height: 32)

    /// Extra padding the panel reserves around the notch so the expanded body
    /// and the HUD have room to draw without clipping at the screen edges.
    static let horizontalPadding: CGFloat = 360
    static let verticalDrop: CGFloat = 420

    static let compactCornerRadius: CGFloat = 12
    static let expandedCornerRadius: CGFloat = 24

    /// The expanded panel keeps a constant width; height is chosen per tab (see
    /// `NotchLayout.expandedBodyHeight`) so each surface fits its own content.
    static let expandedWidth: CGFloat = 540
}

/// Single source of truth for the visible content's size per presentation state.
/// Both the SwiftUI tree (to lay out) and the window controller (to scope the
/// panel's clickable region to exactly the visible content) read from here, so
/// the panel never swallows clicks over its large but invisible surrounding frame.
enum NotchLayout {
    /// Height of the expanded body below the notch, sized per tab so each surface
    /// fits its own content instead of one fixed box.
    static func expandedBodyHeight(tab: NotchState.ExpandedTab, hasInfoRow: Bool, trayEmpty: Bool) -> CGFloat {
        switch tab {
        case .home: return hasInfoRow ? 296 : 175
        case .media: return 220
        case .tray: return trayEmpty ? 180 : 246
        case .settings: return 250
        }
    }

    static func contentSize(presentation: NotchState.Presentation,
                            notch: CGSize,
                            tab: NotchState.ExpandedTab,
                            hasInfoRow: Bool,
                            trayEmpty: Bool,
                            hasCompactContent: Bool) -> CGSize {
        switch presentation {
        case .hidden:
            return notch
        case .compact:
            return CGSize(width: notch.width + (hasCompactContent ? 130 : 0),
                          height: notch.height + (hasCompactContent ? 4 : 0))
        case .expanded:
            let body = expandedBodyHeight(tab: tab, hasInfoRow: hasInfoRow, trayEmpty: trayEmpty)
            return CGSize(width: NotchMetrics.expandedWidth, height: body + notch.height)
        }
    }
}
