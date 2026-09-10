import AppKit
import ApplicationServices
import TrackerCore

/// Which application, and which of its windows, has focus. The application half
/// works for everyone; the window title needs Accessibility trust and simply
/// stays nil without it.
@MainActor
final class FocusWatcher: NSObject {
    enum Event: Sendable, Equatable {
        case app(bundleID: String, appName: String, windowTitle: String?)
        case windowTitle(String?)
    }

    /// A hung app must not hang the agent: AX calls are synchronous IPC.
    private static let messagingTimeout: Float = 0.25
    /// Renaming a tab or typing in a title bar retitles the window per
    /// keystroke; one span per keystroke is not attention data.
    private static let titleDebounce = Duration.seconds(1)

    var onEvent: ((Event) -> Void)?

    private(set) var isTrusted = AXIsProcessTrusted()

    private var observer: AXObserver?
    private var appElement: AXUIElement?
    private var windowElement: AXUIElement?
    private var observedPID: pid_t?
    private var debounce: Task<Void, Never>?

    func start() {
        NSWorkspace.shared.notificationCenter.addObserver(
            self,
            selector: #selector(applicationActivated),
            name: NSWorkspace.didActivateApplicationNotification,
            object: nil
        )
        publishFrontmost()
    }

    func stop() {
        NSWorkspace.shared.notificationCenter.removeObserver(self)
        debounce?.cancel()
        detach()
    }

    /// Accessibility can be granted while the agent is running; re-attaching is
    /// what makes titles appear without a restart.
    func refreshTrust() {
        let trusted = AXIsProcessTrusted()
        guard trusted != isTrusted else { return }
        isTrusted = trusted
        detach()
        publishFrontmost()
    }

    @objc private func applicationActivated() {
        publishFrontmost()
    }

    /// Re-reads the frontmost app and its focused window title.
    func publishFrontmost() {
        guard let app = NSWorkspace.shared.frontmostApplication,
              let bundleID = app.bundleIdentifier,
              bundleID != Bundle.main.bundleIdentifier
        else { return }
        attach(to: app.processIdentifier)
        onEvent?(.app(bundleID: bundleID, appName: app.localizedName ?? bundleID, windowTitle: focusedTitle()))
    }

    private func attach(to pid: pid_t) {
        guard pid != observedPID else { return }
        detach()
        observedPID = pid
        guard isTrusted else { return }

        var created: AXObserver?
        guard AXObserverCreate(pid, focusObserverCallback, &created) == .success, let created else {
            Log.focus.error("AXObserverCreate failed for pid \(pid, privacy: .public)")
            return
        }
        let element = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(element, Self.messagingTimeout)
        AXObserverAddNotification(
            created,
            element,
            kAXFocusedWindowChangedNotification as CFString,
            Unmanaged.passUnretained(self).toOpaque()
        )
        CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(created), .defaultMode)
        observer = created
        appElement = element
        observeFocusedWindow()
    }

    private func detach() {
        if let observer {
            if let appElement {
                AXObserverRemoveNotification(observer, appElement, kAXFocusedWindowChangedNotification as CFString)
            }
            if let windowElement {
                AXObserverRemoveNotification(observer, windowElement, kAXTitleChangedNotification as CFString)
            }
            CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .defaultMode)
        }
        observer = nil
        appElement = nil
        windowElement = nil
        observedPID = nil
    }

    /// Title changes are posted by the window element, not by the application
    /// element, so the observation moves with the focused window.
    private func observeFocusedWindow() {
        guard let observer else { return }
        if let windowElement {
            AXObserverRemoveNotification(observer, windowElement, kAXTitleChangedNotification as CFString)
        }
        windowElement = focusedWindow()
        guard let windowElement else { return }
        AXUIElementSetMessagingTimeout(windowElement, Self.messagingTimeout)
        AXObserverAddNotification(
            observer,
            windowElement,
            kAXTitleChangedNotification as CFString,
            Unmanaged.passUnretained(self).toOpaque()
        )
    }

    fileprivate func handleAXNotification(_ name: String) {
        if name == kAXFocusedWindowChangedNotification {
            observeFocusedWindow()
        }
        debounce?.cancel()
        debounce = Task { [weak self] in
            try? await Task.sleep(for: FocusWatcher.titleDebounce)
            guard !Task.isCancelled, let self else { return }
            onEvent?(.windowTitle(focusedTitle()))
        }
    }

    private func focusedTitle() -> String? {
        guard let window = windowElement ?? focusedWindow() else { return nil }
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(window, kAXTitleAttribute as CFString, &value) == .success,
              let title = value as? String, !title.isEmpty
        else { return nil }
        return title
    }

    private func focusedWindow() -> AXUIElement? {
        guard let appElement else { return nil }
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(appElement, kAXFocusedWindowAttribute as CFString, &value) == .success,
              let value, CFGetTypeID(value) == AXUIElementGetTypeID()
        else { return nil }
        return unsafeDowncast(value, to: AXUIElement.self)
    }
}

/// AXObserver takes a C function pointer; the run loop source is on the main
/// run loop, so the callback already arrives on the main actor.
private func focusObserverCallback(
    _: AXObserver,
    _: AXUIElement,
    _ notification: CFString,
    _ context: UnsafeMutableRawPointer?
) {
    guard let context else { return }
    let watcher = Unmanaged<FocusWatcher>.fromOpaque(context).takeUnretainedValue()
    let name = notification as String
    MainActor.assumeIsolated { watcher.handleAXNotification(name) }
}
