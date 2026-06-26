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
    /// `NotchRootView.expandedBodyHeight`) so each surface fits its own content.
    static let expandedWidth: CGFloat = 540
}
