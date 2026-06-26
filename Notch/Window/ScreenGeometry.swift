import AppKit

/// Resolves the physical notch rectangle and the larger panel rectangle that
/// surrounds it. Recomputed on every display-parameter change.
struct ScreenGeometry: Equatable {
    let screen: NSScreen
    /// The black bezel notch, in screen coordinates (bottom-left origin).
    let notchFrame: NSRect
    /// The panel's frame: a region around the notch with room for the expanded
    /// body and HUD to draw.
    let panelFrame: NSRect
    /// Notch size in the panel's own (top-anchored) layout terms.
    let notchSize: CGSize
    let hasRealNotch: Bool

    static func == (lhs: ScreenGeometry, rhs: ScreenGeometry) -> Bool {
        // Compare geometry only. NSScreen is recreated on every screen-parameter
        // change, so including reference identity would defeat the dedup guard.
        // Frames are in global coordinates, so equal frames imply same placement.
        lhs.notchFrame == rhs.notchFrame && lhs.panelFrame == rhs.panelFrame
    }

    /// Build geometry for the best target screen (the built-in notched panel),
    /// falling back to the main screen with a simulated pill.
    static func current() -> ScreenGeometry {
        let screen = preferredScreen()
        let inset = screen.safeAreaInsets

        let hasRealNotch = inset.top > 0
        let notchHeight = hasRealNotch ? inset.top : NotchMetrics.fallbackNotchSize.height

        let notchWidth: CGFloat
        if hasRealNotch,
           let left = screen.auxiliaryTopLeftArea?.width,
           let right = screen.auxiliaryTopRightArea?.width {
            notchWidth = screen.frame.width - left - right
        } else {
            notchWidth = NotchMetrics.fallbackNotchSize.width
        }

        let frame = screen.frame
        let notchFrame = NSRect(
            x: frame.midX - notchWidth / 2,
            y: frame.maxY - notchHeight,
            width: notchWidth,
            height: notchHeight
        )

        let panelWidth = notchWidth + NotchMetrics.horizontalPadding * 2
        let panelHeight = notchHeight + NotchMetrics.verticalDrop
        let panelFrame = NSRect(
            x: frame.midX - panelWidth / 2,
            y: frame.maxY - panelHeight,
            width: panelWidth,
            height: panelHeight
        )

        return ScreenGeometry(
            screen: screen,
            notchFrame: notchFrame,
            panelFrame: panelFrame,
            notchSize: CGSize(width: notchWidth, height: notchHeight),
            hasRealNotch: hasRealNotch
        )
    }

    /// Prefer the built-in notched display; else the screen with the menu bar;
    /// else the first screen. Never assume `screens[0]` is built-in.
    private static func preferredScreen() -> NSScreen {
        if let notched = NSScreen.screens.first(where: { $0.safeAreaInsets.top > 0 }) {
            return notched
        }
        return NSScreen.main ?? NSScreen.screens.first ?? NSScreen()
    }
}
