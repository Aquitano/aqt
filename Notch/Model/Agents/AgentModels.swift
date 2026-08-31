import Foundation

/// Which coding agent a session belongs to. Drives provider selection, the
/// compact-pill label, and the per-agent enable rows in the Agents tab.
enum AgentKind: String, Codable, CaseIterable, Identifiable, Sendable {
    case claudeCode
    case codex
    case openCode
    case ohMyPi
    case t3code

    var id: String { rawValue }

    /// Lowercase tag used in the compact pill ("claude · editing").
    var shortName: String {
        switch self {
        case .claudeCode: return "claude"
        case .codex: return "codex"
        case .openCode: return "opencode"
        case .ohMyPi: return "omp"
        case .t3code: return "t3"
        }
    }

    var displayName: String {
        switch self {
        case .claudeCode: return "Claude Code"
        case .codex: return "Codex"
        case .openCode: return "OpenCode"
        case .ohMyPi: return "oh-my-pi"
        case .t3code: return "T3 Code"
        }
    }

    /// Semantic icon key resolved by the app-wide pixel glyph renderer.
    var symbol: String {
        switch self {
        case .claudeCode: return "sparkles"
        case .codex: return "chevron.left.forwardslash.chevron.right"
        case .openCode: return "curlybraces"
        case .ohMyPi: return "fossil.shell.fill"
        case .t3code: return "square.grid.2x2"
        }
    }
}

/// Build-level switches for the agent feature. The permission-approval
/// round-trip (Approve/Deny from the notch) is fully implemented but currently
/// switched off everywhere — with it off, permission requests are answered
/// "ask" immediately so the agent falls back to its own terminal prompt.
enum AgentFeatures {
    static let permissionApproval = false
}

/// Lifecycle/activity state of one agent session. The first three are "busy"
/// states; `idle` is alive-but-waiting; `needsAttention` and `finished` are the
/// two notify-worthy transitions.
enum AgentStatus: String, Codable, Sendable {
    case running         // generating / thinking
    case editing         // applying a file edit (Edit/Write/MultiEdit)
    case tool            // running a non-edit tool (Bash, etc.)
    case idle            // alive, waiting for the next prompt
    case needsAttention  // permission prompt / waiting on the user
    case finished        // turn just completed (transient, then idle)

    /// A busy state actively does work; the pill shows these with motion priority.
    var isBusy: Bool {
        switch self {
        case .running, .editing, .tool: return true
        case .idle, .needsAttention, .finished: return false
        }
    }

    var label: String {
        switch self {
        case .running: return "running"
        case .editing: return "editing"
        case .tool: return "tool"
        case .idle: return "idle"
        case .needsAttention: return "needs you"
        case .finished: return "done"
        }
    }
}

/// One watched agent session, reconciled from provider events + liveness.
struct AgentSession: Identifiable, Equatable, Sendable {
    let id: String
    let kind: AgentKind
    var project: String
    var cwd: String?
    var status: AgentStatus
    var startedAt: Date
    var lastActivity: Date
    var pid: pid_t?
    var gitBranch: String?
    /// Most recent human-readable detail (notification text, last summary).
    var detail: String?
    /// Deep link to focus the exact hosting terminal tab (e.g. Warp's
    /// `warp://session/<uuid>`), captured from the agent process's environment.
    var terminalFocusURL: String?
    /// Most recent user prompt and assistant reply, for the expanded preview.
    var lastPrompt: String?
    var lastResponse: String?
    /// Terminal hosting the session (e.g. "Warp"), for the row badge.
    var terminalName: String?
    /// herdr pane hosting the session (e.g. "wX:p2") when it runs inside herdr,
    /// captured from the agent process's environment. Jumping needs it because
    /// the pane's owner is a detached daemon, not the window on screen.
    var herdrPaneID: String?
    /// Human verb for what it's doing now ("Reading", "Editing", "Running",
    /// "Thinking"), shown in the row instead of the bare status when present.
    var activityVerb: String?
    /// Parent session id when this is a sub-agent (Task), for grouping.
    var parentSessionID: String?
    /// Pending interactive permission request (Claude's PermissionRequest hook is
    /// blocked on our reply); non-nil enables the Approve/Deny row actions.
    var permissionRequestId: String?
}

