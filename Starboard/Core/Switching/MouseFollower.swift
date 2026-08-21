import AppKit

/// "Mouse follows focused app": warps the pointer to the center of the newly
/// focused window shortly after a switch (BATTLEPLAN Phase 7). The delay lets
/// activation and AX raising settle first.
enum MouseFollower {
    static func warpToFocusedWindow() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
            guard let app = NSWorkspace.shared.frontmostApplication else { return }
            let pid = app.processIdentifier
            DispatchQueue.global(qos: .userInitiated).async {
                let appElement = AXUIElementCreateApplication(pid)
                AXUIElementSetMessagingTimeout(appElement, 0.25)

                var focusedValue: CFTypeRef?
                guard AXUIElementCopyAttributeValue(
                    appElement, kAXFocusedWindowAttribute as CFString, &focusedValue
                ) == .success, let focused = focusedValue else { return }
                let window = focused as! AXUIElement

                var positionValue: CFTypeRef?
                var sizeValue: CFTypeRef?
                guard AXUIElementCopyAttributeValue(
                    window, kAXPositionAttribute as CFString, &positionValue
                ) == .success,
                    AXUIElementCopyAttributeValue(
                        window, kAXSizeAttribute as CFString, &sizeValue
                    ) == .success else { return }

                var position = CGPoint.zero
                var size = CGSize.zero
                AXValueGetValue(positionValue as! AXValue, .cgPoint, &position)
                AXValueGetValue(sizeValue as! AXValue, .cgSize, &size)
                guard size.width > 0, size.height > 0 else { return }

                CGWarpMouseCursorPosition(
                    CGPoint(x: position.x + size.width / 2, y: position.y + size.height / 2)
                )
            }
        }
    }
}
