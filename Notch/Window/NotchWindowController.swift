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
    private var displayInventory: [DisplayDescriptor]
    private var compactHitRegions: [String: NSRect] = [:]
    private var cancellables = Set<AnyCancellable>()
    private var mouseMonitors: [Any] = []
    /// Global left-mouse-up monitor, installed only for the duration of a drag session.
    private var dragUpMonitor: Any?
    /// Low-rate pointer poll for follow-the-pointer on several displays
    /// (see `updatePointerDisplayPolling`).
    private var pointerDisplayTask: Task<Void, Never>?
    /// Per-host guard for a compact panel left interactive with the pointer gone
    /// (see `applyPassthrough`).
    private var passthroughWatchdogs: [String: Task<Void, Never>] = [:]
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
        var inventory = DisplayInventory.current()
        if inventory.isEmpty { inventory = [DisplayInventory.fallback()] }
        self.displayInventory = inventory
        self.activeDisplayKey = DisplayInventory.displayKey(
            containing: NSEvent.mouseLocation,
            in: inventory
        )
        reconcileHosts()
        observe()
        setupMouseTracking()
    }

    func stop() {
        activeDisplayTask?.cancel()
        pointerDisplayTask?.cancel()
        for task in passthroughWatchdogs.values { task.cancel() }
        passthroughWatchdogs.removeAll()
        removeDragUpMonitor()
        for monitor in mouseMonitors { NSEvent.removeMonitor(monitor) }
        mouseMonitors.removeAll()
        for host in hosts.values { host.orderOut() }
    }

    // MARK: - Host inventory

    private func reconcileHosts() {
        let selection = DisplaySelectionPolicy.resolve(
            displays: displayInventory,
            placement: env.settings.displayPlacement,
            followActiveDisplay: env.settings.followActiveDisplay,
            activeDisplayKey: activeDisplayKey
        )
        let targets = selection.targets.isEmpty ? [displayInventory[0]] : selection.targets
        let desiredKeys = Set(targets.map(\.key))

        prepareInteractionHostForRemoval(desiredKeys: desiredKeys)

        for key in Array(hosts.keys) where !desiredKeys.contains(key) {
            hosts[key]?.orderOut()
            hosts[key]?.onPresentationChange = nil
            hosts[key]?.onTabChange = nil
            hosts[key]?.onHoverChange = nil
            hosts[key]?.onHoverSensorEntered = nil
            passthroughWatchdogs.removeValue(forKey: key)?.cancel()
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
                host.onHoverChange = { [weak self] _ in
                    guard let self, let host = self.hosts[display.key] else { return }
                    self.applyPassthrough(host, mouseLocation: NSEvent.mouseLocation)
                }
                host.onHoverSensorEntered = { [weak self] in
                    guard let self, let host = self.hosts[display.key] else { return }
                    self.hoverSensorEntered(host)
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
        updatePointerDisplayPolling()
    }

    private func prepareInteractionHostForRemoval(desiredKeys: Set<String>) {
        guard let key = interactionHostKey, let host = hosts[key] else { return }
        let hasTransientInteraction = host.panel.presentingShareSheet
            || host.panel.editingText
            || host.panel.interactingWithTray
            || host.panel.previewing
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
            host.panel.interactingWithTray = false
            host.panel.previewing = false
            if dragHostKey == key { endDragSession(host) }
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
        if let key = displayKeyAtPointer(),
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
                    self.activeDisplayKey = self.displayKeyAtPointer()
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
            .sink { [weak self] presentation, hudVisible in
                guard let self else { return }
                // With a notch on every display the HUD belongs on the pointer's
                // display; resolve that now rather than tracking the pointer.
                if hudVisible, self.env.settings.displayPlacement == .all,
                   let key = self.displayKeyAtPointer(), self.hosts[key] != nil {
                    self.activateDisplay(key)
                }
                self.syncGlobalPresentation(presentation)
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
        var inventory = DisplayInventory.current()
        if inventory.isEmpty { inventory = [DisplayInventory.fallback()] }
        displayInventory = inventory
        if activeDisplayKey == nil || !displayInventory.contains(where: { $0.key == activeDisplayKey }) {
            activeDisplayKey = displayKeyAtPointer()
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

    /// Only local monitors, plus one global monitor for drags. Pointer moves reach
    /// us via each host's `HoverSensorPanel` (while the panel is click-through) or
    /// the panel itself (once interactive), so the app is not woken by every
    /// system-wide mouse move, scroll, or click. Scroll and middle-click on the
    /// compact pill arrive locally because the sensor has already made the panel
    /// interactive by then.
    private func setupMouseTracking() {
        let localMove = NSEvent.addLocalMonitorForEvents(matching: [.mouseMoved]) { [weak self] event in
            self?.pointerMoved()
            return event
        }
        let globalDrag = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDragged]) { [weak self] _ in
            self?.dragMoved()
        }
        let scrollLocal = NSEvent.addLocalMonitorForEvents(matching: [.scrollWheel]) { [weak self] event in
            self?.scrollWheel(event)
            return event
        }
        let middleLocal = NSEvent.addLocalMonitorForEvents(matching: [.otherMouseDown]) { [weak self] event in
            self?.otherMouseDown(event)
            return event
        }
        mouseMonitors = [localMove, globalDrag, scrollLocal, middleLocal].compactMap { $0 }
    }

    private func pointerMoved() {
        if isDragSessionActive, let host = dragHost { endDragSession(host) }
        for host in hosts.values where host.state.activeDropZone != nil {
            host.state.activeDropZone = nil
        }
        applyPassthroughAtPointer()
    }

    /// The pointer landed on a compact pill while its panel was click-through:
    /// make the panel interactive so SwiftUI hover tracking takes over.
    private func hoverSensorEntered(_ host: NotchPanelHost) {
        guard host.state.presentation == .compact, host.panel.isVisible else { return }
        if env.settings.displayPlacement == .all { activateDisplay(host.displayKey) }
        setIgnoresMouseEvents(false, on: host)
        armPassthroughWatchdog(host)
    }

    // MARK: - Pointer display tracking

    /// Follow-the-pointer moves the single notch to whichever display the pointer
    /// is on, which needs the pointer's position even when it is nowhere near a
    /// notch. Poll at a low rate for that case only; with a notch on every display
    /// the sensors and the HUD resolve the active display on demand, and a single
    /// display needs nothing.
    private func updatePointerDisplayPolling() {
        let wanted = displayInventory.count > 1
            && env.settings.displayPlacement != .all
            && env.settings.followActiveDisplay
        guard wanted != (pointerDisplayTask != nil) else { return }
        if wanted {
            pointerDisplayTask = Task { @MainActor [weak self] in
                while !Task.isCancelled {
                    try? await Task.sleep(for: .milliseconds(400))
                    guard let self, !Task.isCancelled else { return }
                    self.considerActiveDisplay()
                }
            }
        } else {
            pointerDisplayTask?.cancel()
            pointerDisplayTask = nil
        }
    }

    private func activateDisplay(_ key: String) {
        guard key != activeDisplayKey else { return }
        activeDisplayKey = key
        if env.state.presentation != .expanded { interactionHostKey = key }
        updateHostRoles()
        applyAll()
    }

    private func considerActiveDisplay() {
        guard env.settings.followActiveDisplay,
              !isDragSessionActive,
              interactionHost?.panel.presentingShareSheet != true,
              interactionHost?.panel.editingText != true,
              interactionHost?.panel.interactingWithTray != true,
              interactionHost?.panel.previewing != true,
              env.state.presentation != .expanded,
              let candidate = displayKeyAtPointer(),
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
                  self.displayKeyAtPointer() == candidate else { return }
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
            guard let representation = dragRepresentation(),
                  let host = hosts.values.first(where: { dragDropZone($0).contains(mouse) }) else { return }
            isDragSessionActive = true
            dragHostKey = host.displayKey
            interactionHostKey = host.displayKey
            host.panel.ignoresMouseEvents = false
            host.state.activeDropRepresentation = representation
            host.state.beginDropTargeting()
            updateHostRoles()
            installDragUpMonitor()
        }
        guard let host = dragHost else { return }
        host.state.isOptionMoveActive = env.settings.trayMoveEnabled
            && NSEvent.modifierFlags.contains(.option)
            && !originalFileURLsForDrop().isEmpty
        let zone = dropZone(for: mouse, host: host)
        if host.state.activeDropZone != zone { host.state.activeDropZone = zone }
    }

    private func dragRepresentation() -> TrayRepresentationKind? {
        let identifiers = NSPasteboard(name: .drag).types?.map(\.rawValue) ?? []
        return TrayDropCapabilities.preferredKind(for: identifiers)
    }

    private func dropZone(for point: NSPoint, host: NotchPanelHost) -> DropZone {
        point.x >= host.geometry.panelFrame.midX ? .share : .keep
    }

    func dropZoneAtCursor() -> DropZone {
        let host = dragHost ?? hostAtCursor() ?? interactionHost
        return host.map { dropZone(for: NSEvent.mouseLocation, host: $0) } ?? .keep
    }

    func originalFileURLsForDrop() -> [URL] {
        guard env.settings.trayMoveEnabled else { return [] }
        let pasteboard = NSPasteboard(name: .drag)
        let urls = pasteboard.readObjects(
            forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]
        ) as? [URL] ?? []
        guard !urls.isEmpty,
              urls.allSatisfy({ TrayManager.moveEligibility(for: $0) == .eligible })
        else { return [] }
        return urls
    }

    private func dragEnded() {
        guard isDragSessionActive, let host = dragHost else { return }
        endDragSession(host)
        if !interactiveContentRect(for: host).contains(NSEvent.mouseLocation) {
            host.state.collapse()
        }
        updatePassthrough()
    }

    private func endDragSession(_ host: NotchPanelHost) {
        isDragSessionActive = false
        dragHostKey = nil
        host.state.endDropTargeting()
        removeDragUpMonitor()
    }

    private func installDragUpMonitor() {
        guard dragUpMonitor == nil else { return }
        dragUpMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseUp]) { [weak self] _ in
            self?.dragEnded()
        }
    }

    private func removeDragUpMonitor() {
        if let monitor = dragUpMonitor { NSEvent.removeMonitor(monitor) }
        dragUpMonitor = nil
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
        compactHitRegions = hosts.reduce(into: [:]) { result, entry in
            let (key, host) = entry
            result[key] = interactiveContentRect(for: host).insetBy(dx: -4, dy: -4)
        }
        applyPassthroughAtPointer()
    }

    private func applyPassthroughAtPointer() {
        let mouseLocation = NSEvent.mouseLocation
        for host in hosts.values {
            applyPassthrough(host, mouseLocation: mouseLocation)
        }
    }

    /// Decide whether the panel is interactive or click-through, and show the
    /// hover sensor only in the compact state (the only one where the panel can
    /// be click-through while still needing to notice the pointer).
    private func applyPassthrough(_ host: NotchPanelHost, mouseLocation: NSPoint) {
        guard host.panel.isVisible else {
            host.hoverSensor.update(rect: nil)
            return
        }
        if isDragSessionActive, dragHostKey == host.displayKey {
            setIgnoresMouseEvents(false, on: host)
            host.hoverSensor.update(rect: nil)
            return
        }
        switch host.state.presentation {
        case .expanded:
            setIgnoresMouseEvents(false, on: host)
            host.hoverSensor.update(rect: nil)
        case .hidden:
            setIgnoresMouseEvents(true, on: host)
            host.hoverSensor.update(rect: nil)
        case .compact:
            let hit = compactHitRegions[host.displayKey]
                ?? interactiveContentRect(for: host).insetBy(dx: -4, dy: -4)
            let inside = host.state.isHovering || hit.contains(mouseLocation)
            setIgnoresMouseEvents(!inside, on: host)
            host.hoverSensor.update(rect: hit)
            if inside { armPassthroughWatchdog(host) }
        }
    }

    /// A compact panel made interactive by the sensor only learns the pointer
    /// left through its own mouse-moved events, which stop once the pointer is
    /// outside the panel frame. Re-check at a low rate until the panel is
    /// click-through again (or hovering / expanded, where SwiftUI reports exit).
    private func armPassthroughWatchdog(_ host: NotchPanelHost) {
        let key = host.displayKey
        guard passthroughWatchdogs[key] == nil else { return }
        passthroughWatchdogs[key] = Task { @MainActor [weak self] in
            defer { self?.passthroughWatchdogs[key] = nil }
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(250))
                guard let self, !Task.isCancelled, let host = self.hosts[key] else { return }
                guard host.state.presentation == .compact,
                      !host.state.isHovering,
                      !host.panel.ignoresMouseEvents else { return }
                self.applyPassthrough(host, mouseLocation: NSEvent.mouseLocation)
            }
        }
    }

    private func setIgnoresMouseEvents(_ ignores: Bool, on host: NotchPanelHost) {
        if host.panel.ignoresMouseEvents != ignores {
            host.panel.ignoresMouseEvents = ignores
        }
    }

    private func displayKeyAtPointer() -> String? {
        DisplayInventory.displayKey(containing: NSEvent.mouseLocation, in: displayInventory)
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
                agentCount: env.activities.compactActivity?.agentCount,
                activityLabel: env.activities.compactActivity.map {
                    ActivityPresenter.compactLabel(for: $0.kind)
                },
                trayItemCount: env.tray.items.count
            ),
            dropActive: host.state.isDropActive,
            floatingTabBar: env.settings.floatingTabBar
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
            other.panel.interactingWithTray = false
            other.panel.previewing = false
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
            other.panel.interactingWithTray = false
            other.panel.previewing = false
        }
        host.panel.editingText = true
        host.panel.makeKeyAndOrderFront(nil)
    }

    func endTextEditing() {
        for host in hosts.values where host.panel.editingText {
            host.panel.editingText = false
        }
    }

    func beginTrayInteraction() {
        chooseInteractionHostAtPointer()
        guard let host = interactionHost else { return }
        for other in hosts.values where other.displayKey != host.displayKey {
            other.panel.interactingWithTray = false
            other.panel.previewing = false
        }
        host.panel.interactingWithTray = true
        host.panel.makeKeyAndOrderFront(nil)
    }

    func endTrayInteraction() {
        for host in hosts.values where host.panel.interactingWithTray {
            host.panel.interactingWithTray = false
        }
    }

    func beginPreviewing() {
        beginTrayInteraction()
        interactionHost?.panel.previewing = true
    }

    func endPreviewing() {
        for host in hosts.values where host.panel.previewing {
            host.panel.previewing = false
        }
    }

    var window: NSWindow? { interactionHost?.panel }
}
