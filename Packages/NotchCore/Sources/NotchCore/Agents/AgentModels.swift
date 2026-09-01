import Foundation

/// Which coding agent a session belongs to. Drives provider selection, the
/// compact-pill label, and the per-agent enable rows in the Agents tab.
package enum AgentKind: String, Codable, CaseIterable, Identifiable, Sendable {
    case claudeCode
    case codex
    case openCode
    case ohMyPi
    case t3code

    package var id: String { rawValue }

    /// Lowercase tag used in the compact pill ("claude · editing").
    package var shortName: String {
        switch self {
        case .claudeCode: return "claude"
        case .codex: return "codex"
        case .openCode: return "opencode"
        case .ohMyPi: return "omp"
        case .t3code: return "t3"
        }
    }

    package var displayName: String {
        switch self {
        case .claudeCode: return "Claude Code"
        case .codex: return "Codex"
        case .openCode: return "OpenCode"
        case .ohMyPi: return "oh-my-pi"
        case .t3code: return "T3 Code"
        }
    }

    /// Semantic icon key resolved by the app-wide pixel glyph renderer.
    package var symbol: String {
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
package enum AgentFeatures {
    package static let permissionApproval = false
}

/// Lifecycle/activity state of one agent session. The first three are "busy"
/// states; `idle` is alive-but-waiting; `needsAttention` and `finished` are the
/// two notify-worthy transitions.
package enum AgentStatus: String, Codable, Sendable {
    case running         // generating / thinking
    case editing         // applying a file edit (Edit/Write/MultiEdit)
    case tool            // running a non-edit tool (Bash, etc.)
    case idle            // alive, waiting for the next prompt
    case needsAttention  // permission prompt / waiting on the user
    case finished        // turn just completed (transient, then idle)

    /// A busy state actively does work; the pill shows these with motion priority.
    package var isBusy: Bool {
        switch self {
        case .running, .editing, .tool: return true
        case .idle, .needsAttention, .finished: return false
        }
    }

    package var label: String {
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

/// One thread on a paired t3 server, as the T3 Code desktop app addresses it.
/// Carried by the rows `T3CodeProvider` publishes and by hook-announced sessions
/// running inside T3 Code's embedded terminal: neither has a terminal tab a jump
/// could select, so both land on the app through `deepLink`.
package struct T3ThreadRef: Codable, Equatable, Sendable {
    package let environmentID: String
    package let threadID: String

    /// Injected by T3 Code's embedded terminal into every process it hosts.
    package static let environmentIDKey = "T3CODE_ENVIRONMENT_ID"
    package static let threadIDKey = "T3CODE_THREAD_ID"

    package init(environmentID: String, threadID: String) {
        self.environmentID = environmentID
        self.threadID = threadID
    }

    package init?(processEnvironment env: [String: String]) {
        guard let environmentID = env[Self.environmentIDKey], !environmentID.isEmpty,
              let threadID = env[Self.threadIDKey], !threadID.isEmpty else { return nil }
        self.init(environmentID: environmentID, threadID: threadID)
    }

    /// T3 Code 0.0.36 registers the t3code:// scheme but doesn't navigate on this
    /// URL yet — opening it only launches or raises the app (verified live). The
    /// path shape matches t3's own `buildAgentAwarenessDeepLink`, so focusing the
    /// exact thread should start working once they ship their handler.
    package var deepLink: URL? {
        guard let environment = environmentID.addingPercentEncoding(withAllowedCharacters: Self.pathSegment),
              let thread = threadID.addingPercentEncoding(withAllowedCharacters: Self.pathSegment) else {
            return nil
        }
        return URL(string: "t3code://threads/\(environment)/\(thread)")
    }

    private static let pathSegment = CharacterSet.alphanumerics
        .union(CharacterSet(charactersIn: "-._~"))
}

/// One watched agent session, reconciled from provider events + liveness.
package struct AgentSession: Identifiable, Equatable, Sendable {
    package let id: String
    package let kind: AgentKind
    package var project: String
    package var cwd: String?
    package var status: AgentStatus
    package var startedAt: Date
    package var lastActivity: Date
    package var pid: pid_t?
    package var gitBranch: String?
    /// Most recent human-readable detail (notification text, last summary).
    package var detail: String?
    /// Deep link to focus the exact hosting terminal tab (e.g. Warp's
    /// `warp://session/<uuid>`), captured from the agent process's environment.
    package var terminalFocusURL: String?
    /// Most recent user prompt and assistant reply, for the expanded preview.
    package var lastPrompt: String?
    package var lastResponse: String?
    /// Terminal hosting the session (e.g. "Warp"), for the row badge.
    package var terminalName: String?
    /// herdr pane hosting the session (e.g. "wX:p2") when it runs inside herdr,
    /// captured from the agent process's environment. Jumping needs it because
    /// the pane's owner is a detached daemon, not the window on screen.
    package var herdrPaneID: String?
    /// The T3 Code thread behind this session — a t3-provided row, or a session
    /// whose terminal is T3 Code's. Jumping opens its deep link.
    package var t3Thread: T3ThreadRef?
    /// Bundle id of the app drawing this session's terminal. Lets a notification
    /// stay quiet while that window is the one you're already looking at.
    package var terminalBundleID: String?
    /// The session outlived its window: still running, but on a pty nothing draws
    /// any more. The row stays (an orphan can still be burning tokens), the jump
    /// goes away, and quitting it is offered instead.
    package var isDetached: Bool = false
    /// Human verb for what it's doing now ("Reading", "Editing", "Running",
    /// "Thinking"), shown in the row instead of the bare status when present.
    package var activityVerb: String?
    /// Parent session id when this is a sub-agent (Task), for grouping.
    package var parentSessionID: String?
    /// Pending interactive permission request (Claude's PermissionRequest hook is
    /// blocked on our reply); non-nil enables the Approve/Deny row actions.
    package var permissionRequestId: String?

    package init(id: String, kind: AgentKind, project: String, cwd: String? = nil, status: AgentStatus, startedAt: Date, lastActivity: Date, pid: pid_t? = nil, gitBranch: String? = nil, detail: String? = nil, terminalFocusURL: String? = nil, lastPrompt: String? = nil, lastResponse: String? = nil, terminalName: String? = nil, herdrPaneID: String? = nil, t3Thread: T3ThreadRef? = nil, terminalBundleID: String? = nil, isDetached: Bool = false, activityVerb: String? = nil, parentSessionID: String? = nil, permissionRequestId: String? = nil) {
        self.id = id
        self.kind = kind
        self.project = project
        self.cwd = cwd
        self.status = status
        self.startedAt = startedAt
        self.lastActivity = lastActivity
        self.pid = pid
        self.gitBranch = gitBranch
        self.detail = detail
        self.terminalFocusURL = terminalFocusURL
        self.lastPrompt = lastPrompt
        self.lastResponse = lastResponse
        self.terminalName = terminalName
        self.herdrPaneID = herdrPaneID
        self.t3Thread = t3Thread
        self.terminalBundleID = terminalBundleID
        self.isDetached = isDetached
        self.activityVerb = activityVerb
        self.parentSessionID = parentSessionID
        self.permissionRequestId = permissionRequestId
    }
}

/// Tools whose execution applies a file edit, so a session running one reads as
/// `.editing` rather than the generic `.tool`. Matched case-sensitively against
/// Claude's tool names; shared by the transcript parser and the status reducer so
/// the two can't drift.
package let agentEditTools: Set<String> = ["Edit", "Write", "MultiEdit", "NotebookEdit"]

/// Human-readable verb for a tool name — the row's "what it's doing now".
package func agentToolVerb(_ tool: String) -> String {
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
package func agentClip(_ string: String, max: Int = 240) -> String {
    let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.count <= max ? trimmed : String(trimmed.prefix(max)) + "…"
}

/// Display name for a working directory (its last path component).
package func agentProjectName(_ cwd: String?) -> String {
    guard let cwd, !cwd.isEmpty else { return "—" }
    return (cwd as NSString).lastPathComponent
}

/// A normalized, notify-worthy transition a provider emits to `AgentManager`,
/// distinct from the raw wire payload. Carries the post-transition session.
package struct AgentEvent: Sendable {
    package enum Kind: Sendable {
        case started
        case needsAttention
        case finished
        case ended
    }

    package let kind: Kind
    package let session: AgentSession
    package let message: String?

    package init(kind: Kind, session: AgentSession, message: String? = nil) {
        self.kind = kind
        self.session = session
        self.message = message
    }
}

/// Line-delimited JSON exchanged over `~/.notch/agents.sock`. The hook/notify
/// clients (which never load the UI) build this; `AgentSocketServer` decodes it.
/// Fields are normalized by the client so the server stays agent-agnostic.
package struct HookEnvelope: Codable, Sendable {
    package var agent: String            // AgentKind.rawValue
    package var hook: String             // event name ("Notification", "Stop", "agent-turn-complete", ...)
    package var sessionId: String?
    package var cwd: String?
    package var transcriptPath: String?
    package var message: String?
    /// Best-effort agent process id (client's getppid()), used as a liveness hint.
    package var pid: Int32?

    // Normalized fields the event-driven clients (Codex hook, OpenCode plugin,
    // oh-my-pi extension) populate so one provider can interpret them uniformly.
    /// "started" | "busy" | "tool" | "editing" | "idle" | "finished" | "waiting" | "ended"
    package var status: String?
    package var tool: String?
    /// `notification_type` on Claude's Notification hook (`idle_prompt`,
    /// `permission_prompt`, `agent_needs_input`, …), which classifies the
    /// notification precisely instead of leaving us to read its message text.
    package var notificationType: String?
    package var prompt: String?
    package var response: String?
    package var model: String?
    package var project: String?
    /// Parent session id when this is a sub-agent, for grouping.
    package var parent: String?
    /// Correlates a blocking PermissionRequest hook with the app's decision reply.
    package var requestId: String?
    /// Versioned, allowlisted detail for a permission request. Optional so hooks
    /// and app versions predating structured requests remain wire-compatible.
    package var permission: AgentPermissionRequest? = nil

    // Account-wide usage (status == "usage"), captured from Claude's statusLine.
    package var fiveHourUsed: Double?
    package var sevenDayUsed: Double?
    package var fiveHourResetsAt: Double?
    package var sevenDayResetsAt: Double?

    package init(agent: String, hook: String, sessionId: String? = nil, cwd: String? = nil,
                 transcriptPath: String? = nil, message: String? = nil, pid: Int32? = nil,
                 status: String? = nil, tool: String? = nil, notificationType: String? = nil,
                 prompt: String? = nil, response: String? = nil, model: String? = nil,
                 project: String? = nil, parent: String? = nil, requestId: String? = nil,
                 permission: AgentPermissionRequest? = nil, fiveHourUsed: Double? = nil,
                 sevenDayUsed: Double? = nil, fiveHourResetsAt: Double? = nil,
                 sevenDayResetsAt: Double? = nil) {
        self.agent = agent
        self.hook = hook
        self.sessionId = sessionId
        self.cwd = cwd
        self.transcriptPath = transcriptPath
        self.message = message
        self.pid = pid
        self.status = status
        self.tool = tool
        self.notificationType = notificationType
        self.prompt = prompt
        self.response = response
        self.model = model
        self.project = project
        self.parent = parent
        self.requestId = requestId
        self.permission = permission
        self.fiveHourUsed = fiveHourUsed
        self.sevenDayUsed = sevenDayUsed
        self.fiveHourResetsAt = fiveHourResetsAt
        self.sevenDayResetsAt = sevenDayResetsAt
    }
}

/// Account-wide Claude usage limits, from the statusLine `rate_limits` data.
package struct AgentUsage: Equatable, Sendable {
    package var fiveHourUsedPercent: Double
    package var sevenDayUsedPercent: Double
    package var fiveHourResetsAt: Date?
    package var sevenDayResetsAt: Date?

    package init(fiveHourUsedPercent: Double, sevenDayUsedPercent: Double, fiveHourResetsAt: Date? = nil, sevenDayResetsAt: Date? = nil) {
        self.fiveHourUsedPercent = fiveHourUsedPercent
        self.sevenDayUsedPercent = sevenDayUsedPercent
        self.fiveHourResetsAt = fiveHourResetsAt
        self.sevenDayResetsAt = sevenDayResetsAt
    }
}
