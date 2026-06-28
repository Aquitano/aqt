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

    func jump(toPID pid: pid_t?, cwd: String?, focusURL: String? = nil) {
        // Precise path: the tab exports a focus deep link (e.g. Warp's
        // warp://session/<uuid>); opening it selects the exact tab. The terminal
        // gets activated as a side effect of handling the URL.
        if let focusURL, let url = URL(string: focusURL) {
            NSWorkspace.shared.open(url)
            return
        }

        guard let pid = resolvePID(pid, cwd: cwd) else {
            Log.agents.notice("terminal jump: no pid or focus URL for session")
            return
        }
        let lookup = processLookup
        Task {
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
    /// (Ghostty, VS Code) so the caller falls back. Reads/commands run off-main.
    nonisolated private static func focusPrecise(pid: pid_t, lookup: ProcessLookup) -> Bool {
        let env = lookup.environment(of: pid)
        let term = env["TERM_PROGRAM"]
        let tty = lookup.controllingTTY(of: pid)

        // iTerm2 — also covers tmux -CC (panes are real iTerm2 sessions).
        if term == "iTerm.app", let tty { return focusByTTY(app: "iTerm2", tty: tty) }
        if let pane = env["WEZTERM_PANE"] { return focusWezTerm(pane: pane) }
        if let windowID = env["KITTY_WINDOW_ID"] { return focusKitty(windowID: windowID, listenOn: env["KITTY_LISTEN_ON"]) }
        if term == "Apple_Terminal", let tty { return focusAppleTerminal(tty: tty) }
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

    nonisolated private static func binary(_ name: String) -> String? {
        ["/opt/homebrew/bin/\(name)", "/usr/local/bin/\(name)", "/usr/bin/\(name)"]
            .first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    /// Use the known pid, else find any live process in the session's cwd (its
    /// ancestor chain still leads to the hosting terminal).
    private func resolvePID(_ pid: pid_t?, cwd: String?) -> pid_t? {
        if let pid, processLookup.name(of: pid) != nil { return pid }
        guard let cwd else { return nil }
        let target = processLookup.normalize(cwd)
        return processLookup.allPIDs().first { processLookup.cwd(of: $0) == target }
    }

    private static func activateTerminal(forPID pid: pid_t, lookup: ProcessLookup) {
        var current: pid_t? = pid
        var depth = 0
        while let c = current, depth < 12 {
            if let app = NSRunningApplication(processIdentifier: c),
               app.bundleIdentifier != nil, app.activationPolicy == .regular {
                app.activate()
                return
            }
            current = lookup.ppid(of: c)
            depth += 1
        }
        Log.agents.notice("terminal jump: no GUI ancestor for pid \(pid)")
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
