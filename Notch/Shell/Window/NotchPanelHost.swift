import AppKit
import NotchCore
import SwiftUI

/// One display-local panel and SwiftUI tree. Feature data is shared through the
/// app environment, while presentation state is local so all displays may keep a
/// compact hover target without expanding in lockstep.
@MainActor
final class NotchPanelHost {
    let displayKey: String
    let state: NotchState
    let panel: NotchPanel
    /// Hover target for the compact pill while `panel` is click-through.
    let hoverSensor: HoverSensorPanel

    private let env: AppEnvironment
    private let contentView = NotchContentView()
    private let hostingView: NSHostingView<AnyView>
    private(set) var geometry: ScreenGeometry
    private var showsHUD = false
    private var controlsSharedRendering = false

    /// The pointer moved over, entered, or left the panel while it was
    /// interactive. The controller re-derives hover and click-through from the
    /// pointer's position on every call.
    var onPointerEvent: (() -> Void)?
    var onHoverSensorEntered: (() -> Void)?

    init(env: AppEnvironment, geometry: ScreenGeometry, state: NotchState) {
        self.env = env
        self.displayKey = geometry.display.key
        self.geometry = geometry
        self.state = state
        self.panel = NotchPanel(contentRect: geometry.panelFrame)
        self.hoverSensor = HoverSensorPanel()
        self.hostingView = NSHostingView(rootView: AnyView(EmptyView()))
        hoverSensor.onEnter = { [weak self] in self?.onHoverSensorEntered?() }

        hostingView.frame = NSRect(origin: .zero, size: geometry.panelFrame.size)
        hostingView.autoresizingMask = [.width, .height]
        hostingView.sizingOptions = []
        contentView.addSubview(hostingView)
        contentView.onPointerEvent = { [weak self] in self?.onPointerEvent?() }
        panel.contentView = contentView
        panel.ignoresMouseEvents = true

        rebuildRoot()
    }

    func update(
        geometry: ScreenGeometry,
        showsHUD: Bool,
        controlsSharedRendering: Bool
    ) {
        let geometryChanged = geometry != self.geometry
        let roleChanged = showsHUD != self.showsHUD
            || controlsSharedRendering != self.controlsSharedRendering
        self.geometry = geometry
        self.showsHUD = showsHUD
        self.controlsSharedRendering = controlsSharedRendering

        if geometryChanged {
            panel.setFrame(geometry.panelFrame, display: true)
            hostingView.frame = NSRect(origin: .zero, size: geometry.panelFrame.size)
        }
        if geometryChanged || roleChanged { rebuildRoot() }
    }

    func applyVisibility(hudVisible: Bool) {
        let shouldShow = state.presentation != .hidden || (showsHUD && hudVisible)
        if shouldShow {
            if !panel.isVisible { panel.orderFrontRegardless() }
        } else {
            panel.orderOut(nil)
        }
    }

    func orderOut() {
        panel.orderOut(nil)
        hoverSensor.orderOut(nil)
    }

    private func rebuildRoot() {
        let root = NotchRootView(showsHUD: showsHUD)
            .environment(\.notchGeometry, geometry.notchSize)
            .environment(\.notchExpandedWidth, geometry.expandedWidth)
            .environment(\.notchUsesVirtualChrome, geometry.usesVirtualChrome)
            .environment(\.notchControlsSharedRendering, controlsSharedRendering)
            .environment(\.notchDisplayKey, displayKey)
            .injectNotchEnvironment(env, state: state)
        hostingView.rootView = AnyView(root)
    }
}

/// The panel's root view: hosts the SwiftUI tree and reports pointer motion
/// over the whole panel frame. Hover is decided by the controller from the
/// pointer's position against the content's hit rect, not by SwiftUI hit
/// testing, so a blob that morphs under a stationary pointer or a gap between
/// the blob and its floating dock cannot produce a spurious exit.
private final class NotchContentView: NSView {
    var onPointerEvent: (() -> Void)?

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        for area in trackingAreas { removeTrackingArea(area) }
        addTrackingArea(NSTrackingArea(
            rect: bounds,
            options: [.mouseEnteredAndExited, .mouseMoved, .activeAlways, .inVisibleRect],
            owner: self
        ))
    }

    override func mouseEntered(with event: NSEvent) { onPointerEvent?() }
    override func mouseMoved(with event: NSEvent) { onPointerEvent?() }
    override func mouseExited(with event: NSEvent) { onPointerEvent?() }
}
