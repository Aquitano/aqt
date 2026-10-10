import CoreGraphics
import StarboardCore

/// Switches Spaces by posting the Mission Control shortcuts: Control + digit
/// and Control + arrow. "Switch to Desktop N" has to be turned on under
/// System Settings > Keyboard > Keyboard Shortcuts > Mission Control.
enum SpaceSwitcher {
    /// Marks the events posted here so the event tap lets them through.
    static let syntheticTag: Int64 = 0x5354_4152 // "STAR"

    static func jump(to number: Int) {
        guard let keyCode = Keycode.digitKeycodes[number] else { return }
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
