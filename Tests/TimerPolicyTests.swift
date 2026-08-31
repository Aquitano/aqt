import XCTest

final class TimerPolicyTests: XCTestCase {

    func testPhasesAlternate() {
        XCTAssertEqual(PomodoroPolicy.next(after: .focus), .rest)
        XCTAssertEqual(PomodoroPolicy.next(after: .rest), .focus)
    }

    func testMinutesClampToDialBounds() {
        XCTAssertEqual(PomodoroPolicy.clampedMinutes(0), PomodoroPolicy.minuteRange.lowerBound)
        XCTAssertEqual(PomodoroPolicy.clampedMinutes(25), 25)
        XCTAssertEqual(PomodoroPolicy.clampedMinutes(400), PomodoroPolicy.minuteRange.upperBound)
    }

    func testDefaultDurationsSitInsideDialBounds() {
        for phase in PomodoroPhase.allCases {
            XCTAssertTrue(PomodoroPolicy.minuteRange.contains(PomodoroPolicy.defaultMinutes(for: phase)))
        }
    }

    func testCompletionPeekPerPhase() {
        XCTAssertEqual(
            PomodoroPolicy.completionPeek(for: .focus, name: "Focus"),
            PomodoroPolicy.CompletionPeek(title: "Focus finished", message: "Time for a break")
        )
        XCTAssertEqual(
            PomodoroPolicy.completionPeek(for: .rest, name: "Break"),
            PomodoroPolicy.CompletionPeek(title: "Break over", message: "Back to focus")
        )
        // A plain countdown keeps its user-visible name as the headline.
        XCTAssertEqual(
            PomodoroPolicy.completionPeek(for: nil, name: "Tea"),
            PomodoroPolicy.CompletionPeek(title: "Tea", message: "Timer finished")
        )
    }
}
