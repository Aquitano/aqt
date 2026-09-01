import Foundation
import Testing
@testable import NotchCore

/// `SessionReconciler` is pure, so the grace-window / carry-forward / event rules
/// are exercised here without the provider's actor, timers, or sockets.
struct SessionReconcilerTests {

    private let t0 = Date(timeIntervalSince1970: 1_000)
    /// Inside `StatusReducer.busyEvidenceTimeout` of `t0`, so these fixtures
    /// exercise the reconciler's own rules rather than the staleness backstop.
    private let later = Date(timeIntervalSince1970: 1_300)

    private func scanned(
        _ id: String, cwd: String = "/Users/x/proj", busy: AgentStatus = .idle,
        at: Date? = nil, verb: String? = nil
    ) -> ScannedSession {
        ScannedSession(
            sessionId: id, cwd: cwd, pid: 42, lastActivity: at ?? t0, gitBranch: "main",
            busyStatus: busy, focusURL: nil, terminalName: "Warp", herdrPaneID: nil,
            t3Thread: nil, terminalBundleID: nil, isDetached: false,
            prompt: "p", response: "r", verb: verb
        )
    }

    private func hook(
        _ name: String, at: Date, message: String? = nil, tool: String? = nil, requestId: String? = nil
    ) -> HookSnapshot {
        HookSnapshot(name: name, time: at, message: message, tool: tool, requestId: requestId)
    }

    private func run(_ build: (inout SessionReconciler.Inputs) -> Void) -> SessionReconciler.Output {
        var inputs = SessionReconciler.Inputs(now: later)
        build(&inputs)
        return SessionReconciler.reconcile(inputs)
    }

    @Test func emptyInputsProduceNothing() {
        let out = run { _ in }
        #expect(out.sessions.isEmpty)
        #expect(out.events.isEmpty)
        #expect(out.expiredHookIDs.isEmpty)
    }

    @Test func scannedSessionPublishedWithTranscriptStatus() {
        let out = run { $0.scan = [scanned("s1", busy: .tool, verb: "Running")] }
        let session = out.sessions["s1"]
        #expect(session?.status == .tool)
        #expect(session?.activityVerb == "Running")
        #expect(session?.project == "proj")
    }

    @Test func idleStatusClearsActivityVerb() {
        // A non-busy status must not carry a stale verb into the row.
        let out = run { $0.scan = [scanned("s1", busy: .idle, verb: "Running")] }
        #expect(out.sessions["s1"]?.activityVerb == nil)
    }

    @Test func tombstonedSessionIsExcluded() {
        let out = run {
            $0.scan = [scanned("s1")]
            $0.endedSessionIDs = ["s1"]
        }
        #expect(out.sessions["s1"] == nil)
    }

    // MARK: - Hook-only grace window

    @Test func hookOnlySessionKeptWithinGrace() {
        let out = run {
            $0.hookState = ["h1": hook("Notification", at: later, message: "needs you")]
            $0.hookCwd = ["h1": "/Users/x/proj"]
            $0.now = later.addingTimeInterval(10) // within 30s window
        }
        #expect(out.sessions["h1"] != nil)
        #expect(out.expiredHookIDs.isEmpty)
    }

    @Test func hookOnlySessionExpiredPastGrace() {
        let out = run {
            $0.hookState = ["h1": hook("Notification", at: t0, message: "needs you")]
            $0.hookCwd = ["h1": "/Users/x/proj"]
            $0.now = t0.addingTimeInterval(60) // past 30s window
        }
        #expect(out.sessions["h1"] == nil)
        #expect(out.expiredHookIDs == ["h1"])
    }

    @Test func hookStateWithoutCwdExpiresPastGraceInsteadOfLeaking() {
        // A hookState entry with no matching cwd can't be surfaced; past the grace
        // window it must be reported as expired so the caller can drop it, rather
        // than lingering as a permanent entry.
        let out = run {
            $0.hookState = ["h1": hook("Notification", at: t0, message: "needs you")]
            $0.hookCwd = [:]
            $0.now = t0.addingTimeInterval(60)
        }
        #expect(out.sessions["h1"] == nil)
        #expect(out.expiredHookIDs == ["h1"])
    }

    @Test func hookStateWithoutCwdIsKeptWithinGrace() {
        // Within grace it may just be a cwd-bearing hook that hasn't arrived yet.
        let out = run {
            $0.hookState = ["h1": hook("Notification", at: later, message: "needs you")]
            $0.hookCwd = [:]
            $0.now = later.addingTimeInterval(10)
        }
        #expect(out.sessions["h1"] == nil)
        #expect(out.expiredHookIDs.isEmpty)
    }

    // MARK: - Events

    @Test func sessionStartHookEmitsStarted() {
        let out = run {
            $0.scan = [scanned("s1", at: t0)]
            $0.hookState = ["s1": hook("SessionStart", at: later)]
        }
        #expect(out.events.map(\.kind) == [.started])
    }

    @Test func scanDiscoveryWithoutHookIsSilent() {
        // A session that predates the app is discovered by the scan, not announced.
        let out = run { $0.scan = [scanned("s1")] }
        #expect(out.events.isEmpty)
    }

