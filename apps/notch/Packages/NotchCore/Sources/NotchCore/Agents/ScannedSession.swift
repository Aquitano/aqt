import Foundation

/// One live Claude session as it stands right now: a bound `claude` pid that is
/// still running, and its own transcript parsed for status.
///
/// A pure value produced by `SessionProbe` and consumed by `SessionReconciler` —
/// kept in the model layer (not the libproc adapter) so the reconciler and its
/// tests don't depend on `ProcessLookup`.
package struct ScannedSession: Sendable {
    package let sessionId: String
    package let cwd: String
    package let pid: pid_t
    package let lastActivity: Date
    package let gitBranch: String?
    package let busyStatus: AgentStatus
    package let focusURL: String?
    package let terminalName: String?
    package let herdrPaneID: String?
    package let t3Thread: T3ThreadRef?
    /// The app drawing this session's terminal, for the "don't shout at me about
    /// the window I'm looking at" check.
    package let terminalBundleID: String?
    /// The hosting window is gone but the process kept running (see
    /// `TerminalAttachment`), so there is nothing for a jump to land on.
    package let isDetached: Bool
    package let prompt: String?
    package let response: String?
    package let verb: String?

    package init(sessionId: String, cwd: String, pid: pid_t, lastActivity: Date, gitBranch: String? = nil, busyStatus: AgentStatus, focusURL: String? = nil, terminalName: String? = nil, herdrPaneID: String? = nil, t3Thread: T3ThreadRef? = nil, terminalBundleID: String? = nil, isDetached: Bool, prompt: String? = nil, response: String? = nil, verb: String? = nil) {
        self.sessionId = sessionId
        self.cwd = cwd
        self.pid = pid
        self.lastActivity = lastActivity
        self.gitBranch = gitBranch
        self.busyStatus = busyStatus
        self.focusURL = focusURL
        self.terminalName = terminalName
        self.herdrPaneID = herdrPaneID
        self.t3Thread = t3Thread
        self.terminalBundleID = terminalBundleID
        self.isDetached = isDetached
        self.prompt = prompt
        self.response = response
        self.verb = verb
    }
}
