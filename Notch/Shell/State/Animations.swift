import SwiftUI
import NotchCore
import AppKit

/// The "Apple feel" lives here: one asymmetric spring set, ~0.4s each.
/// Open and close both settle without overshoot, compact<->expanded snaps. Reduce Motion
/// swaps every curve for a non-bouncy `.smooth`.
enum NotchAnimation {

    /// A critically damped spring: fast out of the gate, decelerating into
    /// place with no overshoot, so the body never rebounds after it lands.
    static func open(reduceMotion: Bool) -> Animation {
        .smooth(duration: reduceMotion ? 0.35 : 0.4)
    }

    /// The expanded content fades in once the blob has mostly landed, and
    /// drops out quickly on close so nothing lingers inside a shrinking body.
    static func contentReveal(expanded: Bool, reduceMotion: Bool) -> Animation {
        if reduceMotion { return .smooth(duration: 0.2) }
        return expanded ? .easeOut(duration: 0.2).delay(0.14) : .easeIn(duration: 0.12)
    }

    /// Duration of the close/collapse. Also gates how long the expanded content
    /// stays mounted (fading, clipped by the blob) before it is dropped.
    static let closeDuration: TimeInterval = 0.4

    static func close(reduceMotion: Bool) -> Animation {
        .smooth(duration: closeDuration)
    }

    static func morph(reduceMotion: Bool) -> Animation {
        reduceMotion ? .smooth(duration: 0.35) : .snappy(duration: 0.4)
    }

    /// One-shot pop for a new track / new activity. Used as a phaseAnimator curve.
    static let pop: Animation = .spring(response: 0.32, dampingFraction: 0.55)

    /// Gentle swell while the cursor rests on the compact pill, before it opens.
    static func hoverGrow(reduceMotion: Bool) -> Animation {
        .smooth(duration: reduceMotion ? 0.18 : 0.22)
    }

    /// Widget-grid editing: tiles sliding aside during a reorder drag, and
    /// add/remove layout changes. Tight, no bounce — slots should open crisply.
    static let reorder: Animation = .spring(response: 0.28, dampingFraction: 0.85)
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

    /// Concave shoulder inset of the blob at a given width, matching the curve in
    /// `NotchShape.path`. The *visible* body starts this far in from each edge, so
    /// anything that draws inside the blob (the compact pill) must clear it or it
    /// slips under the rounded corner. Shared so the shape and the content can't
    /// disagree about where the body actually begins.
    static func shoulderInset(width: CGFloat, notchWidth: CGFloat) -> CGFloat {
        guard notchWidth > 0 else { return 0 }
        return min(width / 2, max(0, (width - notchWidth) / 18))
    }
}

/// Single source of truth for the visible content's size per presentation state.
/// Both the SwiftUI tree (to lay out) and the window controller (to scope the
/// panel's clickable region to exactly the visible content) read from here, so
/// the panel never swallows clicks over its large but invisible surrounding frame.
enum NotchLayout {
    /// Point size of the compact pill's trailing label. Shared with `CompactView`
    /// so the width reserved here matches exactly what gets drawn. Deliberately
    /// fixed (no Dynamic Type): the pill must fit the physical notch strip, whose
    /// height doesn't scale with the user's text size.
    static let compactLabelFontSize: CGFloat = 12

    /// Resting horizontal padding the compact pill keeps clear of the rounded
    /// corners. The width reserved in `compactExtraWidth` is derived from it, so
    /// the estimate and the drawn pill share one constant.
    static let compactHorizontalPadding: CGFloat = 18

    /// Minimum gap kept between the pill content and the blob's *visible* shoulder
    /// edge. The shoulder grows with the blob's width (see `shoulderInset`), so a
    /// fixed padding would let the leading icon slide under the corner whenever the
    /// blob is momentarily wide (entrance grow, morph, a wider status label). The
    /// padding tracks the shoulder instead, holding this gap at any width.
    static let compactShoulderGap: CGFloat = 9

    /// Horizontal padding the compact pill applies for its current on-screen width:
    /// enough to clear the blob's shoulder at that width plus `compactShoulderGap`,
    /// never less than the resting padding. Because the content fills the blob, the
    /// width is the live (animating) blob width, so the icon stays clear of the
    /// corner through every transition instead of only at rest.
    static func compactOuterPadding(width: CGFloat, notchWidth: CGFloat) -> CGFloat {
        max(compactHorizontalPadding,
            NotchMetrics.shoulderInset(width: width, notchWidth: notchWidth) + compactShoulderGap)
    }

    /// Breathing room added inside each slot beyond its content's measured width.
    static let compactSlotInset: CGFloat = 12

    /// What the compact pill is showing. Drives its width so the trailing slot
    /// fits the actual label instead of one fixed size that truncates longer text.
    enum CompactContent: Equatable {
        case none
        case media
        /// An agent pill. Its status label changes constantly (running -> tool ->
        /// editing ...); reserving per-label would resize the pill on every change
        /// and shove the leading icon under the rounded corner mid-transition, so
        /// the agent pill sizes once for the widest status label. Only the session
        /// count (rare) changes its width, via the per-session glyph strip.
        case agent(count: Int)
        case activity(label: String)
    }

    /// Resolve the compact content from the live state. Media wins over an
    /// activity (mirrors `CompactView`), so all three readers stay in sync. An
    /// agent activity is its own fixed-width case so status changes don't resize.
    static func compactContent(
        hasMedia: Bool,
        agentCount: Int?,
        activityLabel: String?,
        trayItemCount: Int = 0
    ) -> CompactContent {
        if hasMedia { return .media }
        if let agentCount { return .agent(count: agentCount) }
        if let label = activityLabel { return .activity(label: label) }
        if trayItemCount > 0 {
            return .activity(label: trayItemCount == 1 ? "1 item" : "\(trayItemCount) items")
        }
        return .none
    }

