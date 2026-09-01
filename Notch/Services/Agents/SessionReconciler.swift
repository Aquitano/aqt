import Foundation

/// Merges a process/transcript scan and the per-session hook state into the
/// published session set, resolves each status (via `StatusReducer`), and derives
/// the notify-worthy transitions — all as a pure function.
///
/// This is the second-trickiest behaviour in the feature after the status
/// decision: the grace-window purge of hook-only sessions, the carry-forward of
/// detail the current cycle didn't re-observe, and the "fire each distinct
/// permission prompt exactly once" dedup. Keeping it pure lets those rules be
/// table-tested; the provider is left with only the side effects (publish,
/// emit, purge its dictionaries).
enum SessionReconciler {

    struct Inputs {
        var scan: [ScannedSession] = []
        var hookState: [String: HookSnapshot] = [:]
        var hookCwd: [String: String] = [:]
        var endedSessionIDs: Set<String> = []
        /// The previously-published set, for carry-forward and transition detection.
        var previous: [String: AgentSession] = [:]
        /// Last attention-hook time surfaced per session (drives the prompt dedup).
        var emittedAttentionAt: [String: Date] = [:]
        var now: Date
        var graceWindow: TimeInterval = 30
    }

    struct Output {
        let sessions: [String: AgentSession]
        let events: [AgentEvent]
        /// Hook-only sessions that aged out past the grace window — the caller
        /// drops their hook/cwd bookkeeping.
        let expiredHookIDs: [String]
        /// The updated dedup map; replaces the caller's `emittedAttentionAt`.
        let emittedAttentionAt: [String: Date]
    }

    static func reconcile(_ input: Inputs) -> Output {
        var sessions: [String: AgentSession] = [:]
        var expiredHookIDs: [String] = []
        var emittedAttentionAt = input.emittedAttentionAt

        for scanned in input.scan where !input.endedSessionIDs.contains(scanned.sessionId) {
            sessions[scanned.sessionId] = AgentSession(
                id: scanned.sessionId, kind: .claudeCode, project: agentProjectName(scanned.cwd),
                cwd: scanned.cwd, status: .idle, startedAt: scanned.lastActivity,
                lastActivity: scanned.lastActivity, pid: scanned.pid, gitBranch: scanned.gitBranch,
                terminalFocusURL: scanned.focusURL, lastPrompt: scanned.prompt,
                lastResponse: scanned.response, terminalName: scanned.terminalName,
                herdrPaneID: scanned.herdrPaneID, isDetached: scanned.isDetached
            )
        }

        // Hook-known sessions not yet seen by the scan. Keep one only briefly:
        // a real session shows up in the scan within a reconcile or two, so a
        // hook with no matching live process past the grace window is a crashed
        // session that never sent SessionEnd — expire it instead of resurrecting
        // a phantom (e.g. a stuck "needs you") on every rebuild.
        for sid in input.hookState.keys where sessions[sid] == nil {
            if input.endedSessionIDs.contains(sid) { continue }
            guard let hook = input.hookState[sid] else { continue }
            let withinGrace = input.now.timeIntervalSince(hook.time) <= input.graceWindow
            guard let cwd = input.hookCwd[sid] else {
                // No cwd to build a session from. Left as-is it would be a permanent
                // hookState entry (skipped by both the surface and expiry branches),
                // so expire it once past the grace window.
                if !withinGrace {
                    expiredHookIDs.append(sid)
                    emittedAttentionAt[sid] = nil
                }
                continue
            }
            if withinGrace {
                sessions[sid] = AgentSession(
                    id: sid, kind: .claudeCode, project: agentProjectName(cwd), cwd: cwd,
                    status: .idle, startedAt: hook.time, lastActivity: hook.time,
                    pid: nil, gitBranch: nil, detail: hook.message
                )
            } else {
                expiredHookIDs.append(sid)
                emittedAttentionAt[sid] = nil
            }
        }

        for sid in sessions.keys {
            var session = sessions[sid]!
            let scanned = input.scan.first { $0.sessionId == sid }
            let resolved = StatusReducer.reduce(
                hook: input.hookState[sid], scan: scanned.map(scanInput), now: input.now
            )
            session.status = resolved.status
            session.activityVerb = resolved.status.isBusy ? resolved.verb : nil
            session.detail = input.hookState[sid]?.message ?? session.detail
            // Only while the latest hook is the blocked PermissionRequest; any newer
            // hook means the request was answered (or timed out into the terminal
            // prompt), so the row's Approve/Deny must disappear.
            if let hook = input.hookState[sid], hook.name == "PermissionRequest" {
                session.permissionRequestId = hook.requestId
            }
            if let prev = input.previous[sid] {
                session.startedAt = prev.startedAt
                // Keep previously-captured detail if this cycle didn't see it.
                session.detail = session.detail ?? prev.detail
                session.terminalFocusURL = session.terminalFocusURL ?? prev.terminalFocusURL
                session.terminalName = session.terminalName ?? prev.terminalName
                session.herdrPaneID = session.herdrPaneID ?? prev.herdrPaneID
                session.lastPrompt = session.lastPrompt ?? prev.lastPrompt
                session.lastResponse = session.lastResponse ?? prev.lastResponse
            }
            sessions[sid] = session
        }

        let events = deriveEvents(
            sessions: sessions, previous: input.previous,
            hookState: input.hookState, emittedAttentionAt: &emittedAttentionAt
        )

        return Output(
            sessions: sessions, events: events,
            expiredHookIDs: expiredHookIDs, emittedAttentionAt: emittedAttentionAt
        )
    }

    /// Hooks that announce a *new* reason to look at a session, so each one earns
    /// its own notification. `PermissionTimedOut` is deliberately absent: it
    /// follows a prompt we already announced.
    private static let attentionHooks: Set<String> = ["Notification", "PermissionRequest", "StopFailure"]

    private static func deriveEvents(
        sessions: [String: AgentSession],
        previous: [String: AgentSession],
        hookState: [String: HookSnapshot],
        emittedAttentionAt: inout [String: Date]
    ) -> [AgentEvent] {
        var events: [AgentEvent] = []
        for (sid, session) in sessions {
            // A fresh permission prompt surfaces even when the status was already
            // needsAttention (two prompts in a row share the status). Keyed on the
            // attention hook's time so each distinct prompt fires exactly once.
            if session.status == .needsAttention,
               let attentionTime = hookState[sid].flatMap({
                   attentionHooks.contains($0.name) ? $0.time : nil
               }) {
                if emittedAttentionAt[sid] != attentionTime {
                    emittedAttentionAt[sid] = attentionTime
                    events.append(AgentEvent(kind: .needsAttention, session: session, message: session.detail))
                }
                continue
            }

            guard let prev = previous[sid] else {
                // Only a genuine SessionStart hook announces a start; sessions that
                // predate the app/enable are discovered silently by the scan.
                if hookState[sid]?.name == "SessionStart" {
                    events.append(AgentEvent(kind: .started, session: session, message: nil))
                }
                continue
            }

            if prev.status != session.status, session.status == .finished {
                events.append(AgentEvent(kind: .finished, session: session, message: nil))
            }
        }
        for (sid, session) in previous where sessions[sid] == nil {
            emittedAttentionAt[sid] = nil
            events.append(AgentEvent(kind: .ended, session: session, message: nil))
        }
        return events
    }

    /// Project a scanned session onto just the facts the status reducer needs.
    private static func scanInput(_ scanned: ScannedSession) -> StatusReducer.Scan {
        StatusReducer.Scan(lastActivity: scanned.lastActivity, busy: scanned.busyStatus, verb: scanned.verb)
    }
}
