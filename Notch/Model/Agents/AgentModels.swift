import Foundation

/// Which coding agent a session belongs to. Drives provider selection, the
/// compact-pill label, and the per-agent enable rows in the Agents tab.
enum AgentKind: String, Codable, CaseIterable, Identifiable, Sendable {
    case claudeCode
    case codex
    case openCode
    case ohMyPi

    var id: String { rawValue }

    /// Lowercase tag used in the compact pill ("claude · editing").
    var shortName: String {
        switch self {
        case .claudeCode: return "claude"
        case .codex: return "codex"
        case .openCode: return "opencode"
        case .ohMyPi: return "omp"
        }
    }

    var displayName: String {
        switch self {
        case .claudeCode: return "Claude Code"
        case .codex: return "Codex"
        case .openCode: return "OpenCode"
        case .ohMyPi: return "oh-my-pi"
        }
    }

    /// SF Symbol for the agent glyph in list rows.
    var symbol: String {
        switch self {
        case .claudeCode: return "sparkles"
        case .codex: return "chevron.left.forwardslash.chevron.right"
        case .openCode: return "curlybraces"
        case .ohMyPi: return "fossil.shell.fill"
        }
    }
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

    var symbol: String {
        switch self {
        case .running: return "ellipsis"
        case .editing: return "pencil"
        case .tool: return "wrench.and.screwdriver"
        case .idle: return "pause.circle"
        case .needsAttention: return "exclamationmark.circle.fill"
        case .finished: return "checkmark.circle.fill"
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
    /// Human verb for what it's doing now ("Reading", "Editing", "Running",
    /// "Thinking"), shown in the row instead of the bare status when present.
    var activityVerb: String?
    /// Parent session id when this is a sub-agent (Task), for grouping.
    var parentSessionID: String?
}

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

/// A normalized, notify-worthy transition a provider emits to `AgentManager`,
/// distinct from the raw wire payload. Carries the post-transition session.
struct AgentEvent: Sendable {
    enum Kind: Sendable {
        case started
        case statusChanged
        case needsAttention
        case finished
        case ended
    }

    let kind: Kind
    let session: AgentSession
    let message: String?
}

/// What a provider can observe, so the UI can be honest about each agent's
/// limits (e.g. Codex exposes finish + liveness only, no attention signal).
struct AgentProviderCapabilities: OptionSet, Sendable {
    let rawValue: Int

    /// Push live activity (status changes mid-turn), not just terminal events.
    static let liveEvents = AgentProviderCapabilities(rawValue: 1 << 0)
    /// Surface a "needs you" / permission-prompt signal.
    static let attention = AgentProviderCapabilities(rawValue: 1 << 1)
    /// Answer permission prompts / questions remotely (future phase).
    static let respondToPermissions = AgentProviderCapabilities(rawValue: 1 << 2)
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
}
