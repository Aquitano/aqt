import Carbon.HIToolbox
import Foundation
import StarboardCore

/// Reads the active keyboard layout. The Text Input Source APIs belong to the
/// main thread, so the map is built here and handed to the tap.
@MainActor
enum KeyLayout {
    static func current() -> KeyboardMap {
        guard let source = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
              let property = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData)
        else { return .ansi }
        let data = Unmanaged<CFData>.fromOpaque(property).takeUnretainedValue() as Data
        let printed: [Int64: Character] = data.withUnsafeBytes { bytes in
            guard let base = bytes.baseAddress else { return [:] }
            let layout = base.assumingMemoryBound(to: UCKeyboardLayout.self)
            var printed: [Int64: Character] = [:]
            for keyCode in UInt16(0) ..< 128 {
                printed[Int64(keyCode)] = character(for: keyCode, in: layout)
            }
            return printed
        }
        return KeyboardMap(printed: printed)
    }

    static func observeChanges(_ onChange: @escaping @MainActor () -> Void) -> NSObjectProtocol {
        DistributedNotificationCenter.default().addObserver(
            forName: Notification.Name(kTISNotifySelectedKeyboardInputSourceChanged as String),
            object: nil,
            queue: .main
        ) { _ in
            MainActor.assumeIsolated { onChange() }
        }
    }

    private static func character(for keyCode: UInt16, in layout: UnsafePointer<UCKeyboardLayout>) -> Character? {
        var deadKeyState: UInt32 = 0
        var length = 0
        var characters = [UniChar](repeating: 0, count: 4)
        let status = UCKeyTranslate(
            layout,
            keyCode,
            UInt16(kUCKeyActionDown),
            0,
            UInt32(LMGetKbdType()),
            OptionBits(kUCKeyTranslateNoDeadKeysMask),
            &deadKeyState,
            characters.count,
            &length,
            &characters
        )
        guard status == noErr, deadKeyState == 0, length > 0 else { return nil }
        let text = String(utf16CodeUnits: characters, count: length)
        return text.count == 1 ? text.first : nil
    }
}
