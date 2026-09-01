import Foundation

/// What a hook told us about one Claude session: which process it is, which
/// transcript it writes, and where its terminal is. Every field is captured at
/// hook time — when the process tree is alive and the environment is readable —
/// so nothing downstream has to guess a session's identity from file timing.
///
/// A pid is not an identity on its own, because the number gets reused, so the
/// process's start time rides along and liveness always re-checks the pair.
///
/// Persisted, so restarting the app doesn't lose the sessions it already knows:
/// hooks announce a session once, not on a schedule.
struct AgentSessionBinding: Codable, Sendable, Equatable {
    let sessionId: String
    let pid: pid_t
    /// The process's kernel start time, in epoch seconds. A number rather than a
    /// `Date` on purpose: the shared JSON coder writes dates as second-resolution
    /// ISO-8601, and a start time that came back rounded would stop matching the
    /// running process — silently dropping every session on the next launch,
    /// which is the one thing persisting these was meant to prevent.
    let startedAt: TimeInterval
    var cwd: String
    var transcriptPath: String

    /// Terminal locators, read once from the agent's environment: Warp's
    /// per-tab focus URL, the herdr pane, and the T3 Code thread hosting the
    /// session.
    var focusURL: String?
    var terminalName: String?
    var herdrPaneID: String?
    var t3Thread: T3ThreadRef?
    /// The app drawing this session's terminal, so a notification can stay quiet
    /// while you're looking straight at it. Resolved once — `terminalResolved`
    /// records that we tried, since a detached session legitimately has none and
    /// retrying would re-run the ancestry walk on every reconcile.
    var terminalBundleID: String?
    var terminalResolved = false

    var isHerdrHosted: Bool { herdrPaneID != nil }
}
