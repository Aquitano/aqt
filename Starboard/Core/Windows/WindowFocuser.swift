import AppKit

/// Private but long-stable: resolves an AXUIElement window to its CGWindowID,
/// the only reliable bridge between CGWindowList and AX (BATTLEPLAN §3.5).
@_silgen_name("_AXUIElementGetWindow")
@discardableResult
func _AXUIElementGetWindow(
    _ element: AXUIElement,
    _ identifier: UnsafeMutablePointer<CGWindowID>) -> AXError

/// Focuses specific windows via AX: raise + make-main off the main thread
/// (with the 250 ms timeout), then activate the owning app on main.
enum WindowFocuser {
    static func focus(_ window: WindowInfo) {
        onAppElement(pid: window.pid) { appElement in
            guard let target = axWindow(matching: window, in: appElement) else { return }
            raise(target)
            activateOnMain(pid: window.pid)
        }
    }

    /// rcmd+`: focus the frontmost app's next window (AX order, wrapping).
    static func cycleFrontmostAppWindows() {
        guard let app = NSWorkspace.shared.frontmostApplication else { return }
        cycleWindows(of: app)
    }

    /// ralt+letter window jump: bring the app forward and step its windows.
    static func cycleWindows(of app: NSRunningApplication) {
        let pid = app.processIdentifier
        onAppElement(pid: pid) { appElement in
            guard let windows: [AXUIElement] = copy(appElement, kAXWindowsAttribute as CFString),
                  !windows.isEmpty else {
                activateOnMain(pid: pid)
                return
            }
            let focused: AXUIElement? = copy(appElement, kAXFocusedWindowAttribute as CFString)
            let focusedID = focused.map(windowID)
            let currentIndex = windows.firstIndex { windowID($0) == focusedID } ?? -1
            raise(windows[(currentIndex + 1) % windows.count])
            activateOnMain(pid: pid)
        }
    }

    // MARK: - Primitives

    private static func onAppElement(pid: pid_t, _ body: @escaping (AXUIElement) -> Void) {
        DispatchQueue.global(qos: .userInitiated).async {
            let element = AXUIElementCreateApplication(pid)
            AXUIElementSetMessagingTimeout(element, 0.25)
            body(element)
        }
    }

    private static func axWindow(matching window: WindowInfo, in appElement: AXUIElement) -> AXUIElement? {
        guard let windows: [AXUIElement] = copy(appElement, kAXWindowsAttribute as CFString) else {
            return nil
        }
        if let byID = windows.first(where: { windowID($0) == window.id }) {
            return byID
        }
        // Fallback when the private symbol misbehaves: match by title.
        if let title = window.title {
            return windows.first { (copy($0, kAXTitleAttribute as CFString) as String?) == title }
        }
        return windows.first
    }

    private static func windowID(_ element: AXUIElement) -> CGWindowID? {
        var id = CGWindowID(0)
        guard _AXUIElementGetWindow(element, &id) == .success else { return nil }
        return id
    }

    private static func raise(_ window: AXUIElement) {
        AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue)
        AXUIElementPerformAction(window, kAXRaiseAction as CFString)
    }

    private static func activateOnMain(pid: pid_t) {
        DispatchQueue.main.async {
            NSRunningApplication(processIdentifier: pid)?.activate()
        }
    }

    private static func copy<T>(_ element: AXUIElement, _ attribute: CFString) -> T? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success else {
            return nil
        }
        return value as? T
    }
}
