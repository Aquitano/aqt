import Foundation

/// libproc adapter for Claude liveness: enumerates live `claude` processes, maps
/// each to the newest transcript in its cwd, and reads terminal locators from the
/// process environment. Stateless and `Sendable`, so a reconcile can run it off
/// the main actor. JSON interpretation is delegated to `TranscriptParser`.
struct ProcessScanner: Sendable {

    let lookup: ProcessLookup

    nonisolated static let projectsRoot = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".claude/projects", isDirectory: true)

    func scan() -> [ScannedSession] {
        let processes = lookup.allPIDs().compactMap { pid -> LiveProcess? in
            guard Self.isClaudeProcess(pid, lookup: lookup),
                  let cwd = lookup.cwd(of: pid) else { return nil }
            let terminal = Self.terminalInfo(forPID: pid, lookup: lookup)
            let openTranscript = Self.openTranscript(forPID: pid, cwd: cwd, lookup: lookup)
            return LiveProcess(
                pid: pid, cwd: cwd, startedAt: lookup.startDate(of: pid),
                terminal: terminal, openTranscript: openTranscript
            )
        }

        var assignments: [(LiveProcess, Transcript)] = []
        var claimed = Set<String>()

        // Open-file evidence is authoritative. Claim those sessions first so a
        // fallback process cannot take another process's newest transcript.
        for process in processes {
            guard let transcript = process.openTranscript else { continue }
            assignments.append((process, transcript))
            claimed.insert(transcript.sessionId)
        }
        for process in processes where process.openTranscript == nil {
            guard let transcript = Self.transcripts(forCwd: process.cwd)
                .first(where: { transcript in
                    !claimed.contains(transcript.sessionId)
                        && (process.startedAt.map {
                            transcript.mtime >= $0.addingTimeInterval(-5)
                        } ?? true)
                }) else { continue }
            assignments.append((process, transcript))
            claimed.insert(transcript.sessionId)
        }

        return assignments.map { process, transcript in
            return ScannedSession(
                sessionId: transcript.sessionId, cwd: process.cwd, pid: process.pid,
                lastActivity: transcript.mtime, gitBranch: transcript.state.branch,
                busyStatus: transcript.state.busy,
                focusURL: process.terminal.focusURL, terminalName: process.terminal.name,
                herdrPaneID: process.terminal.herdrPane,
                prompt: transcript.state.prompt, response: transcript.state.response,
                verb: transcript.state.verb
            )
        }
    }

    private struct LiveProcess {
        let pid: pid_t
        let cwd: String
        let startedAt: Date?
        let terminal: (focusURL: String?, name: String?, herdrPane: String?)
        let openTranscript: Transcript?
    }

    private struct Transcript {
        let sessionId: String
        let mtime: Date
        let state: TranscriptState
    }

    /// The `claude` CLI's executable is the versioned binary
    /// (`…/claude/versions/X.Y.Z`), so `proc_name` is the version string, not
    /// "claude" — matching by name finds nothing. Match by executable path, and
    /// fall back to argv for a runtime-hosted CLI (`node …/claude-code/…`).
    private static func isClaudeProcess(_ pid: pid_t, lookup: ProcessLookup) -> Bool {
        guard let path = lookup.path(of: pid) else { return false }
        let lower = path.lowercased()
        if lower.contains("/claude/") || lower.contains("/claude-code") { return true }
        let base = (path as NSString).lastPathComponent
        if base == "claude" { return true }
        if base == "node" || base == "bun" || base == "deno" {
            return lookup.arguments(of: pid).contains { $0.lowercased().contains("claude") }
        }
        return false
    }

    /// Terminal locator + display name, read from the agent process's environment.
    /// Warp exports `WARP_FOCUS_URL` (warp://session/<uuid>) per tab.
    private static func terminalInfo(
        forPID pid: pid_t,
        lookup: ProcessLookup
    ) -> (focusURL: String?, name: String?, herdrPane: String?) {
        let env = lookup.environment(of: pid)
        var focusURL: String?
        if let url = env["WARP_FOCUS_URL"], !url.isEmpty {
            focusURL = url
        } else if let uuid = env["WARP_TERMINAL_SESSION_UUID"], !uuid.isEmpty {
            focusURL = "warp://session/\(uuid)"
        }
        // A herdr pane inherits its client's TERM_PROGRAM, so the raw value names
        // the window herdr happens to be attached to rather than what hosts the
        // session. Name the workspace instead — that is what a jump lands on.
        guard let pane = env[HerdrBridge.paneIDKey] else {
            return (focusURL, terminalName(env["TERM_PROGRAM"]), nil)
        }
        return (focusURL, herdrTerminalName(workspace: env[HerdrBridge.workspaceIDKey]), pane)
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

    /// Allowed characters in Claude Code's project-directory encoding: `[a-zA-Z0-9]`.
    private static let projectDirAllowed = Set(
        "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
    )

    /// Claude Code names each project's transcript directory by replacing every
    /// non-alphanumeric character of the cwd with "-" (so "/", ".", and spaces all
    /// become "-"). Handling only "/" and "." missed any path containing a space:
    /// the scan found no transcript, the session survived only as a hook-only entry,
    /// then flapped in and out of the UI on the 30s grace window.
    private static func encodeProjectDir(_ cwd: String) -> String {
        String(cwd.map { projectDirAllowed.contains($0) ? $0 : "-" })
    }

    private static func transcripts(forCwd cwd: String) -> [Transcript] {
        let dir = projectsRoot.appendingPathComponent(encodeProjectDir(cwd), isDirectory: true)
        guard let entries = try? FileManager.default.contentsOfDirectory(
            at: dir, includingPropertiesForKeys: [.contentModificationDateKey], options: [.skipsHiddenFiles]
        ) else { return [] }
        return entries
            .filter { $0.pathExtension == "jsonl" }
            .sorted { mtime($0) > mtime($1) }
            .map { url in
                Transcript(
                    sessionId: url.deletingPathExtension().lastPathComponent,
                    mtime: mtime(url),
                    state: TranscriptParser.parse(readTail(url, maxBytes: 65536) ?? Data())
                )
            }
    }

    private static func openTranscript(
        forPID pid: pid_t,
        cwd: String,
        lookup: ProcessLookup
    ) -> Transcript? {
        let projectDir = projectsRoot.appendingPathComponent(encodeProjectDir(cwd), isDirectory: true).path
        let candidates = lookup.openFilePaths(of: pid).filter {
            $0.hasPrefix(projectDir + "/") && URL(fileURLWithPath: $0).pathExtension == "jsonl"
        }
        guard let active = candidates.max(by: { mtime(URL(fileURLWithPath: $0)) < mtime(URL(fileURLWithPath: $1)) }) else {
            return nil
        }
        let url = URL(fileURLWithPath: active)
        return Transcript(
            sessionId: url.deletingPathExtension().lastPathComponent,
            mtime: mtime(url),
            state: TranscriptParser.parse(readTail(url, maxBytes: 65536) ?? Data())
        )
    }

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
