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
    private var mouseMonitors: [Any] = []

    /// True while an inbound file drag is hovering the notch; keeps the panel
    /// interactive so SwiftUI's `onDrop` can land the drop (see `setupMouseTracking`).
    private var isDragSessionActive = false

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
        setupMouseTracking()
    }

    deinit {
        for monitor in mouseMonitors { NSEvent.removeMonitor(monitor) }
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
        updatePassthrough()
    }

    // MARK: - Click-through

    /// The panel frame is far larger than the visible notch content (it reserves
    /// room for the expanded body + HUD), so capturing events across the whole
    /// frame would make a wide, tall, invisible region of the screen unclickable.
    /// Instead we let events pass through everywhere except the actual visible
    /// content rect, recomputed as the pointer moves and as the content resizes.
    private func setupMouseTracking() {
        let globalMove = NSEvent.addGlobalMonitorForEvents(matching: [.mouseMoved]) { [weak self] _ in
            self?.pointerMoved()
        }
        let localMove = NSEvent.addLocalMonitorForEvents(matching: [.mouseMoved]) { [weak self] event in
            self?.pointerMoved()
            return event
        }
        // A file drag from another app posts dragged events (never mouseMoved) while
        // the panel is click-through, so the move monitors above never fire and the
        // drop is silently missed. Track the drag explicitly and open the panel to
        // events once the pointer reaches the notch, then let `onDrop` take over.
        let globalDrag = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDragged]) { [weak self] _ in
            self?.dragMoved()
        }
        let globalUp = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseUp]) { [weak self] _ in
            self?.dragEnded()
        }
        mouseMonitors = [globalMove, localMove, globalDrag, globalUp].compactMap { $0 }
    }

    /// A real pointer move cannot happen mid drag-session, so any drag state is
    /// stale by the time one arrives — clear it before restoring passthrough.
    private func pointerMoved() {
        isDragSessionActive = false
        updatePassthrough()
    }

    /// While a file drag hovers the notch's catch area, make the panel interactive
    /// so the drop registers. Once the notch commits to expanding it stays
    /// interactive (the `.expanded` case below); if the drag leaves first, restore
    /// click-through so other drop targets underneath aren't blocked.
    private func dragMoved() {
        guard panel.isVisible else { return }
        if dragDropZone().contains(NSEvent.mouseLocation) {
            guard !isDragSessionActive else { return }
            isDragSessionActive = true
            panel.ignoresMouseEvents = false
        } else if isDragSessionActive, env.state.presentation != .expanded {
            isDragSessionActive = false
            updatePassthrough()
        }
    }

    private func dragEnded() {
        guard isDragSessionActive else { return }
        isDragSessionActive = false
        // A drag that only flew over the notch (dropped elsewhere) leaves it
        // expanded with no hover to close it; collapse unless the drop landed here.
        if env.state.presentation == .expanded,
           !interactiveContentRect().contains(NSEvent.mouseLocation) {
            env.state.collapse(hasCompactContent: true)
        }
        updatePassthrough()
    }

    /// Generous catch area around the bezel for an inbound file drag: wider and
    /// taller than the visible pill so a drag can aim loosely at the notch, but far
    /// smaller than the full panel frame so drags toward the screen corners don't
    /// trip it.
    private func dragDropZone() -> NSRect {
        let width = geometry.notchSize.width + 200
        let drop: CGFloat = 90
        return NSRect(
            x: geometry.notchFrame.midX - width / 2,
            y: geometry.notchFrame.minY - drop,
            width: width,
            height: geometry.notchFrame.height + drop
        )
    }

    private func updatePassthrough() {
        guard panel.isVisible else { return }
        if isDragSessionActive {
            panel.ignoresMouseEvents = false
            return
        }
        switch env.state.presentation {
        case .expanded:
            // The panel is visibly present and auto-collapses on exit, so keep it
            // interactive. Toggling passthrough here would make AppKit fire a
            // spurious mouseExited and collapse the panel mid-interaction.
            panel.ignoresMouseEvents = false
        case .hidden:
            // Hidden (HUD may still be showing, but it is informational).
            panel.ignoresMouseEvents = true
        case .compact:
            // Only the small pill is interactive; the rest of the large panel
            // frame must pass clicks through to whatever is beneath it.
            let hit = interactiveContentRect().insetBy(dx: -4, dy: -4)
            panel.ignoresMouseEvents = !hit.contains(NSEvent.mouseLocation)
        }
    }

    /// The visible content's rect in screen coordinates: centered on the notch,
    /// pinned to the top, sized by `NotchLayout` for the current state.
    private func interactiveContentRect() -> NSRect {
        let size = NotchLayout.contentSize(
            presentation: env.state.presentation,
            notch: geometry.notchSize,
            tab: env.state.expandedTab,
            hasInfoRow: env.settings.showWeatherWidget || env.settings.showCalendarWidget,
            trayEmpty: env.tray.items.isEmpty,
            hasCompactContent: env.activities.compactActivity != nil || !env.media.track.isEmpty
        )
        return NSRect(
            x: geometry.panelFrame.midX - size.width / 2,
            y: geometry.panelFrame.maxY - size.height,
            width: size.width,
            height: size.height
        )
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
