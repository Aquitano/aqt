import XCTest

@MainActor
final class NotchStateTests: XCTestCase {
    func testHoverExitKeepsPhysicalNotchAvailableWithoutCompactContent() async {
        let state = NotchState()
        state.expand()

        state.hoverChanged(false)
        try? await Task.sleep(for: .milliseconds(220))

        XCTAssertEqual(state.presentation, .compact)
    }

    func testExplicitHideStillOrdersTheNotchOut() {
        let state = NotchState()
        state.showCompact()

        state.hide()

        XCTAssertEqual(state.presentation, .hidden)
    }
}
