import Foundation

/// Hardware keycodes (ANSI layout). Right-vs-left modifier identity only exists
/// at the keycode level — CGEventFlags merges both sides (BATTLEPLAN §3.2).
///
/// TODO(Phase 3): letters are ANSI-only; translate via UCKeyTranslate with the
/// current keyboard layout for international layouts.
enum Keycode {
    static let rightCommand: Int64 = 0x36
    static let leftCommand: Int64 = 0x37
    static let leftOption: Int64 = 0x3A
    static let rightOption: Int64 = 0x3D
    static let capsLock: Int64 = 0x39

    static let tab: Int64 = 0x30
    static let escape: Int64 = 0x35
    static let backtick: Int64 = 0x32
    static let leftBracket: Int64 = 0x21
    static let rightBracket: Int64 = 0x1E
    static let equal: Int64 = 0x18
    static let minus: Int64 = 0x1B
    static let f5: Int64 = 0x60

    static let letters: [Int64: Character] = [
        0x00: "a", 0x0B: "b", 0x08: "c", 0x02: "d", 0x0E: "e", 0x03: "f",
        0x05: "g", 0x04: "h", 0x22: "i", 0x26: "j", 0x28: "k", 0x25: "l",
        0x2E: "m", 0x2D: "n", 0x1F: "o", 0x23: "p", 0x0C: "q", 0x0F: "r",
        0x01: "s", 0x11: "t", 0x20: "u", 0x09: "v", 0x0D: "w", 0x07: "x",
        0x10: "y", 0x06: "z",
    ]

    /// Digit row 1–9, for Spaces navigation (Phase 5).
    static let digits: [Int64: Int] = [
        0x12: 1, 0x13: 2, 0x14: 3, 0x15: 4, 0x17: 5,
        0x16: 6, 0x1A: 7, 0x1C: 8, 0x19: 9,
    ]
}