    // Agent pill metrics, shared between the width reserved here and the views
    // that draw it (`CompactView` / `PixelWorkingIndicator`) so they can't drift.
    static let agentGlyphWidth: CGFloat = 13.5
    static let agentStatusGap: CGFloat = 7
    static let agentCountGap: CGFloat = 5
    static let agentSessionsFontSize: CGFloat = 11

    /// Slot width for the agent pill: one spinner glyph + the widest status
    /// label on one side, "N sessions" on the other. Sized for the widest status
    /// so state changes never resize; only the session count (rare) does.
    static func compactAgentSlotWidth(count: Int) -> CGFloat {
        let strip = agentGlyphWidth
        let statusFont = NSFont.systemFont(ofSize: compactLabelFontSize, weight: .medium)
        // Mirrors ActivityPresenter.agentCompactStatus's possible labels.
        let widestStatus = ["Running", "Editing", "Working", "Needs you", "Done", "Idle"]
            .map { ($0 as NSString).size(withAttributes: [.font: statusFont]).width }
            .max() ?? 60
        let leading = strip + agentStatusGap + widestStatus
        let countFont = NSFont.systemFont(ofSize: compactLabelFontSize, weight: .bold)
        let sessionsFont = NSFont.monospacedSystemFont(ofSize: agentSessionsFontSize, weight: .medium)
        let trailing = ("\(min(max(count, 1), 99))" as NSString)
            .size(withAttributes: [.font: countFont]).width
            + agentCountGap
            + ("sessions" as NSString).size(withAttributes: [.font: sessionsFont]).width
        return min(max(leading, trailing), 170) + compactSlotInset
    }

    /// Width of each of the two equal slots flanking the centered notch gap.
    /// Both sides reserve the same width so the gap stays aligned with the
    /// physical notch; `CompactView` lays its slots out at exactly this value and
    /// the pill's total width is derived from it, so the drawn content and the
    /// reserved width share a single source. The label width is clamped so a
    /// short badge still reads as a pill and a long name truncates rather than
    /// growing the bezel without bound.
    static func compactSlotWidth(_ content: CompactContent) -> CGFloat {
        switch content {
        case .none:
            return 0
        case .media:
            return 47
        case let .agent(count):
            return compactAgentSlotWidth(count: count)
        case let .activity(label):
            let font = NSFont.systemFont(ofSize: compactLabelFontSize, weight: .medium)
            let measured = (label as NSString).size(withAttributes: [.font: font]).width
            return min(max(measured, 30), 120) + compactSlotInset
        }
    }

    /// Width the compact pill adds around the notch: two equal slots plus the
    /// outer padding. This is the *estimate* used for the first frame and for the
    /// window controller's hit region; the on-screen pill refines the visible
    /// width from its measured content (see `CompactView`) so the blob always
    /// fits what it draws.
    static func compactExtraWidth(_ content: CompactContent) -> CGFloat {
        content == .none ? 0 : ceil(compactSlotWidth(content) * 2) + compactHorizontalPadding * 2
    }

    /// Height of the expanded body below the notch, sized per tab so each surface
    /// fits its own content instead of one fixed box.
    static func expandedBodyHeight(tab: NotchState.ExpandedTab, hasInfoRow: Bool, trayEmpty: Bool) -> CGFloat {
        switch tab {
        case .home: return hasInfoRow ? 296 : 175
        case .agents: return 320
        case .media: return 220
        case .timer: return 240
        case .tray: return trayEmpty ? 204 : 286
        }
    }

    /// Body height while a file drag is showing the two-zone drop chooser, so the
    /// store/share fields get a stable, comfortable size regardless of the tray.
    static let dropChooserHeight: CGFloat = 188

    /// Vertical room the in-blob tab strip occupies (strip + the stack spacing
    /// under it). Every other tab bar style renders outside the body — a capsule
    /// below the blob, or icons in the notch band — so the blob gives this back.
    static let tabStripAllowance: CGFloat = 52
    static let floatingDockGap: CGFloat = 8
    static let floatingDockHeight: CGFloat = 44

    /// How far the shoulder tab row sits below the top of the blob. Zero keeps the
    /// icons level with the physical cutout, which is the point of the design; the
    /// menu-bar band can be unreliable about clicks that close to the bezel, so
    /// this is the one number to nudge if they turn out flaky.
    static let shoulderRowTopInset: CGFloat = 0

    /// How much the compact pill grows while hovered: the body widens past the
    /// notch on both sides and drops a little, so the swell reads as the island
    /// lifting off the bezel rather than a scaled bitmap whose top edge sticks
    /// out beside the physical cutout.
    static let hoverInflation = CGSize(width: 18, height: 8)

    static func hoverInflated(_ size: CGSize) -> CGSize {
        CGSize(width: size.width + hoverInflation.width, height: size.height + hoverInflation.height)
    }

    static func contentSize(presentation: NotchState.Presentation,
                            notch: CGSize,
                            expandedWidth: CGFloat = NotchMetrics.expandedWidth,
                            tab: NotchState.ExpandedTab,
                            hasInfoRow: Bool,
                            trayEmpty: Bool,
                            compact: CompactContent,
                            dropActive: Bool = false,
                            tabBarStyle: TabBarStyle = .inside) -> CGSize {
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
                    - (tabBarStyle == .inside ? 0 : tabStripAllowance)
            return CGSize(width: expandedWidth, height: body + notch.height)
        }
    }
}
