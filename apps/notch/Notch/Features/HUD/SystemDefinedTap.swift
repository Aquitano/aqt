import AppKit
import ApplicationServices
import CoreGraphics
import NotchCore

/// Event tap on NX_SYSDEFINED media keys, in one of two modes:
///
/// - **Listen-only** (Input Monitoring): never consumes events, so the system
///   still changes volume/brightness and draws its own HUD; we just observe.
/// - **Consuming** (Accessibility): the handler applies the change itself and
///   returns true to swallow the key, which is what hides the native HUD. A key
///   the handler can't honour (external-display brightness, an unwritable
///   device) passes through untouched so the system takes over — otherwise the
///   key would be eaten with nothing happening.
///
/// The run-loop source lives on the main run loop, so events are handled on the
/// main thread and the handler's decision is synchronous.
final class SystemDefinedTap: @unchecked Sendable {
    enum MediaKey { case volumeUp, volumeDown, mute, brightnessUp, brightnessDown }

    /// Called on the main thread for every media key-down, auto-repeats
    /// included. `fine` mirrors the system's Shift+Option quarter-step chord.
    /// Return true to swallow the event (honoured in consuming mode only).
    var onMediaKey: ((MediaKey, _ fine: Bool) -> Bool)?

    private var tap: CFMachPort?
    private var source: CFRunLoopSource?
    private var consuming = false
    /// Key codes whose key-down we swallowed; the matching key-up is swallowed
    /// too so the system never sees half a key press.
    private var swallowedKeyCodes = Set<Int>()

    /// NX_SYSDEFINED is event type 14; there's no CGEventType case for it.
    private static let systemDefinedMask = CGEventMask(1) << 14

    @discardableResult
    func start(consuming: Bool) -> Bool {
        if tap != nil {
            guard consuming != self.consuming else { return true }
            stop()
        }
        // Don't call the request variants here: at launch they yank System
        // Settings to the front unprompted. The HUD simply stays inactive until
        // the user grants access (Settings > Permissions deep-links there).
        guard consuming ? AXIsProcessTrusted() : CGPreflightListenEventAccess() else {
            return false
        }
        self.consuming = consuming

        let refcon = Unmanaged.passUnretained(self).toOpaque()
        guard let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: consuming ? .defaultTap : .listenOnly,
            eventsOfInterest: Self.systemDefinedMask,
            callback: { _, type, event, refcon in
                guard let refcon else { return Unmanaged.passUnretained(event) }
                let me = Unmanaged<SystemDefinedTap>.fromOpaque(refcon).takeUnretainedValue()
                if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
                    me.reEnable()
                    return Unmanaged.passUnretained(event)
                }
                return me.handle(event) ? nil : Unmanaged.passUnretained(event)
            },
            userInfo: refcon
        ) else {
            Log.hud.error("Failed to create system-defined event tap")
            return false
        }

        self.tap = tap
        let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        self.source = source
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        return true
    }

    func stop() {
        if let source {
            CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes)
        }
        if let tap {
            CGEvent.tapEnable(tap: tap, enable: false)
            CFMachPortInvalidate(tap)
        }
        source = nil
        tap = nil
        swallowedKeyCodes.removeAll()
    }

    var isEnabled: Bool {
        guard let tap else { return false }
        return CGEvent.tapIsEnabled(tap: tap)
    }

    private func reEnable() {
        guard let tap else { return }
        CGEvent.tapEnable(tap: tap, enable: true)
    }

    /// Returns true when the event must be swallowed.
    private func handle(_ cgEvent: CGEvent) -> Bool {
        guard let event = NSEvent(cgEvent: cgEvent), event.subtype.rawValue == 8 else { return false }
        let data1 = event.data1
        let keyCode = (data1 & 0xFFFF_0000) >> 16
        let keyState = (data1 & 0xFF00) >> 8

        let key: MediaKey? = switch keyCode {
        case 0: .volumeUp // NX_KEYTYPE_SOUND_UP
        case 1: .volumeDown // NX_KEYTYPE_SOUND_DOWN
        case 7: .mute // NX_KEYTYPE_MUTE
        case 2: .brightnessUp // NX_KEYTYPE_BRIGHTNESS_UP
        case 3: .brightnessDown // NX_KEYTYPE_BRIGHTNESS_DOWN
        default: nil
        }
        guard let key else { return false }

        if keyState == 0x0B { // key up: swallow iff its key-down was swallowed
            return consuming && swallowedKeyCodes.remove(keyCode) != nil
        }
        guard keyState == 0x0A else { return false } // key down only

        let fine = event.modifierFlags.isSuperset(of: [.shift, .option])
        let swallow = onMediaKey?(key, fine) ?? false
        guard consuming, swallow else { return false }
        swallowedKeyCodes.insert(keyCode)
        return true
    }
}
