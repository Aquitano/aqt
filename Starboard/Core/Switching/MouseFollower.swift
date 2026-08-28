import AppKit

/// "Mouse follows focused app": warps the pointer to the center of the newly
/// focused window shortly after a switch (BATTLEPLAN Phase 7). The delay lets
/// activation and AX raising settle first.
///
/// Apps are free to return any CFType for any AX attribute, so every value is
/// type-checked before it is unwrapped — a force-cast here traps the app.
enum MouseFollower {
    static func warpToFocusedWindow() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
            guard let app = NSWorkspace.shared.frontmostApplication else { return }
            let pid = app.processIdentifier
            DispatchQueue.global(qos: .userInitiated).async {
                let appElement = AXUIElementCreateApplication(pid)
                AXUIElementSetMessagingTimeout(appElement, 0.25)

                guard let window = focusedWindow(of: appElement),
                      let positionValue = axValue(window, kAXPositionAttribute, .cgPoint),
                      let sizeValue = axValue(window, kAXSizeAttribute, .cgSize) else { return }

                var position = CGPoint.zero
                var size = CGSize.zero
                guard AXValueGetValue(positionValue, .cgPoint, &position),
                      AXValueGetValue(sizeValue, .cgSize, &size),
                      size.width > 0, size.height > 0 else { return }

                CGWarpMouseCursorPosition(
                    CGPoint(x: position.x + size.width / 2, y: position.y + size.height / 2)
                )
            }
        }
    }

    private static func focusedWindow(of appElement: AXUIElement) -> AXUIElement? {
        var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(
            appElement, kAXFocusedWindowAttribute as CFString, &raw
        ) == .success, let raw, CFGetTypeID(raw) == AXUIElementGetTypeID() else { return nil }
        return (raw as! AXUIElement)
    }

    /// Copies an attribute and returns it only if it really is an AXValue of
    /// the expected kind.
    private static func axValue(
        _ element: AXUIElement,
        _ attribute: String,
        _ type: AXValueType
    ) -> AXValue? {
        var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &raw) == .success,
              let raw, CFGetTypeID(raw) == AXValueGetTypeID() else { return nil }
        let value = raw as! AXValue
        return AXValueGetType(value) == type ? value : nil
    }
}
