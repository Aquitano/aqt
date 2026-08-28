import Carbon.HIToolbox
import Foundation

/// Resolves hardware key codes through the user's active keyboard layout.
/// The Carbon layout APIs are still the canonical macOS mechanism for turning
/// a CGEvent key code into the unmodified character printed by that layout.
enum KeyLayout {
    private static let cache = LayoutCache()

    static func letter(for keyCode: Int64) -> Character? {
        switch cache.character(for: keyCode) {
        case .translated(let character):
            let value = String(character).lowercased()
            guard value.unicodeScalars.count == 1,
                  let scalar = value.unicodeScalars.first,
                  (UnicodeScalar("a").value ... UnicodeScalar("z").value).contains(scalar.value)
            else { return nil }
            return Character(value)
        case .unavailable:
            return Keycode.letters[keyCode]
        }
    }

    static func digit(for keyCode: Int64) -> Int? {
        switch cache.character(for: keyCode) {
        case .translated(let character):
            guard let value = character.wholeNumberValue, (1 ... 9).contains(value) else {
                return nil
            }
            return value
        case .unavailable:
            return Keycode.digits[keyCode]
        }
    }

    /// Public for app lifecycle hooks and deterministic tests.
    static func invalidate() {
        cache.invalidate()
    }
}

private final class LayoutCache: @unchecked Sendable {
    enum Result {
        case translated(Character)
        case unavailable
    }

    private let lock = NSLock()
    private var layoutData: Data?
    private var translations: [Int64: Result] = [:]
    private var loaded = false
    private var observer: NSObjectProtocol?

    init() {
        observer = DistributedNotificationCenter.default().addObserver(
            forName: Notification.Name(kTISNotifySelectedKeyboardInputSourceChanged as String),
            object: nil,
            queue: nil
        ) { [weak self] _ in
            self?.invalidate()
        }
    }

    deinit {
        if let observer {
            DistributedNotificationCenter.default().removeObserver(observer)
        }
    }

    func invalidate() {
        lock.withLock {
            loaded = false
            layoutData = nil
            translations.removeAll(keepingCapacity: true)
        }
    }

    func character(for keyCode: Int64) -> Result {
        if let cached = lock.withLock({ translations[keyCode] }) { return cached }
        guard (0 ... Int64(UInt16.max)).contains(keyCode), let data = currentLayoutData() else {
            return .unavailable
        }

        var deadKeyState: UInt32 = 0
        var length = 0
        var characters = [UniChar](repeating: 0, count: 4)
        let status: OSStatus = data.withUnsafeBytes { bytes in
            guard let baseAddress = bytes.baseAddress else { return OSStatus(paramErr) }
            let layout = baseAddress.assumingMemoryBound(to: UCKeyboardLayout.self)
            return UCKeyTranslate(
                layout,
                UInt16(keyCode),
                UInt16(kUCKeyActionDown),
                0,
                UInt32(LMGetKbdType()),
                OptionBits(kUCKeyTranslateNoDeadKeysMask),
                &deadKeyState,
                characters.count,
                &length,
                &characters
            )
        }

        guard status == noErr, deadKeyState == 0, length > 0 else {
            lock.withLock { translations[keyCode] = .unavailable }
            return .unavailable
        }
        let translated = String(utf16CodeUnits: characters, count: length)
        guard translated.count == 1, let character = translated.first else {
            lock.withLock { translations[keyCode] = .unavailable }
            return .unavailable
        }
        let result = Result.translated(character)
        lock.withLock { translations[keyCode] = result }
        return result
    }

    private func currentLayoutData() -> Data? {
        lock.withLock {
            if loaded { return layoutData }
            loaded = true

            guard let source = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
                  let property = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData)
            else { return nil }
            let data = unsafeBitCast(property, to: CFData.self)
            layoutData = data as Data
            return layoutData
        }
    }
}