    @Test func disappearedSessionEmitsEnded() {
        let prior = AgentSession(id: "s1", kind: .claudeCode, project: "proj", cwd: "/x",
                                 status: .running, startedAt: t0, lastActivity: t0)
        let out = run { $0.previous = ["s1": prior] }
        #expect(out.events.map(\.kind) == [.ended])
        #expect(out.sessions["s1"] == nil)
    }

    @Test func transitionToFinishedEmitsFinished() {
        let prior = AgentSession(id: "s1", kind: .claudeCode, project: "proj", cwd: "/Users/x/proj",
                                 status: .running, startedAt: t0, lastActivity: t0)
        let out = run {
            $0.scan = [scanned("s1", at: t0)]
            $0.hookState = ["s1": hook("Stop", at: later)]
            $0.previous = ["s1": prior]
        }
        #expect(out.sessions["s1"]?.status == .finished)
        #expect(out.events.map(\.kind) == [.finished])
    }

    @Test func repeatPermissionPromptFiresOncePerDistinctHookTime() {
        let promptHook = hook("Notification", at: later, message: "allow rm?")
        // First reconcile surfaces the prompt.
        let first = run {
            $0.scan = [scanned("s1", at: t0)]
            $0.hookState = ["s1": promptHook]
        }
        #expect(first.events.map(\.kind) == [.needsAttention])

        // Same hook time again (a plain re-reconcile) must not re-fire.
        let second = run {
            $0.scan = [scanned("s1", at: t0)]
            $0.hookState = ["s1": promptHook]
            $0.previous = first.sessions
            $0.emittedAttentionAt = first.emittedAttentionAt
        }
        #expect(second.events.isEmpty)

        // A second, distinct prompt (newer hook time) re-fires even though the
        // status was already needsAttention.
        let third = run {
            $0.scan = [scanned("s1", at: t0)]
            $0.hookState = ["s1": hook("Notification", at: later.addingTimeInterval(5), message: "allow curl?")]
            $0.previous = second.sessions
            $0.emittedAttentionAt = second.emittedAttentionAt
        }
        #expect(third.events.map(\.kind) == [.needsAttention])
    }

    @Test func permissionRequestStampsIdAndFiresAttention() {
        let out = run {
            $0.scan = [scanned("s1", at: t0)]
            $0.hookState = ["s1": hook("PermissionRequest", at: later, message: "Bash: rm -rf build", requestId: "r1")]
        }
        #expect(out.sessions["s1"]?.status == .needsAttention)
        #expect(out.sessions["s1"]?.permissionRequestId == "r1")
        #expect(out.sessions["s1"]?.detail == "Bash: rm -rf build")
        #expect(out.events.map(\.kind) == [.needsAttention])
    }

    @Test func stopFailureFiresAttentionWithItsReason() {
        // A turn killed by an API error used to leave the row "Thinking" silently.
        let out = run {
            $0.scan = [scanned("s1", busy: .running, at: t0, verb: "Thinking")]
            $0.hookState = ["s1": hook("StopFailure", at: later, message: "rate_limit — too many requests")]
        }
        #expect(out.sessions["s1"]?.status == .needsAttention)
        #expect(out.sessions["s1"]?.detail == "rate_limit — too many requests")
        #expect(out.events.map(\.kind) == [.needsAttention])
    }

    @Test func permissionRequestIdClearsOnNewerHook() {
        // Once any newer hook lands (answered, or timed out into the terminal
        // prompt and the turn moved on), the Approve/Deny affordance must go away.
        let out = run {
            $0.scan = [scanned("s1", at: t0)]
            $0.hookState = ["s1": hook("PermissionResolved", at: later)]
            $0.previous = ["s1": AgentSession(
                id: "s1", kind: .claudeCode, project: "proj", cwd: "/Users/x/proj",
                status: .needsAttention, startedAt: t0, lastActivity: t0, permissionRequestId: "r1"
            )]
        }
        #expect(out.sessions["s1"]?.permissionRequestId == nil)
        #expect(out.sessions["s1"]?.status == .running)
    }

    @Test func permissionRequestIdClearsOnTimeoutButNeedsAttentionRemains() {
        let out = run {
            $0.scan = [scanned("s1", busy: .tool, at: t0)]
            $0.hookState = ["s1": hook("PermissionTimedOut", at: later)]
            $0.previous = ["s1": AgentSession(
                id: "s1", kind: .claudeCode, project: "proj", cwd: "/Users/x/proj",
                status: .needsAttention, startedAt: t0, lastActivity: t0,
                detail: "Bash: rm -rf build", permissionRequestId: "r1"
            )]
        }
        #expect(out.sessions["s1"]?.permissionRequestId == nil)
        #expect(out.sessions["s1"]?.status == .needsAttention)
        #expect(out.sessions["s1"]?.detail == "Bash: rm -rf build")
    }

    @Test func startedAtCarriesForwardFromPrevious() {
        let prior = AgentSession(id: "s1", kind: .claudeCode, project: "proj", cwd: "/Users/x/proj",
                                 status: .running, startedAt: t0, lastActivity: t0)
        let out = run {
            $0.scan = [scanned("s1", at: later)] // newer mtime, but startedAt should stick to t0
            $0.previous = ["s1": prior]
        }
        #expect(out.sessions["s1"]?.startedAt == t0)
    }
}
