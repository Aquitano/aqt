@testable import StarboardCore
import Testing

/// Drives the router the way the event tap does: flags carry the modifier
/// picture, and time only moves forward.
private struct Keyboard {
    var router = InputRouter(config: RouterConfig(stageLetters: ["w"]))
    var time = 100.0
    var flags: UInt64 = 0

    static let digitOne: Int64 = 0x12
    static let digitThree: Int64 = 0x14
    static let spaceBar: Int64 = 0x31

    mutating func press(_ bit: UInt64) -> Route {
        flags |= bit
        return send(.flagsChanged, 0x36)
    }

    mutating func release(_ bit: UInt64) -> Route {
        flags &= ~bit
        return send(.flagsChanged, 0x36)
    }

    mutating func down(_ keyCode: Int64, autorepeat: Bool = false) -> Route {
        send(.keyDown, keyCode, autorepeat: autorepeat)
    }

    mutating func up(_ keyCode: Int64) -> Route {
        send(.keyUp, keyCode)
    }

    mutating func type(_ keyCode: Int64) -> Route {
        let route = down(keyCode)
        _ = up(keyCode)
        return route
    }

    /// The key in the letter's ANSI position.
    mutating func down(_ letter: Character, autorepeat: Bool = false) -> Route {
        down(Self.keyCode(letter), autorepeat: autorepeat)
    }

    mutating func up(_ letter: Character) -> Route {
        up(Self.keyCode(letter))
    }

    mutating func type(_ letter: Character) -> Route {
        type(Self.keyCode(letter))
    }

    private static func keyCode(_ letter: Character) -> Int64 {
        Keycode.letters.first { $0.value == letter }?.key ?? -1
    }

    mutating func capsLock() -> Route {
        send(.flagsChanged, Keycode.capsLock)
    }

    mutating func wait(_ seconds: Double) {
        time += seconds
    }

    private mutating func send(_ kind: KeyEvent.Kind, _ keyCode: Int64, autorepeat: Bool = false) -> Route {
        time += 0.01
        return router.handle(
            KeyEvent(kind: kind, keyCode: keyCode, flags: flags, isAutorepeat: autorepeat, time: time)
        )
    }
}

private let rcmd = Modifiers.DeviceBit.rightCommand
private let lcmd = Modifiers.DeviceBit.leftCommand
private let ralt = Modifiers.DeviceBit.rightOption
private let rshift = Modifiers.DeviceBit.rightShift

struct KeyboardSafetyTests {
    @Test func nothingIsRoutedWithoutRightCommand() {
        var keyboard = Keyboard()
        #expect(keyboard.down("s") == Route(consume: false, intents: []))
        #expect(keyboard.up("s") == Route(consume: false, intents: []))
    }

    @Test func leftCommandAloneIsNotAHold() {
        var keyboard = Keyboard()
        #expect(keyboard.press(lcmd).intents.isEmpty)
        #expect(keyboard.down("q") == Route(consume: false, intents: []))
    }

    @Test func aConsumedKeyDownSwallowsItsKeyUpAfterRelease() {
        var keyboard = Keyboard()
        _ = keyboard.press(rcmd)
        #expect(keyboard.down("s").consume)
        _ = keyboard.release(rcmd)
        #expect(keyboard.up("s").consume)
        #expect(!keyboard.up("s").consume)
    }

    @Test func autorepeatIsSwallowedButNeverRouted() {
        var keyboard = Keyboard()
        _ = keyboard.press(rcmd)
        _ = keyboard.down("s")
        #expect(keyboard.down("s", autorepeat: true) == Route(consume: true, intents: []))
        #expect(keyboard.down("j", autorepeat: true) == Route(consume: false, intents: []))
    }

    @Test func keysAfterEscapeAreSwallowedWithoutActing() {
        var keyboard = Keyboard()
        _ = keyboard.press(rcmd)
        _ = keyboard.type("s")
        _ = keyboard.type("j")
        #expect(keyboard.type(Keycode.escape).intents == [.cancelSearch])
        #expect(keyboard.down("q") == Route(consume: true, intents: []))
        #expect(keyboard.release(rcmd).intents == [.holdEnded(.dismiss)])
    }

    @Test func afterTypingEveryKeyIsSwallowed() {
        var keyboard = Keyboard()
        _ = keyboard.press(rcmd)
        _ = keyboard.type("s")
        _ = keyboard.type(Keycode.backspace)
        #expect(keyboard.type(Keycode.backspace) == Route(consume: true, intents: []))
        _ = keyboard.type("j")
        _ = keyboard.type("k")
        #expect(keyboard.type(Keyboard.spaceBar) == Route(consume: true, intents: []))
        #expect(keyboard.type(Keyboard.digitOne) == Route(consume: true, intents: []))
    }

