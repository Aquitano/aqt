import Foundation

/// Idempotent, reversible writes to agent config files. Enabling installs this
/// app's hook entries; disabling removes only our entries (identified by the
/// `--agent-hook` marker) and prunes anything left empty.
///
/// Config is often a dotfiles-managed symlink. We write through to the real
/// target so the atomic temp+rename replaces the file's contents instead of
/// clobbering the symlink with a plain file.
struct AgentConfigInstaller {

    enum InstallerError: Error {
        case noExecutablePath
        /// The file exists but could not be read or parsed as a JSON object;
        /// we refuse to overwrite it (that would destroy the user's settings).
        case settingsUnreadable
        /// `hooks` exists but is not a JSON object; refuse to clobber it.
        case unexpectedHooksShape
    }

    private let claudeSettingsURL = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".claude/settings.json")

    private static let claudeHookEvents = ["Notification", "Stop", "SessionStart", "SessionEnd"]
    private static let hookMarker = "--agent-hook"

    // MARK: - Claude

    func claudeHooksInstalled() -> Bool {
        guard case let .object(root) = readSettings(at: claudeSettingsURL),
              let hooks = root["hooks"] as? [String: Any] else { return false }
        return Self.claudeHookEvents.contains { event in
            commands(inEvent: hooks[event]).contains { $0.contains(Self.hookMarker) }
        }
    }

    /// Add our hook to each watched event, refreshing a stale executable path
    /// (self-heal). Throws — rather than overwriting — if the existing file is
    /// present but unreadable/unparseable, so a transient read error or a manual
    /// JSON syntax slip can never wipe the user's settings.
    func installClaudeHooks() throws {
        guard let exe = Bundle.main.executablePath else { throw InstallerError.noExecutablePath }
        let command = "\(shellQuoted(exe)) \(Self.hookMarker)"

        var root: [String: Any]
        switch readSettings(at: claudeSettingsURL) {
        case .missing: root = [:]
        case .object(let obj): root = obj
        case .unreadable: throw InstallerError.settingsUnreadable
        }

        var hooks: [String: Any]
        switch root["hooks"] {
        case .none: hooks = [:]
        case let existing as [String: Any]: hooks = existing
        default: throw InstallerError.unexpectedHooksShape
        }

        for event in Self.claudeHookEvents {
            if let existing = hooks[event] {
                // Leave a malformed (non-array) event value untouched.
                guard let groups = existing as? [[String: Any]] else { continue }
                hooks[event] = pruneMarker(from: groups) + [ourGroup(command)]
            } else {
                hooks[event] = [ourGroup(command)]
            }
        }
        root["hooks"] = hooks
        try writeJSON(root, to: claudeSettingsURL)
    }

    func removeClaudeHooks() throws {
        guard case var .object(root) = readSettings(at: claudeSettingsURL),
              var hooks = root["hooks"] as? [String: Any] else { return }
        for event in Self.claudeHookEvents {
            guard let groups = hooks[event] as? [[String: Any]] else { continue }
            let pruned = pruneMarker(from: groups)
            if pruned.isEmpty { hooks[event] = nil } else { hooks[event] = pruned }
        }
        if hooks.isEmpty { root["hooks"] = nil } else { root["hooks"] = hooks }
        try writeJSON(root, to: claudeSettingsURL)
    }

    // MARK: - Hook shaping

    private func ourGroup(_ command: String) -> [String: Any] {
        ["hooks": [["type": "command", "command": command]]]
    }

    /// Strip only our marker commands, at inner-hook granularity, so a group that
    /// also holds a user's hook keeps that hook (the group is dropped only if it
    /// becomes empty).
    private func pruneMarker(from groups: [[String: Any]]) -> [[String: Any]] {
        groups.compactMap { group in
            guard var inner = group["hooks"] as? [[String: Any]] else { return group }
            inner.removeAll { ($0["command"] as? String)?.contains(Self.hookMarker) == true }
            if inner.isEmpty { return nil }
            var pruned = group
            pruned["hooks"] = inner
            return pruned
        }
    }

    // MARK: - JSON I/O

    private enum ReadResult {
        case missing
        case object([String: Any])
        case unreadable
    }

    private func readSettings(at url: URL) -> ReadResult {
        guard FileManager.default.fileExists(atPath: url.path) else { return .missing }
        guard let data = try? Data(contentsOf: url) else { return .unreadable }
        guard let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            return .unreadable
        }
        return .object(object)
    }

    private func writeJSON(_ object: [String: Any], to url: URL) throws {
        let data = try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys])
        let target = resolvedTarget(of: url)
        try FileManager.default.createDirectory(
            at: target.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try data.write(to: target, options: .atomic)
    }

    /// Follow a chain of symlinks to the real file path (bounded). Returns `url`
    /// unchanged when it is not a symlink or does not exist yet.
    private func resolvedTarget(of url: URL) -> URL {
        let fm = FileManager.default
        var current = url
        for _ in 0..<8 {
            guard let dest = try? fm.destinationOfSymbolicLink(atPath: current.path) else { break }
            if (dest as NSString).isAbsolutePath {
                current = URL(fileURLWithPath: dest).standardizedFileURL
            } else {
                current = current.deletingLastPathComponent()
                    .appendingPathComponent(dest).standardizedFileURL
            }
        }
        return current
    }

    // MARK: - Hook parsing

    private func commands(inEvent value: Any?) -> [String] {
        guard let groups = value as? [[String: Any]] else { return [] }
        return groups.flatMap { group -> [String] in
            guard let inner = group["hooks"] as? [[String: Any]] else { return [] }
            return inner.compactMap { $0["command"] as? String }
        }
    }

    private func shellQuoted(_ path: String) -> String { "\"\(path)\"" }
}
