import Foundation

/// One live Claude session as it stands right now: a bound `claude` pid that is
/// still running, and its own transcript parsed for status.
///
/// A pure value produced by `SessionProbe` and consumed by `SessionReconciler` —
/// kept in the model layer (not the libproc adapter) so the reconciler and its
/// tests don't depend on `ProcessLookup`.
struct ScannedSession: Sendable {
    let sessionId: String
    let cwd: String
    let pid: pid_t
    let lastActivity: Date
    let gitBranch: String?
    let busyStatus: AgentStatus
    let focusURL: String?
    let terminalName: String?
    let herdrPaneID: String?
    let t3Thread: T3ThreadRef?
    /// The app drawing this session's terminal, for the "don't shout at me about
    /// the window I'm looking at" check.
    let terminalBundleID: String?
    /// The hosting window is gone but the process kept running (see
    /// `TerminalAttachment`), so there is nothing for a jump to land on.
    let isDetached: Bool
    let prompt: String?
    let response: String?
    let verb: String?
}