    @Test func untypedKeysStillReachTheSystem() {
        var keyboard = Keyboard()
        _ = keyboard.press(rcmd)
        _ = keyboard.type(Keyboard.digitThree)
        #expect(keyboard.type(Keycode.tab) == Route(consume: false, intents: []))
        #expect(keyboard.type(Keyboard.spaceBar) == Route(consume: false, intents: []))
    }

    @Test func aReleaseTheTapMissedHealsOnTheNextEvent() {
        var keyboard = Keyboard()
        _ = keyboard.press(rcmd)
        keyboard.flags = 0
        #expect(keyboard.down("s") == Route(consume: false, intents: [.holdEnded(.dismiss)]))
    }

    @Test func resetEndsAnOpenHold() {
        var keyboard = Keyboard()
        _ = keyboard.press(rcmd)
        #expect(keyboard.router.reset() == [.holdEnded(.invalidated)])
        #expect(keyboard.router.reset().isEmpty)
    }

    @Test func aStaleConsumedKeyIsDroppedAtTheNextHold() {
        var keyboard = Keyboard()
        _ = keyboard.press(rcmd)
        _ = keyboard.down("s")
        _ = keyboard.release(rcmd)
        _ = keyboard.press(rcmd)
        #expect(!keyboard.up("s").consume)
    }
}

struct HoldTests {
    @Test func aHoldBeginsAndEnds() {
        var keyboard = Keyboard()
        #expect(keyboard.press(rcmd).intents == [.holdBegan])
        #expect(keyboard.release(rcmd).intents == [.holdEnded(.dismiss)])
    }

    @Test func theFirstLetterSwitchesAndStartsAQuery() {
        var keyboard = Keyboard()
        _ = keyboard.press(rcmd)
        #expect(keyboard.type("s") == Route(consume: true, intents: [.switchToLetter("s"), .searchQuery("s")]))
        #expect(keyboard.type("s").intents == [.switchToLetter("s")])
        #expect(keyboard.release(rcmd).intents == [.holdEnded(.dismiss)])
    }

    @Test func tabCyclesTheLetterThenMovesTheSelection() {
        var keyboard = Keyboard()
        _ = keyboard.press(rcmd)
        #expect(keyboard.type(Keycode.tab) == Route(consume: false, intents: []))
        _ = keyboard.type("s")
        #expect(keyboard.type(Keycode.tab).intents == [.cycleLetter("s")])
        _ = keyboard.type("j")
        #expect(keyboard.type(Keycode.tab).intents == [.moveSelection(1)])
    }

    @Test func aSecondLetterSearchesAndReleaseCommits() {
        var keyboard = Keyboard()
        _ = keyboard.press(rcmd)
        _ = keyboard.type("s")
        #expect(keyboard.type("j").intents == [.searchQuery("sj")])
        #expect(keyboard.release(rcmd).intents == [.holdEnded(.commit)])
    }

    @Test func bareActionLettersExtendTheQuery() {
        var keyboard = Keyboard()
        _ = keyboard.press(rcmd)
        _ = keyboard.type("w")
        _ = keyboard.type("h")
        #expect(keyboard.type("a").intents == [.searchQuery("wha")])
    }

    @Test func leftCommandActsOnTheSelection() {
        var keyboard = Keyboard()
        _ = keyboard.press(rcmd)
        _ = keyboard.type("s")
        _ = keyboard.type("j")
        _ = keyboard.press(lcmd)
        #expect(keyboard.type("w").intents == [.itemAction(.close)])
        #expect(keyboard.type("q").intents == [.itemAction(.quit)])
        #expect(keyboard.type("h").intents == [.itemAction(.hide)])
    }

    @Test func rightOptionPinsTheLetter() {
        var keyboard = Keyboard()
        _ = keyboard.press(rcmd)
        _ = keyboard.press(ralt)
        #expect(keyboard.type("k").intents == [.assignLetter("k")])
    }

    @Test func backspaceWalksTheQueryBack() {
        var keyboard = Keyboard()
        _ = keyboard.press(rcmd)
        _ = keyboard.type("s")
        _ = keyboard.type("j")
        #expect(keyboard.type(Keycode.backspace).intents == [.searchQuery("s")])
        #expect(keyboard.type("s").intents == [.switchToLetter("s")])
        #expect(keyboard.type(Keycode.backspace).intents == [.searchQuery("")])
        #expect(keyboard.type(Keycode.backspace) == Route(consume: true, intents: []))
    }

