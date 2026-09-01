import AppKit

/// Countdown engine behind the timer tab and the status-menu timers, surfaced
/// as a `.timer` activity. The activity is sticky (no TTL) until it fires or is
/// cancelled; completion emits a Quick Peek. A single `Task.sleep` backs the
/// running timer — never a repeating timer.
@MainActor
@Observable
final class TimerManager {

    enum RunState: Equatable { case idle, running, paused }

    private(set) var runState: RunState = .idle
    /// Phase of the running/paused timer; nil for a plain countdown.
    private(set) var activePhase: PomodoroPhase?
    private(set) var endsAt: Date?
    private(set) var pausedRemaining: TimeInterval?
    private(set) var totalDuration: TimeInterval = 0
    /// Focus sessions completed since launch; the timer tab renders these as dots.
    private(set) var completedFocusSessions = 0
    /// The timer tab's pre-selected phase; a finished phase flips it to the other
    /// one (see `PomodoroPolicy.next`) so the natural next session is one tap away.
    var selectedPhase: PomodoroPhase = .focus

    var isRunning: Bool { runState != .idle }

    private unowned let activities: ActivityManager
    private var activityID: UUID?
    private var name = ""
    private var task: Task<Void, Never>?

    init(activities: ActivityManager) {
        self.activities = activities
    }

    func start(phase: PomodoroPhase, minutes: Int) {
        begin(name: phase.title,
              duration: TimeInterval(PomodoroPolicy.clampedMinutes(minutes) * 60),
              phase: phase)
    }

    func start(name: String, duration: TimeInterval) {
        begin(name: name, duration: duration, phase: nil)
    }

    func pause() {
        guard runState == .running, let endsAt else { return }
        task?.cancel()
        task = nil
        let remaining = max(0, endsAt.timeIntervalSinceNow)
        pausedRemaining = remaining
        self.endsAt = nil
        runState = .paused
        republish(endsAt: Date().addingTimeInterval(remaining), pausedRemaining: remaining)
    }

    func resume() {
        guard runState == .paused, let remaining = pausedRemaining else { return }
        let endsAt = Date().addingTimeInterval(remaining)
        self.endsAt = endsAt
        pausedRemaining = nil
        runState = .running
        republish(endsAt: endsAt, pausedRemaining: nil)
        schedule(seconds: remaining)
    }

    func cancel() {
        task?.cancel()
        task = nil
        clearActivity()
        reset()
    }

    private func begin(name: String, duration: TimeInterval, phase: PomodoroPhase?) {
        cancel()
        self.name = name
        activePhase = phase
        totalDuration = duration
        let endsAt = Date().addingTimeInterval(duration)
        self.endsAt = endsAt
        runState = .running
        republish(endsAt: endsAt, pausedRemaining: nil)
        schedule(seconds: duration)
    }

    private func schedule(seconds: TimeInterval) {
        task = Task { [weak self] in
            try? await Task.sleep(for: .seconds(seconds))
            guard !Task.isCancelled else { return }
            self?.complete()
        }
    }

    private func complete() {
        let peek = PomodoroPolicy.completionPeek(for: activePhase, name: name)
        if activePhase == .focus { completedFocusSessions += 1 }
        if let phase = activePhase { selectedPhase = PomodoroPolicy.next(after: phase) }
        task = nil
        clearActivity()
        reset()
        activities.peek(title: peek.title, message: peek.message, symbol: "timer", tint: .warning, ttl: 6)
        NSSound.beep()
    }

    private func reset() {
        runState = .idle
        activePhase = nil
        endsAt = nil
        pausedRemaining = nil
        totalDuration = 0
    }

    /// The activity carries the countdown target; a paused timer swaps it for a
    /// frozen remaining so the pill shows a static value instead of drifting.
    private func republish(endsAt: Date, pausedRemaining: TimeInterval?) {
        clearActivity()
        let activity = Activity(
            kind: .timer(name: name, endsAt: endsAt, pausedRemaining: pausedRemaining),
            priority: .normal, createdAt: Date()
        )
        activityID = activity.id
        activities.publish(activity)
    }

    private func clearActivity() {
        if let id = activityID { activities.remove(id: id) }
        activityID = nil
    }
}
