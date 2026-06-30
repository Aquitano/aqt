import XCTest

/// The `StatusReducer` source is compiled directly into this logic-test target
/// (see `project.yml`), so its `internal` API is reachable without hosting the
/// app — these fixtures run without a live Claude process.
final class StatusReducerTests: XCTestCase {

    private let t0 = Date(timeIntervalSince1970: 1_000)
    private let later = Date(timeIntervalSince1970: 2_000)

    private func hook(_ name: String, at time: Date, message: String? = nil, tool: String? = nil) -> HookSnapshot {
        HookSnapshot(name: name, time: time, message: message, tool: tool)
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

    // MARK: - Notification: permission prompt vs. idle nudge

    func testPermissionPromptNeedsAttention() {
        let resolved = StatusReducer.reduce(
            hook: hook("Notification", at: later, message: "Claude needs your permission to run rm -rf"),
            scan: nil
        )
        XCTAssertEqual(resolved.status, .needsAttention)
    }

    func testIdleNotificationFallsThroughToTranscript() {
        // An idle "waiting for your input" nudge is not a needs-you; with a scan it
        // resolves to the transcript's structural status, not needsAttention.
        let resolved = StatusReducer.reduce(
            hook: hook("Notification", at: later, message: "Claude is waiting for your input"),
            scan: scan(at: t0, busy: .idle)
        )
        XCTAssertEqual(resolved.status, .idle)
    }

    func testIdleNotificationWithoutScanIsIdle() {
        let resolved = StatusReducer.reduce(
            hook: hook("Notification", at: later, message: "idle"),
            scan: nil
        )
        XCTAssertEqual(resolved, .init(status: .idle, verb: nil))
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

    func testSessionStartWithoutScanIsRunning() {
        let resolved = StatusReducer.reduce(hook: hook("SessionStart", at: later), scan: nil)
        XCTAssertEqual(resolved, .init(status: .running, verb: nil))
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
