import AppKit
import CoreGraphics

/// Listen-only event tap on NX_SYSDEFINED. Never consumes events, so the system
/// still changes volume/brightness and draws its own HUD; we just observe the
/// key presses to render our overlay alongside. Needs Input Monitoring.
final class SystemDefinedTap: @unchecked Sendable {

    enum MediaKey { case volumeUp, volumeDown, mute, brightnessUp, brightnessDown }

    var onKeyDown: ((MediaKey) -> Void)?

    private var tap: CFMachPort?
    private var source: CFRunLoopSource?

    /// NX_SYSDEFINED is event type 14; there's no CGEventType case for it.
    private static let systemDefinedMask = CGEventMask(1) << 14

    @discardableResult
    func start() -> Bool {
        guard tap == nil else { return true }
        // Don't call CGRequestListenEventAccess() here: at launch it yanks System
        // Settings to the front unprompted. The HUD simply stays inactive until the
        // user grants Input Monitoring (Settings > Permissions deep-links there).
        guard CGPreflightListenEventAccess() else {
            return false
        }

        let refcon = Unmanaged.passUnretained(self).toOpaque()
        guard let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .listenOnly,
            eventsOfInterest: Self.systemDefinedMask,
            callback: { _, type, event, refcon in
                guard let refcon else { return Unmanaged.passUnretained(event) }
                let me = Unmanaged<SystemDefinedTap>.fromOpaque(refcon).takeUnretainedValue()
                if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
                    me.reEnable()
                } else {
                    me.handle(event)
                }
                return Unmanaged.passUnretained(event)
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

    var isEnabled: Bool {
        guard let tap else { return false }
        return CGEvent.tapIsEnabled(tap: tap)
    }

    private func reEnable() {
        guard let tap else { return }
        CGEvent.tapEnable(tap: tap, enable: true)
    }

    private func handle(_ cgEvent: CGEvent) {
        guard let event = NSEvent(cgEvent: cgEvent), event.subtype.rawValue == 8 else { return }
        let data1 = event.data1
        let keyCode = (data1 & 0xFFFF0000) >> 16
        let keyState = (data1 & 0xFF00) >> 8
        guard keyState == 0x0A else { return }   // key down only

        let key: MediaKey?
        switch keyCode {
        case 0: key = .volumeUp       // NX_KEYTYPE_SOUND_UP
        case 1: key = .volumeDown     // NX_KEYTYPE_SOUND_DOWN
        case 7: key = .mute           // NX_KEYTYPE_MUTE
        case 2: key = .brightnessUp   // NX_KEYTYPE_BRIGHTNESS_UP
        case 3: key = .brightnessDown // NX_KEYTYPE_BRIGHTNESS_DOWN
        default: key = nil
        }
        guard let key else { return }
        DispatchQueue.main.async { [weak self] in self?.onKeyDown?(key) }
    }
}
