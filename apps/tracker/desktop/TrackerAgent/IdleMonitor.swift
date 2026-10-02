import AppKit
import CoreGraphics
import TrackerCore

/// Idle is more than "no keystrokes": a locked screen, a sleeping display and a
/// sleeping machine all mean the same thing for attention data.
@MainActor
final class IdleMonitor: NSObject {
    /// The same threshold `chrome.idle` runs on in the extension.
    private static let threshold: TimeInterval = 60
    private static let interval = Duration.seconds(5)
    private static let tolerance = Duration.milliseconds(500)
    private static let anyInputEvent = CGEventType(rawValue: ~0)

    /// The date is when the state began: the last input for an idle poll,
    /// now for a lock, a sleep or a resume.
    var onChange: ((Bool, Date) -> Void)?

    private(set) var isIdle = false

    private var inputIdle = false
    private var lastInputAt = Date.now
    private var screensAsleep = false
    private var sessionInactive = false
    private var isLocked = false
    private var isSleeping = false
    private var pollTask: Task<Void, Never>?

    /// Idle whatever the input counter says, so there is nothing to poll for.
    private var isAway: Bool {
        screensAsleep || sessionInactive || isLocked || isSleeping
    }

    func start() {
        let workspace = NSWorkspace.shared.notificationCenter
        workspace.addObserver(
            self,
            selector: #selector(goInactive),
            name: NSWorkspace.willSleepNotification,
            object: nil
        )
        workspace.addObserver(self, selector: #selector(goActive), name: NSWorkspace.didWakeNotification, object: nil)
        workspace.addObserver(
            self,
            selector: #selector(goInactive),
            name: NSWorkspace.screensDidSleepNotification,
            object: nil
        )
        workspace.addObserver(
            self,
            selector: #selector(goActive),
            name: NSWorkspace.screensDidWakeNotification,
            object: nil
        )
        workspace.addObserver(
            self,
            selector: #selector(goInactive),
            name: NSWorkspace.sessionDidResignActiveNotification,
            object: nil
        )
        workspace.addObserver(
            self,
            selector: #selector(goActive),
            name: NSWorkspace.sessionDidBecomeActiveNotification,
            object: nil
        )

        let distributed = DistributedNotificationCenter.default()
        distributed.addObserver(self, selector: #selector(goInactive), name: .screenIsLocked, object: nil)
        distributed.addObserver(self, selector: #selector(goActive), name: .screenIsUnlocked, object: nil)

        pollTask = polling(after: .zero)
    }

    func stop() {
        NSWorkspace.shared.notificationCenter.removeObserver(self)
        DistributedNotificationCenter.default().removeObserver(self)
        pollTask?.cancel()
        pollTask = nil
    }

    @objc private func goInactive(_ notification: Notification) {
        apply(notification.name, asleep: true)
    }

    @objc private func goActive(_ notification: Notification) {
        apply(notification.name, asleep: false)
    }

    private func apply(_ name: Notification.Name, asleep: Bool) {
        switch name {
        case NSWorkspace.willSleepNotification, NSWorkspace.didWakeNotification:
            isSleeping = asleep
        case NSWorkspace.screensDidSleepNotification, NSWorkspace.screensDidWakeNotification:
            screensAsleep = asleep
        case NSWorkspace.sessionDidResignActiveNotification, NSWorkspace.sessionDidBecomeActiveNotification:
            sessionInactive = asleep
        default:
            isLocked = asleep
        }
        // Waking, unlocking and switching back all take input the idle counter
        // has not seen yet, so the poll must not immediately re-idle the span.
        if !asleep {
            inputIdle = false
        }
        publish()
        pollTask?.cancel()
        pollTask = isAway ? nil : polling(after: Self.interval)
    }

    private func polling(after delay: Duration) -> Task<Void, Never> {
        Task { [weak self] in
            var delay = delay
            while !Task.isCancelled {
                try? await Task.sleep(for: delay, tolerance: IdleMonitor.tolerance)
                guard !Task.isCancelled, let next = self?.pollInput() else { return }
                delay = next
            }
        }
    }

    /// Recent input cannot cross the threshold until it has been quiet that
    /// long, so the next poll waits for that moment rather than every interval.
    private func pollInput() -> Duration {
        guard let eventType = Self.anyInputEvent else { return Self.interval }
        let seconds = CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: eventType)
        inputIdle = seconds >= Self.threshold
        lastInputAt = .now.addingTimeInterval(-seconds)
        publish()
        return inputIdle ? Self.interval : max(Self.interval, .seconds(Self.threshold - seconds))
    }

    private func publish() {
        let idle = inputIdle || isAway
        guard idle != isIdle else { return }
        isIdle = idle
        Log.idle.debug("idle \(idle, privacy: .public)")
        onChange?(idle, idle && inputIdle ? lastInputAt : .now)
    }
}

private extension Notification.Name {
    static let screenIsLocked = Notification.Name("com.apple.screenIsLocked")
    static let screenIsUnlocked = Notification.Name("com.apple.screenIsUnlocked")
}
