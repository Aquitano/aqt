import CoreGraphics

enum SpaceDirection: Equatable {
    case left, right
}

/// Strategy A (BATTLEPLAN §3.6): post the Mission Control keyboard shortcuts
/// (ctrl+digit "Switch to Desktop N", ctrl+arrows). Robust across macOS
/// versions but animated, and ctrl+digit must be enabled in System Settings →
/// Keyboard Shortcuts → Mission Control.
enum SyntheticSpaceSwitcher {
    /// Marks events we post so the tap passes them through instead of
    /// re-routing them (rcmd is still physically held while they arrive).
    static let syntheticTag: Int64 = 0x5354_4152 // "STAR"

    static func jump(to index: Int) {
        guard let keyCode = Keycode.digitKeycodes[index] else { return }
        postControl(keyCode: keyCode)
    }

    static func jumpAdjacent(_ direction: SpaceDirection) {
        postControl(keyCode: direction == .left ? Keycode.leftArrow : Keycode.rightArrow)
    }

    private static func postControl(keyCode: Int64) {
        let source = CGEventSource(stateID: .hidSystemState)
        for keyDown in [true, false] {
            guard let event = CGEvent(
                keyboardEventSource: source,
                virtualKey: CGKeyCode(keyCode),
                keyDown: keyDown
            ) else { continue }
            event.flags = .maskControl
            event.setIntegerValueField(.eventSourceUserData, value: syntheticTag)
            event.post(tap: .cghidEventTap)
        }
    }
}
