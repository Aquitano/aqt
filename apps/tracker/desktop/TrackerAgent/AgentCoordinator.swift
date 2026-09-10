import ApplicationServices
import Foundation
import TrackerCore

@MainActor
@Observable
final class AgentCoordinator {
    private static let heartbeatInterval = Duration.seconds(30)
    private static let trustPollInterval = Duration.seconds(30)
    private static let terminationFlushTimeout: TimeInterval = 2
    private static let deviceIDKey = "device_id"
    private static let menuTitleLimit = 60

    let outbox: Outbox

    private(set) var accessibilityTrusted = AXIsProcessTrusted()

    var trackedDescription: String {
        guard let span = tracker.openSpan else { return "Tracking: nothing" }
        guard let title = span.windowTitle else { return "Tracking: \(span.target.appName)" }
        return "Tracking: \(span.target.appName) — \(title.prefix(Self.menuTitleLimit))"
    }

    private var tracker: SpanTracker
    private let focus = FocusWatcher()
    private let idle = IdleMonitor()
    private var timers: [Task<Void, Never>] = []

    init(configuration: TrackerConfiguration = .environment()) {
        tracker = SpanTracker(configuration: configuration)
        outbox = Outbox(configuration: configuration, deviceID: Self.deviceID())
    }

    func start() {
        focus.onEvent = { [weak self] event in self?.handle(event) }
        idle.onChange = { [weak self] isIdle in
            guard let self else { return }
            guard isIdle else {
                // Refresh before resuming so the new span carries the title the
                // window has now, not the one it had when attention stopped.
                focus.publishFrontmost()
                emit(.active)
                return
            }
            emit(.idle)
        }

        outbox.start()
        focus.start()
        idle.start()

        timers.append(every(Self.heartbeatInterval) { [weak self] in
            guard let self else { return }
            outbox.enqueue(tracker.heartbeat(at: .now))
        })
        timers.append(every(Self.trustPollInterval) { [weak self] in
            guard let self else { return }
            focus.refreshTrust()
            accessibilityTrusted = focus.isTrusted
        })
    }

    func stop() {
        for timer in timers {
            timer.cancel()
        }
        timers.removeAll()
        focus.stop()
        idle.stop()
        outbox.stop()
        outbox.enqueue(tracker.apply(.stop, at: .now))
        outbox.flushOnTerminate(timeout: Self.terminationFlushTimeout)
    }

    private func handle(_ event: FocusWatcher.Event) {
        switch event {
        case let .app(bundleID, appName, windowTitle):
            emit(.frontmost(FocusTarget(bundleID: bundleID, appName: appName), windowTitle: windowTitle))
        case let .windowTitle(title):
            emit(.windowTitle(title))
        }
    }

    private func emit(_ input: SpanInput) {
        outbox.enqueue(tracker.apply(input, at: .now))
    }

    private func every(_ interval: Duration, _ body: @escaping @MainActor () -> Void) -> Task<Void, Never> {
        Task { @MainActor in
            while !Task.isCancelled {
                try? await Task.sleep(for: interval)
                guard !Task.isCancelled else { return }
                body()
            }
        }
    }

    /// One id per machine, the label every row carries so a later merge across
    /// devices is a UNION.
    private static func deviceID() -> UUID {
        if let stored = UserDefaults.standard.string(forKey: deviceIDKey), let existing = UUID(uuidString: stored) {
            return existing
        }
        let fresh = UUIDv7.generate()
        UserDefaults.standard.set(fresh.uuidString.lowercased(), forKey: deviceIDKey)
        Log.agent.notice("new device id \(fresh.uuidString.lowercased(), privacy: .public)")
        return fresh
    }
}
