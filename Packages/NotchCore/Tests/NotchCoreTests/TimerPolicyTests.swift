import Foundation
import Testing
@testable import NotchCore

struct TimerPolicyTests {

    @Test func phasesAlternate() {
        #expect(PomodoroPolicy.next(after: .focus) == .rest)
        #expect(PomodoroPolicy.next(after: .rest) == .focus)
    }

    @Test func minutesClampToDialBounds() {
        #expect(PomodoroPolicy.clampedMinutes(0) == PomodoroPolicy.minuteRange.lowerBound)
        #expect(PomodoroPolicy.clampedMinutes(25) == 25)
        #expect(PomodoroPolicy.clampedMinutes(400) == PomodoroPolicy.minuteRange.upperBound)
    }

    @Test func defaultDurationsSitInsideDialBounds() {
        for phase in PomodoroPhase.allCases {
            #expect(PomodoroPolicy.minuteRange.contains(PomodoroPolicy.defaultMinutes(for: phase)))
        }
    }

    @Test func completionPeekPerPhase() {
        #expect(
            PomodoroPolicy.completionPeek(for: .focus, name: "Focus")
                == PomodoroPolicy.CompletionPeek(title: "Focus finished", message: "Time for a break")
        )
        #expect(
            PomodoroPolicy.completionPeek(for: .rest, name: "Break")
                == PomodoroPolicy.CompletionPeek(title: "Break over", message: "Back to focus")
        )
        // A plain countdown keeps its user-visible name as the headline.
        #expect(
            PomodoroPolicy.completionPeek(for: nil, name: "Tea")
                == PomodoroPolicy.CompletionPeek(title: "Tea", message: "Timer finished")
        )
    }
}
