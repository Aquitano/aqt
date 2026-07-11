import AppKit
import Combine
import SwiftUI

/// Coordinates one display-local panel host per selected screen. Feature data
/// remains shared, but presentation is local so every display can keep a compact
/// hover target while expansion and key-capable interactions stay exclusive.
@MainActor
final class NotchWindowController {
    private let env: AppEnvironment
    private var hosts: [String: NotchPanelHost] = [:]
    private var interactionHostKey: String?
    private var activeDisplayKey: String?
    private var activeDisplayCandidate: String?
    private var activeDisplayTask: Task<Void, Never>?
    private var cancellables = Set<AnyCancellable>()
    private var mouseMonitors: [Any] = []
    private var handlingHostChange = false

    private var isDragSessionActive = false
    private var dragHostKey: String?
    private var cycleCooldown = false

    /// Anchor for AppKit popovers such as the sharing picker.
    var panelContentView: NSView? { interactionHost?.panel.contentView }

    private var interactionHost: NotchPanelHost? {
        interactionHostKey.flatMap { hosts[$0] }
            ?? activeDisplayKey.flatMap { hosts[$0] }
            ?? hosts.values.first
    }

    init(env: AppEnvironment) {
        self.env = env
        self.activeDisplayKey = DisplayInventory.displayKey(containing: NSEvent.mouseLocation)
        reconcileHosts()
        observe()
        setupMouseTracking()
    }

    func stop() {
        activeDisplayTask?.cancel()
        for monitor in mouseMonitors { NSEvent.removeMonitor(monitor) }
        mouseMonitors.removeAll()
        for host in hosts.values { host.orderOut() }
    }

    // MARK: - Host inventory

    private func reconcileHosts() {
        var inventory = DisplayInventory.current()
        if inventory.isEmpty { inventory = [DisplayInventory.fallback()] }
        let selection = DisplaySelectionPolicy.resolve(
            displays: inventory,
            placement: env.settings.displayPlacement,
            followActiveDisplay: env.settings.followActiveDisplay,
            activeDisplayKey: activeDisplayKey
        )
        let targets = selection.targets.isEmpty ? [inventory[0]] : selection.targets
        let desiredKeys = Set(targets.map(\.key))

        prepareInteractionHostForRemoval(desiredKeys: desiredKeys)

        for key in Array(hosts.keys) where !desiredKeys.contains(key) {
            hosts[key]?.orderOut()
            hosts[key]?.onPresentationChange = nil
            hosts[key]?.onTabChange = nil
            hosts[key] = nil
        }

        for display in targets {
            let profile = env.settings.displayProfile(for: display.key)
            let geometry = ScreenGeometry.make(
                for: display, profile: profile,
                virtualMode: env.settings.virtualNotchMode
            )
            if let host = hosts[display.key] {
                host.update(
                    geometry: geometry,
                    showsHUD: false,
                    controlsSharedRendering: false
                )
            } else {
                let host = NotchPanelHost(env: env, geometry: geometry)
                host.state.expandedTab = env.state.expandedTab
                host.onPresentationChange = { [weak self] presentation in
                    self?.hostPresentationChanged(displayKey: display.key, presentation: presentation)
                }
                host.onTabChange = { [weak self] tab in
                    self?.hostTabChanged(displayKey: display.key, tab: tab)
                }
                hosts[display.key] = host
            }
        }

        interactionHostKey = DisplayHostPolicy.interactionKey(
            availableKeys: desiredKeys,
            current: interactionHostKey,
            active: activeDisplayKey
        )
        updateHostRoles()
        syncGlobalPresentation(env.state.presentation)
        applyAll()
    }

