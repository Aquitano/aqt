import QuartzCore

/// Thin holder so the event-tap closure has one stable object to talk to.
/// Routing logic lives in HoldSession, which stays pure and unit-testable.
/// This layer owns the tap-level invariants:
/// - Nothing is routed while rcmd is up — except the opt-in ralt window jump
///   and the armed Stages leader.
/// - Every consumed keyDown swallows its matching keyUp too, even if rcmd was
///   released in between — apps must never see half a keystroke.
/// - A double rcmd tap-and-hold (two bare presses within 300 ms) opens
///   windows-only search.
/// The opt-in features that extend routing beyond the rcmd hold.
struct RouterOptions {
    var primaryModifier = PrimaryModifier.rightCommand
    /// ralt+letter steps through that app's windows.
    var windowJumpEnabled = false
    /// ralt+digit moves the focused window to a Space (direct strategy only).
    var spacesMoveWindowEnabled = false
}

final class KeyRouter {
    private let resolveLetter: (Int64) -> Character?
    private let resolveDigit: (Int64) -> Int?
    private let hasStage: (Character) -> Bool
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

    /// `hasStage` answers whether a Stage is bound to a letter. Letters without
    /// one pass through: an armed leader must never eat an ordinary keystroke.
    init(
        resolveLetter: @escaping (Int64) -> Character? = KeyLayout.letter,
        resolveDigit: @escaping (Int64) -> Int? = KeyLayout.digit,
        hasStage: @escaping (Character) -> Bool = { _ in false }
    ) {
        self.resolveLetter = resolveLetter
        self.resolveDigit = resolveDigit
        self.hasStage = hasStage
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

        let primaryHeld = modifiers.isHeld(options.primaryModifier)
        if time < stagesArmedUntil {
            // One key ends the leader window either way — including a key
            // modified by the primary modifier, which routes as a normal hold instead.
            stagesArmedUntil = -.infinity
            if !primaryHeld {
                guard let command = stageCommand(for: keyCode) else {
                    return ([], false) // no Stage on that key: passes through
                }
                consumedKeys.insert(keyCode)
                return ([command], true)
            }
        }

        guard primaryHeld else {
            guard options.primaryModifier.secondaryIsHeld(in: modifiers) else { return ([], false) }
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
            primaryModifier: options.primaryModifier,
            letter: resolveLetter(keyCode),
            digit: resolveDigit(keyCode),
            keyWasResolved: true
        )
        let consume = !intents.isEmpty || session.cancelled
        if consume {
            consumedKeys.insert(keyCode)
        }
        return (intents, consume)
    }

    func shouldConsumeKeyUp(_ keyCode: Int64) -> Bool {
        consumedKeys.remove(keyCode) != nil
    }

    /// Whether the key's original keyDown was consumed, without clearing it.
    /// Auto-repeat events are answered with this: they must never be routed,
    /// but they still have to be swallowed if the first press was.
    func isConsumed(_ keyCode: Int64) -> Bool {
        consumedKeys.contains(keyCode)
    }

    /// Convenience alias for tests and default configuration.
    func rightCommandDown(at time: Double = CACurrentMediaTime()) -> [Intent] {
        primaryModifierDown(at: time)
    }

    /// Primary modifier pressed: detects the double-tap-and-hold windows-search gesture.
    func primaryModifierDown(at time: Double = CACurrentMediaTime()) -> [Intent] {
        // A keyUp the tap never saw (app-modal grab, tap disabled mid-press)
        // would otherwise leave an entry that eats an unrelated keyUp later.
        // Clearing here and not on release keeps late keyUps of this hold's
        // own keys swallowed.
        consumedKeys.removeAll(keepingCapacity: true)
        guard lastReleaseWasBareTap, time - lastReleaseTime < 0.3 else { return [] }
        lastReleaseWasBareTap = false
        return session.beginWindowSearch()
    }

    /// Convenience alias for tests and default configuration.
    func rightCommandUp(at time: Double = CACurrentMediaTime()) -> [Intent] {
        primaryModifierUp(at: time)
    }

    /// Primary modifier released: commits a pending search, records bare-tap state.
    func primaryModifierUp(at time: Double = CACurrentMediaTime()) -> [Intent] {
        lastReleaseWasBareTap = session.isBareHold
        lastReleaseTime = time
        return session.primaryModifierUp()
    }

    /// Drops all in-flight state. The tap was off, so the presses and releases
    /// that would have ended it were never delivered.
    func reset() {
        session = HoldSession()
        consumedKeys.removeAll(keepingCapacity: true)
        stagesArmedUntil = -.infinity
        lastReleaseWasBareTap = false
        lastReleaseTime = -.infinity
        rightShiftDownTime = -.infinity
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

    private func stageCommand(for keyCode: Int64) -> Intent? {
        if let letter = resolveLetter(keyCode) {
            return hasStage(letter) ? .stageRestore(letter) : nil
        }
        switch keyCode {
        case Keycode.equal: return .stageBeginSave
        case Keycode.minus: return .stageClose
        default: return nil
        }
    }
}
