import AppKit
import NotchCore

/// The inputs that determine the notch's visible content rect, captured as one
/// value so the geometry can be computed away from the live `AppEnvironment`.
/// `NotchWindowController` reads the ~10 fields off `state`/`settings`/`tray`/
/// `media`/`activities` once to build this; everything downstream is pure.
struct LayoutSnapshot: Equatable {
    var presentation: NotchState.Presentation
    var notch: CGSize
    var expandedWidth: CGFloat = NotchMetrics.expandedWidth
    /// The full panel frame; the content rect is centered in it, pinned to the top.
    var panelFrame: CGRect
    var tab: NotchState.ExpandedTab
    /// Weather and/or calendar widget showing — taller home tab.
    var hasInfoRow: Bool
    var trayEmpty: Bool
    var compact: NotchLayout.CompactContent
    var dropActive: Bool
    /// Where the tab bar renders. The floating capsule sits below the blob, so
    /// the clickable region must extend down to cover it or the tabs are
    /// click-through; the other styles stay inside the blob's own rect.
    var tabBarStyle: TabBarStyle = .inside
    /// The compact pill is swollen while hovered; the region follows it.
    var hovering: Bool = false
}

/// Pure geometry: the visible content's rect in screen coordinates for a given
/// layout snapshot — centered on the notch, pinned to the top, sized by
/// `NotchLayout`. Pulled out of the controller so the sizing/positioning is a
/// table-test instead of something only observable through a fully-wired window.
enum HitRegion {
    static func rect(_ snapshot: LayoutSnapshot) -> CGRect {
        var size = NotchLayout.contentSize(
            presentation: snapshot.presentation,
            notch: snapshot.notch,
            expandedWidth: snapshot.expandedWidth,
            tab: snapshot.tab,
            hasInfoRow: snapshot.hasInfoRow,
            trayEmpty: snapshot.trayEmpty,
            compact: snapshot.compact,
            dropActive: snapshot.dropActive,
            tabBarStyle: snapshot.tabBarStyle
        )
        if snapshot.presentation == .compact, snapshot.hovering, !snapshot.dropActive {
            size = NotchLayout.hoverInflated(size)
        }
        // The drop chooser replaces the tabs, so the dock (and its region) is
        // only present outside a drag.
        let dockAllowance: CGFloat =
            snapshot.presentation == .expanded && snapshot.tabBarStyle == .floating && !snapshot.dropActive
                ? NotchLayout.floatingDockGap + NotchLayout.floatingDockHeight
                : 0
        return CGRect(
            x: snapshot.panelFrame.midX - size.width / 2,
            y: snapshot.panelFrame.maxY - size.height - dockAllowance,
            width: size.width,
            height: size.height + dockAllowance
        )
    }
}
