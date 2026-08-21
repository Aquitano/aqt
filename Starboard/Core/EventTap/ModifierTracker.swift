import CoreGraphics

struct ModifierState: Equatable {
    var rightCommandHeld = false
    var leftCommandHeld = false
    var rightOptionHeld = false
}

/// Tracks which side-specific modifiers are physically held, fed from
/// flagsChanged events. The generic mask bits (.maskCommand etc.) merge both
/// sides, so holding left-⌘ would mask a right-⌘ release — the device-side
/// bits in the raw flags identify each side independently (BATTLEPLAN §3.2).
final class ModifierTracker {
    private enum DeviceBit {
        static let leftCommand: UInt64 = 0x0000_0008 // NX_DEVICELCMDKEYMASK
        static let rightCommand: UInt64 = 0x0000_0010 // NX_DEVICERCMDKEYMASK
        static let rightOption: UInt64 = 0x0000_0040 // NX_DEVICERALTKEYMASK
    }

    private(set) var state = ModifierState()

    /// Returns true if the flagsChanged event itself should be consumed.
    func handleFlagsChanged(keyCode: Int64, flags: CGEventFlags) -> Bool {
        switch keyCode {
        case Keycode.rightCommand:
            state.rightCommandHeld = flags.rawValue & DeviceBit.rightCommand != 0
        case Keycode.leftCommand:
            state.leftCommandHeld = flags.rawValue & DeviceBit.leftCommand != 0
        case Keycode.rightOption:
            state.rightOptionHeld = flags.rawValue & DeviceBit.rightOption != 0
        default:
            break
        }
        // TODO(Phase 6): consume Caps Lock here when configured as the Stages
        // trigger so the lock state never toggles (BATTLEPLAN §3.2).
        return false
    }
}
