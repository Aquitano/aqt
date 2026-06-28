import Foundation

/// Best-effort detection of which agent CLIs are installed, so the Agents tab
/// only offers Enable for tools you actually have. Checks common binary
/// locations and the agent's config/state directory (a GUI app's PATH is too
/// sparse to rely on `which`).
struct CLIDetector {

    func isInstalled(_ kind: AgentKind) -> Bool {
        switch kind {
        case .claudeCode:
            return exists(bin("claude") + [home(".local/share/claude"), home(".claude")])
        case .codex:
            return exists(bin("codex") + [home(".codex"), "/Applications/Codex.app"])
        case .openCode:
            return exists(bin("opencode") + [home(".config/opencode"), home(".opencode/bin/opencode")])
        case .ohMyPi:
            return exists(bin("omp") + [home(".omp")])
        }
    }

    private func exists(_ paths: [String]) -> Bool {
        paths.contains { FileManager.default.fileExists(atPath: $0) }
    }

    private func bin(_ name: String) -> [String] {
        ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin",
         home(".local/bin"), home(".bun/bin"), home("Library/pnpm"), home(".opencode/bin")]
            .map { "\($0)/\(name)" }
    }

    private func home(_ path: String) -> String {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(path).path
    }
}
