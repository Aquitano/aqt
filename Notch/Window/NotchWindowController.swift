import AppKit
import SwiftUI
import Combine

/// Owns the overlay panel and the single SwiftUI tree hosted inside it.
/// Drives the panel on/off screen from `NotchState` + the HUD, keeps it pinned
/// to the notch across display changes, and stops rendering when occluded.
@MainActor
final class NotchWindowController {

    private let env: AppEnvironment
    private let panel: NotchPanel
    private let hostingView: NSHostingView<AnyView>
    private var geometry: ScreenGeometry
    private var cancellables = Set<AnyCancellable>()

    init(env: AppEnvironment) {
        self.env = env
        self.geometry = ScreenGeometry.current()

        self.panel = NotchPanel(contentRect: geometry.panelFrame)

        let root = NotchRootView()
            .environment(\.notchGeometry, geometry.notchSize)
            .injectNotchEnvironment(env)
        self.hostingView = NSHostingView(rootView: AnyView(root))
        hostingView.frame = NSRect(origin: .zero, size: geometry.panelFrame.size)
        hostingView.autoresizingMask = [.width, .height]
        // The panel frame is driven entirely by ScreenGeometry; if the hosting
        // view also propagated SwiftUI's sizing into AppKit it would re-enter
        // layout mid-pass (the "layoutSubtreeIfNeeded while already laying out"
        // warning) as the compact/expanded morph changes size.
        hostingView.sizingOptions = []
        // Let the SwiftUI layer be the only thing that ever paints.
        panel.contentView = hostingView

        panel.ignoresMouseEvents = true

        observe()
    }

    // MARK: - Wiring

    private func observe() {
        // Pin to the notch when displays change.
        NotificationCenter.default.publisher(for: NSApplication.didChangeScreenParametersNotification)
            .debounce(for: .milliseconds(150), scheduler: RunLoop.main)
            .sink { [weak self] _ in self?.recomputeGeometry() }
            .store(in: &cancellables)

        // Pause heavy work when the window is fully occluded (e.g. fullscreen app on top).
        NotificationCenter.default.publisher(for: NSWindow.didChangeOcclusionStateNotification, object: panel)
            .sink { [weak self] _ in self?.occlusionChanged() }
            .store(in: &cancellables)

        // On-screen whenever the notch is visible OR a HUD is showing.
        Publishers.CombineLatest(env.state.$presentation, env.hud.$isVisible)
            .receive(on: RunLoop.main)
            .sink { [weak self] presentation, hudVisible in
                self?.apply(presentation: presentation, hudVisible: hudVisible)
            }
            .store(in: &cancellables)
    }

    private func apply(presentation: NotchState.Presentation, hudVisible: Bool) {
        let shouldShow = presentation != .hidden || hudVisible
        if shouldShow {
            if !panel.isVisible {
                panel.orderFrontRegardless()
            }
        } else {
            panel.orderOut(nil)
        }
        // Only capture mouse events when there is interactive notch content.
        panel.ignoresMouseEvents = presentation == .hidden
    }

    private func recomputeGeometry() {
        let next = ScreenGeometry.current()
        guard next != geometry else { return }
        geometry = next
        panel.setFrame(next.panelFrame, display: true)
        hostingView.frame = NSRect(origin: .zero, size: next.panelFrame.size)
        hostingView.rootView = AnyView(
            NotchRootView()
                .environment(\.notchGeometry, next.notchSize)
                .injectNotchEnvironment(env)
        )
    }

    private func occlusionChanged() {
        let visible = panel.occlusionState.contains(.visible)
        env.setRenderingActive(visible)
    }

    // MARK: - Share sheet lifecycle

    /// Make the panel key and present the share sheet. The AirDrop sheet shows
    /// asynchronously, so we keep `presentingShareSheet` true until `endShareSheet()`
    /// is called from the sharing-service delegate (success, failure, or cancel).
    func beginShareSheet(_ perform: () -> Void) {
        panel.presentingShareSheet = true
        panel.makeKeyAndOrderFront(nil)
        perform()
    }

    func endShareSheet() {
        panel.presentingShareSheet = false
    }

    var window: NSWindow { panel }
}
