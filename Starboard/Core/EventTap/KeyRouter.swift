/// Thin holder so the event-tap closure has one stable object to talk to.
/// Routing logic lives in HoldSession, which stays pure and unit-testable.
/// This layer owns the two tap-level invariants:
/// - Nothing is ever routed (or consumed) unless rcmd is physically held.
/// - Every consumed keyDown swallows its matching keyUp too, even if rcmd was
///   released in between — apps must never see half a keystroke.
final class KeyRouter {
    private(set) var session = HoldSession()
    private var consumedKeys = Set<Int64>()

    /// Intents for a keyDown plus whether the event must be consumed. A
    /// cancelled hold produces no intents but still consumes, so keys after
    /// Escape can't leak to the frontmost app as real ⌘-shortcuts.
    func keyDown(_ keyCode: Int64, modifiers: ModifierState) -> (intents: [Intent], consume: Bool) {
        guard modifiers.rightCommandHeld else { return ([], false) }
        let intents = session.keyDown(keyCode, modifiers: modifiers)
        let consume = !intents.isEmpty || session.cancelled
        if consume { consumedKeys.insert(keyCode) }
        return (intents, consume)
    }

    func shouldConsumeKeyUp(_ keyCode: Int64) -> Bool {
        consumedKeys.remove(keyCode) != nil
    }

    /// Intents produced by an rcmd release (commits a pending search).
    func rightCommandUp() -> [Intent] {
        session.rightCommandUp()
    }
}
