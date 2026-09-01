import XCTest

/// The `StatusReducer` source is compiled directly into this logic-test target
/// (see `project.yml`), so its `internal` API is reachable without hosting the
/// app — these fixtures run without a live Claude process.
final class StatusReducerTests: XCTestCase {

    /// Both fixtures sit well inside `busyEvidenceTimeout`, so a test only meets
    /// the staleness backstop when it asks for it by passing its own `now`.
    private let now = Date()
    private lazy var t0 = now.addingTimeInterval(-120)
    private lazy var later = now.addingTimeInterval(-10)

    private func hook(
        _ name: String, at time: Date, message: String? = nil, tool: String? = nil,
        notificationType: String? = nil
    ) -> HookSnapshot {
        HookSnapshot(name: name, time: time, message: message, tool: tool,
                     notificationType: notificationType)
    }

    private func scan(at time: Date, busy: AgentStatus = .running, verb: String? = nil) -> StatusReducer.Scan {
        StatusReducer.Scan(lastActivity: time, busy: busy, verb: verb)
    }

    // MARK: - Hook vs. file timing

    func testFreshHookOverridesTranscript() {
        // Hook newer than the last transcript write wins.
        let resolved = StatusReducer.reduce(
            hook: hook("UserPromptSubmit", at: later),
            scan: scan(at: t0, busy: .idle)
        )
        XCTAssertEqual(resolved, .init(status: .running, verb: "Thinking"))
    }

    func testStaleHookYieldsToTranscript() {
        // Hook older than the last transcript write is ignored; trust the scan.
        let resolved = StatusReducer.reduce(
            hook: hook("UserPromptSubmit", at: t0),
            scan: scan(at: later, busy: .editing, verb: "Editing")
        )
        XCTAssertEqual(resolved, .init(status: .editing, verb: "Editing"))
    }

    func testHookEqualToFileTimeStillWins() {
        // The boundary is inclusive (>=): a hook stamped at the file mtime wins.
        let resolved = StatusReducer.reduce(
            hook: hook("Stop", at: t0),
            scan: scan(at: t0, busy: .running)
        )
        XCTAssertEqual(resolved.status, .finished)
    }

    // MARK: - PreToolUse: running -> editing -> tool

    func testPreToolUseEditToolIsEditing() {
        let resolved = StatusReducer.reduce(hook: hook("PreToolUse", at: later, tool: "Write"), scan: nil)
        XCTAssertEqual(resolved, .init(status: .editing, verb: "Editing"))
    }

    func testPreToolUseNonEditToolIsTool() {
        let resolved = StatusReducer.reduce(hook: hook("PreToolUse", at: later, tool: "Bash"), scan: nil)
        XCTAssertEqual(resolved, .init(status: .tool, verb: "Running"))
    }

    func testPreToolUseWithoutToolNameIsRunning() {
        let resolved = StatusReducer.reduce(hook: hook("PreToolUse", at: later, tool: nil), scan: nil)
        XCTAssertEqual(resolved, .init(status: .running, verb: "Thinking"))
    }

    func testPostToolUseIsRunning() {
        let resolved = StatusReducer.reduce(hook: hook("PostToolUse", at: later), scan: nil)
        XCTAssertEqual(resolved, .init(status: .running, verb: "Thinking"))
    }

    func testPostToolUseFailureIsRunning() {
        // A failed tool fires only PostToolUseFailure; without it the row keeps the
        // tool's verb ("Editing") until something else happens.
        let resolved = StatusReducer.reduce(
            hook: hook("PostToolUseFailure", at: later),
            scan: scan(at: t0, busy: .editing, verb: "Editing")
        )
        XCTAssertEqual(resolved, .init(status: .running, verb: "Thinking"))
    }

    // MARK: - Notification: permission prompt vs. idle nudge

    func testPermissionPromptNeedsAttention() {
        let resolved = StatusReducer.reduce(
            hook: hook("Notification", at: later, message: "Claude needs your permission to run rm -rf"),
            scan: nil
        )
        XCTAssertEqual(resolved.status, .needsAttention)
    }

    func testIdleNotificationIsIdleNotBusy() {
        // An idle nudge is positive evidence the session is waiting. Falling back to
        // the transcript here re-inferred "running" from an unanswered prompt and
        // left the row working forever.
        let resolved = StatusReducer.reduce(
            hook: hook("Notification", at: later, message: "Claude is waiting for your input"),
            scan: scan(at: t0, busy: .running, verb: "Thinking")
        )
        XCTAssertEqual(resolved, .init(status: .idle, verb: nil))
    }

    // MARK: - Notification types (Claude's own classification)

    func testIdleNotificationTypeIsIdle() {
        let resolved = StatusReducer.reduce(
            hook: hook("Notification", at: later, message: "Claude is waiting", notificationType: "idle_prompt"),
            scan: scan(at: t0, busy: .running)
        )
        XCTAssertEqual(resolved.status, .idle)
    }

    func testPermissionNotificationTypeNeedsAttention() {
        // The type decides even when the message reads like an idle nudge.
        let resolved = StatusReducer.reduce(
            hook: hook("Notification", at: later, message: "waiting for your input",
                       notificationType: "permission_prompt"),
            scan: nil
        )
        XCTAssertEqual(resolved.status, .needsAttention)
    }

    func testInformationalNotificationTypeDefersToTranscript() {
        // auth confirmations and quota auto-resume say nothing about the turn.
        let resolved = StatusReducer.reduce(
            hook: hook("Notification", at: later, notificationType: "quota_auto_resume_fired"),
            scan: scan(at: t0, busy: .tool, verb: "Running")
        )
        XCTAssertEqual(resolved, .init(status: .tool, verb: "Running"))
    }

