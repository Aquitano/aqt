import AppKit
import NotchCore

/// Whether an agent's terminal is still on screen. A session whose window died —
/// the tab closed, or the terminal app restarted under it — keeps running on an
/// orphaned pty: the process is alive, so the scan still finds it, but nothing
/// draws it. Jumping to one has nowhere to land, and the cwd-matched precise
/// focus happily selects an unrelated tab that happens to share the directory.
///
/// Shared by the scanner (which marks such a session detached) and the jumper
/// (which needs the same walk to pick the app to raise), so the two can't
/// disagree about what is reachable.
enum TerminalAttachment {

    /// Multiplexer-hosted panes are attached whatever their ancestry: a detached
    /// server owns them, so a client can draw them again at any time. Everything
    /// else has to still reach a Dock-visible app.
    static func isAttached(pid: pid_t, herdrPane: String?, lookup: ProcessLookup) -> Bool {
        if herdrPane != nil { return true }
        if lookup.firstAncestor(of: pid, where: { isMultiplexerServer($0, lookup: lookup) }) != nil {
            return true
        }
        return guiAncestor(of: pid, lookup: lookup) != nil
    }

    /// Nearest ancestor that is a regular, Dock-visible app: the window hosting a
    /// terminal process. Also how a live herdr client is told from a stale one,
    /// whose chain dead-ends at launchd once its window is gone.
    static func guiAncestor(of pid: pid_t, lookup: ProcessLookup) -> NSRunningApplication? {
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

    private static let multiplexers: Set<String> = ["tmux", "herdr", "screen", "zellij"]

    private static func isMultiplexerServer(_ pid: pid_t, lookup: ProcessLookup) -> Bool {
        guard let path = lookup.path(of: pid) else { return false }
        return multiplexers.contains((path as NSString).lastPathComponent)
    }
}
