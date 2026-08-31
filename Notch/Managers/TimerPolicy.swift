import Foundation

/// The two pomodoro phases the timer tab cycles between. `rest` renders as
/// "Break"; the raw value stays stable for persistence.
enum PomodoroPhase: String, CaseIterable, Identifiable {
    case focus
    case rest

    var id: String { rawValue }

    var title: String {
        switch self {
        case .focus: return "Focus"
        case .rest: return "Break"
        }
    }
}

/// Pure decisions for the pomodoro cycle: which phase follows which, the dial's
/// bounds, and the completion peek per phase — kept away from `TimerManager`'s
/// task/activity plumbing so the transitions are table-testable.
enum PomodoroPolicy {

    /// Dial bounds in minutes: wide enough for deep-work blocks, small enough
    /// that every minute stays a distinct tick on the dial.
    static let minuteRange: ClosedRange<Int> = 5...90

    static func defaultMinutes(for phase: PomodoroPhase) -> Int {
        switch phase {
        case .focus: return 25
        case .rest: return 5
        }
    }

    static func clampedMinutes(_ minutes: Int) -> Int {
        min(max(minutes, minuteRange.lowerBound), minuteRange.upperBound)
    }

    /// Focus and break alternate; a finished phase pre-selects the other one so
    /// the natural next session is one tap away.
    static func next(after phase: PomodoroPhase) -> PomodoroPhase {
        switch phase {
        case .focus: return .rest
        case .rest: return .focus
        }
    }

    struct CompletionPeek: Equatable {
        var title: String
        var message: String
    }

    /// nil phase = a plain countdown started outside the pomodoro tab.
    static func completionPeek(for phase: PomodoroPhase?, name: String) -> CompletionPeek {
        switch phase {
        case .focus: return CompletionPeek(title: "Focus finished", message: "Time for a break")
        case .rest: return CompletionPeek(title: "Break over", message: "Back to focus")
        case nil: return CompletionPeek(title: name, message: "Timer finished")
        }
    }
}
