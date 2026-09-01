import Testing
import NotchCore

@MainActor
struct NotchStateTests {
    @Test func hoverExitCollapsesAfterGrace() async {
        let clock = ManualClock()
        let state = NotchState(clock: clock)
        state.expand()

        state.hoverChanged(false)
        await clock.advance(by: .milliseconds(100))
        #expect(state.presentation == .expanded, "still inside the hover-out grace")

        await clock.advance(by: .milliseconds(100))
        #expect(state.presentation == .compact)
    }

    @Test func pointerReturningDuringGraceCancelsCollapse() async {
        let clock = ManualClock()
        let state = NotchState(clock: clock)
        state.expand()

        state.hoverChanged(false)
        await clock.advance(by: .milliseconds(100))
        state.hoverChanged(true)
        await clock.advance(by: .seconds(1))

        #expect(state.presentation == .expanded)
    }

    @Test func tabSwitchHoldsOffHoverExitCollapse() async {
        let clock = ManualClock()
        let state = NotchState(clock: clock)
        state.expand()
        state.select(tab: .media)

        state.hoverChanged(false)
        await clock.advance(by: .milliseconds(500))
        #expect(state.presentation == .expanded, "the resize hold absorbs the hover exit")

        await clock.advance(by: .milliseconds(400))
        #expect(state.presentation == .compact)
    }

    @Test func hoverEntryExpandsAfterIntentDelay() async {
        let clock = ManualClock()
        let state = NotchState(clock: clock)
        state.showCompact()

        state.hoverChanged(true)
        await clock.advance(by: .milliseconds(200))
        #expect(state.presentation == .compact, "a skim across the pill must not open it")

        await clock.advance(by: .milliseconds(150))
        #expect(state.presentation == .expanded)
    }

    @Test func explicitHideStillOrdersTheNotchOut() {
        let state = NotchState()
        state.showCompact()

        state.hide()

        #expect(state.presentation == .hidden)
    }

    @Test func immediateCollapseSkipsHoverExitGracePeriod() {
        let state = NotchState()
        state.expand()
        state.select(tab: .media)

        state.collapseImmediately()

        #expect(state.presentation == .compact)
        #expect(state.isCollapsing)
        #expect(state.expandedTab == .media,
                "the active body stays mounted until the close animation finishes")
    }
}
