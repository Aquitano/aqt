import AppKit

/// Private but stable for years: the window server ID of an AX window, the
/// only reliable bridge between CGWindowList and Accessibility.
@_silgen_name("_AXUIElementGetWindow")
@discardableResult
private func _AXUIElementGetWindow(_ element: AXUIElement, _ identifier: UnsafeMutablePointer<CGWindowID>) -> AXError

struct WindowInfo: Sendable {
    let id: CGWindowID
    let pid: pid_t
}

/// Window lists and Accessibility actions, run in order on one serial queue.
/// An AX call blocks until the target app answers or the timeout passes, so
/// none of them run on the main thread, and running them in order keeps
/// rapid presses from finishing out of sequence.
final class WindowService: @unchecked Sendable {
    private let queue = DispatchQueue(label: "com.aquitano.starboard.windows", qos: .userInteractive)
    private struct Cycle {
        let pid: pid_t
        let windows: [CGWindowID]
        var index = 0
    }

    /// The windows a repeat press steps through. Only touched on `queue`.
    private var cycle: Cycle?

    init() {
        // The default is about six seconds per call, long enough for one hung
        // app to hold up every action queued behind it.
        AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), 0.25)
    }

    /// Windows on the current Space, front to back. Minimized and hidden
    /// windows are not on screen.
    func visibleWindows() async -> [WindowInfo] {
        await withCheckedContinuation { continuation in
            queue.async { continuation.resume(returning: Self.onScreenWindows()) }
        }
    }

    /// Raises the app's next window, most recently used first. The order is
    /// read once at the first step and kept until `endCycle()`, so a window
    /// coming to the front doesn't reshuffle the cycle.
    func stepWindows(of pid: pid_t) {
        queue.async { [self] in
            if cycle?.pid != pid {
                cycle = Cycle(pid: pid, windows: Self.onScreenWindows().filter { $0.pid == pid }.map(\.id))
            }
            guard var current = cycle, current.windows.count > 1 else { return }
            current.index = (current.index + 1) % current.windows.count
            cycle = current
            Self.raise(current.windows[current.index], of: pid)
        }
    }

    func endCycle() {
        queue.async { [self] in cycle = nil }
    }

    func closeFrontWindow(of pid: pid_t) {
        queue.async {
            let app = AXUIElementCreateApplication(pid)
            let window = Self.element(app, kAXFocusedWindowAttribute)
                ?? Self.element(app, kAXMainWindowAttribute)
                ?? Self.elements(app, kAXWindowsAttribute).first
            window.map(Self.pressCloseButton)
        }
    }

    /// Presses each window's close button; the app keeps running.
    func closeAllWindows(of pid: pid_t) {
        queue.async {
            Self.elements(AXUIElementCreateApplication(pid), kAXWindowsAttribute).forEach(Self.pressCloseButton)
        }
    }

    func warpPointer(toFocusedWindowOf pid: pid_t) {
        queue.async {
            guard let window = Self.element(AXUIElementCreateApplication(pid), kAXFocusedWindowAttribute),
                  let origin = Self.value(window, kAXPositionAttribute, .cgPoint, CGPoint.zero),
                  let size = Self.value(window, kAXSizeAttribute, .cgSize, CGSize.zero),
                  size.width > 0, size.height > 0 else { return }
            CGWarpMouseCursorPosition(CGPoint(x: origin.x + size.width / 2, y: origin.y + size.height / 2))
        }
    }

    // MARK: - Queue-only helpers

    private static func onScreenWindows() -> [WindowInfo] {
        let info = signposter.withIntervalSignpost("Window enumeration") {
            CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
        }
        guard let list = info as? [[String: Any]] else { return [] }
        let ownPID = ProcessInfo.processInfo.processIdentifier
        return list.compactMap { entry in
            guard entry[kCGWindowLayer as String] as? Int == 0,
                  let number = entry[kCGWindowNumber as String] as? Int,
                  let owner = entry[kCGWindowOwnerPID as String] as? Int,
                  owner != ownPID,
                  // Status items and tooltips are tiny layer-0 surfaces.
                  let bounds = entry[kCGWindowBounds as String] as? [String: CGFloat],
                  bounds["Width", default: 0] >= 64, bounds["Height", default: 0] >= 64
            else { return nil }
            return WindowInfo(id: CGWindowID(number), pid: pid_t(owner))
        }
    }

    private static func raise(_ windowID: CGWindowID, of pid: pid_t) {
        let target = elements(AXUIElementCreateApplication(pid), kAXWindowsAttribute).first { window in
            var id = CGWindowID(0)
            return _AXUIElementGetWindow(window, &id) == .success && id == windowID
        }
        guard let target else { return }
        AXUIElementSetAttributeValue(target, kAXMainAttribute as CFString, kCFBooleanTrue)
        AXUIElementPerformAction(target, kAXRaiseAction as CFString)
    }

    private static func pressCloseButton(of window: AXUIElement) {
        guard let button = element(window, kAXCloseButtonAttribute) else { return }
        AXUIElementPerformAction(button, kAXPressAction as CFString)
    }

    // Apps may return any CoreFoundation type for any attribute, and a cast
    // to a CF type always succeeds, so each value's type ID is checked first.

    private static func element(_ element: AXUIElement, _ attribute: String) -> AXUIElement? {
        guard let raw = copy(element, attribute), CFGetTypeID(raw) == AXUIElementGetTypeID() else { return nil }
        return unsafeDowncast(raw, to: AXUIElement.self)
    }

    private static func elements(_ element: AXUIElement, _ attribute: String) -> [AXUIElement] {
        guard let raw = copy(element, attribute), let array = raw as? [AnyObject] else { return [] }
        return array.compactMap { item in
            CFGetTypeID(item) == AXUIElementGetTypeID() ? unsafeDowncast(item, to: AXUIElement.self) : nil
        }
    }

    /// `type` must be the AXValue type that holds a `Value`: the bytes are
    /// copied into `result` as they are.
    private static func value<Value: BitwiseCopyable>(
        _ element: AXUIElement,
        _ attribute: String,
        _ type: AXValueType,
        _ initial: Value
    ) -> Value? {
        guard let raw = copy(element, attribute), CFGetTypeID(raw) == AXValueGetTypeID() else { return nil }
        let axValue = unsafeDowncast(raw, to: AXValue.self)
        var result = initial
        guard AXValueGetType(axValue) == type, AXValueGetValue(axValue, type, &result) else { return nil }
        return result
    }

    private static func copy(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
        var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &raw) == .success else { return nil }
        return raw
    }
}
