import Foundation

/// The latest hook a session received, distilled to what the status decision
/// needs. A hook is a precise turn-transition signal; when it's fresher than the
/// transcript it overrides the structural inference.
struct HookSnapshot: Equatable, Sendable {
    let name: String
    let time: Date
    let message: String?
    let tool: String?
    /// Set on PermissionRequest hooks: the id the decision reply must carry.
    var requestId: String? = nil
    /// `notification_type` on a Notification hook (`idle_prompt`,
    /// `permission_prompt`, `agent_needs_input`, …). Claude classifies its own
    /// notifications, so this replaces guessing from the message text.
    var notificationType: String? = nil
}

/// Decides a session's status + activity verb from the latest hook and the
/// transcript scan. Pure: same inputs, same output, no I/O or shared state — so
/// the product-critical transitions (running → editing → needs-attention, the
/// "trust a fresh hook over file timing" rule, the idle-vs-permission split) are
/// exercisable with fixtures instead of live processes.
///
/// This concentrates the feature's trickiest behaviour in one place. Inlining it
/// back into the provider's reconcile loop would scatter that logic across the
/// app's most-edited file, which is exactly what makes it earn its keep.
enum StatusReducer {

    /// The scan-derived facts the decision needs: when the transcript last
    /// changed (to race against the hook time) and what its structure implies.
    struct Scan: Equatable, Sendable {
        let lastActivity: Date
        let busy: AgentStatus
        let verb: String?
    }

    struct Resolved: Equatable, Sendable {
        let status: AgentStatus
        let verb: String?
    }

    /// How long a busy state may stand on evidence that stopped arriving. Nothing
    /// else rescues a turn that ended without a terminal hook — an agent killed
    /// mid-run, a crash, a transcript that simply stopped growing — and such a row
    /// would otherwise read "Thinking" for as long as the process lives. Long
    /// enough that a slow tool (a full build, a test suite) is never demoted while
    /// it works; when it finishes, its hook restores the status immediately.
    static let busyEvidenceTimeout: TimeInterval = 600

    /// Resolve the status, then refuse to keep claiming work on stale evidence.
    static func reduce(hook: HookSnapshot?, scan: Scan?, now: Date = Date()) -> Resolved {
        let resolved = decide(hook: hook, scan: scan)
        guard resolved.status.isBusy else { return resolved }
        let newestEvidence = max(hook?.time ?? .distantPast, scan?.lastActivity ?? .distantPast)
        guard now.timeIntervalSince(newestEvidence) > busyEvidenceTimeout else { return resolved }
        return Resolved(status: .idle, verb: nil)
    }

    /// A hook fresher than the last transcript write is authoritative — it marks
    /// an exact turn transition, so the status never has to be inferred from
    /// timing. Otherwise fall back to the transcript structure (which also stands
    /// in for sessions that predate enabling the hooks).
    private static func decide(hook: HookSnapshot?, scan: Scan?) -> Resolved {
        let fileTime = scan?.lastActivity ?? .distantPast

        if let hook, hook.time >= fileTime {
            switch hook.name {
            case "Notification":
                // Claude's Notification hook covers permission prompts, idle "waiting
                // for your input" nudges, and pure information (auth, quota resume).
                // Only the first is a real needs-you; an idle nudge is the opposite —
                // positive evidence that the session is waiting, which used to fall
                // through and be re-inferred as running from the transcript.
                if let resolved = notificationStatus(hook) { return resolved }
            case "StopFailure":
                // The turn died on an API error (rate limit, overload, auth) instead
                // of finishing: no Stop hook ever fires, and the work the user asked
                // for silently didn't happen. That is on them, not a completion.
                return Resolved(status: .needsAttention, verb: nil)
            case "PermissionRequest":
                // The hook client is blocked on our allow/deny reply — the session
                // is waiting on the user regardless of what the transcript says.
                return Resolved(status: .needsAttention, verb: nil)
            case "PermissionTimedOut":
                // The app can no longer answer the blocked hook; Claude has fallen
                // back to its terminal prompt, so keep the needs-you state but drop
                // the in-notch Approve/Deny controls.
                return Resolved(status: .needsAttention, verb: nil)
            case "Stop", "SessionEnd": return Resolved(status: .finished, verb: nil)
            case "UserPromptSubmit", "PostToolUse", "PostToolUseFailure", "PermissionResolved":
                // Turn just started, or a tool just settled (a failed one fires only
                // PostToolUseFailure, which without this left the row stuck on the
                // tool's verb) and the model is working out what to do next.
                return Resolved(status: .running, verb: "Thinking")
            case "PreToolUse":
                if let tool = hook.tool {
                    return Resolved(status: agentEditTools.contains(tool) ? .editing : .tool, verb: agentToolVerb(tool))
                }
                return Resolved(status: .running, verb: "Thinking")
            // A session that just started has done nothing yet: without a transcript
            // to say otherwise it is waiting for its first prompt, not working.
            case "SessionStart": return Resolved(status: scan?.busy ?? .idle, verb: scan?.verb)
            default: break
            }
        }

        guard let scan else { return Resolved(status: .idle, verb: nil) }
        // parseTail already resolved busy-vs-idle from the transcript structure (a
        // pending tool_use or an unanswered prompt is busy; a text-only final turn is
        // idle), so trust it directly. The old clock-based window wrongly idled long
        // tool runs and thinking pauses, and flip-flopped during active turns.
        return Resolved(status: scan.busy, verb: scan.verb)
    }

    /// What a Notification says about the session, or nil when it says nothing
    /// about it (auth confirmations, quota auto-resume) and the transcript should
    /// decide. Claude tags every notification with its kind; the message text is
    /// only read on versions that don't send one.
    private static func notificationStatus(_ hook: HookSnapshot) -> Resolved? {
        guard let type = hook.notificationType else {
            return isIdleNotification(hook.message)
                ? Resolved(status: .idle, verb: nil)
                : Resolved(status: .needsAttention, verb: nil)
        }
        switch type {
        case "idle_prompt": return Resolved(status: .idle, verb: nil)
        case "permission_prompt", "agent_needs_input",
             "elicitation_dialog", "elicitation_url_dialog":
            return Resolved(status: .needsAttention, verb: nil)
        case "agent_completed": return Resolved(status: .finished, verb: nil)
        default: return nil
        }
    }

    /// Distinguish Claude's idle "waiting for your input" Notification from a
    /// permission prompt, so the former doesn't read as needs-you. Anchored to the
    /// actual idle-nudge phrase rather than a bare "waiting"/"idle" substring, which
    /// would demote a real permission prompt whose tool name or description happens
    /// to contain either word.
    private static func isIdleNotification(_ message: String?) -> Bool {
        guard let message = message?.lowercased() else { return false }
        return message.contains("waiting for your input")
            || message.contains("waiting for input")
    }
}
