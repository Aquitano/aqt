import Foundation
import NotchCore

/// Turns the session bindings hooks gave us into the current picture: drops the
/// ones whose process is gone, reads each survivor's own transcript, and fills
/// in the terminal details the first time it sees a session.
///
/// Its predecessor enumerated every process on the machine, matched the `claude`
/// ones to a working directory, and then guessed which of that directory's
/// transcripts belonged to which process by file mtime. Every guess was a bug
/// waiting to happen: a live process adopting a dead session's transcript, two
/// agents in one directory swapping identities, a backup tool touching a file
/// and making a week-old session look like the freshest one there. Hooks carry
/// the session id, the pid and the transcript path, so none of that is needed —
/// a session is exactly what a hook said it was, for as long as its process lives.
struct SessionProbe: Sendable {

    let lookup: ProcessLookup

    nonisolated static let projectsRoot = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".claude/projects", isDirectory: true)

    struct Result: Sendable {
        let sessions: [ScannedSession]
        /// The bindings as they now stand: dead ones dropped, terminal details
        /// filled in on first sight. The caller adopts and persists these.
        let bindings: [AgentSessionBinding]
    }

    func probe(_ bindings: [AgentSessionBinding]) -> Result {
        var live: [AgentSessionBinding] = []
        var sessions: [ScannedSession] = []

        for binding in bindings where isLive(binding) {
            let resolved = resolveTerminal(binding)
            live.append(resolved)
            sessions.append(session(for: resolved))
        }
        return Result(sessions: sessions, bindings: live)
    }

    /// Whether the bound process is still the one we bound to. Comparing start
    /// times as well as the pid is what stops a recycled number from
    /// resurrecting a session that ended hours ago.
    func isLive(_ binding: AgentSessionBinding) -> Bool {
        guard let startedAt = lookup.startDate(of: binding.pid) else { return false }
        return abs(startedAt.timeIntervalSince1970 - binding.startedAt) < 0.001
    }

    private func session(for binding: AgentSessionBinding) -> ScannedSession {
        let url = URL(fileURLWithPath: binding.transcriptPath)
        let state = TranscriptParser.parse(Self.readTail(url, maxBytes: 65536) ?? Data())
        return ScannedSession(
            sessionId: binding.sessionId, cwd: binding.cwd, pid: binding.pid,
            lastActivity: state.lastEntryAt ?? Self.mtime(url),
            gitBranch: state.branch, busyStatus: state.busy,
            focusURL: binding.focusURL, terminalName: binding.terminalName,
            herdrPaneID: binding.herdrPaneID, t3Thread: binding.t3Thread,
            terminalBundleID: binding.terminalBundleID,
            isDetached: !TerminalAttachment.isAttached(
                pid: binding.pid, herdrPane: binding.herdrPaneID, lookup: lookup
            ),
            prompt: state.prompt, response: state.response, verb: state.verb
        )
    }

    // MARK: - Terminal details (resolved once per session)

    private func resolveTerminal(_ binding: AgentSessionBinding) -> AgentSessionBinding {
        guard !binding.terminalResolved else { return binding }
        var resolved = binding
        resolved.terminalResolved = true

        let env = lookup.environment(of: binding.pid)
        resolved.focusURL = Self.focusURL(env)
        resolved.t3Thread = T3ThreadRef(processEnvironment: env)
        if let pane = env[HerdrBridge.paneIDKey] {
            // A herdr pane inherits its client's TERM_PROGRAM, so the raw value
            // names whichever window herdr is attached to rather than what hosts
            // the session. Name the workspace instead — that is what a jump
            // lands on — and take the bundle from the client drawing it, since
            // the pane's own ancestry ends at herdr's detached server.
            resolved.herdrPaneID = pane
            resolved.terminalName = Self.herdrTerminalName(workspace: env[HerdrBridge.workspaceIDKey])
            resolved.terminalBundleID = herdrClientBundleID()
        } else {
            resolved.terminalName = Self.terminalName(env["TERM_PROGRAM"])
            resolved.terminalBundleID = TerminalAttachment
                .guiAncestor(of: binding.pid, lookup: lookup)?.bundleIdentifier
        }
        return resolved
    }

    private func herdrClientBundleID() -> String? {
        HerdrBridge.clientPIDs(lookup: lookup)
            .lazy
            .compactMap { TerminalAttachment.guiAncestor(of: $0, lookup: lookup)?.bundleIdentifier }
            .first
    }

    /// Warp exports a per-tab focus deep link; it's the one terminal that hands
    /// out an addressable handle through the environment.
    private static func focusURL(_ env: [String: String]) -> String? {
        if let url = env["WARP_FOCUS_URL"], !url.isEmpty { return url }
        if let uuid = env["WARP_TERMINAL_SESSION_UUID"], !uuid.isEmpty { return "warp://session/\(uuid)" }
        return nil
    }

    /// The row badge is `fixedSize`, so an unbounded workspace label would
    /// squeeze the session title out of the row.
    private static let herdrLabelLimit = 18

    private static func herdrTerminalName(workspace: String?) -> String {
        guard let workspace, let label = HerdrBridge.workspaceLabels()[workspace] else { return "Herdr" }
        guard label.count > herdrLabelLimit else { return "Herdr · \(label)" }
        return "Herdr · \(label.prefix(herdrLabelLimit - 1))…"
    }

    private static func terminalName(_ termProgram: String?) -> String? {
        switch termProgram {
        case "WarpTerminal": return "Warp"
        case "iTerm.app": return "iTerm"
        case "Apple_Terminal": return "Terminal"
        case "vscode": return "VS Code"
        case "ghostty", "xterm-ghostty": return "Ghostty"
        case "WezTerm": return "WezTerm"
        case "Hyper": return "Hyper"
        case let other?: return other.isEmpty ? nil : other
        case nil: return nil
        }
    }

    // MARK: - Transcript tail

    private static func readTail(_ url: URL, maxBytes: Int) -> Data? {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? handle.close() }
        let size = (try? handle.seekToEnd()) ?? 0
        let start = size > UInt64(maxBytes) ? size - UInt64(maxBytes) : 0
        try? handle.seek(toOffset: start)
        guard var data = try? handle.readToEnd() else { return nil }
        // Drop the leading partial line when we seeked into the middle of one.
        if start > 0, let newline = data.firstIndex(of: 0x0A) {
            data = data.subdata(in: data.index(after: newline)..<data.endIndex)
        }
        return data
    }

    private static func mtime(_ url: URL) -> Date {
        (try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
    }
}
