import SwiftUI
import AppKit

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
    /// Point size of the compact pill's trailing label. Shared with `CompactView`
    /// so the width reserved here matches exactly what gets drawn.
    static let compactLabelFontSize: CGFloat = 12

    /// What the compact pill is showing. Drives its width so the trailing slot
    /// fits the actual label instead of one fixed size that truncates longer text.
    enum CompactContent: Equatable {
        case none
        case media
        case activity(label: String)
    }

    /// Resolve the compact content from the live state. Media wins over an
    /// activity (mirrors `CompactView`), so all three readers stay in sync.
    static func compactContent(hasMedia: Bool, activityLabel: String?) -> CompactContent {
        if hasMedia { return .media }
        if let label = activityLabel { return .activity(label: label) }
        return .none
    }

    /// Width the compact pill adds around the notch for the given content.
    /// The pill is two equal slots flanking the centered notch gap, so the wider
    /// (text) slot sets the size; reserve the label width plus breathing on both
    /// sides, clamped so a short badge still reads as a pill and a long name
    /// truncates rather than growing the bezel without bound.
    static func compactExtraWidth(_ content: CompactContent) -> CGFloat {
        switch content {
        case .none:
            return 0
        case .media:
            return 130
        case let .activity(label):
            let font = NSFont.systemFont(ofSize: compactLabelFontSize, weight: .medium)
            let measured = (label as NSString).size(withAttributes: [.font: font]).width
            let slot = min(max(measured, 30), 120)
            return ceil(slot * 2) + 52
        }
    }

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

    /// Body height while a file drag is showing the two-zone drop chooser, so the
    /// store/share fields get a stable, comfortable size regardless of the tray.
    static let dropChooserHeight: CGFloat = 188

    static func contentSize(presentation: NotchState.Presentation,
                            notch: CGSize,
                            tab: NotchState.ExpandedTab,
                            hasInfoRow: Bool,
                            trayEmpty: Bool,
                            compact: CompactContent,
                            dropActive: Bool = false) -> CGSize {
        switch presentation {
        case .hidden:
            return notch
        case .compact:
            return CGSize(width: notch.width + compactExtraWidth(compact),
                          height: notch.height + (compact == .none ? 0 : 4))
        case .expanded:
            let body = dropActive
                ? dropChooserHeight
                : expandedBodyHeight(tab: tab, hasInfoRow: hasInfoRow, trayEmpty: trayEmpty)
            return CGSize(width: NotchMetrics.expandedWidth, height: body + notch.height)
        }
    }
}