    private func prepareInteractionHostForRemoval(desiredKeys: Set<String>) {
        guard let key = interactionHostKey, let host = hosts[key] else { return }
        let hasTransientInteraction = host.panel.presentingShareSheet
            || host.panel.editingText
            || (isDragSessionActive && dragHostKey == key)
        let instruction = DisplayHostMigrationPolicy.instruction(
            targetStillAvailable: desiredKeys.contains(key),
            wasExpanded: host.state.presentation == .expanded,
            wasHovering: host.state.isHovering,
            hasTransientInteraction: hasTransientInteraction
        )

        switch instruction {
        case .keepPresentation, .restoreProgrammaticExpansion:
            break
        case .collapse:
            env.state.collapseImmediately()
        case .endTransientInteractionAndCollapse:
            host.panel.presentingShareSheet = false
            host.panel.editingText = false
            if dragHostKey == key {
                isDragSessionActive = false
                dragHostKey = nil
                host.state.endDropTargeting()
            }
            env.state.collapseImmediately()
        }
    }

    /// HUD and shared capture lifecycle belong to one host. Rebuild the old role
    /// holders first and the new primary last, so a secondary CompactView cannot
    /// stop capture after the new primary has started it.
    private func updateHostRoles() {
        let primaryKey = DisplayHostPolicy.primaryKey(
            availableKeys: Set(hosts.keys),
            active: activeDisplayKey,
            interaction: interactionHostKey
        )
        let orderedKeys = hosts.keys.sorted { lhs, rhs in
            if lhs == primaryKey { return false }
            if rhs == primaryKey { return true }
            return lhs < rhs
        }
        for key in orderedKeys {
            guard let host = hosts[key] else { continue }
            host.update(
                geometry: host.geometry,
                showsHUD: key == primaryKey,
                controlsSharedRendering: key == primaryKey
            )
        }
    }

    // MARK: - State synchronization

    private func hostPresentationChanged(
        displayKey: String,
        presentation: NotchState.Presentation
    ) {
        guard !handlingHostChange, let host = hosts[displayKey] else { return }
        handlingHostChange = true
        defer { handlingHostChange = false }

        switch presentation {
        case .expanded:
            interactionHostKey = displayKey
            for other in hosts.values where other.displayKey != displayKey {
                makeCompact(other.state)
            }
            if env.state.expandedTab != host.state.expandedTab {
                env.state.expandedTab = host.state.expandedTab
            }
            if env.state.presentation != .expanded { env.state.expand() }
            updateHostRoles()

        case .compact:
            if interactionHostKey == displayKey,
               env.state.presentation == .expanded {
                env.state.collapseImmediately()
            }

        case .hidden:
            break
        }
        applyAll()
    }

    private func hostTabChanged(displayKey: String, tab: NotchState.ExpandedTab) {
        guard !handlingHostChange, interactionHostKey == displayKey else { return }
        if env.state.expandedTab != tab { env.state.expandedTab = tab }
    }

    private func syncGlobalPresentation(_ presentation: NotchState.Presentation) {
        guard !handlingHostChange else { return }
        handlingHostChange = true
        defer { handlingHostChange = false }

        if presentation == .expanded {
            chooseInteractionHostAtPointer()
        }
        for host in hosts.values {
            switch presentation {
            case .hidden:
                host.state.hide()
            case .compact:
                makeCompact(host.state)
            case .expanded:
                if host.displayKey == interactionHostKey {
                    if host.state.expandedTab != env.state.expandedTab {
                        host.state.expandedTab = env.state.expandedTab
                    }
                    host.state.expand()
                } else {
                    makeCompact(host.state)
                }
            }
        }
        updateHostRoles()
        applyAll()
    }

    private func makeCompact(_ state: NotchState) {
        switch state.presentation {
        case .hidden: state.showCompact()
        case .expanded: state.collapseImmediately()
        case .compact: break
        }
    }

    private func chooseInteractionHostAtPointer() {
        if let key = DisplayInventory.displayKey(containing: NSEvent.mouseLocation),
           hosts[key] != nil {
            activeDisplayKey = key
            interactionHostKey = key
        } else if interactionHostKey.flatMap({ hosts[$0] }) == nil {
            interactionHostKey = hosts.keys.sorted().first
        }
    }

    // MARK: - Wiring

