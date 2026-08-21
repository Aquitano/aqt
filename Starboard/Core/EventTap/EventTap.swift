import CoreGraphics
import Foundation

/// The single global event tap. All keyboard interception flows through the one
/// handler; nothing else in the app may create taps or event monitors.
///
/// The handler returns `true` to consume the event (it never reaches other apps)
/// and `false` to pass it through untouched. It runs on the main run loop for
/// every keystroke system-wide — keep it allocation-free and dispatch real work
/// async (see BATTLEPLAN §3.1).
final class EventTap {
    typealias Handler = (CGEventType, CGEvent) -> Bool

    enum Failure: Error {
        case tapCreationFailed // almost always: Accessibility permission missing
    }

    private let handler: Handler
    private var tap: CFMachPort?
    private var runLoopSource: CFRunLoopSource?

    init(handler: @escaping Handler) {
        self.handler = handler
    }

    func start() throws {
        let mask: CGEventMask =
            (1 << CGEventType.keyDown.rawValue)
            | (1 << CGEventType.keyUp.rawValue)
            | (1 << CGEventType.flagsChanged.rawValue)

        let callback: CGEventTapCallBack = { _, type, event, userInfo in
            let tap = Unmanaged<EventTap>.fromOpaque(userInfo!).takeUnretainedValue()
            if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
                tap.enable()
                return Unmanaged.passUnretained(event)
            }
            return tap.handler(type, event) ? nil : Unmanaged.passUnretained(event)
        }

        guard let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .defaultTap,
            eventsOfInterest: mask,
            callback: callback,
            userInfo: Unmanaged.passUnretained(self).toOpaque()
        ) else {
            throw Failure.tapCreationFailed
        }

        self.tap = tap
        let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        runLoopSource = source
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        enable()
        // TODO(Phase 1): watchdog timer re-checking CGEvent.tapIsEnabled every 5s
        // (BATTLEPLAN §7).
    }

    func enable() {
        guard let tap else { return }
        CGEvent.tapEnable(tap: tap, enable: true)
    }
}
