import XCTest

/// `SessionReconciler` is pure, so the grace-window / carry-forward / event rules
/// are exercised here without the provider's actor, timers, or sockets.
final class SessionReconcilerTests: XCTestCase {

    private let t0 = Date(timeIntervalSince1970: 1_000)
    private let later = Date(timeIntervalSince1970: 2_000)

    private func scanned(
        _ id: String, cwd: String = "/Users/x/proj", busy: AgentStatus = .idle,
        at: Date? = nil, verb: String? = nil
    ) -> ScannedSession {
        ScannedSession(
            sessionId: id, cwd: cwd, pid: 42, lastActivity: at ?? t0, gitBranch: "main",
            busyStatus: busy, focusURL: nil, terminalName: "Warp", herdrPaneID: nil,
            isDetached: false,
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

    func testEmptyInputsProduceNothing() {
        let out = run { _ in }
        XCTAssertTrue(out.sessions.isEmpty)
        XCTAssertTrue(out.events.isEmpty)
        XCTAssertTrue(out.expiredHookIDs.isEmpty)
    }

    func testScannedSessionPublishedWithTranscriptStatus() {
        let out = run { $0.scan = [scanned("s1", busy: .tool, verb: "Running")] }
        let session = out.sessions["s1"]
        XCTAssertEqual(session?.status, .tool)
        XCTAssertEqual(session?.activityVerb, "Running")
        XCTAssertEqual(session?.project, "proj")
    }

    func testIdleStatusClearsActivityVerb() {
        // A non-busy status must not carry a stale verb into the row.
        let out = run { $0.scan = [scanned("s1", busy: .idle, verb: "Running")] }
        XCTAssertNil(out.sessions["s1"]?.activityVerb)
    }

    func testTombstonedSessionIsExcluded() {
        let out = run {
            $0.scan = [scanned("s1")]
            $0.endedSessionIDs = ["s1"]
        }
        XCTAssertNil(out.sessions["s1"])
    }

    // MARK: - Hook-only grace window

    func testHookOnlySessionKeptWithinGrace() {
        let out = run {
            $0.hookState = ["h1": hook("Notification", at: later, message: "needs you")]
            $0.hookCwd = ["h1": "/Users/x/proj"]
            $0.now = later.addingTimeInterval(10) // within 30s window
        }
        XCTAssertNotNil(out.sessions["h1"])
        XCTAssertTrue(out.expiredHookIDs.isEmpty)
    }

    func testHookOnlySessionExpiredPastGrace() {
        let out = run {
            $0.hookState = ["h1": hook("Notification", at: t0, message: "needs you")]
            $0.hookCwd = ["h1": "/Users/x/proj"]
            $0.now = t0.addingTimeInterval(60) // past 30s window
        }
        XCTAssertNil(out.sessions["h1"])
        XCTAssertEqual(out.expiredHookIDs, ["h1"])
    }

    func testHookStateWithoutCwdExpiresPastGraceInsteadOfLeaking() {
        // A hookState entry with no matching cwd can't be surfaced; past the grace
        // window it must be reported as expired so the caller can drop it, rather
        // than lingering as a permanent entry.
        let out = run {
            $0.hookState = ["h1": hook("Notification", at: t0, message: "needs you")]
            $0.hookCwd = [:]
            $0.now = t0.addingTimeInterval(60)
        }
        XCTAssertNil(out.sessions["h1"])
        XCTAssertEqual(out.expiredHookIDs, ["h1"])
    }

    func testHookStateWithoutCwdIsKeptWithinGrace() {
        // Within grace it may just be a cwd-bearing hook that hasn't arrived yet.
        let out = run {
            $0.hookState = ["h1": hook("Notification", at: later, message: "needs you")]
            $0.hookCwd = [:]
            $0.now = later.addingTimeInterval(10)
        }
        XCTAssertNil(out.sessions["h1"])
        XCTAssertTrue(out.expiredHookIDs.isEmpty)
    }

    // MARK: - Events

    func testSessionStartHookEmitsStarted() {
        let out = run {
            $0.scan = [scanned("s1", at: t0)]
            $0.hookState = ["s1": hook("SessionStart", at: later)]
        }
        XCTAssertEqual(out.events.map(\.kind), [.started])
    }

    func testScanDiscoveryWithoutHookIsSilent() {
        // A session that predates the app is discovered by the scan, not announced.
        let out = run { $0.scan = [scanned("s1")] }
        XCTAssertTrue(out.events.isEmpty)
    }

    func testDisappearedSessionEmitsEnded() {
        let prior = AgentSession(id: "s1", kind: .claudeCode, project: "proj", cwd: "/x",
                                 status: .running, startedAt: t0, lastActivity: t0)
        let out = run { $0.previous = ["s1": prior] }
        XCTAssertEqual(out.events.map(\.kind), [.ended])
        XCTAssertNil(out.sessions["s1"])
    }

    func testTransitionToFinishedEmitsFinished() {
        let prior = AgentSession(id: "s1", kind: .claudeCode, project: "proj", cwd: "/Users/x/proj",
                                 status: .running, startedAt: t0, lastActivity: t0)
        let out = run {
            $0.scan = [scanned("s1", at: t0)]
            $0.hookState = ["s1": hook("Stop", at: later)]
            $0.previous = ["s1": prior]
        }
        XCTAssertEqual(out.sessions["s1"]?.status, .finished)
        XCTAssertEqual(out.events.map(\.kind), [.finished])
    }

    func testRepeatPermissionPromptFiresOncePerDistinctHookTime() {
        let promptHook = hook("Notification", at: later, message: "allow rm?")
        // First reconcile surfaces the prompt.
        let first = run {
            $0.scan = [scanned("s1", at: t0)]
            $0.hookState = ["s1": promptHook]
        }
        XCTAssertEqual(first.events.map(\.kind), [.needsAttention])

        // Same hook time again (a plain re-reconcile) must not re-fire.
        let second = run {
            $0.scan = [scanned("s1", at: t0)]
            $0.hookState = ["s1": promptHook]
            $0.previous = first.sessions
            $0.emittedAttentionAt = first.emittedAttentionAt
        }
        XCTAssertTrue(second.events.isEmpty)

        // A second, distinct prompt (newer hook time) re-fires even though the
        // status was already needsAttention.
        let third = run {
            $0.scan = [scanned("s1", at: t0)]
            $0.hookState = ["s1": hook("Notification", at: later.addingTimeInterval(5), message: "allow curl?")]
            $0.previous = second.sessions
            $0.emittedAttentionAt = second.emittedAttentionAt
        }
        XCTAssertEqual(third.events.map(\.kind), [.needsAttention])
    }

    func testPermissionRequestStampsIdAndFiresAttention() {
        let out = run {
            $0.scan = [scanned("s1", at: t0)]
            $0.hookState = ["s1": hook("PermissionRequest", at: later, message: "Bash: rm -rf build", requestId: "r1")]
        }
        XCTAssertEqual(out.sessions["s1"]?.status, .needsAttention)
        XCTAssertEqual(out.sessions["s1"]?.permissionRequestId, "r1")
        XCTAssertEqual(out.sessions["s1"]?.detail, "Bash: rm -rf build")
        XCTAssertEqual(out.events.map(\.kind), [.needsAttention])
    }

    func testPermissionRequestIdClearsOnNewerHook() {
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
        XCTAssertNil(out.sessions["s1"]?.permissionRequestId)
        XCTAssertEqual(out.sessions["s1"]?.status, .running)
    }

    func testPermissionRequestIdClearsOnTimeoutButNeedsAttentionRemains() {
        let out = run {
            $0.scan = [scanned("s1", busy: .tool, at: t0)]
            $0.hookState = ["s1": hook("PermissionTimedOut", at: later)]
            $0.previous = ["s1": AgentSession(
                id: "s1", kind: .claudeCode, project: "proj", cwd: "/Users/x/proj",
                status: .needsAttention, startedAt: t0, lastActivity: t0,
                detail: "Bash: rm -rf build", permissionRequestId: "r1"
            )]
        }
        XCTAssertNil(out.sessions["s1"]?.permissionRequestId)
        XCTAssertEqual(out.sessions["s1"]?.status, .needsAttention)
        XCTAssertEqual(out.sessions["s1"]?.detail, "Bash: rm -rf build")
    }

    func testStartedAtCarriesForwardFromPrevious() {
        let prior = AgentSession(id: "s1", kind: .claudeCode, project: "proj", cwd: "/Users/x/proj",
                                 status: .running, startedAt: t0, lastActivity: t0)
        let out = run {
            $0.scan = [scanned("s1", at: later)] // newer mtime, but startedAt should stick to t0
            $0.previous = ["s1": prior]
        }
        XCTAssertEqual(out.sessions["s1"]?.startedAt, t0)
    }
}
