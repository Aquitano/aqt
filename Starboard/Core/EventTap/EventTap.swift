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
    private var disableTimes: [ContinuousClock.Instant] = []
    private var recoveryLockedOut = false

    static let failedNotification = Notification.Name("StarboardEventTapFailed")
    private static let failureWindow: Duration = .seconds(30)
    private static let maximumFailures = 3

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
                tap.recoverFromSystemDisable()
                return Unmanaged.passUnretained(event)
            }
            let interval = Perf.beginEventRouting()
            let consumed = tap.handler(type, event)
            Perf.endEventRouting(interval)
            return consumed ? nil : Unmanaged.passUnretained(event)
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
    }

    var isEnabled: Bool {
        guard let tap else { return false }
        return CGEvent.tapIsEnabled(tap: tap)
    }

    func enable() {
        guard let tap else { return }
        recoveryLockedOut = false
        disableTimes.removeAll(keepingCapacity: true)
        CGEvent.tapEnable(tap: tap, enable: true)
    }

    /// Called by the watchdog. Unlike a user-requested `enable()`, this counts
    /// repeated OS disables and opens the circuit after a crash loop.
    func recoverIfNeeded() {
        guard !isEnabled else { return }
        recoverFromSystemDisable()
    }

    func disable() {
        guard let tap else { return }
        CGEvent.tapEnable(tap: tap, enable: false)
    }

    private func recoverFromSystemDisable(now: ContinuousClock.Instant = .now) {
        guard !recoveryLockedOut else { return }
        disableTimes.removeAll { now - $0 > Self.failureWindow }
        disableTimes.append(now)

        guard disableTimes.count < Self.maximumFailures else {
            recoveryLockedOut = true
            NSLog("Starboard: event tap disabled repeatedly; recovery locked out")
            NotificationCenter.default.post(name: Self.failedNotification, object: self)
            return
        }

        guard let tap else { return }
        CGEvent.tapEnable(tap: tap, enable: true)
    }
}
