import XCTest
@testable import Starboard

final class KeyRouterTests: XCTestCase {
    private let rcmdHeld = ModifierState(rightCommandHeld: true)

    // MARK: - KeyRouter invariants (the keyboard-bricking failure modes)

    func testNothingRoutedOrConsumedWithoutRightCommand() {
        let router = KeyRouter()
        let result = router.keyDown(0x01, modifiers: ModifierState()) // plain "s"
        XCTAssertTrue(result.intents.isEmpty)
        XCTAssertFalse(result.consume)
        XCTAssertFalse(router.shouldConsumeKeyUp(0x01))
    }

    func testConsumedKeyDownSwallowsItsKeyUpEvenAfterRelease() {
        let router = KeyRouter()
        _ = router.keyDown(0x01, modifiers: rcmdHeld)
        _ = router.rightCommandUp()
        XCTAssertTrue(router.shouldConsumeKeyUp(0x01)) // late keyUp still eaten
        XCTAssertFalse(router.shouldConsumeKeyUp(0x01)) // but only once
    }

    func testCancelledHoldConsumesWithoutActing() {
        let router = KeyRouter()
        _ = router.keyDown(0x01, modifiers: rcmdHeld) // s
        _ = router.keyDown(0x26, modifiers: rcmdHeld) // j → search engaged
        _ = router.keyDown(Keycode.escape, modifiers: rcmdHeld)
        // "q" after Escape must not reach the app as ⌘Q — consumed, no intents.
        let result = router.keyDown(0x0C, modifiers: rcmdHeld)
        XCTAssertTrue(result.intents.isEmpty)
        XCTAssertTrue(result.consume)
    }

    // MARK: - HoldSession routing

    func testUnknownKeysProduceNoIntents() {
        var session = HoldSession()
        XCTAssertTrue(session.keyDown(Keycode.f5, modifiers: rcmdHeld).isEmpty)
        XCTAssertTrue(session.keyDown(Keycode.escape, modifiers: rcmdHeld).isEmpty)
    }

    func testFirstLetterSwitchesAndStartsSearch() {
        var session = HoldSession()
        XCTAssertEqual(
            session.keyDown(0x01, modifiers: rcmdHeld),
            [.switchToLetter("s"), .searchQuery("s")]
        )
    }

    func testSameLetterRepeatSwitchesWithoutPollutingQuery() {
        var session = HoldSession()
        _ = session.keyDown(0x01, modifiers: rcmdHeld)
        XCTAssertEqual(session.keyDown(0x01, modifiers: rcmdHeld), [.switchToLetter("s")])
    }

    func testTabCyclesTheBufferedLetter() {
        var session = HoldSession()
        _ = session.keyDown(0x01, modifiers: rcmdHeld)
        XCTAssertEqual(session.keyDown(Keycode.tab, modifiers: rcmdHeld), [.cycleLetter("s")])
    }

    func testTabMovesSelectionOnceOverlayEngaged() {
        var session = HoldSession()
        _ = session.keyDown(0x01, modifiers: rcmdHeld)
        _ = session.keyDown(0x26, modifiers: rcmdHeld)
        XCTAssertEqual(session.keyDown(Keycode.tab, modifiers: rcmdHeld), [.moveSelection(1)])
    }

    func testRightOptionAssignsLetter() {
        var session = HoldSession()
        let mods = ModifierState(rightCommandHeld: true, rightOptionHeld: true)
        XCTAssertEqual(session.keyDown(0x28, modifiers: mods), [.assignLetter("k")])
    }

    func testDifferentLetterExtendsQuery() {
        var session = HoldSession()
        _ = session.keyDown(0x01, modifiers: rcmdHeld) // s
        XCTAssertEqual(session.keyDown(0x26, modifiers: rcmdHeld), [.searchQuery("sj")])
    }

    func testBareActionLettersExtendQueryInsteadOfActing() {
        var session = HoldSession()
        _ = session.keyDown(0x0D, modifiers: rcmdHeld) // w
        _ = session.keyDown(0x04, modifiers: rcmdHeld) // h → query "wh"
        // "whatsapp" must stay typeable: bare w/q/h are letters, not actions.
        XCTAssertEqual(session.keyDown(0x00, modifiers: rcmdHeld), [.searchQuery("wha")])
    }

    func testLeftCommandActionKeysActOnSelection() {
        var session = HoldSession()
        _ = session.keyDown(0x01, modifiers: rcmdHeld)
        _ = session.keyDown(0x26, modifiers: rcmdHeld) // overlay engaged
        let mods = ModifierState(rightCommandHeld: true, leftCommandHeld: true)
        XCTAssertEqual(session.keyDown(0x0D, modifiers: mods), [.itemAction(.close)])
        XCTAssertEqual(session.keyDown(0x0C, modifiers: mods), [.itemAction(.quit)])
        XCTAssertEqual(session.keyDown(0x04, modifiers: mods), [.itemAction(.hide)])
    }

    func testBackspaceEditsQueryAndDeactivatesWhenEmpty() {
        var session = HoldSession()
        _ = session.keyDown(0x01, modifiers: rcmdHeld)
        _ = session.keyDown(0x26, modifiers: rcmdHeld)
        XCTAssertEqual(session.keyDown(Keycode.backspace, modifiers: rcmdHeld), [.searchQuery("s")])
        XCTAssertEqual(session.keyDown(Keycode.backspace, modifiers: rcmdHeld), [.searchQuery("")])
        XCTAssertFalse(session.searchActive)
    }

    func testEscapeCancelsAndInertsTheHold() {
        var session = HoldSession()
        _ = session.keyDown(0x01, modifiers: rcmdHeld)
        _ = session.keyDown(0x26, modifiers: rcmdHeld)
        XCTAssertEqual(session.keyDown(Keycode.escape, modifiers: rcmdHeld), [.cancelSearch])
        XCTAssertTrue(session.keyDown(0x28, modifiers: rcmdHeld).isEmpty)
        XCTAssertTrue(session.cancelled)
    }

    func testReleaseAfterCancelDoesNotCommit() {
        var session = HoldSession()
        _ = session.keyDown(0x01, modifiers: rcmdHeld)
        _ = session.keyDown(0x26, modifiers: rcmdHeld)
        _ = session.keyDown(Keycode.escape, modifiers: rcmdHeld)
        XCTAssertTrue(session.rightCommandUp().isEmpty)
    }

    func testReleaseCommitsActiveSearch() {
        var session = HoldSession()
        _ = session.keyDown(0x01, modifiers: rcmdHeld)
        _ = session.keyDown(0x26, modifiers: rcmdHeld)
        XCTAssertEqual(session.rightCommandUp(), [.commitSearch])
        // Session reset: a fresh hold starts clean.
        XCTAssertEqual(
            session.keyDown(0x01, modifiers: rcmdHeld),
            [.switchToLetter("s"), .searchQuery("s")]
        )
    }

    func testReleaseWithNoSearchEmitsNothing() {
        var session = HoldSession()
        _ = session.keyDown(0x01, modifiers: rcmdHeld)
        XCTAssertTrue(session.rightCommandUp().isEmpty)
    }
}
