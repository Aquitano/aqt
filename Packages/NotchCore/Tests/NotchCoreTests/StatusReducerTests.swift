import Foundation
import Testing
@testable import NotchCore

/// The `StatusReducer` source is compiled directly into this logic-test target
/// (see `project.yml`), so its `internal` API is reachable without hosting the
/// app — these fixtures run without a live Claude process.
struct StatusReducerTests {

    /// Both fixtures sit well inside `busyEvidenceTimeout`, so a test only meets
    /// the staleness backstop when it asks for it by passing its own `now`.
    private let now: Date
    private let t0: Date
    private let later: Date

    init() {
        let now = Date()
        self.now = now
        t0 = now.addingTimeInterval(-120)
        later = now.addingTimeInterval(-10)
    }

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

    @Test func freshHookOverridesTranscript() {
        // Hook newer than the last transcript write wins.
        let resolved = StatusReducer.reduce(
            hook: hook("UserPromptSubmit", at: later),
            scan: scan(at: t0, busy: .idle)
        )
        #expect(resolved == .init(status: .running, verb: "Thinking"))
    }

    @Test func staleHookYieldsToTranscript() {
        // Hook older than the last transcript write is ignored; trust the scan.
        let resolved = StatusReducer.reduce(
            hook: hook("UserPromptSubmit", at: t0),
            scan: scan(at: later, busy: .editing, verb: "Editing")
        )
        #expect(resolved == .init(status: .editing, verb: "Editing"))
    }

    @Test func hookEqualToFileTimeStillWins() {
        // The boundary is inclusive (>=): a hook stamped at the file mtime wins.
        let resolved = StatusReducer.reduce(
            hook: hook("Stop", at: t0),
            scan: scan(at: t0, busy: .running)
        )
        #expect(resolved.status == .finished)
    }

    // MARK: - PreToolUse: running -> editing -> tool

    @Test func preToolUseEditToolIsEditing() {
        let resolved = StatusReducer.reduce(hook: hook("PreToolUse", at: later, tool: "Write"), scan: nil)
        #expect(resolved == .init(status: .editing, verb: "Editing"))
    }

    @Test func preToolUseNonEditToolIsTool() {
        let resolved = StatusReducer.reduce(hook: hook("PreToolUse", at: later, tool: "Bash"), scan: nil)
        #expect(resolved == .init(status: .tool, verb: "Running"))
    }

    @Test func preToolUseWithoutToolNameIsRunning() {
        let resolved = StatusReducer.reduce(hook: hook("PreToolUse", at: later, tool: nil), scan: nil)
        #expect(resolved == .init(status: .running, verb: "Thinking"))
    }

    @Test func postToolUseIsRunning() {
        let resolved = StatusReducer.reduce(hook: hook("PostToolUse", at: later), scan: nil)
        #expect(resolved == .init(status: .running, verb: "Thinking"))
    }

    @Test func postToolUseFailureIsRunning() {
        // A failed tool fires only PostToolUseFailure; without it the row keeps the
        // tool's verb ("Editing") until something else happens.
        let resolved = StatusReducer.reduce(
            hook: hook("PostToolUseFailure", at: later),
            scan: scan(at: t0, busy: .editing, verb: "Editing")
        )
        #expect(resolved == .init(status: .running, verb: "Thinking"))
    }

    // MARK: - Notification: permission prompt vs. idle nudge

    @Test func permissionPromptNeedsAttention() {
        let resolved = StatusReducer.reduce(
            hook: hook("Notification", at: later, message: "Claude needs your permission to run rm -rf"),
            scan: nil
        )
        #expect(resolved.status == .needsAttention)
    }

    @Test func idleNotificationIsIdleNotBusy() {
        // An idle nudge is positive evidence the session is waiting. Falling back to
        // the transcript here re-inferred "running" from an unanswered prompt and
        // left the row working forever.
        let resolved = StatusReducer.reduce(
            hook: hook("Notification", at: later, message: "Claude is waiting for your input"),
            scan: scan(at: t0, busy: .running, verb: "Thinking")
        )
        #expect(resolved == .init(status: .idle, verb: nil))
    }

    // MARK: - Notification types (Claude's own classification)

    @Test func idleNotificationTypeIsIdle() {
        let resolved = StatusReducer.reduce(
            hook: hook("Notification", at: later, message: "Claude is waiting", notificationType: "idle_prompt"),
            scan: scan(at: t0, busy: .running)
        )
        #expect(resolved.status == .idle)
    }

    @Test func permissionNotificationTypeNeedsAttention() {
        // The type decides even when the message reads like an idle nudge.
        let resolved = StatusReducer.reduce(
            hook: hook("Notification", at: later, message: "waiting for your input",
                       notificationType: "permission_prompt"),
            scan: nil
        )
        #expect(resolved.status == .needsAttention)
    }

    @Test func informationalNotificationTypeDefersToTranscript() {
        // auth confirmations and quota auto-resume say nothing about the turn.
        let resolved = StatusReducer.reduce(
            hook: hook("Notification", at: later, notificationType: "quota_auto_resume_fired"),
            scan: scan(at: t0, busy: .tool, verb: "Running")
        )
        #expect(resolved == .init(status: .tool, verb: "Running"))
    }

