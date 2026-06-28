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

    func jump(toPID pid: pid_t?, cwd: String?) {
        guard let pid = resolvePID(pid, cwd: cwd) else {
            Log.agents.notice("terminal jump: no pid for session")
            return
        }
        let lookup = processLookup
        Task {
            await Task.detached { Self.selectTmuxPane(forAgent: pid, lookup: lookup) }.value
            Self.activateTerminal(forPID: pid, lookup: lookup)
        }
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
