import CoreGraphics

struct ModifierState: Equatable {
    var rightCommandHeld = false
    var leftCommandHeld = false
    var rightOptionHeld = false
    var rightShiftHeld = false
    var leftOptionHeld = false
    var rightControlHeld = false
    var fnHeld = false

    func isHeld(_ modifier: PrimaryModifier) -> Bool {
        switch modifier {
        case .rightCommand: return rightCommandHeld
        case .rightOption: return rightOptionHeld
        case .rightControl: return rightControlHeld
        case .leftOption: return leftOptionHeld
        case .fn: return fnHeld
        }
    }
}

/// Tracks which side-specific modifiers are physically held. The generic mask
/// bits (.maskCommand etc.) merge both sides, so holding left-⌘ would mask a
/// right-⌘ release — the device-side bits in the raw flags identify each side
/// independently (BATTLEPLAN §3.2).
///
/// Every event carries the full modifier picture, so the state is recomputed
/// from scratch on each one rather than toggled by keycode: a lost rcmd release
/// (tap disabled by the OS, secure input, screen lock) would otherwise leave
/// `rightCommandHeld` stuck true and swallow every letter until the next press.
final class ModifierTracker {
    private enum DeviceBit {
        static let rightControl: UInt64 = 0x0000_2000 // NX_DEVICERCTLKEYMASK
        static let rightShift: UInt64 = 0x0000_0004 // NX_DEVICERSHIFTKEYMASK
        static let leftCommand: UInt64 = 0x0000_0008 // NX_DEVICELCMDKEYMASK
        static let rightCommand: UInt64 = 0x0000_0010 // NX_DEVICERCMDKEYMASK
        static let leftOption: UInt64 = 0x0000_0020 // NX_DEVICELALTKEYMASK
        static let rightOption: UInt64 = 0x0000_0040 // NX_DEVICERALTKEYMASK
        static let fn: UInt64 = 0x0080_0000 // NX_SECONDARYFNMASK / maskSecondaryFn
    }

    private(set) var state = ModifierState()

    /// Reconciles the state with the event's flags and returns it.
    @discardableResult
    func update(flags: CGEventFlags) -> ModifierState {
        let raw = flags.rawValue
        state = ModifierState(
            rightCommandHeld: raw & DeviceBit.rightCommand != 0,
            leftCommandHeld: raw & DeviceBit.leftCommand != 0,
            rightOptionHeld: raw & DeviceBit.rightOption != 0,
            rightShiftHeld: raw & DeviceBit.rightShift != 0,
            leftOptionHeld: raw & DeviceBit.leftOption != 0,
            rightControlHeld: raw & DeviceBit.rightControl != 0,
            fnHeld: flags.contains(.maskSecondaryFn) || raw & DeviceBit.fn != 0
        )
        return state
    }

    /// Drops everything held: the tap was off, so releases happened unseen.
    func reset() {
        state = ModifierState()
    }
}
