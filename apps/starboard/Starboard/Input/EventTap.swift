import CoreGraphics
import Foundation
import QuartzCore
import StarboardCore
import Synchronization

/// The one global event tap. It runs on its own thread, so a busy main thread
/// never delays typing anywhere on the system. Only intents cross to the main
/// actor.
final class EventTap: Sendable {
    enum Failure: Error {
        /// Almost always a missing Accessibility grant.
        case creationFailed
    }

    /// CoreFoundation types are safe to use across threads; they only lack
    /// the annotation.
    private struct Port: @unchecked Sendable {
        let machPort: CFMachPort
        let source: CFRunLoopSource
    }

    private let router: Mutex<InputRouter>
    private let port = Mutex<Port?>(nil)
    private let recentDisables = Mutex<[Double]>([])
    private let deliver: @Sendable ([Intent]) -> Void
    private let onFailure: @Sendable () -> Void

    /// `deliver` and `onFailure` are called on the tap thread.
    init(
        config: RouterConfig,
        deliver: @escaping @Sendable ([Intent]) -> Void,
        onFailure: @escaping @Sendable () -> Void
    ) {
        router = Mutex(InputRouter(config: config))
        self.deliver = deliver
        self.onFailure = onFailure
    }

    func start() throws {
        let mask: CGEventMask = (1 << CGEventType.keyDown.rawValue)
            | (1 << CGEventType.keyUp.rawValue)
            | (1 << CGEventType.flagsChanged.rawValue)
        let callback: CGEventTapCallBack = { _, type, event, userInfo in
            guard let userInfo else { return Unmanaged.passUnretained(event) }
            let tap = Unmanaged<EventTap>.fromOpaque(userInfo).takeUnretainedValue()
            return tap.handle(type, event) ? nil : Unmanaged.passUnretained(event)
        }
        guard let machPort = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .defaultTap,
            eventsOfInterest: mask,
            callback: callback,
            userInfo: Unmanaged.passUnretained(self).toOpaque()
        ), let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, machPort, 0) else {
            throw Failure.creationFailed
        }

        let port = Port(machPort: machPort, source: source)
        self.port.withLock { $0 = port }
        // The thread ends on its own once `stop()` removes its only source.
        // The callback holds `self` unretained, so the thread keeps it alive
        // until then.
        let thread = Thread { [self] in
            withExtendedLifetime(self) {
                CFRunLoopAddSource(CFRunLoopGetCurrent(), port.source, .commonModes)
                CFRunLoopRun()
            }
        }
        thread.name = "Starboard event tap"
        thread.qualityOfService = .userInteractive
        thread.start()
    }

    func stop() {
        port.withLock { port in
            guard let current = port else { return }
            CFMachPortInvalidate(current.machPort)
            CFRunLoopSourceInvalidate(current.source)
            port = nil
        }
        invalidate()
    }

    func setEnabled(_ enabled: Bool) {
        if enabled {
            recentDisables.withLock { $0.removeAll() }
        }
        port.withLock { port in
            guard let port else { return }
            CGEvent.tapEnable(tap: port.machPort, enable: enabled)
        }
        invalidate()
    }

    var isEnabled: Bool {
        port.withLock { $0.map { CGEvent.tapIsEnabled(tap: $0.machPort) } ?? false }
    }

    /// False once macOS has torn the port down, for instance after the
    /// Accessibility grant was revoked.
    var isValid: Bool {
        port.withLock { $0.map { CFMachPortIsValid($0.machPort) } ?? false }
    }

    func update(_ change: (inout RouterConfig) -> Void) {
        router.withLock { change(&$0.config) }
    }

    /// Drops everything the router has observed. Whatever was held while the
    /// tap was off was released unseen.
    func invalidate() {
        let intents = router.withLock { $0.reset() }
        if !intents.isEmpty {
            deliver(intents)
        }
    }

    private func handle(_ type: CGEventType, _ event: CGEvent) -> Bool {
        let kind: KeyEvent.Kind
        switch type {
        case .keyDown: kind = .keyDown
        case .keyUp: kind = .keyUp
        case .flagsChanged: kind = .flagsChanged
        case .tapDisabledByTimeout, .tapDisabledByUserInput:
            recoverFromSystemDisable()
            return false
        default:
            return false
        }
        // Space switches Starboard posts arrive while Right Command is still
        // held. They must reach the Dock untouched, and their flags must not
        // end the hold.
        if event.getIntegerValueField(.eventSourceUserData) == SpaceSwitcher.syntheticTag {
            return false
        }

        let keyEvent = KeyEvent(
            kind: kind,
            keyCode: event.getIntegerValueField(.keyboardEventKeycode),
            flags: event.flags.rawValue,
            isAutorepeat: event.getIntegerValueField(.keyboardEventAutorepeat) != 0,
            time: CACurrentMediaTime()
        )
        let route = signposter.withIntervalSignpost("Event routing") {
            router.withLock { $0.handle(keyEvent) }
        }
        if !route.intents.isEmpty {
            deliver(route.intents)
        }
        return route.consume
    }

    /// macOS disables a tap whose callback was too slow. Re-enabling it is
    /// right, but three disables inside 30 seconds mean something keeps
    /// stalling it, and the tap stays off until the user turns Starboard back
    /// on.
    private func recoverFromSystemDisable() {
        let now = CACurrentMediaTime()
        let lockedOut = recentDisables.withLock { disables in
            disables.removeAll { now - $0 > 30 }
            disables.append(now)
            return disables.count >= 3
        }
        invalidate()
        if lockedOut {
            log.error("The event tap was disabled three times in 30 seconds; leaving it off")
            onFailure()
        } else {
            port.withLock { port in
                guard let port else { return }
                CGEvent.tapEnable(tap: port.machPort, enable: true)
            }
        }
    }
}
