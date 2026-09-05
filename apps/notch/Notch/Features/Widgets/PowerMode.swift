import AppKit
import NotchCore

/// One-tap Low Power Mode via the Shortcuts bridge: macOS has no public API to
/// write Low Power Mode, so the app runs a user-installed shortcut wrapping the
/// system "Set Low Power Mode" action. A pre-signed copy ships in the bundle
/// and Settings offers the one-time import. The state change itself flows back
/// through `NSProcessInfoPowerStateDidChange` into `BatteryManager`, so the UI
/// reflects reality, not the button press.
@MainActor
@Observable
final class PowerModeController {
    nonisolated static let shortcutName = "Toggle Low Power Mode"

    /// nil until the first `shortcuts list` check completes.
    private(set) var shortcutInstalled: Bool?
    private(set) var isToggling = false

    private unowned let activities: ActivityManager
    private var refreshTask: Task<Void, Never>?

    init(activities: ActivityManager) {
        self.activities = activities
    }

    func refreshAvailability() {
        guard refreshTask == nil else { return }
        refreshTask = Task.detached(priority: .utility) { [weak self] in
            let names = ShortcutsManager.execute(["list"])?.output
                .split(separator: "\n")
                .map(String.init) ?? []
            let installed = names.contains(Self.shortcutName)
            guard let self else { return }
            await MainActor.run {
                self.shortcutInstalled = installed
                self.refreshTask = nil
            }
        }
    }

    /// Open the bundled signed shortcut so the Shortcuts app offers the import.
    func installShortcut() {
        guard let url = Bundle.main.url(forResource: Self.shortcutName, withExtension: "shortcut") else {
            Log.app.error("Bundled Low Power Mode shortcut missing from Resources")
            return
        }
        NSWorkspace.shared.open(url)
    }

    func toggle() {
        guard !isToggling else { return }
        guard shortcutInstalled == true else {
            refreshAvailability()
            activities.peek(
                title: "Shortcut needed",
                message: "Install the Low Power Mode shortcut in Settings",
                symbol: "leaf.fill", tint: .warning, ttl: 5
            )
            return
        }
        isToggling = true
        Task.detached(priority: .userInitiated) { [weak self] in
            let result = ShortcutsManager.execute(["run", Self.shortcutName])
            guard let self else { return }
            await MainActor.run {
                self.isToggling = false
                guard result?.status != 0 else { return }
                let detail = result?.errorOutput.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                self.activities.peek(
                    title: "Low Power Mode failed",
                    message: detail.isEmpty ? "The shortcut did not run" : detail,
                    symbol: "exclamationmark.triangle", tint: .warning, ttl: 5
                )
            }
        }
    }
}
