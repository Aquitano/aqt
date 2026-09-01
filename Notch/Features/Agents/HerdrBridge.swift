import Foundation
import NotchCore

/// Adapter for herdr (https://herdr.dev), a terminal multiplexer that hosts
/// coding agents in panes owned by a detached background server. That server
/// breaks the usual jump-to-terminal walk — a hosted agent's process ancestry
/// ends at the daemon, never at a window — so reaching a session takes two
/// moves: tell herdr which pane to focus, then raise the client that renders it.
///
/// Everything here shells out to the `herdr` CLI, which answers with JSON on
/// stdout, and degrades to nil/false/empty when herdr is absent or not running.
enum HerdrBridge {

    /// Injected into every managed pane, so their presence marks a hosted agent.
    /// The pane id is also the target `agent focus` takes.
    static let paneIDKey = "HERDR_PANE_ID"
    static let workspaceIDKey = "HERDR_WORKSPACE_ID"
    /// Set in panes only — a client process is told apart by its absence.
    static let markerKey = "HERDR_ENV"

    /// Workspace labels barely change and the row badge wants one per scan, so a
    /// short-lived cache keeps the process spawn off the reconcile loop. Also
    /// caches "herdr isn't running", which is the common case.
    private static let labelTTL: TimeInterval = 10
    private static let labelCache = TTLCache<[String: String]>()
    /// Which pane is focused changes with every keystroke on a pane switch, so
    /// this one is cached only long enough to absorb a burst of events.
    private static let focusTTL: TimeInterval = 2
    private static let focusCache = TTLCache<String?>()

    static func binary() -> String? {
        ["/opt/homebrew/bin/herdr", "/usr/local/bin/herdr", "/usr/bin/herdr"]
            .first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    static func paneID(ofAgent pid: pid_t, lookup: ProcessLookup) -> String? {
        lookup.environment(of: pid)[paneIDKey]
    }

    /// Move herdr's focus to the pane hosting an agent. Focus is server-global,
    /// so this settles the herdr half of a jump on its own; raising the window
    /// that shows it is the caller's job.
    @discardableResult
    static func focus(pane: String) -> Bool {
        guard let binary = binary() else { return false }
        return run(binary, ["agent", "focus", pane]) != nil
    }

    static func workspaceLabels() -> [String: String] {
        labelCache.value(ttl: labelTTL, fetch: fetchWorkspaceLabels)
    }

    /// The pane herdr is currently showing. A client draws one pane at a time,
    /// so this is what tells "the terminal is in front" apart from "this session
    /// is what you're actually looking at".
    static func focusedPaneID() -> String? {
        focusCache.value(ttl: focusTTL, fetch: fetchFocusedPane)
    }

    private static func fetchFocusedPane() -> String? {
        guard let binary = binary(), let data = run(binary, ["agent", "list"]),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let result = root["result"] as? [String: Any],
              let agents = result["agents"] as? [[String: Any]]
        else { return nil }
        return agents.first { $0["focused"] as? Bool == true }?["pane_id"] as? String
    }

    /// Live herdr clients — the terminal-side UI processes — newest first.
    /// Excludes the headless server, `--remote` clients (they render another
    /// machine's session, so focusing a local pane would not show up there) and
    /// clients nested inside a pane of the session they would be raising.
    static func clientPIDs(lookup: ProcessLookup) -> [pid_t] {
        lookup.allPIDs()
            .filter { pid in
                guard let path = lookup.path(of: pid),
                      (path as NSString).lastPathComponent == "herdr",
                      !lookup.arguments(of: pid).dropFirst().contains("server"),
                      lookup.environment(of: pid)[markerKey] == nil
                else { return false }
                return lookup.firstAncestor(of: pid, where: {
                    lookup.arguments(of: $0).contains("--remote")
                }) == nil
            }
            .sorted { (lookup.startDate(of: $0) ?? .distantPast) > (lookup.startDate(of: $1) ?? .distantPast) }
    }

    private static func fetchWorkspaceLabels() -> [String: String] {
        guard let binary = binary(), let data = run(binary, ["workspace", "list"]),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let result = root["result"] as? [String: Any],
              let workspaces = result["workspaces"] as? [[String: Any]]
        else { return [:] }

        return workspaces.reduce(into: [:]) { labels, workspace in
            guard let id = workspace["workspace_id"] as? String,
                  let label = workspace["label"] as? String, !label.isEmpty else { return }
            labels[id] = label
        }
    }

    /// Server-side failures come back as JSON on stderr with a non-zero status,
    /// so the exit code is the only thing worth trusting here.
    private static func run(_ path: String, _ arguments: [String]) -> Data? {
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
            return process.terminationStatus == 0 ? data : nil
        } catch {
            return nil
        }
    }

    /// Every answer here costs a process spawn, so each is held for a beat.
    /// Caching the "herdr isn't running" answer matters just as much — that's
    /// the common case on a machine that doesn't use it.
    private final class TTLCache<Value: Sendable>: @unchecked Sendable {
        private let lock = NSLock()
        private var cached: Value?
        private var fetchedAt = Date.distantPast

        func value(ttl: TimeInterval, fetch: () -> Value) -> Value {
            lock.lock()
            defer { lock.unlock() }
            if let cached, Date().timeIntervalSince(fetchedAt) < ttl { return cached }
            let fresh = fetch()
            cached = fresh
            fetchedAt = Date()
            return fresh
        }
    }
}
