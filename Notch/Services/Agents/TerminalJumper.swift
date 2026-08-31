import AppKit
import Foundation

/// Brings the terminal hosting an agent to the front. Walks the agent's parent
/// chain to the first GUI application and activates it; if the agent runs inside
/// tmux, also selects its pane first (best-effort). Terminal-app raise is limited
/// for tmux since the agent's parent is the detached server, not the client.
///
/// Technique reference: devmegablaster/Notch-Pilot (MIT).
@MainActor
struct TerminalJumper {

    let processLookup: ProcessLookup

    nonisolated private static let tmuxCandidates = [
        "/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"
    ]

    func jump(toPID pid: pid_t?, cwd: String?, focusURL: String? = nil, herdrPaneID: String? = nil) {
        // Precise path: the tab exports a focus deep link (e.g. Warp's
        // warp://session/<uuid>); opening it selects the exact tab. The terminal
        // gets activated as a side effect of handling the URL. A known herdr pane
        // outranks it: panes inherit the client's Warp env at creation, so the
        // URL may point at a long-gone tab while the pane is authoritative.
        if herdrPaneID == nil, let focusURL, let url = URL(string: focusURL),
           url.scheme?.lowercased() == "warp" {
            NSWorkspace.shared.open(url)
            return
        }

        let lookup = processLookup
        Task {
            let resolvedPID = await Task.detached {
                Self.resolvePID(pid, cwd: cwd, lookup: lookup)
            }.value

            // herdr hands its panes to a detached server, so a hosted agent's own
            // ancestry stops at the daemon and never reaches a window. Move herdr's
            // focus to the pane, then aim the terminal focus at the client drawing it.
            let herdrPane = herdrPaneID ?? resolvedPID.flatMap {
                HerdrBridge.paneID(ofAgent: $0, lookup: lookup)
            }
            if let herdrPane {
                let client = await Task.detached { () -> pid_t? in
                    HerdrBridge.focus(pane: herdrPane)
                    guard let client = HerdrBridge.clientPIDs(lookup: lookup)
                        .first(where: { Self.guiAncestor(of: $0, lookup: lookup) != nil })
                    else { return nil }
                    _ = Self.focusPrecise(pid: client, lookup: lookup)
                    return client
                }.value
                guard let client else {
                    Log.agents.notice(
                        "terminal jump: no attached herdr client for pane \(herdrPane, privacy: .public)"
                    )
                    return
                }
                Self.activateTerminal(forPID: client, lookup: lookup)
                return
            }

            guard let pid = resolvedPID else {
                Log.agents.notice("terminal jump: no pid or trusted focus URL for session")
                return
            }
            // Try a terminal-specific precise focus (selects the exact tab/pane).
            let handled = await Task.detached { Self.focusPrecise(pid: pid, lookup: lookup) }.value
            if !handled {
                await Task.detached { Self.selectTmuxPane(forAgent: pid, lookup: lookup) }.value
            }
            // Always raise the hosting GUI app (iTerm/Terminal AppleScript already
            // does, but this covers wezterm/kitty/tmux and the plain fallback).
            Self.activateTerminal(forPID: pid, lookup: lookup)
        }
    }

    /// Select the exact tab/pane using whatever control surface the hosting
    /// terminal exposes, keyed on the agent process's environment + controlling
    /// tty. Returns false for terminals we can only raise at the app level
    /// (VS Code) so the caller falls back. Reads/commands run off-main.
    nonisolated private static func focusPrecise(pid: pid_t, lookup: ProcessLookup) -> Bool {
        let env = lookup.environment(of: pid)
        let term = env["TERM_PROGRAM"]
        let tty = lookup.controllingTTY(of: pid)

        // iTerm2 — also covers tmux -CC (panes are real iTerm2 sessions).
        if term == "iTerm.app", let tty { return focusByTTY(app: "iTerm2", tty: tty) }
        if let pane = env["WEZTERM_PANE"] { return focusWezTerm(pane: pane) }
        if let windowID = env["KITTY_WINDOW_ID"] { return focusKitty(windowID: windowID, listenOn: env["KITTY_LISTEN_ON"]) }
        if term == "Apple_Terminal", let tty { return focusAppleTerminal(tty: tty) }
        if term == "ghostty" { return focusGhostty(agentPID: pid, lookup: lookup) }
        return false
    }

    nonisolated private static func focusByTTY(app: String, tty: String) -> Bool {
        let script = """
        tell application "\(app)"
          repeat with w in windows
            repeat with t in tabs of w
              repeat with s in sessions of t
                if tty of s is "\(tty)" then
                  select w
                  tell t to select
                  tell s to select
                  activate
                  return "ok"
                end if
              end repeat
            end repeat
          end repeat
        end tell
        return "no"
        """
        return run("/usr/bin/osascript", ["-e", script])?.contains("ok") == true
    }

    nonisolated private static func focusAppleTerminal(tty: String) -> Bool {
        let script = """
        tell application "Terminal"
          repeat with w in windows
            repeat with t in tabs of w
              if tty of t is "\(tty)" then
                set selected tab of w to t
                set frontmost of w to true
                set index of w to 1
                activate
                return "ok"
              end if
            end repeat
          end repeat
        end tell
        return "no"
        """
        return run("/usr/bin/osascript", ["-e", script])?.contains("ok") == true
    }

    nonisolated private static func focusWezTerm(pane: String) -> Bool {
        guard let wezterm = binary("wezterm") else { return false }
        _ = run(wezterm, ["cli", "activate-pane", "--pane-id", pane])
        _ = run(wezterm, ["cli", "activate-tab", "--pane-id", pane])
        return true
    }

