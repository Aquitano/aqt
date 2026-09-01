import AppKit
import Carbon.HIToolbox

/// A keyCode + Carbon-modifier pair as stored in Settings, with the conversion
/// and display logic the recorder UI needs.
struct HotKeyChord: Equatable {
    var keyCode: Int
    var carbonModifiers: Int

    static func carbonModifiers(from flags: NSEvent.ModifierFlags) -> Int {
        var modifiers = 0
        if flags.contains(.control) { modifiers |= controlKey }
        if flags.contains(.option) { modifiers |= optionKey }
        if flags.contains(.shift) { modifiers |= shiftKey }
        if flags.contains(.command) { modifiers |= cmdKey }
        return modifiers
    }

    /// A chord must carry a real modifier so it can't shadow plain typing;
    /// bare function keys are the conventional exception.
    var isValid: Bool {
        isFunctionKey || carbonModifiers & (controlKey | optionKey | cmdKey) != 0
    }

    var display: String { modifierSymbols + Self.keyName(for: keyCode) }

    var modifierSymbols: String {
        var symbols = ""
        if carbonModifiers & controlKey != 0 { symbols += "⌃" }
        if carbonModifiers & optionKey != 0 { symbols += "⌥" }
        if carbonModifiers & shiftKey != 0 { symbols += "⇧" }
        if carbonModifiers & cmdKey != 0 { symbols += "⌘" }
        return symbols
    }

    /// Carbon F-key codes are not contiguous, so this is an explicit map.
    private static let functionKeys: [Int: String] = [
        kVK_F1: "F1", kVK_F2: "F2", kVK_F3: "F3", kVK_F4: "F4",
        kVK_F5: "F5", kVK_F6: "F6", kVK_F7: "F7", kVK_F8: "F8",
        kVK_F9: "F9", kVK_F10: "F10", kVK_F11: "F11", kVK_F12: "F12",
        kVK_F13: "F13", kVK_F14: "F14", kVK_F15: "F15", kVK_F16: "F16",
        kVK_F17: "F17", kVK_F18: "F18", kVK_F19: "F19", kVK_F20: "F20",
    ]

    private var isFunctionKey: Bool {
        Self.functionKeys[keyCode] != nil
    }

    static func keyName(for keyCode: Int) -> String {
        switch keyCode {
        case kVK_Space: return "Space"
        case kVK_Return: return "↩"
        case kVK_Tab: return "⇥"
        case kVK_Escape: return "⎋"
        case kVK_Delete: return "⌫"
        case kVK_ForwardDelete: return "⌦"
        case kVK_LeftArrow: return "←"
        case kVK_RightArrow: return "→"
        case kVK_UpArrow: return "↑"
        case kVK_DownArrow: return "↓"
        case kVK_Home: return "↖"
        case kVK_End: return "↘"
        case kVK_PageUp: return "⇞"
        case kVK_PageDown: return "⇟"
        default:
            return functionKeys[keyCode]
                ?? character(for: keyCode)
                ?? "Key \(keyCode)"
        }
    }

    /// Resolves a character key through the current keyboard layout so a chord
    /// recorded on QWERTZ reads back as the key the user actually pressed.
    private static func character(for keyCode: Int) -> String? {
        guard let source = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
              let rawLayout = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData)
        else { return nil }
        let layoutData = Unmanaged<CFData>.fromOpaque(rawLayout).takeUnretainedValue() as Data
        var deadKeyState: UInt32 = 0
        var chars = [UniChar](repeating: 0, count: 4)
        var length = 0
        let status = layoutData.withUnsafeBytes { buffer -> OSStatus in
            guard let layout = buffer.bindMemory(to: UCKeyboardLayout.self).baseAddress else {
                return OSStatus(paramErr)
            }
            return UCKeyTranslate(
                layout, UInt16(keyCode), UInt16(kUCKeyActionDisplay), 0,
                UInt32(LMGetKbdType()), OptionBits(kUCKeyTranslateNoDeadKeysBit),
                &deadKeyState, chars.count, &length, &chars
            )
        }
        guard status == noErr, length > 0 else { return nil }
        let name = String(utf16CodeUnits: chars, count: length).uppercased()
        return name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : name
    }
}
