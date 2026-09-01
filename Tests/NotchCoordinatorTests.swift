import XCTest
import NotchCore

@MainActor
final class NotchCoordinatorTests: XCTestCase {
    func testOnlyOneDisplayExpandsAtATime() {
        let notch = NotchCoordinator()
        let a = notch.register(displayKey: "a")
        let b = notch.register(displayKey: "b")
        notch.showCompact()

        a.expand()
        XCTAssertEqual(a.presentation, .expanded)
        XCTAssertEqual(b.presentation, .compact)
        XCTAssertEqual(notch.expandedKey, "a")

        b.expand()
        XCTAssertEqual(b.presentation, .expanded)
        XCTAssertEqual(a.presentation, .compact, "the previously expanded display collapses immediately")
        XCTAssertEqual(notch.expandedKey, "b")
    }

    func testHoverExpandAlsoCompactsTheOtherDisplays() async {
        let clock = ManualClock()
        let notch = NotchCoordinator(clock: clock)
        let a = notch.register(displayKey: "a")
        let b = notch.register(displayKey: "b")
        notch.showCompact()
        b.expand()

        a.hoverChanged(true)
        await clock.advance(by: .milliseconds(250))

        XCTAssertEqual(a.presentation, .expanded)
        XCTAssertEqual(b.presentation, .compact)
    }

    func testProgrammaticExpandTargetsThePointerDisplayThenTheExpandedOne() {
        let notch = NotchCoordinator()
        let a = notch.register(displayKey: "a")
        let b = notch.register(displayKey: "b")
        notch.expansionTarget = { "b" }

        notch.expand()
        XCTAssertEqual(b.presentation, .expanded)
        XCTAssertEqual(a.presentation, .compact, "a hidden sibling comes up compact")

        notch.expansionTarget = { "a" }
        notch.select(tab: .media)
        XCTAssertEqual(b.expandedTab, .media, "commands go to the expanded display while one is open")
        XCTAssertEqual(a.presentation, .compact)
    }

    func testToggleHidesEveryDisplayAndReopens() {
        let notch = NotchCoordinator()
        let a = notch.register(displayKey: "a")
        let b = notch.register(displayKey: "b")
        notch.showCompact()
        a.expand()

        notch.toggle()
        XCTAssertFalse(notch.isVisible)
        XCTAssertEqual(a.presentation, .hidden)
        XCTAssertEqual(b.presentation, .hidden)

        notch.toggle()
        XCTAssertTrue(notch.isVisible)
        XCTAssertNotNil(notch.expandedKey)
    }

    func testDisplayAppearingWhileVisibleStartsCompact() {
        let notch = NotchCoordinator()
        notch.register(displayKey: "a")
        notch.showCompact()

        let late = notch.register(displayKey: "b")
        XCTAssertEqual(late.presentation, .compact)

        notch.hide()
        let hidden = notch.register(displayKey: "c")
        XCTAssertEqual(hidden.presentation, .hidden)
    }
}
