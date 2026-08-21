import CoreGraphics

struct ModifierState: Equatable {
    var rightCommandHeld = false
    var rightOptionHeld = false
}

/// Tracks which side-specific modifiers are physically held, fed from
/// flagsChanged events. A modifier is down when its flag bit is present after
/// the event for that key's keycode, up when absent.
final class ModifierTracker {
    private(set) var state = ModifierState()

    /// Returns true if the flagsChanged event itself should be consumed.
    func handleFlagsChanged(keyCode: Int64, flags: CGEventFlags) -> Bool {
        switch keyCode {
        case Keycode.rightCommand:
            // .maskCommand is set for either side; the keycode disambiguates.
            // Cross-check with the device-side bit NX_DEVICERCMDKEYMASK (0x10)
            // if both-commands-held edge cases show up.
            state.rightCommandHeld = flags.contains(.maskCommand)
            // TODO(Phase 3): record timestamps here for double-tap detection.
        case Keycode.rightOption:
            state.rightOptionHeld = flags.contains(.maskAlternate)
        default:
            break
        }
        // TODO(Phase 6): consume Caps Lock here when configured as the Stages
        // trigger so the lock state never toggles (BATTLEPLAN §3.2).
        return false
    }
}
