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

    /// A hook fresher than the last transcript write is authoritative — it marks
    /// an exact turn transition, so the status never has to be inferred from
    /// timing. Otherwise fall back to the transcript structure (which also stands
    /// in for sessions that predate enabling the hooks).
    static func reduce(hook: HookSnapshot?, scan: Scan?) -> Resolved {
        let fileTime = scan?.lastActivity ?? .distantPast

        if let hook, hook.time >= fileTime {
            switch hook.name {
            case "Notification":
                // Claude's Notification hook covers both permission prompts and
                // idle "waiting for your input" nudges. Only a permission prompt is
                // a real needs-you; an idle nudge fires with no follow-up activity,
                // so treating it as attention left finished/idle sessions stuck
                // showing "needs you". A genuine prompt clears on its own once the
                // user answers and the transcript advances past the hook time.
                if !isIdleNotification(hook.message) { return Resolved(status: .needsAttention, verb: nil) }
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
            case "UserPromptSubmit", "PostToolUse", "PermissionResolved":
                // Turn just started, or a tool just finished and the model is working
                // on what to do next.
                return Resolved(status: .running, verb: "Thinking")
            case "PreToolUse":
                if let tool = hook.tool {
                    return Resolved(status: agentEditTools.contains(tool) ? .editing : .tool, verb: agentToolVerb(tool))
                }
                return Resolved(status: .running, verb: "Thinking")
            case "SessionStart": return Resolved(status: scan?.busy ?? .running, verb: scan?.verb)
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
