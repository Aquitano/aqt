import Foundation

/// Runs user-pinned Shortcuts via `/usr/bin/shortcuts`. Listing and running both
/// shell out off-main; run failures surface through the activity peek channel.
@MainActor
final class ShortcutsManager: ObservableObject {

    /// Names from `shortcuts list`, for the Settings picker.
    @Published private(set) var available: [String] = []

    private let activities: ActivityManager

    init(activities: ActivityManager) {
        self.activities = activities
    }

    /// Refresh the picker list; called when the Settings editor appears.
    func refreshAvailable() {
        Task.detached(priority: .utility) { [weak self] in
            let names = Self.execute(["list"])?.output
                .split(separator: "\n")
                .map(String.init) ?? []
            guard let self else { return }
            await MainActor.run { self.available = names }
        }
    }

    func run(_ name: String) {
        Task.detached(priority: .userInitiated) { [weak self] in
            let result = Self.execute(["run", name])
            guard let self, result?.status != 0 else { return }
            let detail = result?.errorOutput.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            await MainActor.run {
                self.activities.publish(Activity(
                    kind: .peek(title: "Shortcut failed",
                                message: detail.isEmpty ? name : detail,
                                symbol: "exclamationmark.triangle",
                                tint: .warning),
                    priority: .urgent, createdAt: Date(), ttl: 4
                ))
            }
        }
    }

    nonisolated private static func execute(_ arguments: [String])
        -> (status: Int32, output: String, errorOutput: String)? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/shortcuts")
        process.arguments = arguments
        let stdout = Pipe()
        let stderr = Pipe()
        process.standardOutput = stdout
        process.standardError = stderr
        do {
            try process.run()
        } catch {
            return nil
        }
        // Drain before waiting so a chatty shortcut can't deadlock on a full pipe.
        let outData = stdout.fileHandleForReading.readDataToEndOfFile()
        let errData = stderr.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return (process.terminationStatus,
                String(data: outData, encoding: .utf8) ?? "",
                String(data: errData, encoding: .utf8) ?? "")
    }
}