    @Test func arrowsBelongToTheAppUntilTheOverlayShows() {
        var keyboard = Keyboard()
        _ = keyboard.press(rcmd)
        #expect(keyboard.type(Keycode.downArrow) == Route(consume: false, intents: []))
        keyboard.wait(0.3)
        #expect(keyboard.type(Keycode.downArrow).intents == [.moveSelection(1)])
        #expect(keyboard.release(rcmd).intents == [.holdEnded(.commit)])
    }

    @Test func digitsAndBracketsJumpSpacesUntilTheQueryIsASearch() {
        var keyboard = Keyboard()
        _ = keyboard.press(rcmd)
        #expect(keyboard.type(Keyboard.digitThree).intents == [.jumpToSpace(3)])
        #expect(keyboard.type(Keycode.leftBracket).intents == [.adjacentSpace(.left)])
        _ = keyboard.type("s")
        #expect(keyboard.type(Keyboard.digitOne).intents == [.jumpToSpace(1)])
        #expect(keyboard.type(Keycode.rightBracket).intents == [.adjacentSpace(.right)])
        _ = keyboard.type("j")
        #expect(keyboard.type(Keyboard.digitOne).intents.isEmpty)
        #expect(keyboard.type(Keycode.rightBracket).intents.isEmpty)
    }

    @Test func lettersFollowTheKeyboardLayout() {
        var keyboard = Keyboard()
        // The key in the ANSI S position types "o" on this layout.
        keyboard.router.config.keyboard = KeyboardMap(printed: [0x01: "o"])
        _ = keyboard.press(rcmd)
        #expect(keyboard.type("s").intents == [.switchToLetter("o"), .searchQuery("o")])
    }
}

struct StagesLeaderTests {
    @Test func capsLockArmsAndIsSwallowed() {
        var keyboard = Keyboard()
        #expect(keyboard.capsLock() == Route(consume: true, intents: [.stagesArmed]))
        #expect(keyboard.type("w") == Route(consume: true, intents: [.stageRestore("w")]))
        #expect(keyboard.type("w") == Route(consume: false, intents: []))
    }

    @Test func saveAndCloseFollowTheLeader() {
        var keyboard = Keyboard()
        _ = keyboard.capsLock()
        #expect(keyboard.type(Keycode.equal).intents == [.stageBeginSave])
        _ = keyboard.capsLock()
        #expect(keyboard.type(Keycode.minus).intents == [.stageClose])
    }

    @Test func aLetterWithoutAStageIsTypedNormally() {
        var keyboard = Keyboard()
        _ = keyboard.capsLock()
        #expect(keyboard.type("s") == Route(consume: false, intents: []))
    }

    @Test func theLeaderExpiresAfterThreeSeconds() {
        var keyboard = Keyboard()
        _ = keyboard.capsLock()
        keyboard.wait(3)
        #expect(keyboard.type("w") == Route(consume: false, intents: []))
    }

    @Test func anUnrelatedKeyDisarms() {
        var keyboard = Keyboard()
        _ = keyboard.capsLock()
        #expect(!keyboard.type(Keyboard.spaceBar).consume)
        #expect(!keyboard.type("w").consume)
    }

    @Test func rightCommandRoutesAsAHoldInstead() {
        var keyboard = Keyboard()
        _ = keyboard.capsLock()
        _ = keyboard.press(rcmd)
        #expect(keyboard.type("w").intents == [.switchToLetter("w"), .searchQuery("w")])
        _ = keyboard.release(rcmd)
        #expect(!keyboard.type("w").consume)
    }

    @Test func capsLockPassesThroughWhenItIsNotTheLeader() {
        var keyboard = Keyboard()
        keyboard.router.config.stagesLeader = .rightShift
        #expect(keyboard.capsLock() == Route(consume: false, intents: []))
    }

    @Test func onlyABareQuickRightShiftTapArms() {
        var keyboard = Keyboard()
        keyboard.router.config.stagesLeader = .rightShift
        _ = keyboard.press(rshift)
        #expect(keyboard.release(rshift).intents == [.stagesArmed])

        _ = keyboard.press(rshift)
        _ = keyboard.type("s")
        #expect(keyboard.release(rshift).intents.isEmpty)

        _ = keyboard.press(rshift)
        keyboard.wait(0.5)
        #expect(keyboard.release(rshift).intents.isEmpty)
    }
}