    private func observe() {
        NotificationCenter.default.publisher(for: NSApplication.didChangeScreenParametersNotification)
            .debounce(for: .milliseconds(180), scheduler: RunLoop.main)
            .sink { [weak self] _ in self?.topologyChanged() }
            .store(in: &cancellables)

        env.settings.$displayPlacement
            .dropFirst()
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in self?.reconcileHosts() }
            .store(in: &cancellables)

        env.settings.$followActiveDisplay
            .dropFirst()
            .receive(on: DispatchQueue.main)
            .sink { [weak self] enabled in
                guard let self else { return }
                if enabled {
                    self.activeDisplayKey = DisplayInventory.displayKey(
                        containing: NSEvent.mouseLocation
                    )
                }
                self.reconcileHosts()
            }
            .store(in: &cancellables)

        env.settings.$displayProfiles
            .dropFirst()
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in self?.reconcileHosts() }
            .store(in: &cancellables)

        env.settings.$virtualNotchMode
            .dropFirst()
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in self?.reconcileHosts() }
            .store(in: &cancellables)

        Publishers.CombineLatest(env.state.$presentation, env.hud.$isVisible)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] presentation, _ in
                self?.syncGlobalPresentation(presentation)
            }
            .store(in: &cancellables)

        env.state.$expandedTab
            .dropFirst()
            .receive(on: DispatchQueue.main)
            .sink { [weak self] tab in
                guard let self, let host = self.interactionHost,
                      host.state.expandedTab != tab else { return }
                self.handlingHostChange = true
                host.state.expandedTab = tab
                self.handlingHostChange = false
            }
            .store(in: &cancellables)

        NotificationCenter.default.publisher(for: NSWindow.didChangeOcclusionStateNotification)
            .sink { [weak self] _ in self?.renderingVisibilityChanged() }
            .store(in: &cancellables)

        Publishers.Merge4(
            env.media.$track.map { _ in () },
            env.activities.$activities.map { _ in () },
            env.tray.$items.map { _ in () },
            env.settings.$showCompactNowPlaying.map { _ in () }
        )
        .receive(on: DispatchQueue.main)
        .sink { [weak self] in self?.updatePassthrough() }
        .store(in: &cancellables)
    }

    private func topologyChanged() {
        let inventory = DisplayInventory.current()
        if activeDisplayKey == nil || !inventory.contains(where: { $0.key == activeDisplayKey }) {
            activeDisplayKey = DisplayInventory.displayKey(containing: NSEvent.mouseLocation)
        }
        reconcileHosts()
    }

    private func applyAll() {
        for host in hosts.values {
            host.applyVisibility(hudVisible: env.hud.isVisible)
        }
        updatePassthrough()
        renderingVisibilityChanged()
    }

    // MARK: - Pointer and drag routing

    private func setupMouseTracking() {
        let globalMove = NSEvent.addGlobalMonitorForEvents(matching: [.mouseMoved]) { [weak self] _ in
            self?.pointerMoved()
        }
        let localMove = NSEvent.addLocalMonitorForEvents(matching: [.mouseMoved]) { [weak self] event in
            self?.pointerMoved()
            return event
        }
        let globalDrag = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDragged]) { [weak self] _ in
            self?.dragMoved()
        }
        let globalUp = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseUp]) { [weak self] _ in
            self?.dragEnded()
        }
        let scrollGlobal = NSEvent.addGlobalMonitorForEvents(matching: [.scrollWheel]) { [weak self] event in
            self?.scrollWheel(event)
        }
        let scrollLocal = NSEvent.addLocalMonitorForEvents(matching: [.scrollWheel]) { [weak self] event in
            self?.scrollWheel(event)
            return event
        }
        let middleGlobal = NSEvent.addGlobalMonitorForEvents(matching: [.otherMouseDown]) { [weak self] event in
            self?.otherMouseDown(event)
        }
        let middleLocal = NSEvent.addLocalMonitorForEvents(matching: [.otherMouseDown]) { [weak self] event in
            self?.otherMouseDown(event)
            return event
        }
        mouseMonitors = [globalMove, localMove, globalDrag, globalUp,
                         scrollGlobal, scrollLocal, middleGlobal, middleLocal].compactMap { $0 }
    }

    private func pointerMoved() {
        if isDragSessionActive {
            isDragSessionActive = false
            dragHost?.state.endDropTargeting()
            dragHostKey = nil
        }
        for host in hosts.values where host.state.activeDropZone != nil {
            host.state.activeDropZone = nil
        }

        if env.settings.displayPlacement == .all {
            if let key = DisplayInventory.displayKey(containing: NSEvent.mouseLocation),
               hosts[key] != nil, key != activeDisplayKey {
                activeDisplayKey = key
                if env.state.presentation != .expanded { interactionHostKey = key }
                updateHostRoles()
                applyAll()
            }
        } else {
            considerActiveDisplay()
        }
        updatePassthrough()
    }

    private func considerActiveDisplay() {
        guard env.settings.followActiveDisplay,
              !isDragSessionActive,
              interactionHost?.panel.presentingShareSheet != true,
              interactionHost?.panel.editingText != true,
              env.state.presentation != .expanded,
              let candidate = DisplayInventory.displayKey(containing: NSEvent.mouseLocation),
              candidate != activeDisplayKey else { return }
        guard candidate != activeDisplayCandidate else { return }
        activeDisplayCandidate = candidate
        activeDisplayTask?.cancel()
        activeDisplayTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(260))
            guard let self else { return }
            defer {
                if self.activeDisplayCandidate == candidate { self.activeDisplayCandidate = nil }
            }
            guard !Task.isCancelled,
                  DisplayInventory.displayKey(containing: NSEvent.mouseLocation) == candidate else { return }
            self.activeDisplayKey = candidate
            self.interactionHostKey = candidate
            self.reconcileHosts()
        }
    }

    private var dragHost: NotchPanelHost? {
        dragHostKey.flatMap { hosts[$0] }
    }

    private func dragMoved() {
        let mouse = NSEvent.mouseLocation
        if !isDragSessionActive {
            guard dragCarriesFiles(),
                  let host = hosts.values.first(where: { dragDropZone($0).contains(mouse) }) else { return }
            isDragSessionActive = true
            dragHostKey = host.displayKey
            interactionHostKey = host.displayKey
            host.panel.ignoresMouseEvents = false
            host.state.beginDropTargeting()
            updateHostRoles()
        }
        guard let host = dragHost else { return }
        let zone = dropZone(for: mouse, host: host)
        if host.state.activeDropZone != zone { host.state.activeDropZone = zone }
    }

    private func dragCarriesFiles() -> Bool {
        NSPasteboard(name: .drag).canReadObject(
            forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]
        )
    }

    private func dropZone(for point: NSPoint, host: NotchPanelHost) -> DropZone {
        point.x >= host.geometry.panelFrame.midX ? .share : .keep
    }

    func dropZoneAtCursor() -> DropZone {
        let host = dragHost ?? hostAtCursor() ?? interactionHost
        return host.map { dropZone(for: NSEvent.mouseLocation, host: $0) } ?? .keep
    }

    private func dragEnded() {
        guard isDragSessionActive, let host = dragHost else { return }
        isDragSessionActive = false
        dragHostKey = nil
        host.state.endDropTargeting()
        if !interactiveContentRect(for: host).contains(NSEvent.mouseLocation) {
            host.state.collapse()
        }
        updatePassthrough()
    }

    private func dragDropZone(_ host: NotchPanelHost) -> NSRect {
        let width = host.geometry.notchSize.width + 200
        let drop: CGFloat = 90
        return NSRect(
            x: host.geometry.notchFrame.midX - width / 2,
            y: host.geometry.notchFrame.minY - drop,
            width: width,
            height: host.geometry.notchFrame.height + drop
        )
    }

    // MARK: - Hit testing

    private func updatePassthrough() {
        for host in hosts.values { updatePassthrough(host) }
    }

    private func updatePassthrough(_ host: NotchPanelHost) {
        guard host.panel.isVisible else { return }
        if isDragSessionActive, dragHostKey == host.displayKey {
            host.panel.ignoresMouseEvents = false
            return
        }
        switch host.state.presentation {
        case .expanded:
            host.panel.ignoresMouseEvents = false
        case .hidden:
            host.panel.ignoresMouseEvents = true
        case .compact:
            let hit = interactiveContentRect(for: host).insetBy(dx: -4, dy: -4)
            host.panel.ignoresMouseEvents = !hit.contains(NSEvent.mouseLocation)
        }
    }

    private func hostAtCursor() -> NotchPanelHost? {
        let point = NSEvent.mouseLocation
        return hosts.values.first { host in
            interactiveContentRect(for: host).insetBy(dx: -8, dy: -8).contains(point)
        }
    }

    private func interactiveContentRect(for host: NotchPanelHost) -> NSRect {
        HitRegion.rect(layoutSnapshot(for: host))
    }

    private func layoutSnapshot(for host: NotchPanelHost) -> LayoutSnapshot {
        LayoutSnapshot(
            presentation: host.state.presentation,
            notch: host.geometry.notchSize,
            expandedWidth: host.geometry.expandedWidth,
            panelFrame: host.geometry.panelFrame,
            tab: host.state.expandedTab,
            hasInfoRow: env.settings.hasInfoRowWidgets,
            trayEmpty: env.tray.items.isEmpty,
            compact: NotchLayout.compactContent(
                hasMedia: env.settings.showCompactNowPlaying && !env.media.track.isEmpty,
                isAgent: env.activities.compactActivity?.isAgent ?? false,
                activityLabel: env.activities.compactActivity.map {
                    ActivityPresenter.compactLabel(for: $0.kind)
                }
            ),
            dropActive: host.state.isDropActive
        )
    }

    private func renderingVisibilityChanged() {
        let active = hosts.values.contains {
            $0.panel.isVisible && $0.panel.occlusionState.contains(.visible)
        }
        env.setRenderingActive(active)
    }

    // MARK: - Activity cycling

    private func scrollWheel(_ event: NSEvent) {
        guard !cycleCooldown, let host = cyclableHostAtCursor() else { return }
        let dy = event.scrollingDeltaY
        guard abs(dy) > 2 else { return }
        cycleActivity(forward: dy < 0, host: host)
    }

    private func otherMouseDown(_ event: NSEvent) {
        guard event.buttonNumber == 2, let host = cyclableHostAtCursor() else { return }
        cycleActivity(forward: true, host: host)
    }

    private func cyclableHostAtCursor() -> NotchPanelHost? {
        guard (!env.settings.showCompactNowPlaying || env.media.track.isEmpty),
              env.activities.compactActivityCount > 1,
              let host = hostAtCursor(), host.state.presentation == .compact else { return nil }
        return host
    }

    private func cycleActivity(forward: Bool, host: NotchPanelHost) {
        host.state.cancelPendingExpand()
        env.activities.cycle(forward: forward)
        Haptics.tap(.alignment)
        cycleCooldown = true
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(300))
            self?.cycleCooldown = false
        }
    }

    // MARK: - Key-capable interactions

    func beginShareSheet(_ perform: () -> Void) {
        chooseInteractionHostAtPointer()
        guard let host = interactionHost else { return }
        for other in hosts.values where other.displayKey != host.displayKey {
            other.panel.presentingShareSheet = false
            other.panel.editingText = false
        }
        host.panel.presentingShareSheet = true
        host.panel.makeKeyAndOrderFront(nil)
        perform()
    }

    func endShareSheet() {
        for host in hosts.values where host.panel.presentingShareSheet {
            host.panel.presentingShareSheet = false
        }
    }

    func beginTextEditing() {
        chooseInteractionHostAtPointer()
        guard let host = interactionHost else { return }
        for other in hosts.values where other.displayKey != host.displayKey {
            other.panel.presentingShareSheet = false
            other.panel.editingText = false
        }
        host.panel.editingText = true
        host.panel.makeKeyAndOrderFront(nil)
    }

    func endTextEditing() {
        for host in hosts.values where host.panel.editingText {
            host.panel.editingText = false
        }
    }

    var window: NSWindow? { interactionHost?.panel }
}
