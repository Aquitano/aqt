/// Thin holder so the event-tap closure has one stable object to talk to.
/// All routing logic lives in HoldSession, which stays pure and unit-testable.
final class KeyRouter {
    private(set) var session = HoldSession()

    /// Intents produced by a keyDown while rcmd is held. Empty = pass through.
    func keyDown(_ keyCode: Int64) -> [Intent] {
        session.keyDown(keyCode)
    }

    /// Intents produced by an rcmd release (commits a pending search).
    func rightCommandUp() -> [Intent] {
        session.rightCommandUp()
    }
}
