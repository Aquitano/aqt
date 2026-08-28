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

    func testAutorepeatOnlySwallowsKeysTheFirstPressConsumed() {
        let router = KeyRouter()
        _ = router.keyDown(0x01, modifiers: rcmdHeld) // s → switched
        // Repeats are answered from the consumed set, never routed, and the
        // matching keyUp must still be swallowed afterwards.
        XCTAssertTrue(router.isConsumed(0x01))
        XCTAssertFalse(router.isConsumed(0x26)) // never pressed → passes through
        XCTAssertTrue(router.shouldConsumeKeyUp(0x01))
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

    func testReleaseAfterSingleLetterDismissesPreviewWithoutCommit() {
        var session = HoldSession()
        _ = session.keyDown(0x01, modifiers: rcmdHeld)
        // The switch already happened on keyDown; release only clears the
        // 1-char preview overlay.
        XCTAssertEqual(session.rightCommandUp(), [.cancelSearch])
    }

    func testBareReleaseEmitsNothing() {
        var session = HoldSession()
        XCTAssertTrue(session.rightCommandUp().isEmpty)
    }

    func testArrowsPromoteSingleLetterPreviewToSearch() {
        var session = HoldSession()
        _ = session.keyDown(0x01, modifiers: rcmdHeld)
        XCTAssertEqual(session.keyDown(Keycode.downArrow, modifiers: rcmdHeld), [.moveSelection(1)])
        // Now a real search: release commits the highlighted result.
        XCTAssertEqual(session.rightCommandUp(), [.commitSearch])
    }

    // MARK: - Phase 4: windows

    func testTabOnEmptyHoldOpensWindowCycleThenSteps() {
        var session = HoldSession()
        XCTAssertEqual(session.keyDown(Keycode.tab, modifiers: rcmdHeld), [.beginWindowCycle])
        XCTAssertEqual(session.keyDown(Keycode.tab, modifiers: rcmdHeld), [.moveSelection(1)])
        XCTAssertEqual(session.rightCommandUp(), [.commitSearch])
    }

    func testTypingDuringWindowCyclePivotsToWindowSearch() {
        var session = HoldSession()
        _ = session.keyDown(Keycode.tab, modifiers: rcmdHeld)
        XCTAssertEqual(session.keyDown(0x01, modifiers: rcmdHeld), [.searchQuery("s")])
        XCTAssertEqual(session.scope, .windows)
    }

    func testBacktickCyclesFrontmostAppWindows() {
        var session = HoldSession()
        XCTAssertEqual(session.keyDown(Keycode.backtick, modifiers: rcmdHeld), [.cycleAppWindows])
    }

    func testDoubleTapOpensWindowSearch() {
        let router = KeyRouter()
        _ = router.rightCommandDown(at: 0)
        _ = router.rightCommandUp(at: 0.1) // bare tap
        XCTAssertEqual(router.rightCommandDown(at: 0.2), [.beginWindowSearch])
    }

    func testSlowSecondTapIsNotADoubleTap() {
        let router = KeyRouter()
        _ = router.rightCommandDown(at: 0)
        _ = router.rightCommandUp(at: 0.1)
        XCTAssertTrue(router.rightCommandDown(at: 0.6).isEmpty)
    }

    func testTapWithKeysIsNotHalfADoubleTap() {
        let router = KeyRouter()
        _ = router.rightCommandDown(at: 0)
        _ = router.keyDown(0x01, modifiers: rcmdHeld) // switched an app
        _ = router.rightCommandUp(at: 0.1)
        XCTAssertTrue(router.rightCommandDown(at: 0.2).isEmpty)
    }

    func testWindowJumpRoutesOnlyWhenEnabled() {
        let router = KeyRouter()
        let raltOnly = ModifierState(rightOptionHeld: true)
        let off = router.keyDown(0x28, modifiers: raltOnly)
        XCTAssertTrue(off.intents.isEmpty)
        XCTAssertFalse(off.consume)
        let on = router.keyDown(
            0x28, modifiers: raltOnly,
            options: RouterOptions(windowJumpEnabled: true)
        )
        XCTAssertEqual(on.intents, [.jumpAppWindows("k")])
        XCTAssertTrue(on.consume)
        XCTAssertTrue(router.shouldConsumeKeyUp(0x28))
    }

    func testRouterUsesInjectedKeyboardLayoutForLetters() {
        let router = KeyRouter(
            resolveLetter: { $0 == 0x01 ? "o" : nil },
            resolveDigit: { _ in nil }
        )
        let result = router.keyDown(0x01, modifiers: rcmdHeld)
        XCTAssertEqual(result.intents, [.switchToLetter("o"), .searchQuery("o")])
    }

    func testUnsupportedLayoutCharacterDoesNotFallBackToANSI() {
        let router = KeyRouter(
            resolveLetter: { _ in nil },
            resolveDigit: { _ in nil }
        )
        let result = router.keyDown(0x01, modifiers: rcmdHeld)
        XCTAssertTrue(result.intents.isEmpty)
        XCTAssertFalse(result.consume)
    }

    // MARK: - Phase 5: Spaces

    func testDigitsJumpToSpacesOutsideEngagedSearch() {
        var session = HoldSession()
        XCTAssertEqual(session.keyDown(0x14, modifiers: rcmdHeld), [.jumpToSpace(3)])
        _ = session.keyDown(0x01, modifiers: rcmdHeld) // letter stage
        XCTAssertEqual(session.keyDown(0x12, modifiers: rcmdHeld), [.jumpToSpace(1)])
        _ = session.keyDown(0x26, modifiers: rcmdHeld) // overlay engaged
        XCTAssertTrue(session.keyDown(0x12, modifiers: rcmdHeld).isEmpty)
    }

    func testBracketsJumpAdjacentSpaces() {
        var session = HoldSession()
        XCTAssertEqual(session.keyDown(Keycode.leftBracket, modifiers: rcmdHeld), [.adjacentSpace(.left)])
        XCTAssertEqual(session.keyDown(Keycode.rightBracket, modifiers: rcmdHeld), [.adjacentSpace(.right)])
    }

    // MARK: - Phase 6: Stages leader

    func testArmedLeaderMapsStageCommands() {
        let router = KeyRouter()
        _ = router.armStages(at: 0)
        XCTAssertEqual(
            router.keyDown(0x0D, modifiers: ModifierState(), at: 1).intents,
            [.stageRestore("w")]
        )
        // Window consumed exactly once.
        XCTAssertTrue(router.keyDown(0x0D, modifiers: ModifierState(), at: 1.1).intents.isEmpty)

        _ = router.armStages(at: 2)
        let save = router.keyDown(Keycode.equal, modifiers: ModifierState(), at: 2.5)
        XCTAssertEqual(save.intents, [.stageBeginSave])
        XCTAssertTrue(save.consume)

        _ = router.armStages(at: 4)
        XCTAssertEqual(
            router.keyDown(Keycode.minus, modifiers: ModifierState(), at: 4.5).intents,
            [.stageClose]
        )
    }

    func testLeaderWindowExpiresAfterThreeSeconds() {
        let router = KeyRouter()
        _ = router.armStages(at: 0)
        let result = router.keyDown(0x0D, modifiers: ModifierState(), at: 3.5)
        XCTAssertTrue(result.intents.isEmpty)
        XCTAssertFalse(result.consume)
    }

    func testUnrelatedKeyDisarmsAndPassesThrough() {
        let router = KeyRouter()
        _ = router.armStages(at: 0)
        let space = router.keyDown(0x31, modifiers: ModifierState(), at: 1) // space bar
        XCTAssertTrue(space.intents.isEmpty)
        XCTAssertFalse(space.consume)
        XCTAssertTrue(router.keyDown(0x0D, modifiers: ModifierState(), at: 1.5).intents.isEmpty)
    }

    func testBareRightShiftTapArmsButTypingDoesNot() {
        let router = KeyRouter()
        router.rightShiftDown(at: 0)
        XCTAssertEqual(router.rightShiftUp(at: 0.2), [.stagesArmed])

        let router2 = KeyRouter()
        router2.rightShiftDown(at: 0)
        _ = router2.keyDown(0x01, modifiers: ModifierState(), at: 0.1) // typed "S"
        XCTAssertTrue(router2.rightShiftUp(at: 0.2).isEmpty)

        let router3 = KeyRouter()
        router3.rightShiftDown(at: 0)
        XCTAssertTrue(router3.rightShiftUp(at: 0.8).isEmpty) // held too long
    }

    func testRaltDigitMovesWindowOnlyWhenEnabled() {
        let router = KeyRouter()
        let raltOnly = ModifierState(rightOptionHeld: true)
        XCTAssertTrue(router.keyDown(0x13, modifiers: raltOnly).intents.isEmpty)
        let on = router.keyDown(
            0x13, modifiers: raltOnly,
            options: RouterOptions(spacesMoveWindowEnabled: true)
        )
        XCTAssertEqual(on.intents, [.moveWindowToSpace(2)])
        XCTAssertTrue(on.consume)
    }

    func testRouterUsesInjectedKeyboardLayoutForDigits() {
        let router = KeyRouter(
            resolveLetter: { _ in nil },
            resolveDigit: { $0 == 0x13 ? 7 : nil }
        )
        let result = router.keyDown(
            0x13,
            modifiers: ModifierState(rightOptionHeld: true),
            options: RouterOptions(spacesMoveWindowEnabled: true)
        )
        XCTAssertEqual(result.intents, [.moveWindowToSpace(7)])
        XCTAssertTrue(result.consume)
    }
}
