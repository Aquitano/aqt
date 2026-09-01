import AppKit
import NotchCore
import SwiftUI

/// Coordinates one display-local panel host per selected screen. Feature data
/// remains shared; each host renders its display's `NotchState`, which the
/// `NotchCoordinator` owns and keeps mutually exclusive for expansion. This
/// controller turns those machines into windows: frames, visibility, hover,
/// click-through, drag routing, and the key-capable interactions.
@MainActor
final class NotchWindowController {
    private let env: AppEnvironment
    private var notch: NotchCoordinator { env.notch }
    private var hosts: [String: NotchPanelHost] = [:]
    /// The host a transient key-capable interaction (share sheet, text editing,
    /// drag) is bound to while nothing is expanded; an expanded host always wins.
    private var interactionHostKey: String?
    private var activeDisplayKey: String?
    private var activeDisplayCandidate: String?
    private var activeDisplayTask: Task<Void, Never>?
    private var displayInventory: [DisplayDescriptor]
    private var compactHitRegions: [String: NSRect] = [:]
    private var observers: [Task<Void, Never>] = []
    private var mouseMonitors: [Any] = []
    /// Global left-mouse-up monitor, installed only for the duration of a drag session.
    private var dragUpMonitor: Any?
    /// Low-rate pointer poll for follow-the-pointer on several displays
    /// (see `updatePointerDisplayPolling`).
    private var pointerDisplayTask: Task<Void, Never>?

    private var isDragSessionActive = false
    private var dragHostKey: String?
    private var cycleCooldown = false

    /// Anchor for AppKit popovers such as the sharing picker.
    var panelContentView: NSView? { interactionHost?.panel.contentView }

    private var interactionHost: NotchPanelHost? {
        notch.expandedKey.flatMap { hosts[$0] }
            ?? interactionHostKey.flatMap { hosts[$0] }
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
        env.notch.expansionTarget = { [weak self] in
            guard let self else { return nil }
            if let key = self.displayKeyAtPointer(), self.hosts[key] != nil { return key }
            return self.interactionHostKey.flatMap { self.hosts[$0] != nil ? $0 : nil }
        }
        reconcileHosts()
        wire()
        setupMouseTracking()
    }

    func stop() {
        activeDisplayTask?.cancel()
        pointerDisplayTask?.cancel()
        removeDragUpMonitor()
        for monitor in mouseMonitors { NSEvent.removeMonitor(monitor) }
        mouseMonitors.removeAll()
        for host in hosts.values { host.orderOut() }
    }

    // MARK: - Host inventory

