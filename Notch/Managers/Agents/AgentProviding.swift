import Foundation

/// A source of agent sessions + notify-worthy events. `AgentManager` picks the
/// concrete providers at runtime and treats them uniformly — the agent-side twin
/// of `MediaControlling`.
@MainActor
protocol AgentProviding: AnyObject {
    var kind: AgentKind { get }

    /// Push the provider's full current session set (the reconciliation source).
    var onSessions: (([AgentSession]) -> Void)? { get set }
    /// Push a notify-worthy transition (started / attention / finished / ...).
    var onEvent: ((AgentEvent) -> Void)? { get set }

    /// Whether the opt-in integration is currently installed/active.
    var isEnabled: Bool { get }

    /// Begin watching (only meaningful once enabled). Idempotent.
    func start()
    func stop()

    /// Re-check liveness/state now (e.g. when the user opens the Agents tab).
    func refresh()

    /// Opt-in installer hooks. `enable()` writes the agent's config and throws
    /// (leaving the feature off) when the write fails, so callers can tell the
    /// user; `disable()` removes only this app's entries. Both idempotent and
    /// reversible.
    func enable() throws
    func disable()

    /// Feed a decoded socket envelope addressed to this provider's `kind`.
    func ingest(_ envelope: HookEnvelope, pid: pid_t)
}
