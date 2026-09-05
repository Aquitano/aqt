import NotchCore
import Testing

@MainActor
struct NotchCoordinatorTests {
    @Test func onlyOneDisplayExpandsAtATime() {
        let notch = NotchCoordinator()
        let a = notch.register(displayKey: "a")
        let b = notch.register(displayKey: "b")
        notch.showCompact()

        a.expand()
        #expect(a.presentation == .expanded)
        #expect(b.presentation == .compact)
        #expect(notch.expandedKey == "a")

        b.expand()
        #expect(b.presentation == .expanded)
        #expect(a.presentation == .compact, "the previously expanded display collapses immediately")
        #expect(notch.expandedKey == "b")
    }

    @Test func hoverExpandAlsoCompactsTheOtherDisplays() async {
        let clock = ManualClock()
        let notch = NotchCoordinator(clock: clock)
        let a = notch.register(displayKey: "a")
        let b = notch.register(displayKey: "b")
        notch.showCompact()
        b.expand()

        a.hoverChanged(true)
        await clock.advance(by: .milliseconds(250))

        #expect(a.presentation == .expanded)
        #expect(b.presentation == .compact)
    }

    @Test func programmaticExpandTargetsThePointerDisplayThenTheExpandedOne() {
        let notch = NotchCoordinator()
        let a = notch.register(displayKey: "a")
        let b = notch.register(displayKey: "b")
        notch.expansionTarget = { "b" }

        notch.expand()
        #expect(b.presentation == .expanded)
        #expect(a.presentation == .compact, "a hidden sibling comes up compact")

        notch.expansionTarget = { "a" }
        notch.select(tab: .media)
        #expect(b.expandedTab == .media, "commands go to the expanded display while one is open")
        #expect(a.presentation == .compact)
    }

    @Test func toggleHidesEveryDisplayAndReopens() {
        let notch = NotchCoordinator()
        let a = notch.register(displayKey: "a")
        let b = notch.register(displayKey: "b")
        notch.showCompact()
        a.expand()

        notch.toggle()
        #expect(!notch.isVisible)
        #expect(a.presentation == .hidden)
        #expect(b.presentation == .hidden)

        notch.toggle()
        #expect(notch.isVisible)
        #expect(notch.expandedKey != nil)
    }

    @Test func displayAppearingWhileVisibleStartsCompact() {
        let notch = NotchCoordinator()
        notch.register(displayKey: "a")
        notch.showCompact()

        let late = notch.register(displayKey: "b")
        #expect(late.presentation == .compact)

        notch.hide()
        let hidden = notch.register(displayKey: "c")
        #expect(hidden.presentation == .hidden)
    }
}
