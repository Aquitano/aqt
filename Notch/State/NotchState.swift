import SwiftUI

/// The two fields shown while a file is dragged onto the notch.
enum DropZone: Hashable {
    case keep   // stage on the shelf
    case share  // share immediately via the configured method
}

/// Single source of truth for what the notch is showing right now.
/// Owns the presentation phase and the active-activity selection; the feature
/// managers own their own data and publish into the SwiftUI environment.
@MainActor
@Observable
final class NotchState {

    enum Presentation: Equatable {
        case hidden     // panel ordered out, fully click-through
        case compact    // the pill / now-playing sliver hugging the bezel
        case expanded   // full panel
    }

    enum ExpandedTab: String, CaseIterable, Identifiable, Codable {
        case home, agents, media, timer, tray
        var id: String { rawValue }
        var title: String { rawValue.capitalized }
        var symbol: String {
            switch self {
            case .home: return "square.grid.2x2"
            case .agents: return "terminal"
            case .media: return "play.circle"
            case .timer: return "timer"
            case .tray: return "tray.full"
            }
        }
    }

    var presentation: Presentation = .hidden
    var isHovering: Bool = false
    var expandedTab: ExpandedTab = .home

    /// Injected reset target so the panel can reopen on a user-chosen tab
    /// without NotchState depending on Settings (this file also compiles into
    /// the host-less test target, which carries no Settings).
    var defaultTab: () -> ExpandedTab = { .home }

    /// True while a file drag is hovering the notch. Pins the panel open on the
    /// tray and suppresses the hover-out collapse so a flickering hover can't pull
    /// the drop target out from under the drag.
    var isDropActive: Bool = false

    /// Which drop field the pointer is currently over during a file drag, for the
    /// chooser's highlight. Set by the root drop delegate.
    var activeDropZone: DropZone?
    var activeDropRepresentation: TrayRepresentationKind?
    var isOptionMoveActive = false

    /// True from the start of a collapse until the close animation ends. Keeps the
    /// expanded body mounted (fading, clipped by the shrinking blob) for the whole
    /// close, then lets it drop so the idle compact pill carries no expanded content.
    var isCollapsing: Bool = false

    /// Mirrors `accessibilityReduceMotion`; the root view keeps it in sync so the
    /// transition helpers (which run outside the SwiftUI environment) can react.
    var reduceMotion: Bool = false

    var isExpanded: Bool { presentation == .expanded }
    var isVisible: Bool { presentation != .hidden }

    // MARK: - Transitions

    func hoverChanged(_ hovering: Bool) {
        isHovering = hovering
        if hovering {
            hoverExpand()
        } else {
            collapse()
        }
    }

    /// Pending hover-out collapse, cancelled if the pointer comes back. The grace
    /// period absorbs the brief `onHover` drop that happens when the pointer skims
    /// the menu-bar edge while reaching for the top tab row, so the panel no longer
    /// collapses out from under a click.
    private var collapseTask: Task<Void, Never>?

    /// A tab switch can shrink the panel, pulling the surface (and the floating
    /// dock) up out from under a stationary pointer; the resulting hover-exit
    /// must not close the panel the user just clicked in. Hover-out collapses
    /// requested before this deadline wait it out, giving the morph time to
    /// settle and the pointer time to land back on the moved surface.
    private var resizeHoldUntil: Date = .distantPast

    /// Drops `isCollapsing` once the close animation has finished.
    private var collapsingResetTask: Task<Void, Never>?

    /// Pending hover-driven expand. A short intent delay lets a quick scroll /
    /// middle-click on the pill cycle activities instead, and stops a cursor that
    /// merely skims the menu-bar edge from popping the panel open.
    private var expandTask: Task<Void, Never>?

    /// Immediate expand for programmatic callers (status-bar toggle, inbound drag).
    func expand() {
        cancelPendingExpand()
        collapseTask?.cancel()
        collapseTask = nil
        endCollapsing()
        guard presentation != .expanded else { return }
        withAnimation(NotchAnimation.open(reduceMotion: reduceMotion)) {
            presentation = .expanded
        }
    }

    /// Hover entry: expand after a brief intent delay.
    func hoverExpand() {
        collapseTask?.cancel()
        collapseTask = nil
        guard presentation != .expanded else { return }
        expandTask?.cancel()
        expandTask = Task { @MainActor [weak self] in
            // Brief intent delay so the pill's hover-swell reads before it opens.
            try? await Task.sleep(for: .milliseconds(210))
            guard let self, !Task.isCancelled else { return }
            self.expandTask = nil
            self.endCollapsing()
            withAnimation(NotchAnimation.open(reduceMotion: self.reduceMotion)) {
                self.presentation = .expanded
            }
        }
    }

