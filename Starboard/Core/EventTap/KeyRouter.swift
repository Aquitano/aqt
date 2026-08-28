import QuartzCore

/// Thin holder so the event-tap closure has one stable object to talk to.
/// Routing logic lives in HoldSession, which stays pure and unit-testable.
/// This layer owns the tap-level invariants:
/// - Nothing is routed while rcmd is up — except the opt-in ralt window jump.
/// - Every consumed keyDown swallows its matching keyUp too, even if rcmd was
///   released in between — apps must never see half a keystroke.
/// - A double rcmd tap-and-hold (two bare presses within 300 ms) opens
///   windows-only search.
/// The opt-in features that extend routing beyond the rcmd hold.
struct RouterOptions {
    /// ralt+letter steps through that app's windows.
    var windowJumpEnabled = false
    /// ralt+digit moves the focused window to a Space (direct strategy only).
    var spacesMoveWindowEnabled = false
}

final class KeyRouter {
    private let resolveLetter: (Int64) -> Character?
    private let resolveDigit: (Int64) -> Int?
    private(set) var session = HoldSession()
    private var consumedKeys = Set<Int64>()

    private var lastReleaseWasBareTap = false
    private var lastReleaseTime: Double = -.infinity

    // Stages leader state: a trigger tap arms a 3-second window in which the
    // next key is a Stage command (letter/equal/minus); any other key disarms
    // and passes through.
    private var stagesArmedUntil: Double = -.infinity
    private var lastKeyDownTime: Double = -.infinity
    private var rightShiftDownTime: Double = -.infinity

    init(
        resolveLetter: @escaping (Int64) -> Character? = KeyLayout.letter,
        resolveDigit: @escaping (Int64) -> Int? = KeyLayout.digit
    ) {
        self.resolveLetter = resolveLetter
        self.resolveDigit = resolveDigit
    }

    /// Intents for a keyDown plus whether the event must be consumed. A
    /// cancelled hold produces no intents but still consumes, so keys after
    /// Escape can't leak to the frontmost app as real ⌘-shortcuts.
    func keyDown(
        _ keyCode: Int64,
        modifiers: ModifierState,
        options: RouterOptions = RouterOptions(),
        at time: Double = CACurrentMediaTime()
    ) -> (intents: [Intent], consume: Bool) {
        lastKeyDownTime = time

        if time < stagesArmedUntil, !modifiers.rightCommandHeld {
            stagesArmedUntil = -.infinity
            let command: Intent? = resolveLetter(keyCode).map { .stageRestore($0) }
                ?? (keyCode == Keycode.equal ? .stageBeginSave : nil)
                ?? (keyCode == Keycode.minus ? .stageClose : nil)
            if let command {
                consumedKeys.insert(keyCode)
                return ([command], true)
            }
            return ([], false) // unrelated key: disarmed, passes through
        }

        guard modifiers.rightCommandHeld else {
            guard modifiers.rightOptionHeld else { return ([], false) }
            if options.windowJumpEnabled, let letter = resolveLetter(keyCode) {
                consumedKeys.insert(keyCode)
                return ([.jumpAppWindows(letter)], true)
            }
            if options.spacesMoveWindowEnabled, let digit = resolveDigit(keyCode) {
                consumedKeys.insert(keyCode)
                return ([.moveWindowToSpace(digit)], true)
            }
            return ([], false)
        }
        let intents = session.keyDown(
            keyCode,
            modifiers: modifiers,
            letter: resolveLetter(keyCode),
            digit: resolveDigit(keyCode),
            keyWasResolved: true
        )
        let consume = !intents.isEmpty || session.cancelled
        if consume { consumedKeys.insert(keyCode) }
        return (intents, consume)
    }

    func shouldConsumeKeyUp(_ keyCode: Int64) -> Bool {
        consumedKeys.remove(keyCode) != nil
    }

    /// rcmd pressed: detects the double-tap-and-hold windows-search gesture.
    func rightCommandDown(at time: Double = CACurrentMediaTime()) -> [Intent] {
        guard lastReleaseWasBareTap, time - lastReleaseTime < 0.3 else { return [] }
        lastReleaseWasBareTap = false
        return session.beginWindowSearch()
    }

    /// rcmd released: commits a pending search, records bare-tap state.
    func rightCommandUp(at time: Double = CACurrentMediaTime()) -> [Intent] {
        lastReleaseWasBareTap = session.isBareHold
        lastReleaseTime = time
        return session.rightCommandUp()
    }

    // MARK: - Stages leader

    /// Caps Lock trigger: every (consumed) Caps Lock flagsChanged arms.
    func armStages(at time: Double = CACurrentMediaTime()) -> [Intent] {
        stagesArmedUntil = time + 3.0
        return [.stagesArmed]
    }

    func rightShiftDown(at time: Double = CACurrentMediaTime()) {
        rightShiftDownTime = time
    }

    /// Right Shift trigger arms only on a bare tap: a quick press+release with
    /// no keystroke in between (so shifted typing never arms it).
    func rightShiftUp(at time: Double = CACurrentMediaTime()) -> [Intent] {
        guard time - rightShiftDownTime < 0.4, lastKeyDownTime < rightShiftDownTime else {
            return []
        }
        return armStages(at: time)
    }
}