    nonisolated private static func focusKitty(windowID: String, listenOn: String?) -> Bool {
        guard let kitten = binary("kitten") else { return false }
        var args = ["@"]
        if let listenOn { args += ["--to", listenOn] }
        args += ["focus-window", "--match", "id:\(windowID)"]
        return run(kitten, args) != nil
    }

    /// Ghostty 1.3+ ships an AppleScript dictionary: each terminal surface
    /// exposes its shell-integration working directory and a `focus` command
    /// that selects the surface and raises its window. Ghostty stamps no
    /// per-surface ID into child environments, so the agent's cwd is the
    /// matching key; the first surface in that directory wins.
    nonisolated private static func focusGhostty(agentPID: pid_t, lookup: ProcessLookup) -> Bool {
        guard let cwd = lookup.cwd(of: agentPID) else { return false }
        // libproc reports the directory's real name while Ghostty echoes whatever
        // the shell was cd'd to, which on a case-insensitive volume need not match
        // ("/Users/x/Brain" vs "/Users/x/brain"). Fold case so they compare equal.
        let target = lookup.normalize(cwd).lowercased()

        // `tab` must be hoisted: Ghostty's sdef defines a `tab` class that
        // shadows AppleScript's tab-character constant inside the tell block.
        let listScript = """
        set d to tab
        tell application "Ghostty"
          set out to ""
          repeat with t in terminals
            set wd to working directory of t
            if wd is missing value then set wd to ""
            set out to out & (id of t) & d & wd & linefeed
          end repeat
          return out
        end tell
        """
        guard let listing = run("/usr/bin/osascript", ["-e", listScript]) else { return false }

        let surfaceID = listing.split(separator: "\n").lazy
            .compactMap { line -> String? in
                let parts = line.split(separator: "\t", maxSplits: 1)
                guard parts.count == 2,
                      normalizedGhosttyPath(String(parts[1]), lookup: lookup).lowercased() == target
                else { return nil }
                return String(parts[0])
            }
            .first
        guard let surfaceID else { return false }

        let escaped = surfaceID
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
        let focusScript = """
        tell application "Ghostty"
          repeat with t in terminals
            if id of t is "\(escaped)" then
              focus t
              return "ok"
            end if
          end repeat
        end tell
        return "no"
        """
        return run("/usr/bin/osascript", ["-e", focusScript])?.contains("ok") == true
    }

    /// Ghostty reports the shell's cwd, occasionally as a file URL.
    nonisolated private static func normalizedGhosttyPath(_ raw: String, lookup: ProcessLookup) -> String {
        var path = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if let url = URL(string: path), url.isFileURL { path = url.path(percentEncoded: false) }
        if path.count > 1, path.hasSuffix("/") { path.removeLast() }
        return lookup.normalize(path)
    }

    nonisolated private static func binary(_ name: String) -> String? {
        ["/opt/homebrew/bin/\(name)", "/usr/local/bin/\(name)", "/usr/bin/\(name)"]
            .first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    /// Use the known pid, else find any live process in the session's cwd (its
    /// ancestor chain still leads to the hosting terminal).
    nonisolated private static func resolvePID(
        _ pid: pid_t?,
        cwd: String?,
        lookup: ProcessLookup
    ) -> pid_t? {
        if let pid, lookup.name(of: pid) != nil { return pid }
        guard let cwd else { return nil }
        let target = lookup.normalize(cwd)
        return lookup.allPIDs().first { lookup.cwd(of: $0) == target }
    }

    private static func activateTerminal(forPID pid: pid_t, lookup: ProcessLookup) {
        guard let app = guiAncestor(of: pid, lookup: lookup) else {
            Log.agents.notice("terminal jump: no GUI ancestor for pid \(pid)")
            return
        }
        app.activate()
    }

    /// Nearest ancestor that is a regular, Dock-visible app: the window hosting a
    /// terminal process. Also how a live herdr client is told from a stale one,
    /// whose chain dead-ends at launchd once its window is gone.
    nonisolated private static func guiAncestor(of pid: pid_t, lookup: ProcessLookup) -> NSRunningApplication? {
        var current: pid_t? = pid
        var depth = 0
        while let c = current, depth < 12 {
            if let app = NSRunningApplication(processIdentifier: c),
               app.bundleIdentifier != nil, app.activationPolicy == .regular {
                return app
            }
            current = lookup.ppid(of: c)
            depth += 1
        }
        return nil
    }

    nonisolated private static func selectTmuxPane(forAgent pid: pid_t, lookup: ProcessLookup) {
        guard let tmux = tmuxCandidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) }),
              let listing = run(tmux, ["list-panes", "-a", "-F", "#{pane_pid} #{session_name}:#{window_index}.#{pane_index}"])
        else { return }

        for line in listing.split(separator: "\n") {
            let parts = line.split(separator: " ", maxSplits: 1)
            guard parts.count == 2, let panePID = pid_t(parts[0]) else { continue }
            let target = String(parts[1])
            if lookup.firstAncestor(of: pid, where: { $0 == panePID }) != nil {
                _ = run(tmux, ["select-window", "-t", target])
                _ = run(tmux, ["select-pane", "-t", target])
                return
            }
        }
    }

    @discardableResult
    nonisolated private static func run(_ path: String, _ arguments: [String]) -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: path)
        process.arguments = arguments
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            return String(data: data, encoding: .utf8)
        } catch {
            return nil
        }
    }
}
