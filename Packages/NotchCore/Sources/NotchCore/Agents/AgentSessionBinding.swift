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
package struct AgentSessionBinding: Codable, Sendable, Equatable {
    package let sessionId: String
    package let pid: pid_t
    /// The process's kernel start time, in epoch seconds. A number rather than a
    /// `Date` on purpose: the shared JSON coder writes dates as second-resolution
    /// ISO-8601, and a start time that came back rounded would stop matching the
    /// running process — silently dropping every session on the next launch,
    /// which is the one thing persisting these was meant to prevent.
    package let startedAt: TimeInterval
    package var cwd: String
    package var transcriptPath: String

    /// Terminal locators, read once from the agent's environment: Warp's
    /// per-tab focus URL, the herdr pane, and the T3 Code thread hosting the
    /// session.
    package var focusURL: String?
    package var terminalName: String?
    package var herdrPaneID: String?
    package var t3Thread: T3ThreadRef?
    /// The app drawing this session's terminal, so a notification can stay quiet
    /// while you're looking straight at it. Resolved once — `terminalResolved`
    /// records that we tried, since a detached session legitimately has none and
    /// retrying would re-run the ancestry walk on every reconcile.
    package var terminalBundleID: String?
    package var terminalResolved = false

    package init(sessionId: String, pid: pid_t, startedAt: TimeInterval, cwd: String, transcriptPath: String,
                 focusURL: String? = nil, terminalName: String? = nil, herdrPaneID: String? = nil,
                 t3Thread: T3ThreadRef? = nil, terminalBundleID: String? = nil, terminalResolved: Bool = false) {
        self.sessionId = sessionId
        self.pid = pid
        self.startedAt = startedAt
        self.cwd = cwd
        self.transcriptPath = transcriptPath
        self.focusURL = focusURL
        self.terminalName = terminalName
        self.herdrPaneID = herdrPaneID
        self.t3Thread = t3Thread
        self.terminalBundleID = terminalBundleID
        self.terminalResolved = terminalResolved
    }

    package var isHerdrHosted: Bool { herdrPaneID != nil }
}
