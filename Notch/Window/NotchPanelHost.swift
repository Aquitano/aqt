import AppKit
import Combine
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
    private let hostingView: NSHostingView<AnyView>
    private(set) var geometry: ScreenGeometry
    private var showsHUD = false
    private var controlsSharedRendering = false
    private var cancellables = Set<AnyCancellable>()

    var onPresentationChange: ((NotchState.Presentation) -> Void)?
    var onTabChange: ((NotchState.ExpandedTab) -> Void)?
    var onHoverChange: ((Bool) -> Void)?
    var onHoverSensorEntered: (() -> Void)?

    init(env: AppEnvironment, geometry: ScreenGeometry) {
        self.env = env
        self.displayKey = geometry.display.key
        self.geometry = geometry
        self.state = NotchState()
        state.defaultTab = { env.settings.resolvedDefaultTab }
        state.expandedTab = env.settings.resolvedDefaultTab
        self.panel = NotchPanel(contentRect: geometry.panelFrame)
        self.hoverSensor = HoverSensorPanel()
        self.hostingView = NSHostingView(rootView: AnyView(EmptyView()))
        hoverSensor.onEnter = { [weak self] in self?.onHoverSensorEntered?() }

        hostingView.frame = NSRect(origin: .zero, size: geometry.panelFrame.size)
        hostingView.autoresizingMask = [.width, .height]
        hostingView.sizingOptions = []
        panel.contentView = hostingView
        panel.ignoresMouseEvents = true

        state.$presentation
            .dropFirst()
            .sink { [weak self] in self?.onPresentationChange?($0) }
            .store(in: &cancellables)
        state.$expandedTab
            .dropFirst()
            .sink { [weak self] in self?.onTabChange?($0) }
            .store(in: &cancellables)
        state.$isHovering
            .dropFirst()
            .removeDuplicates()
            .sink { [weak self] in self?.onHoverChange?($0) }
            .store(in: &cancellables)

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
            .injectNotchEnvironment(env, state: state)
        hostingView.rootView = AnyView(root)
    }
}
