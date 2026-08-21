import XCTest
@testable import Starboard

final class KeyRouterTests: XCTestCase {
    // The keyboard-bricking failure mode: emitting intents for keys when rcmd
    // is not held. HoldSession only ever sees keyDowns while rcmd is down (the
    // tap callback guards that), so the invariant tested here is "unknown keys
    // and post-cancel keys produce no intents".
    func testUnknownKeysProduceNoIntents() {
        var session = HoldSession()
        XCTAssertTrue(session.keyDown(Keycode.f5).isEmpty)
        XCTAssertTrue(session.keyDown(Keycode.escape).isEmpty)
    }

    func testFirstLetterSwitchesAndStartsSearch() {
        var session = HoldSession()
        XCTAssertEqual(
            session.keyDown(0x01),
            [.switchToLetter("s"), .searchQuery("s")]
        )
    }

    func testSameLetterRepeatCyclesWithoutPollutingQuery() {
        var session = HoldSession()
        _ = session.keyDown(0x01)
        XCTAssertEqual(session.keyDown(0x01), [.switchToLetter("s")])
    }

    func testDifferentLetterExtendsQuery() {
        var session = HoldSession()
        _ = session.keyDown(0x01) // s
        XCTAssertEqual(session.keyDown(0x26), [.searchQuery("sj")])
    }

    func testBackspaceEditsQueryAndDeactivatesWhenEmpty() {
        var session = HoldSession()
        _ = session.keyDown(0x01)
        _ = session.keyDown(0x26)
        XCTAssertEqual(session.keyDown(Keycode.backspace), [.searchQuery("s")])
        XCTAssertEqual(session.keyDown(Keycode.backspace), [.searchQuery("")])
        XCTAssertFalse(session.searchActive)
    }

    func testEscapeCancelsAndInertsTheHold() {
        var session = HoldSession()
        _ = session.keyDown(0x01)
        _ = session.keyDown(0x26)
        XCTAssertEqual(session.keyDown(Keycode.escape), [.cancelSearch])
        XCTAssertTrue(session.keyDown(0x28).isEmpty) // k — inert until release
    }

    func testReleaseCommitsActiveSearch() {
        var session = HoldSession()
        _ = session.keyDown(0x01)
        _ = session.keyDown(0x26)
        XCTAssertEqual(session.rightCommandUp(), [.commitSearch])
        // Session reset: a fresh hold starts clean.
        XCTAssertEqual(
            session.keyDown(0x01),
            [.switchToLetter("s"), .searchQuery("s")]
        )
    }

    func testReleaseWithNoSearchEmitsNothing() {
        var session = HoldSession()
        _ = session.keyDown(0x01)
        XCTAssertTrue(session.rightCommandUp().isEmpty)
    }

    func testActionKeysWhileSearching() {
        var session = HoldSession()
        _ = session.keyDown(0x01)
        _ = session.keyDown(0x26) // search active with 2-char query
        XCTAssertEqual(session.keyDown(0x0D), [.itemAction(.close)]) // w
        XCTAssertEqual(session.keyDown(0x0C), [.itemAction(.quit)]) // q
        XCTAssertEqual(session.keyDown(0x04), [.itemAction(.hide)]) // h
        XCTAssertEqual(session.keyDown(Keycode.downArrow), [.moveSelection(1)])
        XCTAssertEqual(session.keyDown(Keycode.upArrow), [.moveSelection(-1)])
        XCTAssertEqual(session.keyDown(Keycode.tab), [.moveSelection(1)])
    }
}
