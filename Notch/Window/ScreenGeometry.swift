import AppKit

/// Resolves the physical notch rectangle and the larger panel rectangle that
/// surrounds it. Recomputed on every display-parameter change.
struct ScreenGeometry: Equatable {
    let display: DisplayDescriptor
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

    /// Resolve the selected display and build its geometry. Built-in placement
    /// falls back to main while docked with the lid closed.
    static func current(placement: DisplayPlacement) -> ScreenGeometry {
        let selection = DisplaySelectionPolicy.resolve(
            displays: DisplayInventory.current(), placement: placement
        )
        return make(for: selection.targets.first ?? DisplayInventory.fallback())
    }

    static func make(for display: DisplayDescriptor) -> ScreenGeometry {
        let hasRealNotch = display.hasPhysicalNotch
        let notchHeight = hasRealNotch ? display.safeAreaTop : NotchMetrics.fallbackNotchSize.height

        let notchWidth: CGFloat
        if hasRealNotch,
           let left = display.auxiliaryLeftWidth,
           let right = display.auxiliaryRightWidth {
            notchWidth = display.frame.width - left - right
        } else {
            notchWidth = NotchMetrics.fallbackNotchSize.width
        }

        let frame = display.frame
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
            display: display,
            notchFrame: notchFrame,
            panelFrame: panelFrame,
            notchSize: CGSize(width: notchWidth, height: notchHeight),
            hasRealNotch: hasRealNotch
        )
    }
}