    func cancelPendingExpand() {
        expandTask?.cancel()
        expandTask = nil
    }

    /// A file drag entered the notch: open straight to the tray (the file shelf)
    /// and hold it there for the duration of the drag. SwiftUI's drop targeting is
    /// unreliable when the panel only turns interactive partway through the drag
    /// session, so the window controller drives this directly.
    func beginDropTargeting() {
        isDropActive = true
        expand()
        select(tab: .tray)
    }

    func endDropTargeting() {
        // Leave `activeDropZone` for the drop delegate to consume. Mouse-up fires
        // both this (via the window controller) and SwiftUI's performDrop; clearing
        // the zone here would race that and misroute the drop to the shelf.
        isDropActive = false
        activeDropRepresentation = nil
        isOptionMoveActive = false
    }

    /// Collapse to the physical notch-sized hover target. The compact presentation
    /// remains on-screen even without side content; otherwise ordering the panel
    /// out would make the notch impossible to reopen by hovering it. `.hidden` is
    /// reserved for the explicit status-menu / keyboard toggle.
    func collapse() {
        guard !isDropActive else { return }
        cancelPendingExpand()
        collapseTask?.cancel()
        let grace = max(0.16, resizeHoldUntil.timeIntervalSinceNow + 0.16)
        collapseTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(grace))
            guard let self, !Task.isCancelled else { return }
            self.collapseTask = nil
            // The pointer may have settled back onto the moved surface during
            // the hold without a fresh hover event cancelling this task.
            guard !self.isHovering else { return }
            self.performCollapse()
        }
    }

    /// Collapse without the hover-exit grace period. Use when another app window
    /// is about to replace the notch as the active surface (for example Settings),
    /// so the expanded panel does not remain behind it while waiting for pointer
    /// tracking to notice the transition.
    func collapseImmediately() {
        guard !isDropActive else { return }
        cancelPendingExpand()
        collapseTask?.cancel()
        collapseTask = nil
        performCollapse()
    }

    private func performCollapse() {
        let target: Presentation = .compact
        guard presentation != target else { return }
        // Set `isCollapsing` before the state flip so the expanded body stays
        // mounted across it (fading + clipped by the blob) instead of unmounting
        // the instant `presentation` leaves `.expanded`. Only when closing from
        // the open panel; an already compact notch has nothing to retract.
        // Reset the tab only after the close completes (see `holdCollapsing`);
        // resetting it inside the close animation cross-fades the still-mounted
        // expanded body to home while it shrinks. An already compact notch has
        // no mounted body, so it can reset immediately.
        let wasExpanded = presentation == .expanded
        if wasExpanded {
            holdCollapsing()
        } else {
            expandedTab = defaultTab()
        }
        withAnimation(NotchAnimation.close(reduceMotion: reduceMotion)) {
            presentation = target
        }
    }

    /// Keep the expanded content mounted for one close cycle, then release it and
    /// reset the tab back to home.
    private func holdCollapsing() {
        isCollapsing = true
        collapsingResetTask?.cancel()
        collapsingResetTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(NotchAnimation.closeDuration + 0.1))
            guard let self, !Task.isCancelled else { return }
            self.isCollapsing = false
            self.expandedTab = self.defaultTab()
        }
    }

    private func endCollapsing() {
        collapsingResetTask?.cancel()
        collapsingResetTask = nil
        isCollapsing = false
    }

    func showCompact() {
        guard presentation == .hidden else { return }
        withAnimation(NotchAnimation.morph(reduceMotion: reduceMotion)) {
            presentation = .compact
        }
    }

    func hide() {
        cancelPendingExpand()
        collapseTask?.cancel()
        collapseTask = nil
        endCollapsing()
        guard presentation != .hidden else { return }
        withAnimation(NotchAnimation.close(reduceMotion: reduceMotion)) {
            presentation = .hidden
            expandedTab = defaultTab()
        }
    }

    func select(tab: ExpandedTab) {
        guard tab != expandedTab else { return }
        resizeHoldUntil = Date().addingTimeInterval(0.7)
        withAnimation(NotchAnimation.morph(reduceMotion: reduceMotion)) {
            expandedTab = tab
        }
    }
}
