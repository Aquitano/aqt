public struct KeyEvent: Equatable, Sendable {
    public enum Kind: Equatable, Sendable {
        case keyDown
        case keyUp
        case flagsChanged
    }

    public var kind: Kind
    public var keyCode: Int64
    /// The raw `CGEventFlags` value, device-dependent bits included.
    public var flags: UInt64
    public var isAutorepeat: Bool
    /// Seconds on a monotonic clock.
    public var time: Double

    public init(kind: Kind, keyCode: Int64, flags: UInt64, isAutorepeat: Bool = false, time: Double) {
        self.kind = kind
        self.keyCode = keyCode
        self.flags = flags
        self.isAutorepeat = isAutorepeat
        self.time = time
    }
}

/// The side-specific modifiers Starboard reads. The generic masks merge both
/// sides, so holding Left Command would hide a Right Command release; the
/// device-dependent bits tell the sides apart. Every event carries the full
/// picture, so a release the tap never saw heals on the next event.
struct Modifiers: Equatable {
    let rightCommand: Bool
    let leftCommand: Bool
    let rightOption: Bool
    let rightShift: Bool

    init(flags: UInt64) {
        rightCommand = flags & DeviceBit.rightCommand != 0
        leftCommand = flags & DeviceBit.leftCommand != 0
        rightOption = flags & DeviceBit.rightOption != 0
        rightShift = flags & DeviceBit.rightShift != 0
    }

    /// IOKit's NX_DEVICE*KEYMASK values.
    enum DeviceBit {
        static let rightShift: UInt64 = 0x0000_0004
        static let leftCommand: UInt64 = 0x0000_0008
        static let rightCommand: UInt64 = 0x0000_0010
        static let rightOption: UInt64 = 0x0000_0040
    }
}

/// Hardware key codes, ANSI positions.
public enum Keycode {
    public static let capsLock: Int64 = 0x39
    public static let tab: Int64 = 0x30
    public static let escape: Int64 = 0x35
    public static let backspace: Int64 = 0x33
    public static let upArrow: Int64 = 0x7E
    public static let downArrow: Int64 = 0x7D
    public static let leftArrow: Int64 = 0x7B
    public static let rightArrow: Int64 = 0x7C
    public static let leftBracket: Int64 = 0x21
    public static let rightBracket: Int64 = 0x1E
    public static let equal: Int64 = 0x18
    public static let minus: Int64 = 0x1B

    public static let letters: [Int64: Character] = [
        0x00: "a", 0x0B: "b", 0x08: "c", 0x02: "d", 0x0E: "e", 0x03: "f",
        0x05: "g", 0x04: "h", 0x22: "i", 0x26: "j", 0x28: "k", 0x25: "l",
        0x2E: "m", 0x2D: "n", 0x1F: "o", 0x23: "p", 0x0C: "q", 0x0F: "r",
        0x01: "s", 0x11: "t", 0x20: "u", 0x09: "v", 0x0D: "w", 0x07: "x",
        0x10: "y", 0x06: "z",
    ]

    /// The digit row, 1 to 9.
    public static let digits: [Int64: Int] = [
        0x12: 1, 0x13: 2, 0x14: 3, 0x15: 4, 0x17: 5,
        0x16: 6, 0x1A: 7, 0x1C: 8, 0x19: 9,
    ]

    public static let digitKeycodes: [Int: Int64] =
        Dictionary(uniqueKeysWithValues: digits.map { ($0.value, $0.key) })
}

/// Which letter or digit each key means on the active keyboard layout.
public struct KeyboardMap: Equatable, Sendable {
    private let letters: [Int64: Character]
    private let digits: [Int64: Int]

    public static let ansi = KeyboardMap(letters: Keycode.letters, digits: Keycode.digits)

    private init(letters: [Int64: Character], digits: [Int64: Int]) {
        self.letters = letters
        self.digits = digits
    }

    /// `printed` is what the layout types on each key with no modifier held.
    /// A key printing a letter from another script keeps its ANSI letter, so
    /// shortcuts stay usable on Cyrillic or Greek layouts. A key printing
    /// punctuation is no letter at all, or Dvorak's comma key would be "w".
    /// The digit row keeps its digits on layouts such as AZERTY that print
    /// symbols there unshifted.
    public init(printed: [Int64: Character]) {
        var letters: [Int64: Character] = [:]
        for (keyCode, ansi) in Keycode.letters where printed[keyCode] == nil {
            letters[keyCode] = ansi
        }
        var digits = Keycode.digits
        for (keyCode, character) in printed {
            if let latin = Self.latinLetter(character) {
                letters[keyCode] = latin
            } else if character.isLetter, let ansi = Keycode.letters[keyCode] {
                letters[keyCode] = ansi
            } else if let digit = character.wholeNumberValue, (1 ... 9).contains(digit) {
                digits[keyCode] = digit
            }
        }
        self.init(letters: letters, digits: digits)
    }

    public func letter(for keyCode: Int64) -> Character? {
        letters[keyCode]
    }

    public func digit(for keyCode: Int64) -> Int? {
        digits[keyCode]
    }

    private static func latinLetter(_ character: Character) -> Character? {
        let lowered = character.lowercased()
        guard lowered.unicodeScalars.count == 1,
              let scalar = lowered.unicodeScalars.first,
              ("a" ... "z").contains(scalar) else { return nil }
        return Character(scalar)
    }
}
