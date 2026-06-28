import Foundation

/// A source of agent sessions + notify-worthy events. `AgentManager` picks the
/// concrete providers at runtime and treats them uniformly — the agent-side twin
/// of `MediaControlling`.
@MainActor
protocol AgentProviding: AnyObject {
    var kind: AgentKind { get }
    var capabilities: AgentProviderCapabilities { get }

    /// Push the provider's full current session set (the reconciliation source).
    var onSessions: (([AgentSession]) -> Void)? { get set }
    /// Push a notify-worthy transition (started / attention / finished / ...).
    var onEvent: ((AgentEvent) -> Void)? { get set }

    /// Whether the opt-in integration is currently installed/active.
    var isEnabled: Bool { get }

    /// Begin watching (only meaningful once enabled). Idempotent.
    func start()
    func stop()

    /// Opt-in installer hooks. `enable()` writes the agent's config; `disable()`
    /// removes only this app's entries. Both idempotent and reversible.
    func enable()
    func disable()

    /// Feed a decoded socket envelope addressed to this provider's `kind`.
    /// No-op by default for providers that don't use the socket (e.g. OpenCode).
    func ingest(_ envelope: HookEnvelope, pid: pid_t)
}

extension AgentProviding {
    func ingest(_ envelope: HookEnvelope, pid: pid_t) {}
}
