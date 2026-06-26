import AppKit
import Combine

/// One-shot countdowns surfaced as `.timer` activities. The activity is sticky
/// (no TTL) until it fires or is cancelled; completion emits a Quick Peek. A
/// single `Task.sleep` backs the running timer — never a repeating timer.
@MainActor
final class TimerManager: ObservableObject {

    @Published private(set) var isRunning = false

    private unowned let activities: ActivityManager
    private var activityID: UUID?
    private var task: Task<Void, Never>?

    init(activities: ActivityManager) {
        self.activities = activities
    }

    func start(name: String, duration: TimeInterval) {
        cancel()
        let activity = Activity(kind: .timer(name: name, endsAt: Date().addingTimeInterval(duration)),
                                priority: .normal, createdAt: Date())
        activityID = activity.id
        activities.publish(activity)
        isRunning = true

        task = Task { [weak self] in
            try? await Task.sleep(for: .seconds(duration))
            guard !Task.isCancelled else { return }
            self?.complete(name: name)
        }
    }

    func cancel() {
        task?.cancel()
        task = nil
        clearActivity()
        isRunning = false
    }

    private func complete(name: String) {
        clearActivity()
        task = nil
        isRunning = false
        activities.peek(title: name, message: "Timer finished", symbol: "timer", tint: .warning, ttl: 6)
        NSSound.beep()
    }

    private func clearActivity() {
        if let id = activityID { activities.remove(id: id) }
        activityID = nil
    }
}
