import XCTest
import NotchCore

@MainActor
final class NotchStateTests: XCTestCase {
    func testHoverExitCollapsesAfterGrace() async {
        let clock = ManualClock()
        let state = NotchState(clock: clock)
        state.expand()

        state.hoverChanged(false)
        await clock.advance(by: .milliseconds(100))
        XCTAssertEqual(state.presentation, .expanded, "still inside the hover-out grace")

        await clock.advance(by: .milliseconds(100))
        XCTAssertEqual(state.presentation, .compact)
    }

    func testPointerReturningDuringGraceCancelsCollapse() async {
        let clock = ManualClock()
        let state = NotchState(clock: clock)
        state.expand()

        state.hoverChanged(false)
        await clock.advance(by: .milliseconds(100))
        state.hoverChanged(true)
        await clock.advance(by: .seconds(1))

        XCTAssertEqual(state.presentation, .expanded)
    }

    func testTabSwitchHoldsOffHoverExitCollapse() async {
        let clock = ManualClock()
        let state = NotchState(clock: clock)
        state.expand()
        state.select(tab: .media)

        state.hoverChanged(false)
        await clock.advance(by: .milliseconds(500))
        XCTAssertEqual(state.presentation, .expanded, "the resize hold absorbs the hover exit")

        await clock.advance(by: .milliseconds(400))
        XCTAssertEqual(state.presentation, .compact)
    }

    func testHoverEntryExpandsAfterIntentDelay() async {
        let clock = ManualClock()
        let state = NotchState(clock: clock)
        state.showCompact()

        state.hoverChanged(true)
        await clock.advance(by: .milliseconds(100))
        XCTAssertEqual(state.presentation, .compact, "a skim across the pill must not open it")

        await clock.advance(by: .milliseconds(150))
        XCTAssertEqual(state.presentation, .expanded)
    }

    func testExplicitHideStillOrdersTheNotchOut() {
        let state = NotchState()
        state.showCompact()

        state.hide()

        XCTAssertEqual(state.presentation, .hidden)
    }

    func testImmediateCollapseSkipsHoverExitGracePeriod() {
        let state = NotchState()
        state.expand()
        state.select(tab: .media)

        state.collapseImmediately()

        XCTAssertEqual(state.presentation, .compact)
        XCTAssertTrue(state.isCollapsing)
        XCTAssertEqual(state.expandedTab, .media,
                       "the active body stays mounted until the close animation finishes")
    }
}
