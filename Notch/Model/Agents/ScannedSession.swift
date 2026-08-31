import Foundation

/// One live Claude session found by the process scan: a running `claude` pid,
/// the cwd it's in, and the newest transcript in that cwd parsed for status.
///
/// A pure value produced by `ProcessScanner` and consumed by `SessionReconciler`
/// — kept in the model layer (not the libproc adapter) so the reconciler and its
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
    let prompt: String?
    let response: String?
    let verb: String?
}
