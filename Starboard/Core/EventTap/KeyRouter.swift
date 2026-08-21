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
    private(set) var session = HoldSession()
    private var consumedKeys = Set<Int64>()

    private var lastReleaseWasBareTap = false
    private var lastReleaseTime: Double = -.infinity

    /// Intents for a keyDown plus whether the event must be consumed. A
    /// cancelled hold produces no intents but still consumes, so keys after
    /// Escape can't leak to the frontmost app as real ⌘-shortcuts.
    func keyDown(
        _ keyCode: Int64,
        modifiers: ModifierState,
        options: RouterOptions = RouterOptions()
    ) -> (intents: [Intent], consume: Bool) {
        guard modifiers.rightCommandHeld else {
            guard modifiers.rightOptionHeld else { return ([], false) }
            if options.windowJumpEnabled, let letter = Keycode.letters[keyCode] {
                consumedKeys.insert(keyCode)
                return ([.jumpAppWindows(letter)], true)
            }
            if options.spacesMoveWindowEnabled, let digit = Keycode.digits[keyCode] {
                consumedKeys.insert(keyCode)
                return ([.moveWindowToSpace(digit)], true)
            }
            return ([], false)
        }
        let intents = session.keyDown(keyCode, modifiers: modifiers)
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
}