    private func reconcileHosts() {
        let selection = DisplaySelectionPolicy.resolve(
            displays: displayInventory,
            placement: env.settings.display.placement,
            followActiveDisplay: env.settings.display.followActive,
            activeDisplayKey: activeDisplayKey
        )
        let targets = selection.targets.isEmpty ? [displayInventory[0]] : selection.targets
        let desiredKeys = Set(targets.map(\.key))

        let migration = prepareInteractionHostForRemoval(desiredKeys: desiredKeys)

        for key in Array(hosts.keys) where !desiredKeys.contains(key) {
            hosts[key]?.orderOut()
            hosts[key]?.onPointerEvent = nil
            hosts[key]?.onHoverSensorEntered = nil
            hosts[key] = nil
            notch.unregister(displayKey: key)
        }

        for display in targets {
            let profile = env.settings.displayProfile(for: display.key)
            let geometry = ScreenGeometry.make(
                for: display, profile: profile,
                virtualMode: env.settings.display.virtualNotchMode
            )
            if let host = hosts[display.key] {
                host.update(
                    geometry: geometry,
                    showsHUD: false,
                    controlsSharedRendering: false
                )
            } else {
                let host = NotchPanelHost(
                    env: env, geometry: geometry,
                    state: notch.register(displayKey: display.key)
                )
                host.onPointerEvent = { [weak self] in
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
        // A programmatic expansion whose display went away reopens on the
        // display the pointer is on now.
        if migration == .restoreProgrammaticExpansion { notch.expand() }
        updateHostRoles()
        applyAll()
        updatePointerDisplayPolling()
    }

    @discardableResult
    private func prepareInteractionHostForRemoval(desiredKeys: Set<String>) -> DisplayHostMigrationInstruction {
        guard let host = interactionHost else { return .keepPresentation }
        let key = host.displayKey
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
            host.state.collapseImmediately()
        case .endTransientInteractionAndCollapse:
            host.panel.presentingShareSheet = false
            host.panel.editingText = false
            host.panel.interactingWithTray = false
            host.panel.previewing = false
            if dragHostKey == key { endDragSession(host) }
            host.state.collapseImmediately()
        }
        return instruction
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

    // MARK: - Presentation changes

    /// A machine changed presentation (hover, a command, the coordinator's
    /// exclusivity rule): the expanded display becomes the interaction host,
    /// roles and window visibility follow.
    private func presentationsChanged(hudVisible: Bool) {
        // With a notch on every display the HUD belongs on the pointer's
        // display; resolve that now rather than tracking the pointer.
        if hudVisible, env.settings.display.placement == .all,
           let key = displayKeyAtPointer(), hosts[key] != nil {
            activateDisplay(key)
        }
        if let expanded = notch.expandedKey, hosts[expanded] != nil {
            interactionHostKey = expanded
        }
        updateHostRoles()
        applyAll()
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

    private func wire() {
        let env = self.env
        observers = [
            Task { @MainActor [weak self] in
                // Debounced: a topology change fires several notifications in a row.
                var pending: Task<Void, Never>?
                for await _ in NotificationCenter.default.notifications(
                    named: NSApplication.didChangeScreenParametersNotification
                ) {
                    pending?.cancel()
                    pending = Task { @MainActor [weak self] in
                        try? await Task.sleep(for: .milliseconds(180))
                        guard !Task.isCancelled else { return }
                        self?.topologyChanged()
                    }
                }
            },
            watch(initial: false, {
                _ = env.settings.display.placement
                _ = env.settings.display.profiles
                _ = env.settings.display.virtualNotchMode
            }) { [weak self] in self?.reconcileHosts() },
            watch(initial: false, { env.settings.display.followActive }) { [weak self] enabled in
                guard let self else { return }
                if enabled {
                    self.activeDisplayKey = self.displayKeyAtPointer()
                }
                self.reconcileHosts()
            },
            watch({ (env.notch.states.mapValues(\.presentation), env.hud.isVisible) }) { [weak self] _, hudVisible in
                self?.presentationsChanged(hudVisible: hudVisible)
            },
            Task { @MainActor [weak self] in
                for await _ in NotificationCenter.default.notifications(
                    named: NSWindow.didChangeOcclusionStateNotification
                ) {
                    self?.renderingVisibilityChanged()
                }
            },
            watch({
                _ = env.media.track
                _ = env.activities.activities
                _ = env.tray.items
                _ = env.settings.media.compactNowPlaying
            }) { [weak self] in self?.updatePassthrough() },
        ]
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
    /// make the panel interactive so its own tracking area takes over, and
    /// evaluate hover right away since the sensor already saw the pointer.
    private func hoverSensorEntered(_ host: NotchPanelHost) {
        guard host.state.presentation == .compact, host.panel.isVisible else { return }
        if env.settings.display.placement == .all { activateDisplay(host.displayKey) }
        setIgnoresMouseEvents(false, on: host)
        applyPassthrough(host, mouseLocation: NSEvent.mouseLocation)
    }

    // MARK: - Pointer display tracking

    /// Follow-the-pointer moves the single notch to whichever display the pointer
    /// is on, which needs the pointer's position even when it is nowhere near a
    /// notch. Poll at a low rate for that case only; with a notch on every display
    /// the sensors and the HUD resolve the active display on demand, and a single
    /// display needs nothing.
    private func updatePointerDisplayPolling() {
        let wanted = displayInventory.count > 1
            && env.settings.display.placement != .all
            && env.settings.display.followActive
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
        if notch.expandedKey == nil { interactionHostKey = key }
        updateHostRoles()
        applyAll()
    }

    private func considerActiveDisplay() {
        guard env.settings.display.followActive,
              !isDragSessionActive,
              interactionHost?.panel.presentingShareSheet != true,
              interactionHost?.panel.editingText != true,
              interactionHost?.panel.interactingWithTray != true,
              interactionHost?.panel.previewing != true,
              notch.expandedKey == nil,
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
        host.state.isOptionMoveActive = env.settings.tray.moveEnabled
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
        guard env.settings.tray.moveEnabled else { return [] }
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

    /// The one place pointer position turns into state: hover (which drives
    /// expand/collapse), whether the panel is interactive or click-through, and
    /// the sensor rect. Hover is geometric — the pointer is inside the content's
    /// hit rect — so the blob morphing under a stationary pointer or the gap
    /// between the blob and its floating dock cannot produce a spurious exit.
    /// The sensor shows only in the compact state, the only one where the panel
    /// can be click-through while still needing to notice the pointer.
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
            setHovering(interactiveContentRect(for: host).contains(mouseLocation), on: host)
        case .hidden:
            setIgnoresMouseEvents(true, on: host)
            host.hoverSensor.update(rect: nil)
            setHovering(false, on: host)
        case .compact:
            let hit = compactHitRegions[host.displayKey]
                ?? interactiveContentRect(for: host).insetBy(dx: -4, dy: -4)
            let inside = hit.contains(mouseLocation)
            setIgnoresMouseEvents(!inside, on: host)
            host.hoverSensor.update(rect: hit)
            setHovering(inside, on: host)
        }
    }

    private func setHovering(_ hovering: Bool, on host: NotchPanelHost) {
        guard host.state.isHovering != hovering else { return }
        host.state.hoverChanged(hovering)
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
            hasInfoRow: env.settings.hasInfoRowWidgets(for: host.displayKey),
            trayEmpty: env.tray.items.isEmpty,
            compact: NotchLayout.compactContent(
                hasMedia: env.settings.media.compactNowPlaying && !env.media.track.isEmpty,
                agentCount: env.activities.compactActivity?.agentCount,
                activityLabel: env.activities.compactActivity.map {
                    ActivityPresenter.compactLabel(for: $0.kind)
                },
                trayItemCount: env.tray.items.count
            ),
            dropActive: host.state.isDropActive,
            tabBarStyle: env.settings.notch.tabBarStyle
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
        // Scroll over the expanded timer tab adjusts the dial. Routed from here
        // (not a view-local monitor) because this monitor is the one path that
        // reliably sees scroll events over the non-activating panel.
        if let host = hostAtCursor(), host.state.presentation == .expanded {
            guard host.state.expandedTab == .timer else { return }
            NotificationCenter.default.post(
                name: .timerDialScroll, object: nil,
                userInfo: [TimerDialScroll.deltaY: event.scrollingDeltaY,
                           TimerDialScroll.precise: event.hasPreciseScrollingDeltas]
            )
            return
        }
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
        guard (!env.settings.media.compactNowPlaying || env.media.track.isEmpty),
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
