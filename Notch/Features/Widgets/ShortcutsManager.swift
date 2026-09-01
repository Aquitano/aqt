import Foundation

/// Runs user-pinned Shortcuts via `/usr/bin/shortcuts`. Listing and running both
/// shell out off-main; run failures surface through the activity peek channel.
@MainActor
@Observable
final class ShortcutsManager {

    /// Names from `shortcuts list`, for the Settings picker.
    private(set) var available: [String] = []

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

    /// Shared `shortcuts` CLI runner; also used by `PowerModeController` for
    /// the Low Power Mode bridge.
    nonisolated static func execute(_ arguments: [String])
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
        // Drain both pipes while the process runs. Reading stdout fully before
        // stderr can still deadlock if the child fills stderr while stdout stays
        // open.
        let group = DispatchGroup()
        let outCapture = PipeCapture()
        let errCapture = PipeCapture()
        group.enter()
        DispatchQueue.global(qos: .utility).async {
            outCapture.data = stdout.fileHandleForReading.readDataToEndOfFile()
            group.leave()
        }
        group.enter()
        DispatchQueue.global(qos: .utility).async {
            errCapture.data = stderr.fileHandleForReading.readDataToEndOfFile()
            group.leave()
        }
        process.waitUntilExit()
        group.wait()
        return (process.terminationStatus,
                String(data: outCapture.data, encoding: .utf8) ?? "",
                String(data: errCapture.data, encoding: .utf8) ?? "")
    }
}

private final class PipeCapture: @unchecked Sendable {
    var data = Data()
}