/// Tools whose execution applies a file edit, so a session running one reads as
/// `.editing` rather than the generic `.tool`. Matched case-sensitively against
/// Claude's tool names; shared by the transcript parser and the status reducer so
/// the two can't drift.
let agentEditTools: Set<String> = ["Edit", "Write", "MultiEdit", "NotebookEdit"]

/// Human-readable verb for a tool name — the row's "what it's doing now".
func agentToolVerb(_ tool: String) -> String {
    switch tool.lowercased() {
    case "bash", "shell": return "Running"
    case "read", "notebookread", "cat", "view": return "Reading"
    case "edit", "write", "multiedit", "notebookedit", "apply_patch", "str_replace_editor", "update":
        return "Editing"
    case "grep", "glob", "search", "codebase_search", "ripgrep", "ls": return "Searching"
    case "webfetch", "websearch", "fetch", "browser": return "Browsing"
    case "task", "agent": return "Delegating"
    case "todowrite", "todoread": return "Planning"
    default:
        return tool.isEmpty ? "Working" : tool.prefix(1).uppercased() + tool.dropFirst()
    }
}

/// Trimmed, length-capped text for previews (shared by all providers).
func agentClip(_ string: String, max: Int = 240) -> String {
    let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.count <= max ? trimmed : String(trimmed.prefix(max)) + "…"
}

/// Display name for a working directory (its last path component).
func agentProjectName(_ cwd: String?) -> String {
    guard let cwd, !cwd.isEmpty else { return "—" }
    return (cwd as NSString).lastPathComponent
}

/// A normalized, notify-worthy transition a provider emits to `AgentManager`,
/// distinct from the raw wire payload. Carries the post-transition session.
struct AgentEvent: Sendable {
    enum Kind: Sendable {
        case started
        case needsAttention
        case finished
        case ended
    }

    let kind: Kind
    let session: AgentSession
    let message: String?
}

/// Line-delimited JSON exchanged over `~/.notch/agents.sock`. The hook/notify
/// clients (which never load the UI) build this; `AgentSocketServer` decodes it.
/// Fields are normalized by the client so the server stays agent-agnostic.
struct HookEnvelope: Codable, Sendable {
    var agent: String            // AgentKind.rawValue
    var hook: String             // event name ("Notification", "Stop", "agent-turn-complete", ...)
    var sessionId: String?
    var cwd: String?
    var transcriptPath: String?
    var message: String?
    /// Best-effort agent process id (client's getppid()), used as a liveness hint.
    var pid: Int32?

    // Normalized fields the event-driven clients (Codex hook, OpenCode plugin,
    // oh-my-pi extension) populate so one provider can interpret them uniformly.
    /// "started" | "busy" | "tool" | "editing" | "idle" | "finished" | "waiting" | "ended"
    var status: String?
    var tool: String?
    var prompt: String?
    var response: String?
    var model: String?
    var project: String?
    /// Parent session id when this is a sub-agent, for grouping.
    var parent: String?
    /// Correlates a blocking PermissionRequest hook with the app's decision reply.
    var requestId: String?
    /// Versioned, allowlisted detail for a permission request. Optional so hooks
    /// and app versions predating structured requests remain wire-compatible.
    var permission: AgentPermissionRequest? = nil

    // Account-wide usage (status == "usage"), captured from Claude's statusLine.
    var fiveHourUsed: Double?
    var sevenDayUsed: Double?
    var fiveHourResetsAt: Double?
    var sevenDayResetsAt: Double?
}

/// Account-wide Claude usage limits, from the statusLine `rate_limits` data.
struct AgentUsage: Equatable, Sendable {
    var fiveHourUsedPercent: Double
    var sevenDayUsedPercent: Double
    var fiveHourResetsAt: Date?
    var sevenDayResetsAt: Date?
}