    @Test func idleNotificationWithoutScanIsIdle() {
        let resolved = StatusReducer.reduce(
            hook: hook("Notification", at: later, message: "Claude is waiting for your input"),
            scan: nil
        )
        #expect(resolved == .init(status: .idle, verb: nil))
    }

    @Test func permissionPromptMentioningWaitingStillNeedsAttention() {
        // A permission prompt whose tool name/description contains "waiting" must not
        // be demoted to an idle nudge by a bare-substring match.
        let resolved = StatusReducer.reduce(
            hook: hook("Notification", at: later,
                       message: "Claude needs your permission to use waiting-room-cli"),
            scan: nil
        )
        #expect(resolved.status == .needsAttention)
    }

    @Test func notificationWithNilMessageNeedsAttention() {
        // No message is not an idle nudge; a permission prompt can arrive without one.
        let resolved = StatusReducer.reduce(
            hook: hook("Notification", at: later, message: nil),
            scan: nil
        )
        #expect(resolved.status == .needsAttention)
    }

    // MARK: - Permission requests

    @Test func permissionRequestNeedsAttention() {
        // The blocking hook means the session is waiting on the user, whatever the
        // transcript structure says.
        let resolved = StatusReducer.reduce(
            hook: hook("PermissionRequest", at: later, message: "Bash: rm -rf build"),
            scan: scan(at: t0, busy: .tool)
        )
        #expect(resolved.status == .needsAttention)
    }

    @Test func permissionResolvedIsRunning() {
        let resolved = StatusReducer.reduce(hook: hook("PermissionResolved", at: later), scan: nil)
        #expect(resolved.status == .running)
        #expect(resolved.verb == "Thinking")
    }

    @Test func permissionTimedOutStillNeedsAttention() {
        let resolved = StatusReducer.reduce(
            hook: hook("PermissionTimedOut", at: later),
            scan: scan(at: t0, busy: .tool)
        )
        #expect(resolved.status == .needsAttention)
        #expect(resolved.verb == nil)
    }

    // MARK: - Stop / SessionStart

    @Test func stopIsFinished() {
        #expect(StatusReducer.reduce(hook: hook("Stop", at: later), scan: nil).status == .finished)
    }

    @Test func sessionEndIsFinished() {
        #expect(StatusReducer.reduce(hook: hook("SessionEnd", at: later), scan: nil).status == .finished)
    }

    @Test func sessionStartAdoptsScanStatus() {
        let resolved = StatusReducer.reduce(
            hook: hook("SessionStart", at: later),
            scan: scan(at: t0, busy: .tool, verb: "Running")
        )
        #expect(resolved == .init(status: .tool, verb: "Running"))
    }

    @Test func sessionStartWithoutScanIsIdle() {
        // A session that just started is waiting for its first prompt, not working.
        let resolved = StatusReducer.reduce(hook: hook("SessionStart", at: later), scan: nil)
        #expect(resolved == .init(status: .idle, verb: nil))
    }

    @Test func stopFailureNeedsAttention() {
        // The turn died on an API error: no Stop hook ever comes, and what the user
        // asked for did not happen.
        let resolved = StatusReducer.reduce(
            hook: hook("StopFailure", at: later, message: "rate_limit"),
            scan: scan(at: t0, busy: .running, verb: "Thinking")
        )
        #expect(resolved == .init(status: .needsAttention, verb: nil))
    }

    // MARK: - Stale evidence

    @Test func busyTranscriptGoesIdleOnceEvidenceIsStale() {
        // The backstop for a turn that ended without any terminal hook: an agent
        // killed mid-run, a crash, a transcript that just stopped growing.
        let stale = now.addingTimeInterval(-StatusReducer.busyEvidenceTimeout - 1)
        let resolved = StatusReducer.reduce(
            hook: nil, scan: scan(at: stale, busy: .running, verb: "Thinking"), now: now
        )
        #expect(resolved == .init(status: .idle, verb: nil))
    }

    @Test func staleBusyHookIsAlsoDemoted() {
        let stale = now.addingTimeInterval(-StatusReducer.busyEvidenceTimeout - 1)
        let resolved = StatusReducer.reduce(hook: hook("UserPromptSubmit", at: stale), scan: nil, now: now)
        #expect(resolved.status == .idle)
    }

    @Test func staleNeedsAttentionIsNotDemoted() {
        // A permission prompt is answered when the user gets to it, however long
        // that takes; only claims of *work* expire.
        let stale = now.addingTimeInterval(-StatusReducer.busyEvidenceTimeout * 10)
        let resolved = StatusReducer.reduce(
            hook: hook("PermissionRequest", at: stale), scan: nil, now: now
        )
        #expect(resolved.status == .needsAttention)
    }

    @Test func unknownHookFallsThroughToTranscript() {
        let resolved = StatusReducer.reduce(
            hook: hook("WeirdFutureHook", at: later),
            scan: scan(at: t0, busy: .editing, verb: "Editing")
        )
        #expect(resolved == .init(status: .editing, verb: "Editing"))
    }

    // MARK: - No hook

    @Test func noHookNoScanIsIdle() {
        #expect(StatusReducer.reduce(hook: nil, scan: nil) == .init(status: .idle, verb: nil))
    }

    @Test func noHookUsesTranscript() {
        let resolved = StatusReducer.reduce(hook: nil, scan: scan(at: t0, busy: .tool, verb: "Reading"))
        #expect(resolved == .init(status: .tool, verb: "Reading"))
    }
}
