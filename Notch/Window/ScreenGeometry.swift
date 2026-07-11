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
    let usesVirtualChrome: Bool
    let expandedWidth: CGFloat

    static func == (lhs: ScreenGeometry, rhs: ScreenGeometry) -> Bool {
        // Compare geometry only. NSScreen is recreated on every screen-parameter
        // change, so including reference identity would defeat the dedup guard.
        // Frames are in global coordinates, so equal frames imply same placement.
        lhs.notchFrame == rhs.notchFrame
            && lhs.panelFrame == rhs.panelFrame
            && lhs.expandedWidth == rhs.expandedWidth
    }

    /// Resolve the selected display and build its geometry. Built-in placement
    /// falls back to main while docked with the lid closed.
    static func current(
        placement: DisplayPlacement,
        followActiveDisplay: Bool,
        activeDisplayKey: String?,
        profiles: [DisplayProfile],
        virtualMode: VirtualNotchMode = .automatic
    ) -> ScreenGeometry {
        let selection = DisplaySelectionPolicy.resolve(
            displays: DisplayInventory.current(), placement: placement,
            followActiveDisplay: followActiveDisplay,
            activeDisplayKey: activeDisplayKey
        )
        let target = selection.targets.first ?? DisplayInventory.fallback()
        let profile = profiles.first(where: { $0.displayKey == target.key })
            ?? .standard(for: target.key)
        return make(for: target, profile: profile, virtualMode: virtualMode)
    }

    static func make(
        for display: DisplayDescriptor,
        profile: DisplayProfile,
        virtualMode: VirtualNotchMode = .automatic
    ) -> ScreenGeometry {
        let profile = profile.normalized
        let hasRealNotch = display.hasPhysicalNotch
        let baseHeight = hasRealNotch ? display.safeAreaTop : NotchMetrics.fallbackNotchSize.height
        let minimumHeight = hasRealNotch ? display.safeAreaTop : 24
        let notchHeight = max(minimumHeight, baseHeight + profile.compactHeightAdjustment)

        let measuredWidth: CGFloat
        if hasRealNotch,
           let left = display.auxiliaryLeftWidth,
           let right = display.auxiliaryRightWidth {
            measuredWidth = display.frame.width - left - right
        } else {
            measuredWidth = NotchMetrics.fallbackNotchSize.width
        }
        let minimumWidth = hasRealNotch ? measuredWidth : 160
        let notchWidth = max(minimumWidth, measuredWidth + profile.compactWidthAdjustment)

        let frame = display.frame
        // Never move the interactive gap away from a physical camera housing.
        let horizontalOffset = hasRealNotch ? 0 : profile.horizontalOffset
        let verticalOffset = hasRealNotch ? 0 : profile.verticalOffset
        let requestedExpandedWidth = CGFloat(
            (Double(NotchMetrics.expandedWidth) + profile.expandedWidthAdjustment)
                .clamped(to: 460...720)
        )
        let expandedWidth = min(requestedExpandedWidth, max(420, frame.width - 24))
        let panelWidth = min(frame.width, max(
            notchWidth + NotchMetrics.horizontalPadding * 2,
            expandedWidth + 80
        ))
        let panelHeight = notchHeight + NotchMetrics.verticalDrop
        let requestedCenterX = frame.midX + horizontalOffset
        let panelCenterX = requestedCenterX.clamped(
            to: (frame.minX + panelWidth / 2)...(frame.maxX - panelWidth / 2)
        )
        // SwiftUI centers the visible notch inside the panel, so both frames must
        // share the clamped center or drawing and hit-testing diverge near an edge.
        let notchFrame = NSRect(
            x: panelCenterX - notchWidth / 2,
            y: frame.maxY - verticalOffset - notchHeight,
            width: notchWidth,
            height: notchHeight
        )
        let panelFrame = NSRect(
            x: panelCenterX - panelWidth / 2,
            y: notchFrame.maxY - panelHeight,
            width: panelWidth,
            height: panelHeight
        )

        return ScreenGeometry(
            display: display,
            notchFrame: notchFrame,
            panelFrame: panelFrame,
            notchSize: CGSize(width: notchWidth, height: notchHeight),
            hasRealNotch: hasRealNotch,
            usesVirtualChrome: virtualMode.usesVirtualChrome(for: display),
            expandedWidth: expandedWidth
        )
    }
}

private extension CGFloat {
    func clamped(to range: ClosedRange<CGFloat>) -> CGFloat {
        guard range.lowerBound <= range.upperBound else { return range.lowerBound }
        return Swift.min(Swift.max(self, range.lowerBound), range.upperBound)
    }
}
