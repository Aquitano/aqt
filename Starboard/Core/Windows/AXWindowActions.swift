import AppKit

/// Minimal AX helpers. All calls run off-main with a 250 ms per-element timeout
/// so unresponsive apps can't hang the switcher (BATTLEPLAN §7).
enum AXWindowActions {
    /// Press the close button of every window of the app (Stages close —
    /// never terminates the process).
    static func closeAllWindows(of app: NSRunningApplication) {
        performOffMain(pid: app.processIdentifier) { appElement in
            var value: CFTypeRef?
            guard AXUIElementCopyAttributeValue(
                appElement, kAXWindowsAttribute as CFString, &value
            ) == .success, let windows = value as? [AXUIElement] else { return }
            for window in windows {
                guard let closeButton: AXUIElement = copy(window, kAXCloseButtonAttribute as CFString) else {
                    continue
                }
                AXUIElementPerformAction(closeButton, kAXPressAction as CFString)
            }
        }
    }

    /// Press the close button of one specific window.
    static func close(_ window: WindowInfo) {
        performOffMain(pid: window.pid) { appElement in
            var value: CFTypeRef?
            guard AXUIElementCopyAttributeValue(
                appElement, kAXWindowsAttribute as CFString, &value
            ) == .success, let windows = value as? [AXUIElement] else { return }
            let target = windows.first { element in
                var id = CGWindowID(0)
                return _AXUIElementGetWindow(element, &id) == .success && id == window.id
            }
            guard let target,
                  let closeButton: AXUIElement = copy(target, kAXCloseButtonAttribute as CFString) else {
                return
            }
            AXUIElementPerformAction(closeButton, kAXPressAction as CFString)
        }
    }

    /// Press the close button of the app's frontmost window.
    static func closeFrontmostWindow(of app: NSRunningApplication) {
        performOffMain(pid: app.processIdentifier) { appElement in
            guard let window = frontWindow(of: appElement),
                  let closeButton: AXUIElement = copy(window, kAXCloseButtonAttribute as CFString) else {
                return
            }
            AXUIElementPerformAction(closeButton, kAXPressAction as CFString)
        }
    }

    // MARK: - Primitives

    private static func performOffMain(
        pid: pid_t,
        _ body: @escaping (AXUIElement) -> Void
    ) {
        DispatchQueue.global(qos: .userInitiated).async {
            let element = AXUIElementCreateApplication(pid)
            AXUIElementSetMessagingTimeout(element, 0.25)
            body(element)
        }
    }

    /// The window the user would consider "frontmost": focused, else main,
    /// else the first listed. The AXWindows array's order is arbitrary.
    private static func frontWindow(of appElement: AXUIElement) -> AXUIElement? {
        if let focused: AXUIElement = copy(appElement, kAXFocusedWindowAttribute as CFString) {
            return focused
        }
        if let main: AXUIElement = copy(appElement, kAXMainWindowAttribute as CFString) {
            return main
        }
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(
            appElement, kAXWindowsAttribute as CFString, &value
        ) == .success else { return nil }
        guard let windows = value as? [AXUIElement] else { return nil }
        return windows.first
    }

    private static func copy<T>(_ element: AXUIElement, _ attribute: CFString) -> T? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success else {
            return nil
        }
        return value as? T
    }
}
