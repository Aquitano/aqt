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
        var result: [ScannedSession] = []
        var seenCwd = Set<String>()
        for pid in lookup.allPIDs() where Self.isClaudeProcess(pid, lookup: lookup) {
            guard let cwd = lookup.cwd(of: pid), !seenCwd.contains(cwd) else { continue }
            seenCwd.insert(cwd)
            guard let transcript = Self.newestTranscript(forCwd: cwd) else { continue }
            let terminal = Self.terminalInfo(forPID: pid, lookup: lookup)
            result.append(ScannedSession(
                sessionId: transcript.sessionId, cwd: cwd, pid: pid,
                lastActivity: transcript.mtime, gitBranch: transcript.state.branch,
                busyStatus: transcript.state.busy,
                focusURL: terminal.focusURL, terminalName: terminal.name,
                prompt: transcript.state.prompt, response: transcript.state.response,
                verb: transcript.state.verb
            ))
        }
        return result
    }

    // Known limitation: two `claude` processes in the SAME directory collapse to
    // one scanned session (the newest transcript), since cwd is the only link
    // between a pid and a session without inspecting each process's open files.
    // Distinct hook sessions still surface separately via the provider's hook state.
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
    private static func terminalInfo(forPID pid: pid_t, lookup: ProcessLookup) -> (focusURL: String?, name: String?) {
        let env = lookup.environment(of: pid)
        var focusURL: String?
        if let url = env["WARP_FOCUS_URL"], !url.isEmpty {
            focusURL = url
        } else if let uuid = env["WARP_TERMINAL_SESSION_UUID"], !uuid.isEmpty {
            focusURL = "warp://session/\(uuid)"
        }
        return (focusURL, terminalName(env["TERM_PROGRAM"]))
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

    private static func newestTranscript(
        forCwd cwd: String
    ) -> (sessionId: String, mtime: Date, state: TranscriptState)? {
        let dir = projectsRoot.appendingPathComponent(encodeProjectDir(cwd), isDirectory: true)
        guard let entries = try? FileManager.default.contentsOfDirectory(
            at: dir, includingPropertiesForKeys: [.contentModificationDateKey], options: [.skipsHiddenFiles]
        ) else { return nil }
        let jsonls = entries.filter { $0.pathExtension == "jsonl" }
        guard let newest = jsonls.max(by: { mtime($0) < mtime($1) }) else { return nil }
        let state = TranscriptParser.parse(readTail(newest, maxBytes: 65536) ?? Data())
        return (newest.deletingPathExtension().lastPathComponent, mtime(newest), state)
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
