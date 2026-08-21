import XCTest
@testable import Starboard

final class KeyRouterTests: XCTestCase {
    private var rcmdHeld: ModifierState {
        var state = ModifierState()
        state.rightCommandHeld = true
        return state
    }

    // The keyboard-bricking failure mode: consuming keys when rcmd is not held.
    func testNothingIsConsumedWhenRightCommandNotHeld() {
        let router = KeyRouter()
        XCTAssertNil(router.route(keyDownCode: 0x01, modifiers: ModifierState()))
        XCTAssertNil(router.route(keyDownCode: Keycode.tab, modifiers: ModifierState()))
    }

    func testLetterWithRcmdRoutesToSwitch() {
        let intent = KeyRouter().route(keyDownCode: 0x01, modifiers: rcmdHeld)
        XCTAssertEqual(intent, .switchToLetter("s"))
    }

    func testLetterWithRcmdAndRaltRoutesToAssign() {
        var state = rcmdHeld
        state.rightOptionHeld = true
        XCTAssertEqual(KeyRouter().route(keyDownCode: 0x01, modifiers: state), .assignLetter("s"))
    }

    func testUnhandledKeysPassThroughEvenWithRcmd() {
        let router = KeyRouter()
        XCTAssertNil(router.route(keyDownCode: Keycode.f5, modifiers: rcmdHeld))
    }
}