    func testIdleNotificationWithoutScanIsIdle() {
        let resolved = StatusReducer.reduce(
            hook: hook("Notification", at: later, message: "Claude is waiting for your input"),
            scan: nil
        )
        XCTAssertEqual(resolved, .init(status: .idle, verb: nil))
    }

    func testPermissionPromptMentioningWaitingStillNeedsAttention() {
        // A permission prompt whose tool name/description contains "waiting" must not
        // be demoted to an idle nudge by a bare-substring match.
        let resolved = StatusReducer.reduce(
            hook: hook("Notification", at: later,
                       message: "Claude needs your permission to use waiting-room-cli"),
            scan: nil
        )
        XCTAssertEqual(resolved.status, .needsAttention)
    }

    func testNotificationWithNilMessageNeedsAttention() {
        // No message is not an idle nudge; a permission prompt can arrive without one.
        let resolved = StatusReducer.reduce(
            hook: hook("Notification", at: later, message: nil),
            scan: nil
        )
        XCTAssertEqual(resolved.status, .needsAttention)
    }

    // MARK: - Permission requests

    func testPermissionRequestNeedsAttention() {
        // The blocking hook means the session is waiting on the user, whatever the
        // transcript structure says.
        let resolved = StatusReducer.reduce(
            hook: hook("PermissionRequest", at: later, message: "Bash: rm -rf build"),
            scan: scan(at: t0, busy: .tool)
        )
        XCTAssertEqual(resolved.status, .needsAttention)
    }

    func testPermissionResolvedIsRunning() {
        let resolved = StatusReducer.reduce(hook: hook("PermissionResolved", at: later), scan: nil)
        XCTAssertEqual(resolved.status, .running)
        XCTAssertEqual(resolved.verb, "Thinking")
    }

    func testPermissionTimedOutStillNeedsAttention() {
        let resolved = StatusReducer.reduce(
            hook: hook("PermissionTimedOut", at: later),
            scan: scan(at: t0, busy: .tool)
        )
        XCTAssertEqual(resolved.status, .needsAttention)
        XCTAssertNil(resolved.verb)
    }

    // MARK: - Stop / SessionStart

    func testStopIsFinished() {
        XCTAssertEqual(StatusReducer.reduce(hook: hook("Stop", at: later), scan: nil).status, .finished)
    }

    func testSessionEndIsFinished() {
        XCTAssertEqual(StatusReducer.reduce(hook: hook("SessionEnd", at: later), scan: nil).status, .finished)
    }

    func testSessionStartAdoptsScanStatus() {
        let resolved = StatusReducer.reduce(
            hook: hook("SessionStart", at: later),
            scan: scan(at: t0, busy: .tool, verb: "Running")
        )
        XCTAssertEqual(resolved, .init(status: .tool, verb: "Running"))
    }

    func testSessionStartWithoutScanIsIdle() {
        // A session that just started is waiting for its first prompt, not working.
        let resolved = StatusReducer.reduce(hook: hook("SessionStart", at: later), scan: nil)
        XCTAssertEqual(resolved, .init(status: .idle, verb: nil))
    }

    func testStopFailureNeedsAttention() {
        // The turn died on an API error: no Stop hook ever comes, and what the user
        // asked for did not happen.
        let resolved = StatusReducer.reduce(
            hook: hook("StopFailure", at: later, message: "rate_limit"),
            scan: scan(at: t0, busy: .running, verb: "Thinking")
        )
        XCTAssertEqual(resolved, .init(status: .needsAttention, verb: nil))
    }

    // MARK: - Stale evidence

    func testBusyTranscriptGoesIdleOnceEvidenceIsStale() {
        // The backstop for a turn that ended without any terminal hook: an agent
        // killed mid-run, a crash, a transcript that just stopped growing.
        let stale = now.addingTimeInterval(-StatusReducer.busyEvidenceTimeout - 1)
        let resolved = StatusReducer.reduce(
            hook: nil, scan: scan(at: stale, busy: .running, verb: "Thinking"), now: now
        )
        XCTAssertEqual(resolved, .init(status: .idle, verb: nil))
    }

    func testStaleBusyHookIsAlsoDemoted() {
        let stale = now.addingTimeInterval(-StatusReducer.busyEvidenceTimeout - 1)
        let resolved = StatusReducer.reduce(hook: hook("UserPromptSubmit", at: stale), scan: nil, now: now)
        XCTAssertEqual(resolved.status, .idle)
    }

    func testStaleNeedsAttentionIsNotDemoted() {
        // A permission prompt is answered when the user gets to it, however long
        // that takes; only claims of *work* expire.
        let stale = now.addingTimeInterval(-StatusReducer.busyEvidenceTimeout * 10)
        let resolved = StatusReducer.reduce(
            hook: hook("PermissionRequest", at: stale), scan: nil, now: now
        )
        XCTAssertEqual(resolved.status, .needsAttention)
    }

    func testUnknownHookFallsThroughToTranscript() {
        let resolved = StatusReducer.reduce(
            hook: hook("WeirdFutureHook", at: later),
            scan: scan(at: t0, busy: .editing, verb: "Editing")
        )
        XCTAssertEqual(resolved, .init(status: .editing, verb: "Editing"))
    }

    // MARK: - No hook

    func testNoHookNoScanIsIdle() {
        XCTAssertEqual(StatusReducer.reduce(hook: nil, scan: nil), .init(status: .idle, verb: nil))
    }

    func testNoHookUsesTranscript() {
        let resolved = StatusReducer.reduce(hook: nil, scan: scan(at: t0, busy: .tool, verb: "Reading"))
        XCTAssertEqual(resolved, .init(status: .tool, verb: "Reading"))
    }
}
